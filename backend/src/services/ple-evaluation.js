// PIS-7 evaluation persistence, shared by the physician /end flow and the admin approve flow.
const { supabase } = require('../lib/supabase');
const { lockDeclarationDigest, LOCK_DECLARATION_FIELDS } = require('./model-lock');
const { compositeScore } = require('./ple-gate');
const { rimplEvaluate, isDeterministicRimplError } = require('./rimpl-client');
const { accrueUsage } = require('../lib/usage');
const { costUsd } = require('../lib/pricing');

// Persist an AI evaluation + LPDP snapshot and mark the PLE evaluated.
// Ordered + error-checked: the scored row must land before we write the LPDP snapshot or flip the
// PLE to 'evaluated'. Otherwise a malformed result (e.g. an out-of-range domain score) used to leave
// a composite=0 LPDP snapshot + missing ai_evaluation while the PLE still showed 'evaluated'.
async function persistEvaluation(pleId, physicianId, result) {
  const composite = compositeScore(result);
  const domain = {
    d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4,
    d5: result.d5, d6: result.d6, d7: result.d7,
  };
  const { error: aiErr } = await supabase.from('ai_evaluations').insert({
    ple_id: pleId, ...domain,
    composite_score: composite,
    domain_rationale: result.domain_rationale,
    model_version: result.model_version ?? 'CCME_LLM_v8.0',
    prompt_version: result.prompt_version ?? null,
    rubric_version: result.rubric_version ?? null,
    // §10.2 / Model Lock Record: the full configuration behind THIS score — decoding parameters as
    // sent, the declared weights checksum, and a fingerprint over the set. Two scores with different
    // fingerprints did not come from the same locked configuration, which makes the lock checkable
    // from the data instead of from memory.
    provenance: result.provenance ?? null,
  });
  // UNIQUE(ple_id): a 23505 means a row already exists — a concurrent evaluation (the dup-eval race),
  // or a previous PARTIAL persist where the ai row landed but the snapshot/status writes failed. In
  // both cases DON'T throw (that would loop in reconcile); fall through to ensure the LPDP snapshot
  // and 'evaluated' status are also written. The existing row's scores are kept (no double-write).
  if (aiErr && aiErr.code !== '23505') throw new Error(`ai_evaluations insert failed: ${aiErr.message}`);
  // `fresh` = this call actually wrote the evaluation row (no 23505). The caller meters the paid Claude
  // call against the physician ONLY when fresh, so a dup-eval race doesn't double-charge the meter.
  const fresh = !aiErr;

  const { error: lpdpErr } = await supabase.from('lpdp_snapshots').insert({
    physician_id: physicianId, ple_id: pleId,
    composite_score: composite, domain_scores: domain,
  });
  if (lpdpErr && lpdpErr.code !== '23505') throw new Error(`lpdp_snapshots insert failed: ${lpdpErr.message}`);

  const { error: pleErr } = await supabase.from('ples').update({ status: 'evaluated' }).eq('id', pleId);
  if (pleErr) throw new Error(`ples status update failed: ${pleErr.message}`);
  return { fresh };
}

// ---- the lock state an evaluation is stamped with ---------------------------------------------------
//
// Both lock settings in ONE statement. The lock and the unlock write them in one upsert; two separate
// reads could straddle that write and pair the flag of one state with the digest of the other.
const EVALUATION_LOCK_KEYS = Object.freeze(['evaluator_locked_at', 'evaluator_weights_sha256']);
const settingText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const lower = (v) => (typeof v === 'string' && v ? v.toLowerCase() : null);
// The record's declared fields (services/model-lock.js LOCK_DECLARATION_FIELDS), which are all in
// db/migration-evaluator-model-lock.sql: this read does not need the manifest migration.
const LOCK_DECLARATION_COLS = ['id', 'locked_at', ...LOCK_DECLARATION_FIELDS].join(', ');

/**
 * What an evaluation is stamped with: { weights_sha256, lock_declaration_sha256 }, or { error, code }
 * when it must not run. Never throws.
 *
 *   no evaluator_locked_at       unlocked: lock_declaration_sha256 null, weights_sha256 as the setting
 *                                reads (an unlock clears both)
 *   locked, record consistent    the digest of the record the flag points at
 *   otherwise, an error:         lock_state_unreadable (the settings), lock_record_unreadable (the record,
 *                                including an unmigrated table), lock_record_missing (no record behind the
 *                                flag: a hand-set lock), lock_state_inconsistent (the record's
 *                                weights_sha256 is not the one in force)
 * triggerEvaluation below DEFERS on an error. A post-lock score without its declaration
 * fingerprints the same as one under any other declaration over the same weights, and a score is written
 * once per PLE and never re-stamped.
 */
