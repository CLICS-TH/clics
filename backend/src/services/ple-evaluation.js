// PIS-7 evaluation persistence, shared by the physician /end flow and the admin approve flow.
const { supabase } = require('../lib/supabase');
const { compositeScore } = require('./cle-gate');
const { rimplEvaluate } = require('./rimpl-client');

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
  });
  if (aiErr) throw new Error(`ai_evaluations insert failed: ${aiErr.message}`);

  const { error: lpdpErr } = await supabase.from('lpdp_snapshots').insert({
    physician_id: physicianId, ple_id: pleId,
    composite_score: composite, domain_scores: domain,
  });
  if (lpdpErr) throw new Error(`lpdp_snapshots insert failed: ${lpdpErr.message}`);

  const { error: pleErr } = await supabase.from('ples').update({ status: 'evaluated' }).eq('id', pleId);
  if (pleErr) throw new Error(`ples status update failed: ${pleErr.message}`);
}

// The RIMPL evaluation is a network call to a Claude-backed service; a transient 5xx/timeout would
// otherwise silently strand a credit-eligible PLE at cle_pass with no score. Retry with backoff.
async function evaluateWithRetry(payload, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await rimplEvaluate(payload); }
    catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

// Run the PIS-7 evaluation for a passed PLE and persist it. Throws on failure (caller logs).
async function triggerEvaluation(pleId, transcript, physicianId) {
  const result = await evaluateWithRetry({ ple_id: pleId, transcript });
  await persistEvaluation(pleId, physicianId, result);
}

module.exports = { persistEvaluation, triggerEvaluation };
