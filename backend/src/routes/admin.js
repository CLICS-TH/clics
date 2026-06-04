const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { AssignSchema } = require('../lib/schemas');
const { rimplEvaluate } = require('../services/rimpl-client');
const { compositeScore } = require('../services/cle-gate');

const router = Router();
router.use(verifyJwt, requireRole('admin', 'superadmin'));

router.get('/ples', async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('ples').select('*, professionals!ples_physician_id_fkey(full_name_th, full_name_en, specialty)');
  if (status) query = query.eq('status', status);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/ples/flagged', async (req, res) => {
  const { data, error } = await supabase
    .from('ples')
    .select('*, professionals!ples_physician_id_fkey(full_name_th, full_name_en)')
    .eq('status', 'cle_flag_t2')
    .order('ended_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/ples/:id/approve', async (req, res) => {
  const { data: ple } = await supabase.from('ples').select('*').eq('id', req.params.id).single();
  if (!ple || ple.status !== 'cle_flag_t2') return res.status(400).json({ error: 'Not a flagged PLE' });

  await supabase.from('ples').update({ status: 'cle_pass' }).eq('id', req.params.id);

  const { data: messages } = await supabase
    .from('messages').select('role, content').eq('ple_id', req.params.id).order('created_at');
  const transcript = (messages ?? []).map(m => ({ role: m.role, content: m.content }));

  (async () => {
    try {
      const result = await rimplEvaluate({ ple_id: req.params.id, transcript });
      const composite = compositeScore(result);
      await supabase.from('ai_evaluations').insert({
        ple_id: req.params.id,
        d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4,
        d5: result.d5, d6: result.d6, d7: result.d7,
        composite_score: composite, domain_rationale: result.domain_rationale,
        model_version: result.model_version ?? 'CCME_LLM_v8.0',
      });
      await supabase.from('lpdp_snapshots').insert({
        physician_id: ple.physician_id, ple_id: req.params.id,
        composite_score: composite,
        domain_scores: { d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4, d5: result.d5, d6: result.d6, d7: result.d7 },
      });
      await supabase.from('ples').update({ status: 'evaluated' }).eq('id', req.params.id);
    } catch (e) { console.error('Evaluation failed:', e.message); }
  })();

  res.json({ ok: true });
});

router.post('/ples/:id/reject', async (req, res) => {
  const { error } = await supabase.from('ples')
    .update({ status: 'cle_fail_t1' }).eq('id', req.params.id).eq('status', 'cle_flag_t2');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/ples/:id/assign', async (req, res) => {
  const parsed = AssignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { error } = await supabase.from('ples')
    .update({ auditor_id: parsed.data.auditor_id })
    .eq('id', req.params.id)
    .eq('status', 'evaluated');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Read-only auditor list for the assignment dropdown — admins need this but
// GET /admin/users is superadmin-only, so expose just the auditors to admin+superadmin.
router.get('/auditors', async (req, res) => {
  const { data, error } = await supabase
    .from('professionals')
    .select('id, full_name_th, full_name_en')
    .eq('role', 'auditor')
    .order('full_name_th');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/stats', async (req, res) => {
  const { data: ples } = await supabase.from('ples').select('status');
  const total = ples?.length ?? 0;
  const counts = (ples ?? []).reduce((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});
  res.json({ total, ...counts });
});

module.exports = router;
