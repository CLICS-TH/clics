const { Router } = require('express');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { computeICC21 } = require('../services/icc');
const { sendDbError } = require('../lib/db-helpers');
const { assertSlotAvailable, nextPseudonym, allSlotUsage, ROLES } = require('../lib/accounts');

const router = Router();
router.use(verifyJwt, requireRole('superadmin'));

// Superadmin is a locked singleton: it is bootstrapped directly (db/reset-demo.js / seed-users.js)
// and can never be created or assigned through the API, so it is intentionally absent from these enums.
// specialty + license_number are optional at every layer (DB nullable, here .optional(), no form `required`).
const GRANTABLE_ROLES = ['admin', 'physician', 'auditor'];

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(GRANTABLE_ROLES),
  // Every non-superadmin belongs to exactly one council (enforced by prof_council_required).
  council_id: z.string().uuid(),
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
  role: z.enum(GRANTABLE_ROLES).optional(),
  can_audit: z.boolean().optional(),          // "special" dual role: physician + auditor rights
  council_id: z.string().uuid().optional(),   // move a member to another council
  // Per-user AI usage limit override ($). null clears the override -> the standard default applies.
  usage_limit_usd: z.number().nonnegative().nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

const StatusSchema = z.object({ status: z.enum(['active', 'deactivated']) });
const SlotSchema = z.object({ capacity: z.number().int().min(0) });
const UsageSettingsSchema = z.object({
  standard_limit_usd: z.number().nonnegative().optional(),
  api_budget_pool_usd: z.number().nonnegative().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No settings to update' });

// GET /users moved to routes/admin.js (mounted first on the same /admin prefix): it is now
// dual-role — council-scoped for admins, unscoped for superadmin. All user MUTATIONS stay here.

// Executive overview: active members grouped by council × role (powers /admin/overview).
router.get('/overview-counts', async (_req, res) => {
  const { data, error } = await supabase.rpc('council_member_counts');
  if (sendDbError(res, error)) return;
  res.json(data ?? []);
});

router.post('/users', async (req, res) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password, ...profile } = parsed.data;

  // Enforce the slot pool: physician uncapped, admin/auditor per-council.
  const slot = await assertSlotAvailable(profile.role, profile.council_id);
  if (!slot.ok) return res.status(409).json({ error: slot.error });

  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (authErr) return res.status(400).json({ error: authErr.message });

  const insert = { id: authUser.user.id, ...profile, status: 'active' };
  if (profile.role === 'physician') insert.pseudonym = await nextPseudonym();
  // Superadmin directly creating an auditor IS a trusted manual verification (the enforce_auditor_license
  // trigger blocks an active auditor that is still 'unverified').
  if (profile.role === 'auditor') { insert.license_status = 'manual_verified'; insert.license_verified_at = new Date().toISOString(); }

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

  // The superadmin role is immutable — it cannot be changed away, even by the superadmin itself
  // (target-based, so self-demotion is also blocked). Profile edits (name/specialty/license) are allowed.
  if (current.role === 'superadmin' && parsed.data.role && parsed.data.role !== 'superadmin') {
    return res.status(403).json({ error: 'The superadmin role is immutable and cannot be changed.' });
  }
  // The superadmin spans all councils — it must never be pinned to one.
  if (current.role === 'superadmin' && parsed.data.council_id !== undefined) {
    return res.status(403).json({ error: 'The superadmin is not scoped to a council.' });
  }

  const patch = { ...parsed.data };
  const targetCouncil = patch.council_id ?? current.council_id;

  if (patch.role && patch.role !== current.role) {
    if (current.status === 'active') {
      const slot = await assertSlotAvailable(patch.role, targetCouncil); // current user counts in their OLD pool
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
    .from('professionals').select('role, status, council_id').eq('id', req.params.id).single();
  if (curErr || !current) return res.status(404).json({ error: 'User not found' });

  // The superadmin can never be turned off OR back on — its status is locked (cannot be eliminated).
  if (current.role === 'superadmin') {
    return res.status(403).json({ error: 'The superadmin account status is locked and cannot be changed.' });
  }
  if (status === 'active' && current.status !== 'active') {
    // Reactivation re-consumes a slot — check the member's own (per-council for admin/auditor) pool.
    const slot = await assertSlotAvailable(current.role, current.council_id);
    if (!slot.ok) return res.status(409).json({ error: slot.error });
  }

  const { data, error } = await supabase
    .from('professionals').update({ status }).eq('id', req.params.id).select('*').single();
  if (sendDbError(res, error)) return;
  res.json(data);
});

// INVARIANT: there is intentionally NO DELETE /users/:id route — the superadmin must be
// indestructible. If a member-deletion route is ever added, it MUST refuse to delete a superadmin
// (and the DB index `professionals_single_superadmin` keeps the singleton guarantee regardless).

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

// AI usage settings (superadmin): the per-physician standard default + the org-wide API budget pool,
// plus the live total already spent across all members. Stored in app_settings; mirrors /slots.
async function readSetting(key, fallback) {
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).single();
  const v = Number(data?.value);
  return Number.isFinite(v) ? v : fallback;
}

router.get('/usage-settings', async (_req, res) => {
  const [standard_limit_usd, api_budget_pool_usd] = await Promise.all([
    readSetting('standard_usage_limit_usd', 0.5),
    readSetting('api_budget_pool_usd', 0),
  ]);
  // Total spent so far = SQL SUM (no whole-table load). Fall back to the JS reduce pre-migration.
  let total_used_usd;
  const { data: sum, error: sumErr } = await supabase.rpc('total_usage_sum');
  if (!sumErr && sum != null) {
    total_used_usd = Number(sum);
  } else {
    const { data: rows } = await supabase.from('professionals').select('usage_cost_usd');
    total_used_usd = (rows ?? []).reduce((acc, r) => acc + Number(r.usage_cost_usd ?? 0), 0);
  }
  res.json({ standard_limit_usd, api_budget_pool_usd, total_used_usd });
});

router.patch('/usage-settings', async (req, res) => {
  const parsed = UsageSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const now = new Date().toISOString();
  const upserts = [];
  if (parsed.data.standard_limit_usd != null) upserts.push({ key: 'standard_usage_limit_usd', value: parsed.data.standard_limit_usd, updated_at: now });
  if (parsed.data.api_budget_pool_usd != null) upserts.push({ key: 'api_budget_pool_usd', value: parsed.data.api_budget_pool_usd, updated_at: now });
  const { error } = await supabase.from('app_settings').upsert(upserts);
  if (sendDbError(res, error)) return;
  const [standard_limit_usd, api_budget_pool_usd] = await Promise.all([
    readSetting('standard_usage_limit_usd', 0.5),
    readSetting('api_budget_pool_usd', 0),
  ]);
  res.json({ standard_limit_usd, api_budget_pool_usd });
});

// Reset a member's running AI usage meter back to zero (manual-reset escape hatch).
router.post('/users/:id/reset-usage', async (req, res) => {
  const { data, error } = await supabase.from('professionals')
    .update({ usage_cost_usd: 0, usage_input_tokens: 0, usage_output_tokens: 0 })
    .eq('id', req.params.id).select('id, usage_cost_usd').single();
  if (error || !data) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

// ICC(2,1) calibration — overall + per-domain, AND a per-council breakdown so the superadmin
// can see each profession separately. Test sessions are excluded unless ?include_test=true.
const ICC_DOMAINS = ['d1','d2','d3','d4','d5','d6','d7'];
function iccBundle(pairs) {
  const overall = computeICC21(pairs.map(p => ({ ai: Number(p.ai.composite_score), human: Number(p.audit.composite_score) })));
  const per_domain = {};
  for (const d of ICC_DOMAINS) {
    per_domain[d] = computeICC21(pairs.map(p => ({ ai: Number(p.ai[d]), human: Number(p.audit[d]) })));
  }
  return { overall, per_domain, n: pairs.length };
}

router.get('/icc', async (req, res) => {
  const includeTest = req.query.include_test === 'true';

  // Bounded by SCORED sessions (audit_scores is small — few auditors), not all 400K ples.
  // audit_scores carries a denormalized council_id, so we only need is_test from the scored ples.
  const { data: auditScores } = await supabase
    .from('audit_scores').select('ple_id, council_id, composite_score, d1,d2,d3,d4,d5,d6,d7');
  if (!auditScores?.length) return res.json({ overall: null, per_domain: {}, per_council: {}, n: 0 });

  const scoredIds = [...new Set(auditScores.map(a => a.ple_id))];
  const { data: aiScores } = await supabase
    .from('ai_evaluations').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('ple_id', scoredIds);
  const { data: ples } = await supabase.from('ples').select('id, is_test').in('id', scoredIds);
  const testOf = Object.fromEntries((ples ?? []).map(p => [p.id, p.is_test]));

  const aiBy = Object.fromEntries((aiScores ?? []).map(s => [s.ple_id, s]));
  const allPairs = [];
  for (const a of auditScores) {
    const ai = aiBy[a.ple_id];
    if (!ai) continue;
    if (!includeTest && testOf[a.ple_id]) continue;
    allPairs.push({ council_id: a.council_id, ai, audit: a });
  }

  const global = iccBundle(allPairs);

  // Bucket by council and label each with its names.
  const byCouncil = {};
  for (const p of allPairs) (byCouncil[p.council_id] ??= []).push(p);
  const { data: councils } = await supabase.from('councils').select('id, code, name_th, name_en');
  const councilName = Object.fromEntries((councils ?? []).map(c => [c.id, c]));
  const per_council = {};
  for (const [cid, pairs] of Object.entries(byCouncil)) {
    per_council[cid] = { council: councilName[cid] ?? null, ...iccBundle(pairs) };
  }

  res.json({ overall: global.overall, per_domain: global.per_domain, per_council, n: global.n });
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
// Exposed for unit tests (superadmin absent from role enums; specialty/license optional).
module.exports.CreateUserSchema = CreateUserSchema;
module.exports.UpdateUserSchema = UpdateUserSchema;
