const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { ScoreSchema } = require('../lib/schemas');
const { compositeScore } = require('../services/cle-gate');
const { computeICC21 } = require('../services/icc');

const router = Router();
router.use(verifyJwt, requireRole('auditor'));

router.get('/queue', async (req, res) => {
  const { data, error } = await supabase
    .from('ples')
    .select('id, status, ended_at, turn_count, token_count')
    .eq('auditor_id', req.user.id)
    .eq('status', 'evaluated')
    .order('ended_at');
  if (error) return res.status(500).json({ error: error.message });

  // Flag which assigned PLEs this auditor has ALREADY scored, so the queue can mark them and
  // surface the ones still to score (rather than locking the whole list as "already evaluated").
  const ids = (data ?? []).map(p => p.id);
  let scored = new Set();
  if (ids.length) {
    const { data: rows } = await supabase
      .from('audit_scores').select('ple_id').eq('auditor_id', req.user.id).in('ple_id', ids);
    scored = new Set((rows ?? []).map(r => r.ple_id));
  }
  res.json((data ?? []).map(p => ({ ...p, scored: scored.has(p.id) })));
});

router.get('/ples/:id', async (req, res) => {
  const { data: ple } = await supabase
    .from('ples').select('id, status, turn_count, token_count, ended_at')
    .eq('id', req.params.id).eq('auditor_id', req.user.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found or not assigned' });

  const { data: messages } = await supabase
    .from('messages').select('role, content, refs, socratic_question, created_at')
    .eq('ple_id', req.params.id).order('created_at');

  const { data: existing } = await supabase
    .from('audit_scores').select('*').eq('ple_id', req.params.id).eq('auditor_id', req.user.id).single();

  let aiEval = null;
  if (existing) {
    const { data } = await supabase
      .from('ai_evaluations').select('*').eq('ple_id', req.params.id).single();
    aiEval = data;
  }

  res.json({ ple, messages: messages ?? [], audit_score: existing ?? null, ai_evaluation: aiEval });
});

router.post('/ples/:id/score', async (req, res) => {
  const parsed = ScoreSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: existing } = await supabase
    .from('audit_scores').select('id').eq('ple_id', req.params.id).eq('auditor_id', req.user.id).single();
  if (existing) return res.status(409).json({ error: 'Already scored' });

  const { notes, ...scores } = parsed.data;
  const composite = compositeScore(scores);

  const { error } = await supabase.from('audit_scores').insert({
    ple_id: req.params.id, auditor_id: req.user.id,
    ...scores, composite_score: composite, notes,
  });
  if (error) return res.status(500).json({ error: error.message });

  res.json({ composite_score: composite });
});

router.get('/icc', async (req, res) => {
  const { data } = await supabase
    .from('audit_scores').select('ple_id, composite_score').eq('auditor_id', req.user.id);

  if (!data?.length) return res.json({ icc: null, n: 0 });

  const pleIds = data.map(s => s.ple_id);
  const { data: aiScores } = await supabase
    .from('ai_evaluations').select('ple_id, composite_score').in('ple_id', pleIds);

  const pairs = data.flatMap(audit => {
    const ai = aiScores?.find(a => a.ple_id === audit.ple_id);
    return ai ? [{ ai: Number(ai.composite_score), human: Number(audit.composite_score) }] : [];
  });

  const iccResult = computeICC21(pairs);
  res.json(iccResult ?? { icc: null, n: pairs.length });
});

module.exports = router;
