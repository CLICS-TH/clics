const { Router } = require('express');
const { z } = require('zod');
const { supabase, authSupabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { computeICC21 } = require('../services/icc');
const { sendDbError, pageParams } = require('../lib/db-helpers');
const { assertSlotAvailable, nextPseudonym, allSlotUsage, allCouncilSlotUsage, ROLES } = require('../lib/accounts');
const { normalizeCanAudit } = require('../lib/dual-role');
const { POSITIONS, checkSpecialty } = require('../lib/specialties');
const { logEvent } = require('../lib/audit');
const { decryptJson } = require('../lib/crypto');

const router = Router();
router.use(verifyJwt, requireRole('superadmin'));

// Superadmin is a locked singleton: it is bootstrapped directly (db/reset-demo.js / seed-users.js)
// and can never be created or assigned through the API, so it is intentionally absent from these enums.
// specialty + license_number are optional at every layer (DB nullable, here .optional(), no form `required`).
const GRANTABLE_ROLES = ['admin', 'physician', 'auditor', 'analyst', 'ethics'];
// Global oversight roles have no council (prof_council_required allows them null).
const GLOBAL_ROLES = ['analyst', 'ethics'];

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(GRANTABLE_ROLES),
  // "Special" = a physician who ALSO holds auditor rights (can_audit). Only meaningful with
  // role 'physician'; normalized server-side so it can never ride on an admin/auditor.
  can_audit: z.boolean().optional(),
  // Council-scoped roles need a council; analyst/ethics are global (council_id omitted).
  council_id: z.string().uuid().optional(),
  full_name_th: z.string().min(1),
  full_name_en: z.string().min(1),
  specialty: z.string().optional(),            // legacy free-text (dormant)
  specialty_id: z.string().uuid().optional(),  // structured specialty (under council)
  position: z.enum(POSITIONS).optional(),      // ตำแหน่ง ladder
  license_number: z.string().optional(),
}).refine((b) => GLOBAL_ROLES.includes(b.role) || !!b.council_id, {
  message: 'council_id is required for this role', path: ['council_id'],
});