async function evaluationLockStamp() {
  let rows = null, error = null;
  try {
    ({ data: rows, error } = await supabase.from('app_settings').select('key, value_text').in('key', EVALUATION_LOCK_KEYS));
  } catch (e) {
    error = { message: e?.message || String(e) };
  }
  if (!error && !Array.isArray(rows)) error = { message: 'the settings read returned no rows' };
  if (error) return { error: error.message ?? String(error), code: 'lock_state_unreadable' };
  const by = Object.fromEntries(rows.map((r) => [r?.key, settingText(r?.value_text)]));
  const lockedAt = by.evaluator_locked_at ?? null;
  const weights = by.evaluator_weights_sha256 ?? null;
  if (!lockedAt) return { weights_sha256: weights, lock_declaration_sha256: null };

  let record = null;
  try {
    ({ data: record, error } = await supabase.from('evaluator_model_lock').select(LOCK_DECLARATION_COLS)
      .eq('locked_at', lockedAt).order('locked_at', { ascending: false }).limit(1).maybeSingle());
  } catch (e) {
    error = { message: e?.message || String(e) };
  }
  if (error) return { error: `lock record unreadable: ${error.message ?? String(error)}`, code: 'lock_record_unreadable' };
  if (!record) return { error: `no lock record behind evaluator_locked_at ${lockedAt}`, code: 'lock_record_missing' };
  if (lower(record.weights_sha256) !== lower(weights)) {
    return { error: `the lock record's weights_sha256 is not the one in force (evaluator_locked_at ${lockedAt})`, code: 'lock_state_inconsistent' };
  }
  return { weights_sha256: weights, lock_declaration_sha256: lockDeclarationDigest(record) };
}

// Why an evaluation was deferred, by evaluationLockStamp's code, for the thrown error and the drain's log.
const LOCK_DEFER_REASON = Object.freeze({
  lock_state_unreadable: 'the evaluator lock settings could not be read',
  lock_record_unreadable: 'the lock record behind the lock in force could not be read',
  lock_record_missing: 'no lock record stands behind the lock in force',
  lock_state_inconsistent: 'the lock record names other weights than the lock settings',
});

// ---- the echo check: a locked score is saved only if rimpl stamped what it was sent ------------------
//
// rimpl's zod schema STRIPS a key it does not know. So a rimpl older than the declaration digest answers
// 200 with a score stamped `locked: true` and no lock_declaration_sha256: the weights-only fingerprint
// that every declaration over the same weights shares, which is exactly the failure #75 criterion 7 is
// about. A Railway rollback, an out-of-order deploy or an older on-prem image does that, and the model
// manifest's sha256 does not cover provenance, so nothing else would say so.
//
// So each lock digest that was SENT must come back in provenance, compared case-insensitively. When it
// does not, the score is not saved and the evaluation defers (503, transient): it recovers by itself once
// rimpl is current, and the drain's bounded attempts (EVAL_MAX_ATTEMPTS, services/eval-drain.js) route it
// to manual QA otherwise. Unlocked, nothing is sent, nothing is checked, and the score is saved as before.
const LOCK_ECHO = Object.freeze([
  ['lock_declaration_sha256', 'lock_declaration_not_stamped'],
  ['weights_sha256', 'lock_weights_not_stamped'],
]);
function unstampedLockField(provenance, sent) {
  for (const [field, code] of LOCK_ECHO) {
    if (sent[field] == null) continue;
    const got = provenance && typeof provenance === 'object' ? provenance[field] ?? null : null;
    if (lower(got) !== lower(sent[field])) return { field, code, sent: sent[field], got };
  }
  return null;
}
// A digest's first 12 characters, for a log line a person reads. Config hashes, never identifiers.
const short = (v) => (typeof v === 'string' && v ? `${v.slice(0, 12)}…` : 'none');

