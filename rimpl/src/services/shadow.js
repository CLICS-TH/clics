// Shadow evaluation — score a PLE a SECOND time with a candidate model, record it, never serve it.
//
// The problem it solves: the PIS-7 evaluator cannot be repointed at the on-prem model to "see how it
// does". CME credit is gated on ICC ≥ 0.75 and §10.2 requires a locked model+prompt+rubric for the
// pilot, so swapping mid-cohort would confound the primary outcome. And it cannot be settled in
// advance either — only nine PLEs currently carry both an AI and a human score, far too thin to
// certify a scoring instrument. Shadow mode makes the pilot generate its own calibration corpus:
// same transcript, same rubric, two models, one served.
//
// NON-NEGOTIABLES, in priority order:
//   1. It must never affect the served evaluation. Fire-and-forget AFTER the response is sent, every
//      failure swallowed, and it SHEDS rather than queues when the provider is busy — a shadow bug
//      or a shadow backlog must never cost a physician their credit.
//   2. It must never cost the physician anything. No usage accrual, no budget reservation.
//   3. It must never widen the PII surface. It re-uses the ALREADY de-identified transcript text the
//      served evaluation built; it does not re-read, re-flatten, or re-strip anything.
//   4. It must never become visible. shadow_evaluations is RLS deny-all: a second AI score reaching
//      an auditor would anchor their blind scoring and corrupt the ICC it exists to measure.
const { callProvider, providerNameFor, PROVIDERS } = require('./ai');
const { supabase } = require('../lib/supabase');
const { pis7PromptFor } = require('../lib/prompts');
const { Pis7ScoreError } = require('../lib/pis7');
const { scoreWithConsistency, MODES: CONSISTENCY_MODES } = require('./consistency');
const { modelVersion, promptVersionFor, RUBRIC_VERSION } = require('../lib/versions');

// Math.max(x, parseInt('auto',10)) is NaN, not x — Math.max PROPAGATES NaN, and a NaN maxTokens
// serialises to `"max_tokens": null` on the wire (Anthropic 400s; an OpenAI-compatible server
// generates to its context limit). Parse defensively so a bad value falls back to the documented one.
function intEnv(name, dflt, min = 0) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= min ? n : dflt;
}

// Default OFF. Set to a provider name ('local') to start collecting.
const shadowProvider = () => String(process.env.SHADOW_EVAL_PROVIDER || '').trim().toLowerCase();

// Same ceiling as the served evaluation (routes/evaluate.js) — a shadow score truncated at a smaller
// ceiling would look like a model failure when it was really our own budget.
const shadowMaxTokens = () => intEnv('SHADOW_EVAL_MAX_TOKENS', 4096, 1000);

// Shed the shadow when anyone is already WAITING for that provider. Both providers share one FIFO
// queue per provider (services/providers/runtime.js), so an unshed shadow would take a slot ahead of
// a physician's next chat turn. Served traffic wins, always; a shed shadow is a missing data point,
// which is strictly better than a delayed physician. Raise SHADOW_MAX_QUEUE only if the box is idle.
const shadowMaxQueue = () => intEnv('SHADOW_MAX_QUEUE', 0, 0);

