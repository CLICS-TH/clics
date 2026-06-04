const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { MessageSchema, CreatePleSchema } = require('../lib/schemas');
const { computeTier1, compositeScore } = require('../services/cle-gate');
const { rimplChat, rimplEvaluate, rimplEvaluateCriteria } = require('../services/rimpl-client');

const router = Router();
router.use(verifyJwt, requireRole('physician'));

// Create new PLE session
router.post('/', async (req, res) => {
  const parsed = CreatePleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data, error } = await supabase.from('ples').insert({
    physician_id: req.user.id,
    status: 'active',
    started_at: new Date().toISOString(),
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// List physician's own PLEs
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('ples')
    .select('id, status, started_at, ended_at, turn_count, token_count, c1_pass, c2_pass, c3_pass, c4_pass, c5_pass, c6_pass')
    .eq('physician_id', req.user.id)
    .order('started_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get single PLE with messages
router.get('/:id', async (req, res) => {
  const { data: ple, error } = await supabase
    .from('ples').select('*').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (error || !ple) return res.status(404).json({ error: 'Not found' });

  const { data: messages } = await supabase
    .from('messages').select('*').eq('ple_id', req.params.id).order('created_at');

  res.json({ ...ple, messages: messages ?? [] });
});

// Send a message turn
router.post('/:id/message', async (req, res) => {
  const parsed = MessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: ple } = await supabase
    .from('ples').select('*').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (!ple || ple.status !== 'active') return res.status(400).json({ error: 'PLE not active' });

  const { data: history } = await supabase
    .from('messages').select('role, content').eq('ple_id', req.params.id).order('created_at');

  const { message, language } = parsed.data;

  let rimplResponse;
  try {
    rimplResponse = await rimplChat({ ple_id: req.params.id, history: history ?? [], message, language });
  } catch (err) {
    return res.status(502).json({ error: `RIMPL unavailable: ${err.message}` });
  }

  const physicianTokens = Math.ceil(message.length / 4);

  await supabase.from('messages').insert({
    ple_id: req.params.id, role: 'physician',
    content: message, token_count: physicianTokens,
  });

  await supabase.from('messages').insert({
    ple_id: req.params.id, role: 'assistant',
    content: rimplResponse.content,
    references: rimplResponse.references,
    socratic_question: rimplResponse.socratic_question,
    token_count: rimplResponse.token_count,
  });

  await supabase.from('ples').update({
    turn_count: (ple.turn_count ?? 0) + 1,
    token_count: (ple.token_count ?? 0) + (rimplResponse.token_count ?? 0) + physicianTokens,
  }).eq('id', req.params.id);

  res.json(rimplResponse);
});

// End session and run CLE quality gate
router.post('/:id/end', async (req, res) => {
  const { data: ple } = await supabase
    .from('ples').select('*').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (!ple || ple.status !== 'active') return res.status(400).json({ error: 'PLE not active' });

  const endedAt = new Date();
  const durationSeconds = Math.floor((endedAt - new Date(ple.started_at)) / 1000);
  const updatedPle = { ...ple, duration_seconds: durationSeconds };

  const tier1 = computeTier1(updatedPle);

  if (!tier1.c1 || !tier1.c2 || !tier1.c3) {
    await supabase.from('ples').update({
      status: 'cle_fail_t1', ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds, ...tier1,
    }).eq('id', req.params.id);
    return res.json({ status: 'cle_fail_t1', criteria: tier1 });
  }

  const { data: messages } = await supabase
    .from('messages').select('role, content').eq('ple_id', req.params.id).order('created_at');
  const transcript = (messages ?? []).map(m => ({ role: m.role, content: m.content }));

  let tier2 = { c4: false, c5: false, c6: false };
  try {
    tier2 = await rimplEvaluateCriteria({ transcript });
  } catch {
    // RIMPL down — flag for manual QA
  }

  const allCriteria = { ...tier1, ...tier2 };
  const tier2Pass = tier2.c4 && tier2.c5 && tier2.c6;

  if (!tier2Pass) {
    await supabase.from('ples').update({
      status: 'cle_flag_t2', ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds, ...allCriteria,
    }).eq('id', req.params.id);
    return res.json({ status: 'cle_flag_t2', criteria: allCriteria });
  }

  await supabase.from('ples').update({
    status: 'cle_pass', ended_at: endedAt.toISOString(),
    duration_seconds: durationSeconds, ...allCriteria,
  }).eq('id', req.params.id);

  // Fire-and-forget evaluation
  triggerEvaluation(req.params.id, transcript, ple.physician_id).catch(console.error);

  res.json({ status: 'cle_pass', criteria: allCriteria });
});

async function triggerEvaluation(pleId, transcript, physicianId) {
  const result = await rimplEvaluate({ ple_id: pleId, transcript });
  const composite = compositeScore(result);

  await supabase.from('ai_evaluations').insert({
    ple_id: pleId,
    d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4,
    d5: result.d5, d6: result.d6, d7: result.d7,
    composite_score: composite,
    domain_rationale: result.domain_rationale,
    model_version: result.model_version ?? 'CCME_LLM_v8.0',
  });

  await supabase.from('lpdp_snapshots').insert({
    physician_id: physicianId, ple_id: pleId,
    composite_score: composite,
    domain_scores: { d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4, d5: result.d5, d6: result.d6, d7: result.d7 },
  });

  await supabase.from('ples').update({ status: 'evaluated' }).eq('id', pleId);
}

// Get AI evaluation result
router.get('/:id/evaluation', async (req, res) => {
  const { data: ple } = await supabase
    .from('ples').select('status').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (ple.status !== 'evaluated') return res.status(202).json({ status: ple.status });

  const { data: eval_ } = await supabase
    .from('ai_evaluations').select('*').eq('ple_id', req.params.id).single();
  res.json(eval_);
});

module.exports = router;
