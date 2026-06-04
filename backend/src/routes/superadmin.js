const { Router } = require('express');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { computeICC21 } = require('../services/icc');

const router = Router();
router.use(verifyJwt, requireRole('superadmin'));

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['superadmin', 'admin', 'physician', 'auditor']),
  full_name_th: z.string().min(1),
  full_name_en: z.string().min(1),
  specialty: z.string().optional(),
  license_number: z.string().optional(),
});

router.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('professionals').select('*').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/users', async (req, res) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password, ...profile } = parsed.data;
  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (authErr) return res.status(400).json({ error: authErr.message });

  const { error: profErr } = await supabase.from('professionals').insert({ id: authUser.user.id, ...profile });
  if (profErr) {
    await supabase.auth.admin.deleteUser(authUser.user.id);
    return res.status(500).json({ error: profErr.message });
  }

  res.status(201).json({ id: authUser.user.id, email, ...profile });
});

router.get('/icc', async (req, res) => {
  const { data: auditScores } = await supabase
    .from('audit_scores').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7');
  const { data: aiScores } = await supabase
    .from('ai_evaluations').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7');

  if (!auditScores?.length) return res.json({ overall: null, per_domain: {} });

  const pairs = auditScores.flatMap(a => {
    const ai = aiScores?.find(s => s.ple_id === a.ple_id);
    return ai ? [{ ai: Number(ai.composite_score), human: Number(a.composite_score), auditDomains: a, aiDomains: ai }] : [];
  });

  const overall = computeICC21(pairs.map(p => ({ ai: p.ai, human: p.human })));

  const perDomain = {};
  for (const d of ['d1','d2','d3','d4','d5','d6','d7']) {
    perDomain[d] = computeICC21(pairs.map(p => ({
      ai: Number(p.aiDomains[d]),
      human: Number(p.auditDomains[d]),
    })));
  }

  res.json({ overall, per_domain: perDomain, n: pairs.length });
});

router.get('/lpdp/:physicianId', async (req, res) => {
  const { data, error } = await supabase
    .from('lpdp_snapshots').select('*')
    .eq('physician_id', req.params.physicianId)
    .order('snapshot_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