// Self-consistency for the SHADOW arm (services/consistency.js): off (default) | adaptive | median3.
// Default off on purpose — three shadow calls per PLE is exactly the load the shed rule above exists to
// prevent. Enable only on an idle box, when the shadow corpus should be produced under the same rule
// the served local arm uses (EVAL_CONSISTENCY). The row records call 1's tokens and stop reason, so it
// stays comparable with a single-call row; shadow_evaluations has no column for the extra calls.
//
// THE SHADOW NEVER RE-ASKS, in either mode. The candidate's contract-compliance rate is computed from
// this table's `error` column (backend/src/services/agreement.js shadowFailed, scripts/local-model/
// status.mjs), and the table has no json_retries / calls column to say a re-ask happened. With the
// served path's budget of 2, a model with a 10% per-call garbage rate would read ~99.6% contract
// instead of 90% — a laundered failure rate, in the flattering direction, on the one dataset a
// decision to swap the scoring instrument rests on. A `consistency` column on shadow_evaluations
// would be needed before the extra calls could be kept honestly.
const shadowConsistencyMode = () => {
  const mode = String(process.env.SHADOW_EVAL_CONSISTENCY || '').trim().toLowerCase();
  return CONSISTENCY_MODES.includes(mode) ? mode : 'off';
};
// The pair-agreement thresholds are a property of the RULE, not of the arm, so the shadow reads the
// same EVAL_CONSISTENCY_MAX_SUM_DELTA the served evaluation does — a corpus produced under a different
// rule than the one being decided on would be the two-validators problem all over again.
const shadowMaxSumDelta = () => intEnv('EVAL_CONSISTENCY_MAX_SUM_DELTA', 0, 0);

// Decide whether to shadow, and with what. Exported so the route can skip the work entirely.
function shadowTarget(servedProvider) {
  const name = shadowProvider();
  if (!name) return null;                       // disabled (the default)
  const provider = PROVIDERS[name];
  if (!provider) {                              // typo'd config: say so once, don't silently no-op
    console.warn(`[shadow] SHADOW_EVAL_PROVIDER="${name}" is not a known provider — shadow disabled`);
    return null;
  }
  // Shadowing the model that already served is pure waste: same model, same prompt, no comparison.
  if (name === (servedProvider || providerNameFor('evaluate'))) return null;
  return name;
}

// Every mutable column, explicitly. This is NOT cosmetic: postgrest-js's single-object upsert derives
// the INSERT column list from the payload's KEYS, so `ON CONFLICT DO UPDATE SET` only covers the keys
// present — any column omitted RETAINS its previous value. With a per-outcome key set, a re-run would
// MERGE onto the earlier attempt: a later transport failure would leave September's valid scores in
// place beside an error string (a harness counting non-null d1 reads it as a success), and a later
// success would leave a stale error on a validly scored row (a harness filtering `error is null`
// drops it AND counts it as a failure). That silently launders the failure rate in the flattering
// direction, on the one dataset a decision to swap the scoring instrument would rest on.
function blankRow(pleId, provider, model) {
  return {
    ple_id: pleId,
    provider,
    // Provenance is stamped BEFORE the call, from the configured model, so a transport failure is
    // still attributable. Overwritten with the server-reported model on success.
    model_version: modelVersion(model),
    prompt_version: promptVersionFor(provider),
    rubric_version: RUBRIC_VERSION,
    d1: null, d2: null, d3: null, d4: null, d5: null, d6: null, d7: null,
    composite_score: null,
    domain_rationale: null,
    stop_reason: null,
    error: null,
    input_tokens: null,
    output_tokens: null,
    latency_ms: null,
    // Sent explicitly: `default now()` is not re-evaluated on DO UPDATE, so a merged row would
    // otherwise keep the FIRST attempt's timestamp and hide when the data actually came from.
    evaluated_at: new Date().toISOString(),
  };
}