// The RIMPL evaluation is a network call to a Claude-backed service; a transient 5xx/timeout would
// otherwise silently strand a credit-eligible PLE at ple_pass with no score. Retry with backoff —
// EXCEPT on a deterministic failure (bad/out-of-range model output → 502, or a token misconfig →
// 401), where retrying just re-pays Anthropic for the same guaranteed failure. Re-throw immediately
// so reconcile can route the session to manual QA instead of looping every sweep forever.
async function evaluateWithRetry(payload, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await rimplEvaluate(payload); }
    catch (e) {
      lastErr = e;
      if (isDeterministicRimplError(e)) throw e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

// Run the PIS-7 evaluation for a passed PLE and persist it. Throws on failure (caller logs).
// `attempts`: the /end-era default was 3 in-process retries. The evaluation drain passes 1 — it owns
// backoff via eval_next_at, and an in-process retry after a timeout would re-POST a duplicate into
// rimpl's queue while the original may still be waiting there.
// `chiefComplaint` seeds RIMPL's token numbering only; it is never shown to the evaluator.
async function triggerEvaluation(pleId, transcript, physicianId, patientRef, { attempts = 3, chiefComplaint = null } = {}) {
  // The declared Model Lock checksum travels WITH the evaluation so it is stamped on the score at
  // the moment it is produced. Read per call rather than cached: if it is declared (or re-declared)
  // mid-pilot, the scores either side carry different values and the break is visible in the data.
  //
  // FAIL CLOSED, BY DEFERRING. An unreadable lock state is not "unlocked": scoring through it would
  // stamp a post-lock score `locked: false` (rimpl provenance.js: locked = !!weights_sha256), and the
  // score is written once per PLE and never re-stamped. So the evaluation does not run. The error
  // carries status 503 — transient, not in rimpl-client's DETERMINISTIC_STATUSES — so the drain
  // (services/eval-drain.js) defers the row with backoff, exactly as for a full rimpl queue, and only
  // routes it to manual QA once EVAL_MAX_ATTEMPTS is spent. Thrown BEFORE the rimpl call: nothing is
  // paid for, nothing is queued on the box, and the physician sees "queued", not a wrong score.
  //
  // THE DECLARATION TRAVELS TOO (#75 criterion 7). While a lock is in force, the evaluation also carries
  // lock_declaration_sha256, a digest over everything declared on the record the flag points at
  // (services/model-lock.js lockDeclarationDigest): quantization, engine, environment, the system prompt
  // version and the declared decoding are not visible to rimpl any other way. A lock whose record cannot
  // be read, is missing, or names other weights than the setting DEFERS the same way: scoring without
  // the declaration would give the score the fingerprint of every other declaration over those weights.
  const lock = await evaluationLockStamp();
  if (lock.error) {
    const e = new Error(`evaluation deferred, not scored: ${LOCK_DEFER_REASON[lock.code] ?? 'the evaluator lock state is unusable'} (${lock.code}: ${lock.error})`);
    e.status = 503;
    e.code = lock.code;
    throw e;
  }
  const { weights_sha256, lock_declaration_sha256 } = lock;
  const result = await evaluateWithRetry({ ple_id: pleId, transcript, patient_ref: patientRef, chief_complaint: chiefComplaint ?? null,
    weights_sha256, lock_declaration_sha256 }, attempts);
  // Saved only if rimpl stamped back what it was sent (unstampedLockField above). Thrown BEFORE the
  // persist and the meter: nothing is written, so the next attempt scores the PLE afresh.
  const unstamped = unstampedLockField(result?.provenance, { weights_sha256, lock_declaration_sha256 });
  if (unstamped) {
    console.error(`[ple-evaluation] PLE ${pleId}: rimpl did not stamp ${unstamped.field} on the score `
      + `(sent ${short(unstamped.sent)}, got ${short(unstamped.got)}). Most likely a rimpl older than this backend `
      + '(a rollback, an out-of-order deploy or an older on-prem image). Not saved; deferred until rimpl is current.');
    const e = new Error(`evaluation deferred, not saved: rimpl did not stamp ${unstamped.field} on the score (an older rimpl?)`);
    e.status = 503;
    e.code = unstamped.code;
    throw e;
  }
  const { fresh } = await persistEvaluation(pleId, physicianId, result);
  // Accrue the PIS-7 evaluation's cost to the physician's meter ONLY when this call actually wrote
  // the row — a dup-eval race (reconcile vs /end) must not double-charge the physician. There is no
  // reservation on this path (it runs after /end, which is deliberately not budget-gated), so the
  // provider-priced actual is passed straight through as accrueUsage's `costOverride`: an evaluation
  // served by the on-prem model costs $0 while its token counts are still recorded.
  if (fresh) {
    await accrueUsage(physicianId, result.input_tokens, result.output_tokens,
      costUsd(result.input_tokens, result.output_tokens, result.provider));
  }
}

module.exports = { persistEvaluation, triggerEvaluation, evaluationLockStamp };