const UpdateUserSchema = z.object({
  full_name_th: z.string().min(1).optional(),
  full_name_en: z.string().min(1).optional(),
  specialty: z.string().optional(),            // legacy free-text (dormant)
  specialty_id: z.string().uuid().optional(),  // structured specialty (under council)
  position: z.enum(POSITIONS).optional(),      // ตำแหน่ง ladder
  license_number: z.string().optional(),
  role: z.enum(GRANTABLE_ROLES).optional(),
  can_audit: z.boolean().optional(),          // "special" dual role: physician + auditor rights
  council_id: z.string().uuid().optional(),   // move a member to another council
  // Per-user AI usage limit override ($). null clears the override -> the standard default applies.
  // Bounded: the standard cap is $0.50 (~$0.012/turn), so a fat-fingered 500 (instead of 0.50) would
  // silently un-cap a user — reject it.
  usage_limit_usd: z.number().nonnegative().max(50).nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

const StatusSchema = z.object({ status: z.enum(['active', 'deactivated']) });
const SlotSchema = z.object({ capacity: z.number().int().min(0).max(100000) });
const UsageSettingsSchema = z.object({
  standard_limit_usd: z.number().nonnegative().max(50).optional(),       // per-user default; sanity ceiling
  api_budget_pool_usd: z.number().nonnegative().max(1_000_000).optional(), // org-wide pool; sanity ceiling
  // Pilot Test Mode: when ON, new CLEs are TEST sessions (is_test), the 3-CLE study cap is bypassed,
  // and the physician may pick Natural/Socratic directly — so the team can exercise the experiment.
  pilot_test_mode: z.boolean().optional(),
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

  // Specialty (the layer under council) is required for council-scoped roles when the council has
  // any; a provided specialty must belong to that council.
  const spec = await checkSpecialty(profile.role, profile.council_id, profile.specialty_id);
  if (!spec.ok) return res.status(400).json({ error: spec.error });

  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (authErr) return res.status(400).json({ error: authErr.message });

  const insert = { id: authUser.user.id, ...profile, status: 'active' };
  // "Special" (can_audit) applies ONLY to a physician — normalized in one place (lib/dual-role) so
  // create / invite / edit can never drift apart and let the flag ride on an admin/auditor.
  insert.can_audit = normalizeCanAudit(profile.role, parsed.data.can_audit);
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
  const effectiveRole = patch.role ?? current.role;
  const roleChanged = patch.role && patch.role !== current.role;
  const councilChanged = patch.council_id && patch.council_id !== current.council_id;

  // Normalize the dual-role flag against the EFFECTIVE role (post-edit) — one source of truth shared
  // with POST /users and the invite path (lib/dual-role) so "Special" can never ride on an admin/auditor.
  // Only touch it when the caller sent it OR is changing role, so an unrelated profile edit can't
  // silently flip an existing flag, while a demotion away from physician always clears it.
  if ('can_audit' in patch || roleChanged) {
    patch.can_audit = normalizeCanAudit(effectiveRole, patch.can_audit ?? current.can_audit);
  }

  // Slot-check whenever the member would occupy a NEW pool: a role change OR a council move. The
  // admin/auditor pools are PER-COUNCIL, so moving an active director into a full target council must
  // be blocked (a pure council move previously skipped this and could exceed the target's capacity).
  if ((roleChanged || councilChanged) && current.status === 'active') {
    const slot = await assertSlotAvailable(effectiveRole, targetCouncil);
    if (!slot.ok) return res.status(409).json({ error: slot.error });
  }
  // Validate specialty whenever it (or the role/council it depends on) changes. A move to a global
  // oversight role clears specialty/position (they no longer apply); a council-scoped role needs a
  // specialty belonging to its council.
  if (patch.specialty_id !== undefined || patch.position !== undefined || roleChanged || councilChanged) {
    if (roleChanged && !['admin', 'physician', 'auditor'].includes(effectiveRole)) {
      patch.specialty_id = null; patch.position = null;
    } else {
      const effectiveSpecialty = patch.specialty_id ?? current.specialty_id;
      const spec = await checkSpecialty(effectiveRole, targetCouncil, effectiveSpecialty);
      if (!spec.ok) return res.status(400).json({ error: spec.error });
    }
  }
  if (roleChanged && patch.role === 'physician' && !current.pseudonym) patch.pseudonym = await nextPseudonym();

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

// PURGE — hard-delete a user and ALL their data (IRB right-to-erasure / consent withdrawal).
// IRREVERSIBLE, and deliberately distinct from deactivate (which only flips status + KEEPS history).
// Guards: superadmin-only (router-level); the target must already be DEACTIVATED (a two-step so it
// can't be done by accident); NEVER the superadmin (it must stay indestructible — the
// `professionals_single_superadmin` index backs this regardless); and the caller must echo the
// user's full name (type-to-confirm). No DB transaction is available over the REST client, so every
// foreign-key reference is cleared in dependency order before the row is removed.
router.delete('/users/:id/purge', async (req, res) => {
  const id = req.params.id;
  const { data: prof } = await supabase.from('professionals')
    .select('id, role, status, full_name_en').eq('id', id).single();
  if (!prof) return res.status(404).json({ error: 'User not found' });
  if (prof.role === 'superadmin') return res.status(403).json({ error: 'The superadmin account cannot be purged.' });
  if (prof.status !== 'deactivated') return res.status(409).json({ error: 'Deactivate the user first, then purge.' });
  if ((req.body?.confirm_name || '') !== prof.full_name_en) {
    return res.status(400).json({ error: 'Confirmation name does not match.' });
  }

  // Right-to-erasure also covers the invite that onboarded them: invites.email is PII. PENDING invites
  // carry professional_id=NULL (set only on accept), so the professional_id-keyed delete below MISSES
  // them — they're erased ONLY by the email-keyed delete. So the email lookup is REQUIRED, not
  // best-effort: if it fails we must HALT (before any deletion, so a retry is clean) rather than skip
  // the email delete, sever the auth-user linkage, and orphan the address while reporting purged:true.
  let email = null;
  try {
    const { data: au, error: auErr } = await authSupabase.auth.admin.getUserById(id);
    if (auErr) {
      console.error('[purge] could not resolve auth email — purge halted:', auErr.message);
      return res.status(500).json({ error: 'Could not resolve the account email for full erasure — purge halted. Retry.' });
    }
    email = au?.user?.email ?? null; // a legitimately null email (no address on file) → no email PII to erase
  } catch (e) {
    console.error('[purge] getUserById threw — purge halted:', e.message);
    return res.status(500).json({ error: 'Could not resolve the account email for full erasure — purge halted. Retry.' });
  }

  // The user's OWN sessions: lpdp_snapshots has no cascade (clear first), then deleting the cles
  // cascades messages / ai_evaluations / audit_scores / cle_patient_refs by cle_id.
  const { data: ownCles } = await supabase.from('cles').select('id').eq('physician_id', id);
  const deletedCles = ownCles?.length ?? 0;

  // EVERY step is error-checked in dependency order: an unchecked failure makes a LATER step trip an
  // FK (misleading error) or — worse — leaves a partial purge that reports purged:true.
  const steps = [
    supabase.from('lpdp_snapshots').delete().eq('physician_id', id),
    supabase.from('cles').delete().eq('physician_id', id),
    // This user as an AUDITOR of OTHERS' sessions: un-assign + delete their authored scores.
    supabase.from('cles').update({ auditor_id: null }).eq('auditor_id', id),
    supabase.from('audit_scores').delete().eq('auditor_id', id),
    // Their access requests + reviews of others.
    supabase.from('access_requests').delete().eq('auth_user_id', id),
    supabase.from('access_requests').update({ reviewed_by: null }).eq('reviewed_by', id),
    // Invites they CREATED for others are about other people — keep the row, just unlink them.
    supabase.from('invites').update({ created_by: null }).eq('created_by', id),
    // Invites that are about THEM (accepted, or sent to their email) carry their PII — ERASE them.
    supabase.from('invites').delete().eq('professional_id', id),
  ];
  if (email) steps.push(supabase.from('invites').delete().eq('email', email));
  for (const step of steps) {
    const { error } = await step;
    if (sendDbError(res, error)) return;
  }

  // Delete the Supabase auth user FIRST — it holds the email PII, and professionals.id references
  // auth.users ON DELETE CASCADE, so this removes the professionals row (and its cascade children:
  // oauth_identities, cle_folders, cle_patient_refs) too. If it fails, STOP and report retryably —
  // never claim purged:true while the credential + email are still live.
  const { error: authErr } = await authSupabase.auth.admin.deleteUser(id);
  if (authErr) {
    console.error('[purge] auth user delete failed — purge halted:', authErr.message);
    return res.status(500).json({ error: 'Could not remove the account credential — purge halted. Retry.' });
  }
  // Defensive: ensure the professionals row is gone even if the cascade did not fire.
  const delProf = await supabase.from('professionals').delete().eq('id', id);
  if (sendDbError(res, delProf.error)) return;

  res.json({ purged: true, deleted_ples: deletedCles, auth_deleted: true });
});

// Role slot pools — used/capacity/remaining per role, and capacity editing.
router.get('/slots', async (_req, res) => {
  res.json(await allSlotUsage());
});

router.patch('/slots/:role', async (req, res) => {
  const { role } = req.params;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if (role === 'superadmin') return res.status(400).json({ error: 'Superadmin capacity is locked at 1.' });
  // admin/auditor capacity is ENFORCED per-council (council_slots); the global role_slots row is
  // display-only for them. Writing it here used to succeed and show "saved" while changing nothing
  // real (a superadmin who set Admin=0 still couldn't restrict admin creation) — reject loudly instead.
  if (role === 'admin' || role === 'auditor') {
    return res.status(400).json({ error: 'Admin/auditor capacity is per-council — set it via PATCH /admin/councils/:id/slots.' });
  }
  const parsed = SlotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data, error } = await supabase.from('role_slots')
    .update({ capacity: parsed.data.capacity, updated_at: new Date().toISOString() })
    .eq('role', role).select('*').single();
  if (sendDbError(res, error)) return;
  res.json(data);
});

// Per-council admin/auditor capacity — the pools assertSlotAvailable ACTUALLY enforces (the global
// role_slots above is display-only for admin/auditor, so editing it changed nothing real). physician
// is uncapped and superadmin is the global singleton, so neither is per-council.
const COUNCIL_SLOT_ROLES = ['admin', 'auditor'];

router.get('/councils/:id/slots', async (req, res) => {
  res.json(await allCouncilSlotUsage(req.params.id)); // [{ role, council_id, capacity, used, remaining }]
});

router.patch('/councils/:id/slots/:role', async (req, res) => {
  const { id, role } = req.params;
  if (!COUNCIL_SLOT_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Per-council capacity applies only to admin/auditor (physician is uncapped, superadmin is global).' });
  }
  const parsed = SlotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Upsert: a council added after the seed may not have a row yet.
  const { data, error } = await supabase.from('council_slots')
    .upsert({ council_id: id, role, capacity: parsed.data.capacity, updated_at: new Date().toISOString() },
            { onConflict: 'council_id,role' })
    .select('*').single();
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
  const pilot_test_mode = (await readSetting('pilot_test_mode', 0)) === 1;
  res.json({ standard_limit_usd, api_budget_pool_usd, total_used_usd, pilot_test_mode });
});

router.patch('/usage-settings', async (req, res) => {
  const parsed = UsageSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const now = new Date().toISOString();
  const upserts = [];
  if (parsed.data.standard_limit_usd != null) upserts.push({ key: 'standard_usage_limit_usd', value: parsed.data.standard_limit_usd, updated_at: now });
  if (parsed.data.api_budget_pool_usd != null) upserts.push({ key: 'api_budget_pool_usd', value: parsed.data.api_budget_pool_usd, updated_at: now });
  if (parsed.data.pilot_test_mode != null) upserts.push({ key: 'pilot_test_mode', value: parsed.data.pilot_test_mode ? 1 : 0, updated_at: now });
  const { error } = await supabase.from('app_settings').upsert(upserts);
  if (sendDbError(res, error)) return;
  if (parsed.data.pilot_test_mode != null) {
    logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'pilot_test_mode',
      metadata: { enabled: parsed.data.pilot_test_mode } });
  }
  const [standard_limit_usd, api_budget_pool_usd] = await Promise.all([
    readSetting('standard_usage_limit_usd', 0.5),
    readSetting('api_budget_pool_usd', 0),
  ]);
  const pilot_test_mode = (await readSetting('pilot_test_mode', 0)) === 1;
  res.json({ standard_limit_usd, api_budget_pool_usd, pilot_test_mode });
});

// Reset a member's running AI usage meter back to zero (manual-reset escape hatch).
router.post('/users/:id/reset-usage', async (req, res) => {
  const { data, error } = await supabase.from('professionals')
    .update({ usage_cost_usd: 0, usage_input_tokens: 0, usage_output_tokens: 0 })
    .eq('id', req.params.id).select('id, usage_cost_usd').maybeSingle();
  if (sendDbError(res, error)) return;              // a real DB/connectivity error is not "not found"
  if (!data) return res.status(404).json({ error: 'User not found' });
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

  // Bounded by SCORED sessions (audit_scores is small — few auditors), not all 400K cles.
  // audit_scores carries a denormalized council_id, so we only need is_test from the scored cles.
  const { data: auditScores } = await supabase
    .from('audit_scores').select('cle_id, council_id, composite_score, d1,d2,d3,d4,d5,d6,d7');
  if (!auditScores?.length) return res.json({ overall: null, per_domain: {}, per_council: {}, n: 0 });

  const scoredIds = [...new Set(auditScores.map(a => a.cle_id))];
  const { data: aiScores } = await supabase
    .from('ai_evaluations').select('cle_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('cle_id', scoredIds);
  const { data: cles } = await supabase.from('cles').select('id, is_test').in('id', scoredIds);
  const testOf = Object.fromEntries((cles ?? []).map(p => [p.id, p.is_test]));

  const aiBy = Object.fromEntries((aiScores ?? []).map(s => [s.cle_id, s]));
  const allPairs = [];
  for (const a of auditScores) {
    const ai = aiBy[a.cle_id];
    if (!ai) continue;
    if (!includeTest && testOf[a.cle_id]) continue;
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

// Audit trail (CLICS §9.4): newest-first, page-bounded. Read-only oversight view (the Tier-4
// 'ethics' role gets the same data via its own route in the dashboard; RLS allows both).
router.get('/audit-log', async (req, res) => {
  const { limit, offset } = pageParams(req, { def: 100, max: 500 });
  const { data, count, error } = await supabase
    .from('audit_log').select('*', { count: 'exact' })
    .order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (sendDbError(res, error)) return;
  res.setHeader('X-Total-Count', count ?? 0);
  res.json({ total: count ?? 0, limit, offset, events: data ?? [] });
});

// Tier-1 (PI / data custodian) re-identification: decrypt a CLE's reversible PII map so a [NAME-n] /
// [HN-n] token in the de-identified transcript can be traced back to its raw value for audit or
// regulatory inquiry. superadmin-only (the router gate) + EVERY access is audit-logged. The raw
// values live only in cle_pii_map (RLS deny-all, AES-256-GCM); they never enter the export or any
// other surface. This is the "crown jewel" — keep it gated and logged.
router.get('/cles/:id/pii-map', async (req, res) => {
  const { data: cle } = await supabase.from('cles')
    .select('id, cle_code, council_id').eq('id', req.params.id).maybeSingle();
  if (!cle) return res.status(404).json({ error: 'CLE not found' });

  const { data: row, error } = await supabase.from('cle_pii_map')
    .select('map_encrypted, entry_count').eq('cle_id', req.params.id).maybeSingle();
  if (sendDbError(res, error)) return;
  if (!row) return res.status(404).json({ error: 'No PII map for this CLE' });

  let entries;
  try {
    entries = decryptJson(row.map_encrypted);
  } catch (e) {
    console.error('[pii-map] decrypt failed:', e.message);
    return res.status(500).json({ error: 'Could not decrypt the PII map (key mismatch?)' });
  }

  // Audit the re-identification (the audit row itself carries only the CLE pseudonym + count, no PII).
  logEvent({
    actorId: req.user.id, actorRole: req.user.role, action: 'pii.reidentify',
    targetType: 'cle', targetId: cle.cle_code ?? req.params.id, councilId: cle.council_id ?? null,
    metadata: { entry_count: row.entry_count, reason: req.query.reason || null },
  });

  res.json({ cle_code: cle.cle_code ?? null, entry_count: row.entry_count, entries });
});

module.exports = router;
// Exposed for unit tests (superadmin absent from role enums; specialty/license optional).
module.exports.CreateUserSchema = CreateUserSchema;
module.exports.UpdateUserSchema = UpdateUserSchema;
