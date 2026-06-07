const { Router } = require('express');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { computeICC21 } = require('../services/icc');
const { sendDbError } = require('../lib/db-helpers');
const { assertSlotAvailable, nextPseudonym, allSlotUsage, ROLES } = require('../lib/accounts');

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

const UpdateUserSchema = z.object({
  full_name_th: z.string().min(1).optional(),
  full_name_en: z.string().min(1).optional(),
  specialty: z.string().optional(),
  license_number: z.string().optional(),
  role: z.enum(['superadmin', 'admin', 'physician', 'auditor']).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

const StatusSchema = z.object({ status: z.enum(['active', 'deactivated']) });
const SlotSchema = z.object({ capacity: z.number().int().min(0) });

router.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('professionals').select('*').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/users', async (req, res) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password, ...profile } = parsed.data;

  // Enforce the role slot pool (superadmin pool is 1 → a 2nd superadmin is rejected here).
  const slot = await assertSlotAvailable(profile.role);
  if (!slot.ok) return res.status(409).json({ error: slot.error });

  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (authErr) return res.status(400).json({ error: authErr.message });

  const insert = { id: authUser.user.id, ...profile, status: 'active' };
  if (profile.role === 'physician') insert.pseudonym = await nextPseudonym();

  const { error: profErr } = await supabase.from('professionals').insert(insert);
  if (profErr) {
    await supabase.auth.admin.deleteUser(authUser.user.id);
    return res.status(500).json({ error: profErr.message });
  }

  res.status(201).json({ id: authUser.user.id, email, ...insert });
});

// Edit a member's profile / role. A role change into a different (active) pool is slot-checked.
router.patch('/users/:id', async (req, res) => {
  const parsed = UpdateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: current, error: curErr } = await supabase
    .from('professionals').select('*').eq('id', req.params.id).single();
  if (curErr || !current) return res.status(404).json({ error: 'User not found' });

  const patch = { ...parsed.data };

  if (patch.role && patch.role !== current.role) {
    if (current.status === 'active') {
      const slot = await assertSlotAvailable(patch.role); // current user counts in their OLD pool
      if (!slot.ok) return res.status(409).json({ error: slot.error });
    }
    if (patch.role === 'physician' && !current.pseudonym) patch.pseudonym = await nextPseudonym();
  }

  const { data, error } = await supabase
    .from('professionals').update(patch).eq('id', req.params.id).select('*').single();
  if (sendDbError(res, error)) return;
  res.json(data);
});

// Deactivate / reactivate a member. Deactivated members free their slot; reactivating needs one.
router.patch('/users/:id/status', async (req, res) => {
  const parsed = StatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { status } = parsed.data;

  const { data: current, error: curErr } = await supabase
    .from('professionals').select('role, status').eq('id', req.params.id).single();
  if (curErr || !current) return res.status(404).json({ error: 'User not found' });

  if (status === 'deactivated' && current.role === 'superadmin') {
    return res.status(400).json({ error: 'Cannot deactivate the superadmin account.' });
  }
  if (status === 'active' && current.status !== 'active') {
    const slot = await assertSlotAvailable(current.role);
    if (!slot.ok) return res.status(409).json({ error: slot.error });
  }

  const { data, error } = await supabase
    .from('professionals').update({ status }).eq('id', req.params.id).select('*').single();
  if (sendDbError(res, error)) return;
  res.json(data);
});

// Role slot pools — used/capacity/remaining per role, and capacity editing.
router.get('/slots', async (_req, res) => {
  res.json(await allSlotUsage());
});

router.patch('/slots/:role', async (req, res) => {
  const { role } = req.params;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if (role === 'superadmin') return res.status(400).json({ error: 'Superadmin capacity is locked at 1.' });
  const parsed = SlotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data, error } = await supabase.from('role_slots')
    .update({ capacity: parsed.data.capacity, updated_at: new Date().toISOString() })
    .eq('role', role).select('*').single();
  if (sendDbError(res, error)) return;
  res.json(data);
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