// Fire-and-forget. NEVER throws, NEVER rejects — callers do not await this and an unhandled
// rejection here would take down the process for a purely optional measurement.
async function runShadowEvaluation({ pleId, transcriptText, servedProvider }) {
  const provider = shadowTarget(servedProvider);
  if (!provider) return { skipped: true };

  const impl = PROVIDERS[provider];
  const queued = (() => { try { return impl.stats().queued; } catch { return 0; } })();
  if (queued > shadowMaxQueue()) {
    console.warn(`[shadow] shed for PLE ${pleId} — ${provider} has ${queued} call(s) queued; served traffic wins`);
    return { skipped: true, shed: true };
  }

  const startedAt = Date.now();
  let row = blankRow(pleId, provider, (() => { try { return impl.model(); } catch { return null; } })());
  try {
    const mode = shadowConsistencyMode();
    let first = null;
    const callOnce = async () => {
      const reply = await callProvider({
        provider,
        // Rides the BACKGROUND lane on the local box (providers/local.js LANE_FOR), behind every chat
        // turn and criteria call — the queue-level form of "served traffic wins".
        purpose: 'shadow',
        // The SAME prompt the served evaluation would give this provider — a fair comparison, not a
        // different exam.
        systemPrompt: pis7PromptFor(provider),
        messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
        maxTokens: shadowMaxTokens(),
      });
      // Call 1 stamps the row — the same attribution the served evaluation uses — so a row stays
      // comparable with a single-call row whatever the mode.
      if (!first) {
        first = reply;
        row.model_version = modelVersion(reply.model);
        row.stop_reason = reply.stopReason ?? null;
        row.input_tokens = reply.inputTokens ?? null;
        row.output_tokens = reply.outputTokens ?? null;
      }
      return reply;
    };
    try {
      // Same validator and, when enabled, the same reconciliation rule as the served evaluation
      // (services/consistency.js) — but NEVER a re-ask (jsonRetries 0, see shadowConsistencyMode):
      // a garbage reply is recorded below as the failure it is, so the contract rate stays honest.
      const { scores, composite, rationale } = await scoreWithConsistency({
        callOnce, mode, jsonRetries: 0, agree: { maxSumDelta: shadowMaxSumDelta() },
      });
      Object.assign(row, pickDomains(scores), { composite_score: composite, domain_rationale: rationale });
    } catch (scoreErr) {
      if (!(scoreErr instanceof Pis7ScoreError || scoreErr?.name === 'Pis7ScoreError')) throw scoreErr;   // transport → below
      // A candidate model that cannot hold the JSON contract is the single most valuable thing this
      // table can record, so persist the FAILURE rather than dropping the row. Gate 4 needs the
      // denominator: "produced a valid score set 92% of the time" is a disqualifying result, and it
      // is invisible if failures are silently discarded.
      row.error = `${scoreErr.kind}: ${scoreErr.message}`;
    }
  } catch (err) {
    // A full background lane is load, not a verdict on the candidate: treat it exactly like the shed
    // above (no row). A `call_failed` row here would count the box being busy as a model failure —
    // in the pessimistic direction, but still a laundered failure rate.
    if (err?.code === 'queue_full') {
      console.warn(`[shadow] shed for PLE ${pleId} — ${provider} background queue is full; served traffic wins`);
      return { skipped: true, shed: true };
    }
    row.error = `call_failed: ${err?.message || String(err)}`;
  }
  row.latency_ms = Date.now() - startedAt;

  try {
    // Conflict target matches the table's unique(ple_id, provider, model_version): a re-run of the
    // SAME candidate replaces its earlier attempt (no double-counting in the paired corpus), while a
    // DIFFERENT candidate accumulates its own row instead of destroying the first one's data.
    const { error } = await supabase
      .from('shadow_evaluations')
      .upsert(row, { onConflict: 'ple_id,provider,model_version' });
    if (error) {
      console.error(`[shadow] persist failed for PLE ${pleId} (${provider}): ${error.message}`);
      return { persisted: false };
    }
  } catch (e) {
    console.error(`[shadow] persist threw for PLE ${pleId} (${provider}): ${e?.message || e}`);
    return { persisted: false };
  }
  return { persisted: true, provider, failed: !!row.error };
}

function pickDomains(scores) {
  return {
    d1: scores.d1, d2: scores.d2, d3: scores.d3, d4: scores.d4,
    d5: scores.d5, d6: scores.d6, d7: scores.d7,
  };
}

// The safe entry point for a route: never awaited, never able to reject into the request path.
function fireShadowEvaluation(args) {
  Promise.resolve()
    .then(() => runShadowEvaluation(args))
    .catch((e) => console.error(`[shadow] unexpected failure for PLE ${args?.pleId}: ${e?.message || e}`));
}

module.exports = { runShadowEvaluation, fireShadowEvaluation, shadowTarget, blankRow };
