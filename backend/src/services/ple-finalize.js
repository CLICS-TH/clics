// Tier-2 PLE screening finalize — shared by the physician /end flow AND the reconcile sweep, so a
// session that reached 'ended' (tier-1 passed, tier-2 pending) lands a terminal status from EITHER
// path. Pulling it out of /end is what makes 'ended' RECOVERABLE: if the process dies (Railway
// redeploy / OOM) mid-evaluation, the deterministic tier-1 result is already persisted and reconcile
// re-runs just this step — the session is never permanently stranded at 'ended'.
const { supabase } = require('../lib/supabase');
const { rimplEvaluateCriteria, isDeterministicRimplError } = require('./rimpl-client');
const { isRimplRefusal } = require('../lib/rimpl-refusal');
const { accrueUsage } = require('../lib/usage');
const { costUsd } = require('../lib/pricing');
const evalDrain = require('./eval-drain');
const { persistPiiMap } = require('../lib/pii-map');
const { logEvent } = require('../lib/audit');

// PLE-gate booleans live in the c1_pass..c6_pass columns; map {c1..} -> {c1_pass..}.
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
// classifier and finalize: 'ple_flag_t2' on a genuine c4-c7 miss, or 'ple_pass' + fire the
// PIS-7 evaluation. THROWS on a persistent RIMPL error WITHOUT writing a terminal status — the session
// stays 'ended' so the next reconcile sweep retries it, instead of a transient blip permanently
// flagging a qualifying session to manual QA. Returns { status, criteria }.
async function finalizeScreening({ pleId, physicianId, transcript, tier1, patient_ref, ple = {} }) {
  let crit;
  try {
    crit = await evaluateCriteriaWithRetry({ transcript, patient_ref });
  } catch (e) {
    // Declined by the model's safeguards: billed, so metered (as below), then the existing failure path.
    if (isRimplRefusal(e)) {
      console.warn(`[ple-finalize] criteria classifier for ${pleId} declined by the model's safeguards (category ${e.category ?? 'none'})`);
      await accrueUsage(physicianId, e.usage.input_tokens, e.usage.output_tokens,
        costUsd(e.usage.input_tokens, e.usage.output_tokens, e.usage.provider));
    }
    throw e;
  }
  // Persist the reversible on-prem PII map RIMPL returned (encrypted, fail-soft) — Tier-1 audit.
  await persistPiiMap(pleId, crit.pii_map);
  // The CREC082 §1 qualifying test, all four elements. c7 (context/evidence integration) is the one
  // that had no check before: a physician could reason and reflect at length without anchoring any
  // of it to guidance, evidence, or the specifics of the case, and the session still passed.
  const tier2 = { c4: crit.c4, c5: crit.c5, c6: crit.c6, c7: crit.c7 };
  // Price against the provider that ACTUALLY served the classifier. Without the costOverride this
  // falls through to usage.js's 2-arg costUsd(), which bills at Anthropic rates — so an all-local
  // deployment would charge ~$0.39 of a physician's $0.50 cap for a 130k-token transcript that cost
  // $0 of marginal spend, locking them out after a handful of free PLEs. There is no reservation on
  // this path, so the provider-priced actual passes straight through (mirrors ple-evaluation.js).
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
  if (ple.socratic_reason == null && !ple.is_test) {
    const { error: rtErr } = await supabase.rpc('record_t1_outcome', { p_id: physicianId, p_pass: qualifies });
    if (rtErr) console.error('[ple-finalize] record_t1_outcome failed:', rtErr.message);
  }

  if (!qualifies) {
    const { error } = await supabase.from('ples')
      .update({ status: 'ple_flag_t2', ...toPassCols(allCriteria) }).eq('id', pleId);
    if (error) throw new Error(`finalizeScreening ple_flag_t2 update: ${error.message}`);
    return { status: 'ple_flag_t2', criteria: allCriteria };
  }

  const { error } = await supabase.from('ples')
    .update({ status: 'ple_pass', ...toPassCols(allCriteria) }).eq('id', pleId);
  if (error) throw new Error(`finalizeScreening ple_pass update: ${error.message}`);
  // ENQUEUE, don't evaluate. The ple_pass row is the evaluation queue (services/eval-drain.js); the
  // drain claims it FIFO under a bounded concurrency, so a burst of /end calls cannot fan out onto the
  // evaluator. Separate best-effort write: a pre-migration column error must not strand a session
  // that has already reached its terminal screening status.
  await enqueueEvaluation(pleId);
  return { status: 'ple_pass', criteria: allCriteria };
}

// Put a ple_pass row at the back of the evaluation queue and wake the drain. Shared by /end (via
// finalizeScreening), admin approve/re-evaluate and the reconcile sweep. `front: true` puts an admin
// recovery ahead of the backlog. Fail-soft on the write: the row is still ple_pass, and the drain's
// claim orders by coalesce(eval_enqueued_at, ended_at, created_at), so it is found either way.
async function enqueueEvaluation(pleId, { front = false } = {}) {
  const { error } = await supabase.from('ples')
    .update({ eval_enqueued_at: front ? new Date(0).toISOString() : new Date().toISOString(),
      eval_attempts: 0, eval_next_at: null, eval_claimed_at: null, eval_last_error: null })
    .eq('id', pleId);
  if (error) console.error(`[ple-finalize] PLE ${pleId}: enqueue write failed (drain will still find it by ended_at): ${error.message}`);
  evalDrain.kick();
}

// The tier-2 classifier was DECLINED by the model's safeguards (rimpl 422 'refused'). That is
// deterministic: the same transcript is declined again, and every attempt is billed. So the session goes
// straight to manual QA instead of resting at 'ended' for reconcile to pay for the same decline. The
// usage is already metered (finalizeScreening, above).
//
// The same state machine and audit event as the evaluation drain's flag() (services/eval-drain.js):
// status 'ple_flag_t2', the claim cleared, a `deterministic:<status>:<code>` reason in eval_last_error,
// and 'ple.eval_deterministic_failure' in the audit log. It is guarded on 'ended', the only state a
// tier-2 screening runs from, so a session something else already moved on is left alone. Best-effort
// like flag(): a failed write is logged and the session stays 'ended', where reconcile still finds it.
async function flagRefusedScreening({ pleId, ple, err }) {
  const reason = `deterministic:${err?.status ?? 422}:refused${err?.category ? ':' + err.category : ''}`;
  const { error } = await supabase.from('ples')
    .update({ status: 'ple_flag_t2', eval_claimed_at: null, eval_last_error: reason })
    .eq('id', pleId).eq('status', 'ended');
  if (error) console.error(`[ple-finalize] PLE ${pleId}: refusal flag write failed: ${error.message}`);
  console.warn(`[ple-finalize] PLE ${pleId}: tier-2 classifier declined by the model's safeguards -> manual QA (${reason})`);
  await logEvent({ action: 'ple.eval_deterministic_failure', targetType: 'ple', targetId: pleId, councilId: ple?.council_id ?? null,
    metadata: { reason, stage: 'criteria' } }).catch(() => {});
}

module.exports = { finalizeScreening, evaluateCriteriaWithRetry, toPassCols, enqueueEvaluation, flagRefusedScreening };
