// Tier-2 CLE screening finalize — shared by the physician /end flow AND the reconcile sweep, so a
// session that reached 'ended' (tier-1 passed, tier-2 pending) lands a terminal status from EITHER
// path. Pulling it out of /end is what makes 'ended' RECOVERABLE: if the process dies (Railway
// redeploy / OOM) mid-evaluation, the deterministic tier-1 result is already persisted and reconcile
// re-runs just this step — the session is never permanently stranded at 'ended'.
const { supabase } = require('../lib/supabase');
const { rimplEvaluateCriteria, isDeterministicRimplError } = require('./rimpl-client');
const { accrueUsage } = require('../lib/usage');
const { costUsd } = require('../lib/pricing');
const { triggerEvaluation } = require('./cle-evaluation');
const { persistPiiMap } = require('../lib/pii-map');

// CLE-gate booleans live in the c1_pass..c6_pass columns; map {c1..} -> {c1_pass..}.
const toPassCols = (crit) => Object.fromEntries(Object.entries(crit).map(([k, v]) => [`${k}_pass`, v]));

// Retry the tier-2 criteria call on a TRANSIENT failure (so one RIMPL blip at /end can't wrongly
// demote a fully-qualifying session to manual QA); give up immediately on a deterministic failure.
async function evaluateCriteriaWithRetry(payload, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await rimplEvaluateCriteria(payload); }
    catch (e) {
      lastErr = e;
      if (isDeterministicRimplError(e)) throw e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

// Given a session that reached 'ended' with its deterministic fields persisted, run the qualifying
// classifier and finalize: 'cle_flag_t2' on a genuine c4-c7 miss, or 'cle_pass' + fire the
// PIS-7 evaluation. THROWS on a persistent RIMPL error WITHOUT writing a terminal status — the session
// stays 'ended' so the next reconcile sweep retries it, instead of a transient blip permanently
// flagging a qualifying session to manual QA. Returns { status, criteria }.
async function finalizeScreening({ cleId, physicianId, transcript, tier1, patient_ref, cle = {} }) {
  const crit = await evaluateCriteriaWithRetry({ transcript, patient_ref });
  // Persist the reversible on-prem PII map RIMPL returned (encrypted, fail-soft) — Tier-1 audit.
  await persistPiiMap(cleId, crit.pii_map);
  // The CREC082 §1 qualifying test, all four elements. c7 (context/evidence integration) is the one
  // that had no check before: a physician could reason and reflect at length without anchoring any
  // of it to guidance, evidence, or the specifics of the case, and the session still passed.
  const tier2 = { c4: crit.c4, c5: crit.c5, c6: crit.c6, c7: crit.c7 };
  // Price against the provider that ACTUALLY served the classifier. Without the costOverride this
  // falls through to usage.js's 2-arg costUsd(), which bills at Anthropic rates — so an all-local
  // deployment would charge ~$0.39 of a physician's $0.50 cap for a 130k-token transcript that cost
  // $0 of marginal spend, locking them out after a handful of free CLEs. There is no reservation on
  // this path, so the provider-priced actual passes straight through (mirrors cle-evaluation.js).
  await accrueUsage(physicianId, crit.input_tokens, crit.output_tokens,
    costUsd(crit.input_tokens, crit.output_tokens, crit.provider));

  const allCriteria = { ...tier1, ...tier2 };
  const qualifies = tier2.c4 && tier2.c5 && tier2.c6 && tier2.c7;

  // The consecutive-failure counter, moved here from the /end route. It used to be fed by the
  // tier-1 verdict; tier-1 is metadata now, so fed from there it would record a pass for every
  // session and reset itself forever. "Failure" means the session did not qualify as a PLE, which
  // is what the counter was always describing. Only a natural, real session feeds it — a Socratic
  // session is not part of the "natural fails" signal and a test session must not pollute it.
  // Best-effort: never let bookkeeping block a finalize.
  if (cle.socratic_reason == null && !cle.is_test) {
    const { error: rtErr } = await supabase.rpc('record_t1_outcome', { p_id: physicianId, p_pass: qualifies });
    if (rtErr) console.error('[cle-finalize] record_t1_outcome failed:', rtErr.message);
  }

  if (!qualifies) {
    const { error } = await supabase.from('cles')
      .update({ status: 'cle_flag_t2', ...toPassCols(allCriteria) }).eq('id', cleId);
    if (error) throw new Error(`finalizeScreening cle_flag_t2 update: ${error.message}`);
    return { status: 'cle_flag_t2', criteria: allCriteria };
  }

  const { error } = await supabase.from('cles')
    .update({ status: 'cle_pass', ...toPassCols(allCriteria) }).eq('id', cleId);
  if (error) throw new Error(`finalizeScreening cle_pass update: ${error.message}`);
  // Fire-and-forget the PIS-7 evaluation (its own retry + idempotent persist + reconcile backstop).
  triggerEvaluation(cleId, transcript, physicianId, patient_ref).catch(err =>
    console.error(`[EVAL] triggerEvaluation failed for CLE ${cleId}:`, err.message));
  return { status: 'cle_pass', criteria: allCriteria };
}

module.exports = { finalizeScreening, evaluateCriteriaWithRetry, toPassCols };
