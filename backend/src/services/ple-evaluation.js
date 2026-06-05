// PIS-7 evaluation persistence, shared by the physician /end flow and the admin approve flow.
const { supabase } = require('../lib/supabase');
const { compositeScore } = require('./cle-gate');
const { rimplEvaluate } = require('./rimpl-client');

// Persist an AI evaluation + LPDP snapshot and mark the PLE evaluated.
async function persistEvaluation(pleId, physicianId, result) {
  const composite = compositeScore(result);
  const domain = {
    d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4,
    d5: result.d5, d6: result.d6, d7: result.d7,
  };
  await supabase.from('ai_evaluations').insert({
    ple_id: pleId, ...domain,
    composite_score: composite,
    domain_rationale: result.domain_rationale,
    model_version: result.model_version ?? 'CCME_LLM_v8.0',
  });
  await supabase.from('lpdp_snapshots').insert({
    physician_id: physicianId, ple_id: pleId,
    composite_score: composite, domain_scores: domain,
  });
  await supabase.from('ples').update({ status: 'evaluated' }).eq('id', pleId);
}

// Run the PIS-7 evaluation for a passed PLE and persist it. Throws on failure (caller logs).
async function triggerEvaluation(pleId, transcript, physicianId) {
  const result = await rimplEvaluate({ ple_id: pleId, transcript });
  await persistEvaluation(pleId, physicianId, result);
}

module.exports = { persistEvaluation, triggerEvaluation };
