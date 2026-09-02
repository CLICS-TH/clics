const { Router } = require('express');
const { z } = require('zod');
const { invalidateScope } = require('../lib/eval-scope');
const { supabase, authSupabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { computeICC21, iccOneWay, iccTwoWayAverage } = require('../services/icc');
const { weightedKappaByDomain } = require('../services/kappa');
const { sendDbError, pageParams, toCsv } = require('../lib/db-helpers');
const { compRateCap, cappedPles } = require('../lib/compensation');
const { COMPLETED_STATUSES } = require('../lib/ple-status');
const { assertSlotAvailable, nextPseudonym, allSlotUsage, allCouncilSlotUsage, allCouncilsSlotUsage, ROLES } = require('../lib/accounts');
const { normalizeCanAudit } = require('../lib/dual-role');
const { POSITIONS, checkSpecialty } = require('../lib/specialties');
const { logEvent } = require('../lib/audit');
const retention = require('../services/retention');
const { decryptJson } = require('../lib/crypto');
const { probeRimplProvider, probeRimplDeep } = require('../services/rimpl-client');
const { decisiveVerdict } = require('../services/agreement');
const { getTextSetting, minAuditorsPerPle } = require('../lib/settings');

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
  // Per-user AUDITOR-pool limit override ($) — same bounds/semantics as usage_limit_usd, but on the
  // separate auditor budget (so a dual-role user's two pools are configured independently).
  auditor_usage_limit_usd: z.number().nonnegative().max(50).nullable().optional(),
  // Per-user TOKEN ceiling overrides (the local model is $0, so tokens are the unit that throttles).
  // null clears the override → the org standard applies; 0 = no token cap for this user. Bounded at
  // 50M so a mistyped value cannot silently un-cap someone.
  usage_limit_tokens: z.number().int().nonnegative().max(50_000_000).nullable().optional(),
  auditor_usage_limit_tokens: z.number().int().nonnegative().max(50_000_000).nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

const StatusSchema = z.object({ status: z.enum(['active', 'deactivated']) });
const SlotSchema = z.object({ capacity: z.number().int().min(0).max(100000) });
const UsageSettingsSchema = z.object({
  standard_limit_usd: z.number().nonnegative().max(50).optional(),       // physician per-user default; sanity ceiling
  auditor_standard_limit_usd: z.number().nonnegative().max(50).optional(), // auditor-pool per-user default
  api_budget_pool_usd: z.number().nonnegative().max(1_000_000).optional(), // org-wide pool; sanity ceiling
  // Pilot Test Mode: when ON, new PLEs are TEST sessions (is_test), the 3-PLE study cap is bypassed,
  // and the physician may pick Natural/Socratic directly — so the team can exercise the experiment.
  pilot_test_mode: z.boolean().optional(),
  // Clinical Artifacts: when ON, the AI may emit `:::artifact{...}` side-panel blocks (DDx tables, care
  // plans, …). A research-stimulus change — default OFF, enabled deliberately by a superadmin.
  clinical_artifacts_enabled: z.boolean().optional(),
  // Peer Calibration: when ON, a PLE may be assigned to several auditors and the reveal pane shows a
  // you-vs-auditor-average radar (alongside vs-AI). Default OFF (single-auditor blind audit).
  peer_calibration_enabled: z.boolean().optional(),
  // Hold Result Until Audited: when ON, a physician's PIS-7 score is withheld ("under expert review")
  // until an auditor has scored that PLE — for a blinded test round. Default OFF.
  hold_result_until_audited: z.boolean().optional(),
  // Compensation (CLICS §12): ฿/completed-PLE rate and the per-physician cap in PLEs (0 = no cap).
  // Minimum auditors per PLE. WARNS, never blocks — see lib/settings.minAuditorsPerPle. Capped at
  // 10 so a typo cannot badge the entire queue red.
  min_auditors_per_cle: z.number().int().min(1).max(10).optional(),
  comp_rate_thb: z.number().nonnegative().max(1_000_000).optional(),
  comp_cap_cles: z.number().int().nonnegative().max(10_000).optional(),
  // ---- Local AI capacity (docs/GATE0-DGX-RESULTS.md §7) ----
  // Token ceilings per user (0 = none). Placeholders until the capacity report sets them.
  standard_limit_tokens: z.number().int().nonnegative().max(50_000_000).optional(),
  auditor_standard_limit_tokens: z.number().int().nonnegative().max(50_000_000).optional(),
  // Transcript cap in context tokens + the % at which the portal warns. Floor 8000 so a typo cannot
  // make every session un-endable after two turns; ceiling 200k, above any served context.
  ple_max_transcript_tokens: z.number().int().min(8000).max(200_000).optional(),
  ple_transcript_warn_pct: z.number().int().min(50).max(95).optional(),
  // Evaluation drain: in-flight evaluations from this backend, and the p50 used for the queue ETA.
  eval_drain_concurrency: z.number().int().min(1).max(8).optional(),
  eval_p50_seconds: z.number().int().min(10).max(1800).optional(),
  // Council CODES (comma-separated) whose queued evaluations this backend must leave alone — set to
  // SANDBOX while a laptop stack scores that council on the local model. Empty string clears.
  eval_drain_exclude_councils: z.string().max(200).regex(/^[A-Za-z0-9_,\s-]*$/).optional(),
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

  // The user's OWN sessions: lpdp_snapshots has no cascade (clear first), then deleting the ples
  // cascades messages / ai_evaluations / audit_scores / ple_patient_refs by ple_id.
  const { data: ownPles } = await supabase.from('ples').select('id').eq('physician_id', id);
  const deletedPles = ownPles?.length ?? 0;

  // EVERY step is error-checked in dependency order: an unchecked failure makes a LATER step trip an
  // FK (misleading error) or — worse — leaves a partial purge that reports purged:true.
  const steps = [
    supabase.from('lpdp_snapshots').delete().eq('physician_id', id),
    supabase.from('ples').delete().eq('physician_id', id),
    // This user as an AUDITOR of OTHERS' sessions: un-assign + delete their authored scores.
    supabase.from('ples').update({ auditor_id: null }).eq('auditor_id', id),
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
  // oauth_identities, ple_folders, ple_patient_refs) too. If it fails, STOP and report retryably —
  // never claim purged:true while the credential + email are still live.
  const { error: authErr } = await authSupabase.auth.admin.deleteUser(id);
  if (authErr) {
    console.error('[purge] auth user delete failed — purge halted:', authErr.message);
    return res.status(500).json({ error: 'Could not remove the account credential — purge halted. Retry.' });
  }
  // Defensive: ensure the professionals row is gone even if the cascade did not fire.
  const delProf = await supabase.from('professionals').delete().eq('id', id);
  if (sendDbError(res, delProf.error)) return;

  res.json({ purged: true, deleted_ples: deletedPles, auth_deleted: true });
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

// Admin/auditor usage across EVERY council at once — the "active per council" breakdown table.
// [{ council_id, code, name_th, name_en, slots: [{ role, capacity, used, remaining }, ...] }]
router.get('/council-slots', async (_req, res) => {
  res.json(await allCouncilsSlotUsage());
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

// Total spent so far for a pool = SQL SUM (no whole-table load). Fall back to a JS reduce pre-migration.
async function poolTotal(sumRpc, col) {
  const { data: sum, error } = await supabase.rpc(sumRpc);
  if (!error && sum != null) return Number(sum);
  const { data: rows } = await supabase.from('professionals').select(col);
  return (rows ?? []).reduce((acc, r) => acc + Number(r[col] ?? 0), 0);
}

// What the Socratic rescue's per-round classifier has cost, across every episode.
//
// It is deliberately NOT a per-user pool like the two above, and that is a considered departure from
// the ticket, which asked for one "following the precedent already set for auditor AI usage". Those
// pools are CAPS: they block when exhausted. The rescue is initiated by the system, to make a
// session conform to the protocol — a budget that could switch that off would silently stop the
// conformance behaviour, and it would charge the intervention to the person it was performed on.
// So the spend is accrued per episode (ples.rescue_assessment_cost_usd) and reported here, which is
// the half of the requirement that actually protects anyone.
//
// Summed in JS rather than by an RPC: pilot scale is a few hundred rows, and adding a database
// function for a number shown on one screen is not worth the migration.
async function rescueSpendTotal() {
  const { data: rows, error } = await supabase.from('ples').select('rescue_assessment_cost_usd');
  if (error) return null;                                  // a read failure is not a total of zero
  return (rows ?? []).reduce((acc, r) => acc + Number(r.rescue_assessment_cost_usd ?? 0), 0);
}

router.get('/usage-settings', async (_req, res) => {
  // All independent reads in one batch (was several sequential awaits on the same table).
  const [standard_limit_usd, auditor_standard_limit_usd, api_budget_pool_usd, pilot, artifacts, peer, hold, comp_rate_thb, comp_cap_cles, min_auditors_per_cle, total_used_usd, auditor_total_used_usd, rescue_total_used_usd,
    standard_limit_tokens, auditor_standard_limit_tokens, ple_max_transcript_tokens, ple_transcript_warn_pct, eval_drain_concurrency, eval_p50_seconds, eval_drain_exclude_councils] = await Promise.all([
    readSetting('standard_usage_limit_usd', 0.5),
    readSetting('auditor_standard_usage_limit_usd', 0.5),
    readSetting('api_budget_pool_usd', 0),
    readSetting('pilot_test_mode', 0),
    readSetting('clinical_artifacts', 0),
    readSetting('peer_calibration', 0),
    readSetting('hold_result_until_audited', 0),
    readSetting('comp_rate_thb', 500),
    readSetting('comp_cap_cles', 3),
    readSetting('min_auditors_per_cle', 1),
    poolTotal('total_usage_sum', 'usage_cost_usd'),
    poolTotal('total_auditor_usage_sum', 'auditor_usage_cost_usd'),
    rescueSpendTotal(),
    readSetting('standard_usage_limit_tokens', 0),
    readSetting('auditor_standard_usage_limit_tokens', 0),
    readSetting('ple_max_transcript_tokens', 64000),
    readSetting('ple_transcript_warn_pct', 80),
    readSetting('eval_drain_concurrency', 1),
    readSetting('eval_p50_seconds', 90),
    getTextSetting('eval_drain_exclude_councils', ''),
  ]);
  res.json({ standard_limit_usd, auditor_standard_limit_usd, api_budget_pool_usd, total_used_usd, auditor_total_used_usd, rescue_total_used_usd, pilot_test_mode: pilot === 1, clinical_artifacts_enabled: artifacts === 1, peer_calibration_enabled: peer === 1, hold_result_until_audited: hold === 1, comp_rate_thb, comp_cap_cles, min_auditors_per_cle,
    standard_limit_tokens, auditor_standard_limit_tokens, ple_max_transcript_tokens, ple_transcript_warn_pct, eval_drain_concurrency, eval_p50_seconds, eval_drain_exclude_councils });
});

router.patch('/usage-settings', async (req, res) => {
  const parsed = UsageSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const now = new Date().toISOString();
  const upserts = [];
  if (parsed.data.standard_limit_usd != null) upserts.push({ key: 'standard_usage_limit_usd', value: parsed.data.standard_limit_usd, updated_at: now });
  if (parsed.data.auditor_standard_limit_usd != null) upserts.push({ key: 'auditor_standard_usage_limit_usd', value: parsed.data.auditor_standard_limit_usd, updated_at: now });
  if (parsed.data.api_budget_pool_usd != null) upserts.push({ key: 'api_budget_pool_usd', value: parsed.data.api_budget_pool_usd, updated_at: now });
  if (parsed.data.pilot_test_mode != null) upserts.push({ key: 'pilot_test_mode', value: parsed.data.pilot_test_mode ? 1 : 0, updated_at: now });
  if (parsed.data.clinical_artifacts_enabled != null) upserts.push({ key: 'clinical_artifacts', value: parsed.data.clinical_artifacts_enabled ? 1 : 0, updated_at: now });
  if (parsed.data.peer_calibration_enabled != null) upserts.push({ key: 'peer_calibration', value: parsed.data.peer_calibration_enabled ? 1 : 0, updated_at: now });
  if (parsed.data.hold_result_until_audited != null) upserts.push({ key: 'hold_result_until_audited', value: parsed.data.hold_result_until_audited ? 1 : 0, updated_at: now });
  if (parsed.data.comp_rate_thb != null) upserts.push({ key: 'comp_rate_thb', value: parsed.data.comp_rate_thb, updated_at: now });
  if (parsed.data.comp_cap_cles != null) upserts.push({ key: 'comp_cap_cles', value: parsed.data.comp_cap_cles, updated_at: now });
  if (parsed.data.min_auditors_per_cle != null) upserts.push({ key: 'min_auditors_per_cle', value: parsed.data.min_auditors_per_cle, updated_at: now });
  for (const [field, key] of [['standard_limit_tokens', 'standard_usage_limit_tokens'], ['auditor_standard_limit_tokens', 'auditor_standard_usage_limit_tokens'],
    ['ple_max_transcript_tokens', 'ple_max_transcript_tokens'], ['ple_transcript_warn_pct', 'ple_transcript_warn_pct'],
    ['eval_drain_concurrency', 'eval_drain_concurrency'], ['eval_p50_seconds', 'eval_p50_seconds']]) {
    if (parsed.data[field] != null) upserts.push({ key, value: parsed.data[field], updated_at: now });
  }
  if (parsed.data.eval_drain_exclude_councils != null) {
    // Text-valued (council codes). Normalised to upper-case codes; the numeric column is a placeholder.
    // Every code must name a real council: lib/eval-scope.js fails CLOSED on an unknown code (the drain
    // then claims nothing at all), so a typo saved here would silently stop every evaluation.
    const list = [...new Set(parsed.data.eval_drain_exclude_councils.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean))];
    if (list.length) {
      const { data: rows, error: cErr } = await supabase.from('councils').select('code').in('code', list);
      if (cErr) return res.status(502).json({ error: 'Could not verify council codes — try again' });
      const known = new Set((rows ?? []).map((r) => String(r.code).toUpperCase()));
      const unknown = list.filter((c) => !known.has(c));
      if (unknown.length) return res.status(400).json({ error: `Unknown council code(s): ${unknown.join(', ')}`, unknown });
    }
    upserts.push({ key: 'eval_drain_exclude_councils', value: 0, value_text: list.join(',') || null, updated_at: now });
  }
  const { error } = await supabase.from('app_settings').upsert(upserts);
  if (sendDbError(res, error)) return;
  if (parsed.data.eval_drain_exclude_councils != null) {
    invalidateScope(); // the drain and the reconcile sweep re-read the partition on their next tick
    logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'eval_drain_exclude_councils',
      metadata: { codes: parsed.data.eval_drain_exclude_councils } });
  }
  if (parsed.data.pilot_test_mode != null) {
    logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'pilot_test_mode',
      metadata: { enabled: parsed.data.pilot_test_mode } });
  }
  if (parsed.data.clinical_artifacts_enabled != null) {
    logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'clinical_artifacts',
      metadata: { enabled: parsed.data.clinical_artifacts_enabled } });
  }
  if (parsed.data.peer_calibration_enabled != null) {
    logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'peer_calibration',
      metadata: { enabled: parsed.data.peer_calibration_enabled } });
  }
  if (parsed.data.hold_result_until_audited != null) {
    logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'hold_result_until_audited',
      metadata: { enabled: parsed.data.hold_result_until_audited } });
  }
  if (parsed.data.min_auditors_per_cle != null) {
    // Logged because it changes what every subsequent ICC cohort report calls "at target".
    logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'min_auditors_per_cle',
      metadata: { value: parsed.data.min_auditors_per_cle } });
  }
  const [standard_limit_usd, auditor_standard_limit_usd, api_budget_pool_usd, pilot, artifacts, peer, hold, comp_rate_thb, comp_cap_cles, min_auditors_per_cle] = await Promise.all([
    readSetting('standard_usage_limit_usd', 0.5),
    readSetting('auditor_standard_usage_limit_usd', 0.5),
    readSetting('api_budget_pool_usd', 0),
    readSetting('pilot_test_mode', 0),
    readSetting('clinical_artifacts', 0),
    readSetting('peer_calibration', 0),
    readSetting('hold_result_until_audited', 0),
    readSetting('comp_rate_thb', 500),
    readSetting('comp_cap_cles', 3),
    readSetting('min_auditors_per_cle', 1),
  ]);
  res.json({ standard_limit_usd, auditor_standard_limit_usd, api_budget_pool_usd, pilot_test_mode: pilot === 1, clinical_artifacts_enabled: artifacts === 1, peer_calibration_enabled: peer === 1, hold_result_until_audited: hold === 1, comp_rate_thb, comp_cap_cles, min_auditors_per_cle });
});

// ---------------------------------------------------------------------------------------------
// AI provider switch — which model serves each purpose (Claude cloud ↔ the on-prem DGX).
//
// Deliberately its OWN endpoint rather than more keys on /usage-settings. That handler upserts nine
// settings in one array; a change this one must be able to REFUSE (the evaluator lock) cannot share
// a bulk write with settings that should still apply. Separating them also keeps the typed
// confirmation and the audit entry attached to the thing they are actually about.
//
// The values are read by RIMPL (services/provider-settings.js), which layers them OVER its env:
//   app_settings.ai_provider_<purpose> → AI_PROVIDER_<PURPOSE> → AI_PROVIDER → 'anthropic'
const AI_PURPOSES = ['chat', 'evaluate', 'criteria', 'discuss', 'embed'];
// Embeddings are a different market from chat: Anthropic has no embeddings API and Claude cannot
// serve `embed`, so the valid answers differ per purpose. Offering a provider that would throw on
// first use is not a switch, it is a trap.
const AI_PROVIDER_CHOICES = {
  chat: ['anthropic', 'local'],
  evaluate: ['anthropic', 'local'],
  criteria: ['anthropic', 'local'],
  discuss: ['anthropic', 'local'],
  embed: ['openai', 'local'],
};
const AI_PROVIDER_DEFAULT = { chat: 'anthropic', evaluate: 'anthropic', criteria: 'anthropic', discuss: 'anthropic', embed: 'openai' };

// Typed confirmations. Not theatre: `evaluate` is the measuring instrument the whole credit gate
// (ICC >= 0.75) is defined against, and unlocking it mid-pilot breaks the §10.2 locked-configuration
// guarantee. A checkbox is too easy to hit on the way to something else.
const CONFIRM_EVALUATOR = 'CHANGE EVALUATOR';
const CONFIRM_UNLOCK = 'UNLOCK EVALUATOR';
// Overrides the readiness gate below. Its OWN field rather than another value for `confirm`, because
// the two refusals can fire on the same request: switching `evaluate` to an unfit provider needs
// CHANGE EVALUATOR *and* this. Sharing one field would make that switch impossible to express.
const CONFIRM_UNFIT = 'SWITCH ANYWAY';
// Re-declaring after a lock is already in force. The change-control rule permits it only for a
// critical safety or security reason, and only if scoring stops and the data either side is
// separated — so it must not be reachable by pressing the same button twice.
const CONFIRM_RELOCK = 'REPLACE THE LOCK';

const AiProviderSchema = z.object({
  purpose: z.enum(AI_PURPOSES).optional(),
  provider: z.string().min(1).optional(),
  evaluator_locked: z.boolean().optional(),
  confirm: z.string().optional(),
  confirm_unfit: z.string().optional(),
}).refine(
  (b) => (b.purpose != null && b.provider != null) || b.evaluator_locked != null,
  { message: 'send either {purpose, provider} or {evaluator_locked}' },
);

async function readAiProviders() {
  const [providers, locked] = await Promise.all([
    Promise.all(AI_PURPOSES.map(async (p) => [p, await getTextSetting(`ai_provider_${p}`, AI_PROVIDER_DEFAULT[p])])),
    getTextSetting('evaluator_locked_at', null),
  ]);
  return {
    providers: Object.fromEntries(providers),
    choices: AI_PROVIDER_CHOICES,
    evaluator_locked_at: locked,
    // Echoed so the UI never has to hardcode the phrases — one source of truth for both sides.
    confirm_phrases: { change_evaluator: CONFIRM_EVALUATOR, unlock_evaluator: CONFIRM_UNLOCK, switch_unfit: CONFIRM_UNFIT, replace_lock: CONFIRM_RELOCK },
  };
}

router.get('/ai-providers', async (_req, res) => {
  res.json(await readAiProviders());
});

// The Primary Evaluator Model Lock.
//
// Scores already carry a configuration fingerprint. What was missing is the DECLARATION of the parts
// a running system cannot read for itself — the weights checksum above all, which is not obtainable
// over an inference API and must be stated by someone with filesystem access. Until it is, the lock
// is an assertion rather than a checkable fact.
const ModelLockSchema = z.object({
  // 64 hex characters. Loose validation here would defeat the point: a checksum nobody can verify
  // the shape of is a string, not evidence.
  weights_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected a 64-character SHA-256 hex digest'),
  inference_engine: z.string().min(1).max(200),
  quantization: z.string().max(200).optional(),
  system_prompt_version: z.string().min(1).max(200),
  evaluator_prompt_version: z.string().min(1).max(200),
  rubric_version: z.string().min(1).max(200),
  decoding: z.object({
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().optional(),
    seed: z.number().int().nullable().optional(),
  }).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  note: z.string().max(4000).optional(),
  confirm_relock: z.string().optional(),
});

// Current lock, plus whether a new declaration is permitted and why not.
router.get('/evaluator-lock', async (_req, res) => {
  // Express 4 hangs the client on an async rejection rather than reaching the error middleware, and
  // Promise.all rejects as a unit — one failing read would take the whole screen down silently.
  let current = null, lockedAt = null, gate = { ok: false };
  try {
    [{ data: current }, lockedAt, gate] = await Promise.all([
      supabase.from('evaluator_model_lock').select('*').order('locked_at', { ascending: false }).limit(1).maybeSingle(),
      getTextSetting('evaluator_locked_at', null),
      decisiveVerdict({}),
    ]);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  const verdict = gate.ok ? gate.verdict : null;
  res.json({
    locked_at: lockedAt,
    current: current ?? null,
    candidate: gate.ok ? gate.candidate : null,
    // The form is unavailable until the candidate has cleared the DECISIVE bar. Not the screening
    // bar: two models agreeing closely can be similarly wrong, and freezing the study's measuring
    // instrument against a number that never touched a human judgement is the thing this prevents.
    can_declare: verdict?.state === 'pass',
    gate: verdict,
  });
});

router.post('/evaluator-lock', async (req, res) => {
  const parsed = ModelLockSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Already locked? Re-declaring is not a repeat of the same action — the change-control rule allows
  // it only for a critical safety or security reason, with scoring stopped and the data either side
  // separated. Pressing the button twice must not be able to do that quietly.
  const existingLock = await getTextSetting('evaluator_locked_at', null);
  if (existingLock && parsed.data.confirm_relock !== CONFIRM_RELOCK) {
    return res.status(409).json({
      error: `The evaluator was locked on ${existingLock}. Replacing that lock means stopping scoring and separating the data either side of the change.`,
      code: 'confirmation_required', confirm_phrase: CONFIRM_RELOCK, locked_at: existingLock,
    });
  }

  let gate;
  try { gate = await decisiveVerdict({}); } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!gate.ok) return sendDbError(res, gate.error);
  if (gate.verdict.state !== 'pass') {
    return res.status(409).json({
      error: `The candidate has not cleared the decisive threshold (${gate.verdict.state}): ${gate.verdict.why}`,
      code: 'gate_not_passed', gate: gate.verdict,
    });
  }

  const now = new Date().toISOString();
  const { confirm_relock: _c, ...declaration } = parsed.data;
  const { data: row, error } = await supabase.from('evaluator_model_lock').insert({
    locked_at: now, locked_by: req.user.id,
    provider: gate.candidate?.provider ?? null,
    model_version: gate.candidate?.model_version ?? null,
    ...declaration,
    // The proof that the freeze was permitted, kept beside the thing it permitted. Reconstructing
    // the corpus as it stood on the day is not something anyone will actually do later.
    gate: gate.verdict,
  }).select('*').maybeSingle();
  if (sendDbError(res, error)) return;

  // Two settings, deliberately written AFTER the record exists: evaluator_locked_at is what the
  // provider-switch endpoint refuses on, and evaluator_weights_sha256 is what every subsequent score
  // is stamped with. A flag set without a record behind it is the state this whole change removes.
  const { error: setErr } = await supabase.from('app_settings').upsert([
    { key: 'evaluator_locked_at', value: 0, value_text: now, updated_at: now },
    { key: 'evaluator_weights_sha256', value: 0, value_text: declaration.weights_sha256, updated_at: now },
  ]);
  if (setErr) {
    // The record landed and the flag did not. Left alone, that is the worst of both: a signed record
    // asserting a freeze the provider-switch endpoint would still happily override. Roll the record
    // back so the failure is total and legible, rather than a lock that only looks real.
    await supabase.from('evaluator_model_lock').delete().eq('locked_at', now).eq('locked_by', req.user.id);
    return res.status(500).json({ error: `Lock not applied (${setErr.message}); the draft record was rolled back.` });
  }

  logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'evaluator_model_lock',
    metadata: { locked_at: now, weights_sha256: declaration.weights_sha256, replaced_lock: existingLock ?? null,
      provider: gate.candidate?.provider ?? null, model_version: gate.candidate?.model_version ?? null,
      gate: gate.verdict } });

  res.json({ ok: true, locked_at: now, record: row ?? null });
});

// What each provider is actually able to do right now — model served, context window, reachability,
// and the embedding dimension.
//
// The numbers already existed on RIMPL's deep health route, and that is precisely why they were
// useless: nobody opens a JSON endpoint before flipping a switch. Surfacing them beside the switch
// turns "is the box ready" from something you have to know to curl into something you can see.
router.get('/ai-readiness', async (_req, res) => {
  try {
    const { body } = await probeRimplDeep({ timeoutMs: 8000 });

    // The embedding dimension is the one readiness fact /health/deep CANNOT report. readiness()
    // probes only the chat providers, and no endpoint anywhere states a vector width — the only
    // honest way to learn it is to embed a string and measure the result. So it is asked for here,
    // separately and deliberately, rather than left as a criterion nobody can see.
    //
    // Cost is one short embedding per load of a superadmin-only screen (fractions of a cent at a
    // vendor, nothing on-prem). A failure is reported, never fatal: the rest of the screen is still
    // the answer to "can this box serve".
    let embedding = null;
    const embedProvider = body?.models?.embed?.provider ?? null;
    if (embedProvider) {
      try {
        const v = await probeRimplProvider({ name: embedProvider, purpose: 'embed' });
        embedding = {
          provider: embedProvider,
          model: body?.models?.embed?.model ?? null,
          fit: !!v.fit,
          dimension: v.measured ?? null,
          required: v.required ?? null,
          reason: v.reason ?? null,
        };
      } catch (e) {
        embedding = { provider: embedProvider, model: body?.models?.embed?.model ?? null,
          fit: false, dimension: null, required: null, reason: e.message };
      }
    }

    res.json({
      reachable: true,
      checks: body?.checks ?? {},
      models: body?.models ?? null,
      routing: body?.routing ?? null,
      embedding,
    });
  } catch (e) {
    // A degraded RIMPL is an ANSWER here, not a server error — the screen exists to show exactly this.
    res.json({ reachable: false, error: e.message, checks: {}, models: null, routing: null, embedding: null });
  }
});

router.patch('/ai-providers', async (req, res) => {
  const parsed = AiProviderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { purpose, provider, evaluator_locked, confirm, confirm_unfit } = parsed.data;
  const now = new Date().toISOString();
  const lockedAt = await getTextSetting('evaluator_locked_at', null);

  // --- lock / unlock ---------------------------------------------------------------------------
  if (evaluator_locked != null) {
    // Unlocking is the dangerous direction, so it is the one that has to be typed out. Locking is
    // always allowed: making the safe action harder than the unsafe one gets it skipped.
    if (!evaluator_locked && lockedAt && confirm !== CONFIRM_UNLOCK) {
      return res.status(409).json({
        error: `The evaluator is locked (since ${lockedAt}). Unlocking changes the instrument the ICC credit gate is defined against.`,
        code: 'confirmation_required', confirm_phrase: CONFIRM_UNLOCK,
      });
    }
    const value_text = evaluator_locked ? (lockedAt || now) : null;
    const { error } = await supabase.from('app_settings')
      .upsert({ key: 'evaluator_locked_at', value: 0, value_text, updated_at: now });
    if (sendDbError(res, error)) return;
    logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'evaluator_lock',
      metadata: { locked: evaluator_locked, locked_at: value_text, previous_locked_at: lockedAt } });
    return res.json(await readAiProviders());
  }

  // --- provider change -------------------------------------------------------------------------
  const name = String(provider).trim().toLowerCase();
  const allowed = AI_PROVIDER_CHOICES[purpose];
  if (!allowed.includes(name)) {
    return res.status(400).json({ error: `"${name}" cannot serve ${purpose}. Valid: ${allowed.join(', ')}`, code: 'invalid_provider' });
  }

  if (purpose === 'evaluate') {
    // Refuse OUTRIGHT once locked — not a warning. During the pilot the scoring model is frozen by
    // §10.2, and a mid-cohort swap would confound the primary outcome with the instrument.
    if (lockedAt) {
      return res.status(409).json({
        error: `The PIS-7 evaluator was locked on ${lockedAt} and cannot be changed while the pilot is running. Unlock it first if this is deliberate.`,
        code: 'evaluator_locked', evaluator_locked_at: lockedAt,
      });
    }
    if (confirm !== CONFIRM_EVALUATOR) {
      return res.status(409).json({
        error: 'Changing the PIS-7 evaluator changes the instrument every score and the ICC credit gate are measured against.',
        code: 'confirmation_required', confirm_phrase: CONFIRM_EVALUATOR,
      });
    }
  }

  const previous = await getTextSetting(`ai_provider_${purpose}`, AI_PROVIDER_DEFAULT[purpose]);

  // READINESS GATE. Ask whether the target can actually serve before pointing traffic at it.
  //
  // The failure this prevents is specific and was already measured: an inference server left on a
  // 4,096-token context accepts the switch happily and then fails EVERY evaluation, because a
  // creditable transcript is 10,000+ tokens. Without this, the switch succeeds, nothing looks wrong,
  // and the first person to find out is a physician who loses a session.
  //
  // UNKNOWN COUNTS AS UNFIT — including "RIMPL did not answer". We cannot verify, so we do not
  // assert; the typed override exists for the operator who knows better than the probe.
  //
  // Skipped when the provider is not actually changing: a no-op write should not make a vendor call.
  if (name !== previous) {
    let verdict;
    try {
      verdict = await probeRimplProvider({ name, purpose });
    } catch (e) {
      verdict = { fit: false, code: 'probe_unreachable', reason: `could not reach RIMPL to probe "${name}": ${e.message}` };
    }
    if (!verdict.fit && confirm_unfit !== CONFIRM_UNFIT) {
      return res.status(409).json({
        error: `"${name}" is not ready to serve ${purpose}: ${verdict.reason}`,
        code: 'provider_not_ready',
        provider_code: verdict.code ?? null,
        measured: verdict.measured ?? null,
        required: verdict.required ?? null,
        confirm_phrase: CONFIRM_UNFIT,
      });
    }
    if (!verdict.fit) {
      // Overridden, not absent. A switch made over a failed readiness check is exactly the entry
      // someone will want when explaining why scoring broke on a given date.
      logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'ai_provider_unfit_override', metadata: { purpose, provider: name, verdict } });
    }
  }

  const { error } = await supabase.from('app_settings')
    .upsert({ key: `ai_provider_${purpose}`, value: 0, value_text: name, updated_at: now });
  if (sendDbError(res, error)) return;

  // Audit EVERY flip, not just the evaluator. Under a hybrid, "which system produced this score"
  // (§10.2 provenance) is only answerable if the switch history is on the record beside the scores.
  logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'ai_provider_change',
    metadata: { purpose, from: previous, to: name } });

  res.json(await readAiProviders());
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

// Reset a member's AUDITOR-pool meter to zero (separate escape hatch for the auditor budget).
router.post('/users/:id/reset-auditor-usage', async (req, res) => {
  const { data, error } = await supabase.from('professionals')
    .update({ auditor_usage_cost_usd: 0, auditor_usage_input_tokens: 0, auditor_usage_output_tokens: 0 })
    .eq('id', req.params.id).select('id, auditor_usage_cost_usd').maybeSingle();
  if (sendDbError(res, error)) return;
  if (!data) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

// ICC(2,1) calibration — overall + per-domain, AND a per-council breakdown so the superadmin
// can see each profession separately. Test sessions are excluded unless ?include_test=true.
const ICC_DOMAINS = ['d1','d2','d3','d4','d5','d6','d7'];
function iccBundle(pairs, minAuditors = 1) {
  const overall = computeICC21(pairs.map(p => ({ ai: Number(p.ai.composite_score), human: Number(p.audit.composite_score) })));
  const per_domain = {};
  for (const d of ICC_DOMAINS) {
    per_domain[d] = computeICC21(pairs.map(p => ({ ai: Number(p.ai[d]), human: Number(p.audit[d]) })));
  }

  // COHORT TRANSPARENCY, not a filter. Every PLE with a human score is in the figure above,
  // including the ones scored by a single auditor. What changes is that the caller can now SEE the
  // rater distribution behind the number instead of having to assume it.
  //
  // This project has been burnt once by the alternative: the headline ICC of 0.811 was partly an
  // artifact of a failed evaluation dropping out (n 33 -> 30). Restricting a cohort to tidy a number
  // is the same mistake in a different costume, so the restricted view is offered ALONGSIDE the full
  // one and is never substituted for it.
  const dist = {};
  for (const p of pairs) dist[p.n_auditors] = (dist[p.n_auditors] ?? 0) + 1;
  const atTarget = pairs.filter(p => p.n_auditors >= minAuditors);

  // Inter-auditor agreement — the figure the manuscript's ">= 3 blinded auditors" claim is actually
  // about, and the one AI-vs-human ICC cannot answer. ICC(1,1), not ICC(2,1): auditors are drawn per
  // PLE from a roster rather than all scoring every PLE, so rater is nested in subject and a two-way
  // model would claim to remove a rater effect this design cannot identify. See services/icc.js.
  const multi = pairs.filter(p => p.rater_scores && p.rater_scores.length >= 2);
  const inter_auditor = multi.length >= 2
    ? iccOneWay(multi.map(p => p.rater_scores))
    : { icc: null, n: multi.length, interpretation: multi.length
        ? 'Only 1 PLE has more than one auditor — inter-auditor agreement is not estimable yet'
        : 'No PLE has more than one auditor yet' };

  return {
    overall,
    per_domain,
    n: pairs.length,
    // The cohort, stated.
    min_auditors: minAuditors,
    auditors_per_cle: dist,
    n_at_target: atTarget.length,
    n_below_target: pairs.length - atTarget.length,
    // The SAME statistic restricted to PLEs meeting the target — shown next to the full figure so
    // the two can be compared, never in place of it.
    overall_at_target: atTarget.length >= 2
      ? computeICC21(atTarget.map(p => ({ ai: Number(p.ai.composite_score), human: Number(p.audit.composite_score) })))
      : null,
    inter_auditor,

    // The SAP names ICC(A,3) — "two-way random absolute-agreement, AVERAGE measures" — for human
    // interrater reliability. It is computed here, and it is reported NEXT TO ICC(1,1) rather than
    // instead of it, because which one is legitimate depends on how assignment actually ran:
    //
    //   * If a FIXED panel scores every PLE, raters are crossed with subjects, ICC(A,3) is
    //     identifiable, and it is the right figure — it describes the reliability of the panel MEAN,
    //     which is what the AI is compared against.
    //   * If auditors are drawn per PLE from the 20-25 pool (which is how the sampler assigns
    //     today), rater is nested in subject, the rater main effect ICC(A,3) estimates is not
    //     identifiable, and the number would claim to have removed an effect the design cannot see.
    //
    // Publishing whichever is larger without saying which design produced it is the failure mode
    // this pairing exists to prevent. It is null whenever the matrix is too ragged to support it.
    inter_auditor_average: multi.length >= 2 ? iccTwoWayAverage(multi.map(p => p.rater_scores)) : null,
    inter_auditor_note: 'ICC(1,1) assumes auditors are drawn per PLE (rater nested in subject) and is the conservative reading. ICC(A,k) assumes a fixed panel scoring every PLE. Report the one matching how assignment actually ran, and say which.',

    // Weighted kappa — SAP "Additional agreement". Ordinal-aware in a way ICC is not: it asks how
    // often the two land on the SAME 0-5 category, corrected for the agreement their marginal
    // habits would produce by chance. Per-domain because a composite that agrees can still hide one
    // domain where raters systematically diverge — and that domain is the one whose anchors need
    // rewriting.
    weighted_kappa: weightedKappaByDomain(
      pairs.map(p => ({ a: p.ai, b: p.audit })), { min: 0, max: 5 }),
  };
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
  // Aggregate to ONE human value per PLE (mean across auditors) before pairing: ICC(2,1) assumes a
  // single human rating per subject, so a multi-auditor PLE must not emit N pairs that reuse the same
  // AI value (which would inflate n + distort the statistic). With one auditor the mean is that score.
  const byPle = new Map();
  for (const a of auditScores) {
    if (!byPle.has(a.ple_id)) byPle.set(a.ple_id, []);
    byPle.get(a.ple_id).push(a);
  }
  const allPairs = [];
  for (const [pleId, rows] of byPle) {
    const ai = aiBy[pleId];
    if (!ai) continue;
    if (!includeTest && testOf[pleId]) continue;
    const mean = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0) / rows.length;
    const audit = { composite_score: mean('composite_score') };
    for (const d of ICC_DOMAINS) audit[d] = mean(d);
    allPairs.push({
      council_id: rows[0].council_id,
      ai,
      audit,
      n_auditors: rows.length,
      // Kept UNAGGREGATED alongside the mean: the mean is what pairs against the AI score, but
      // inter-auditor agreement needs the individual auditors, and averaging them away first is
      // exactly what makes that figure impossible to compute later.
      rater_scores: rows.map(r => Number(r.composite_score)),
    });
  }

  const minAuditors = await minAuditorsPerPle();
  const global = iccBundle(allPairs, minAuditors);

  // Bucket by council and label each with its names.
  const byCouncil = {};
  for (const p of allPairs) (byCouncil[p.council_id] ??= []).push(p);
  const { data: councils } = await supabase.from('councils').select('id, code, name_th, name_en');
  const councilName = Object.fromEntries((councils ?? []).map(c => [c.id, c]));
  const per_council = {};
  for (const [cid, pairs] of Object.entries(byCouncil)) {
    per_council[cid] = { council: councilName[cid] ?? null, ...iccBundle(pairs, minAuditors) };
  }

  // Spread `global` rather than cherry-picking four fields: the cohort description
  // (auditors_per_cle, n_below_target, overall_at_target, inter_auditor) is the point of this
  // change, and re-listing fields by hand is how it silently stops being reported.
  res.json({ ...global, per_council });
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

// Tier-1 (PI / data custodian) re-identification: decrypt a PLE's reversible PII map so a [NAME-n] /
// [HN-n] token in the de-identified transcript can be traced back to its raw value for audit or
// regulatory inquiry. superadmin-only (the router gate) + EVERY access is audit-logged. The raw
// values live only in ple_pii_map (RLS deny-all, AES-256-GCM); they never enter the export or any
// other surface. This is the "crown jewel" — keep it gated and logged.
router.get('/ples/:id/pii-map', async (req, res) => {
  const { data: ple } = await supabase.from('ples')
    .select('id, ple_code, council_id').eq('id', req.params.id).maybeSingle();
  if (!ple) return res.status(404).json({ error: 'PLE not found' });

  const { data: row, error } = await supabase.from('ple_pii_map')
    .select('map_encrypted, entry_count').eq('ple_id', req.params.id).maybeSingle();
  if (sendDbError(res, error)) return;
  if (!row) return res.status(404).json({ error: 'No PII map for this PLE' });

  let entries;
  try {
    entries = decryptJson(row.map_encrypted);
  } catch (e) {
    console.error('[pii-map] decrypt failed:', e.message);
    return res.status(500).json({ error: 'Could not decrypt the PII map (key mismatch?)' });
  }

  // Audit the re-identification (the audit row itself carries only the PLE pseudonym + count, no PII).
  logEvent({
    actorId: req.user.id, actorRole: req.user.role, action: 'pii.reidentify',
    targetType: 'ple', targetId: ple.ple_code ?? req.params.id, councilId: ple.council_id ?? null,
    metadata: { entry_count: row.entry_count, reason: req.query.reason || null },
  });

  res.json({ ple_code: ple.ple_code ?? null, entry_count: row.entry_count, entries });
});

// ---- Compensation payouts (superadmin only) ------------------------------------------------------
// Owed = completed (non-test) PLEs × rate, capped (configurable). Paid = Σ payouts ledger.
// "Completed" spans ple_pass AND evaluated — see lib/ple-status.js; ple_pass alone counts zero.
// Unlike the pseudonymized /admin/compensation report, this view carries REAL names + (decrypted)
// payment details so the team can actually pay — so it is superadmin-only and every read is audit-
// logged. The actual transfer happens externally; POST .../pay records it.
async function loadPayoutBase() {
  // Settings + the (larger) PLE scan are independent — overlap them.
  const [{ rate, cap }, plesRes] = await Promise.all([
    compRateCap(),
    supabase.from('ples').select('physician_id').in('status', COMPLETED_STATUSES).eq('is_test', false),
  ]);
  if (plesRes.error) throw plesRes.error;
  const countByPhys = {};
  for (const r of plesRes.data ?? []) countByPhys[r.physician_id] = (countByPhys[r.physician_id] ?? 0) + 1;
  const physIds = Object.keys(countByPhys);
  const empty = Promise.resolve({ data: [] });
  const [{ data: pros }, { data: pay }, { data: ledger }] = await Promise.all([
    physIds.length ? supabase.from('professionals').select('id, full_name_th, full_name_en, pseudonym').in('id', physIds) : empty,
    physIds.length ? supabase.from('payment_info').select('physician_id, enc').in('physician_id', physIds) : empty,
    physIds.length ? supabase.from('payouts').select('physician_id, amount_thb').in('physician_id', physIds) : empty,
  ]);
  const proById = new Map((pros ?? []).map(p => [p.id, p]));
  const payById = new Map((pay ?? []).map(p => [p.physician_id, p.enc]));
  const paidByPhys = {};
  for (const l of ledger ?? []) paidByPhys[l.physician_id] = (paidByPhys[l.physician_id] ?? 0) + Number(l.amount_thb);
  const safeDecrypt = (id) => { const enc = payById.get(id); if (!enc) return null; try { return decryptJson(enc); } catch { return null; } };
  // One owed/paid/outstanding line per physician — single source for the JSON view + the CSV export.
  const lineFor = (id) => {
    const completed = cappedPles(countByPhys[id], cap);
    const owed = completed * rate;
    const paid = paidByPhys[id] ?? 0;
    return { completed, owed, paid, outstanding: Math.max(0, owed - paid) };
  };
  return { rate, cap, physIds, proById, safeDecrypt, lineFor };
}
function maskAccount(info) {
  if (!info) return null;
  const src = info.account_no || info.promptpay || '';
  if (!src) return null;
  const label = info.account_no ? (info.bank ? `${info.bank} ` : '') : 'PromptPay ';
  return `${label}••••${String(src).slice(-4)}`;
}

router.get('/payouts', async (req, res) => {
  let base;
  try { base = await loadPayoutBase(); } catch (e) { return res.status(500).json({ error: e.message }); }
  const { rate, cap, physIds, proById, safeDecrypt, lineFor } = base;
  const recipients = physIds.map((id) => {
    const p = proById.get(id);
    const { completed, owed, paid, outstanding } = lineFor(id);
    const info = safeDecrypt(id);
    return {
      physician_id: id,
      name: p ? (p.full_name_th || p.full_name_en) : null,
      pseudonym: p?.pseudonym ?? null,
      completed_cles: completed, owed_thb: owed, paid_thb: paid, outstanding_thb: outstanding,
      has_payment_info: info != null, account_masked: maskAccount(info),
    };
  }).sort((a, b) => (b.outstanding_thb - a.outstanding_thb) || String(a.name).localeCompare(String(b.name)));
  logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'payout.view', metadata: { n: recipients.length } });
  res.json({ rate_thb_per_cle: rate, cap_cles: cap, n: recipients.length, recipients });
});

const PaySchema = z.object({
  amount_thb: z.number().positive().max(1_000_000),
  paid_ref: z.string().trim().max(120).optional().default(''),
});
router.post('/payouts/:physicianId/pay', async (req, res) => {
  const parsed = PaySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  // The target must be a real professional — a clear 404 instead of an opaque FK-violation 500.
  const { data: prof } = await supabase.from('professionals').select('id').eq('id', req.params.physicianId).maybeSingle();
  if (!prof) return res.status(404).json({ error: 'Physician not found' });
  // Recompute owed/outstanding server-side and refuse an overpayment (the UI also disables the button,
  // but a direct API call or a concurrent double-click must not push paid past owed).
  const { rate, cap } = await compRateCap();
  const [{ data: passRows }, { data: ledger }] = await Promise.all([
    supabase.from('ples').select('id').eq('physician_id', req.params.physicianId).in('status', COMPLETED_STATUSES).eq('is_test', false),
    supabase.from('payouts').select('amount_thb').eq('physician_id', req.params.physicianId),
  ]);
  const completed = cappedPles((passRows ?? []).length, cap);
  const owed = completed * rate;
  const paid = (ledger ?? []).reduce((s, l) => s + Number(l.amount_thb), 0);
  const outstanding = Math.max(0, owed - paid);
  if (parsed.data.amount_thb > outstanding + 0.001) {
    return res.status(400).json({ error: `จำนวนเกินยอดค้างจ่าย (฿${outstanding}) / Amount exceeds outstanding (฿${outstanding}).`, code: 'over_outstanding', outstanding_thb: outstanding });
  }
  const { data, error } = await supabase.from('payouts').insert({
    physician_id: req.params.physicianId, ple_count: completed, amount_thb: parsed.data.amount_thb,
    paid_ref: parsed.data.paid_ref || null, paid_by: req.user.id,
  }).select('id').single();
  if (sendDbError(res, error)) return;
  logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'payout.pay', targetType: 'professional',
    targetId: req.params.physicianId, metadata: { amount_thb: parsed.data.amount_thb, paid_ref: parsed.data.paid_ref || null } });
  res.json({ ok: true, id: data.id });
});

// Payout file for the actual transfer — REAL names + decrypted account details. Superadmin-only +
// audit-logged (this CSV carries payment PII; the research export at /admin/export.xlsx stays pseudonymized).
router.get('/payouts/export', async (req, res) => {
  let base;
  try { base = await loadPayoutBase(); } catch (e) { return res.status(500).json({ error: e.message }); }
  const { physIds, proById, safeDecrypt, lineFor } = base;
  const header = ['pseudonym', 'name', 'completed_cles', 'owed_thb', 'paid_thb', 'outstanding_thb', 'account_name', 'bank', 'account_no', 'promptpay'];
  const rows = physIds.map((id) => {
    const p = proById.get(id);
    const { completed, owed, paid, outstanding } = lineFor(id);
    const info = safeDecrypt(id) || {};
    return [p?.pseudonym ?? '', p ? (p.full_name_th || p.full_name_en) : '', completed, owed, paid, outstanding,
      info.account_name ?? '', info.bank ?? '', info.account_no ?? '', info.promptpay ?? ''];
  });
  logEvent({ actorId: req.user.id, actorRole: 'superadmin', action: 'payout.export', metadata: { n: physIds.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="clics-payouts.csv"');
  res.send(toCsv(header, rows));
});

// ---- Retention / de-identification (CREC082 DMP §8, ICF §11) ---------------------------------
// Superadmin only, and everything below is read-only except the one guarded execute.
//
// There is no scheduler. The deadline is five years after a project that has not started; a cron
// written now and left unattended until ~2031, running irreversible deletes against a schema that
// will have changed many times, would be a bigger risk than the one it manages. A human runs this.

router.get('/retention', async (_req, res) => {
  try {
    res.json({ ...(await retention.plan()), confirm_phrase: retention.CONFIRM_PHRASE });
  } catch (e) {
    console.error('[superadmin] retention plan failed:', e.message);
    res.status(500).json({ error: 'Could not compute the retention plan.' });
  }
});

const RetentionPolicySchema = z.object({
  // ISO date, or null to clear it and stop the clock. Nothing is due while this is unset.
  project_end_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  retention_years: z.number().int().min(1).max(50).optional(),
});

router.patch('/retention', async (req, res) => {
  const parsed = RetentionPolicySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const rows = [];
  if ('project_end_date' in parsed.data) rows.push({ key: 'project_end_date', value: 0, value_text: parsed.data.project_end_date ?? null });
  if (parsed.data.retention_years != null) rows.push({ key: 'retention_years', value: parsed.data.retention_years, value_text: null });
  if (!rows.length) return res.status(400).json({ error: 'Nothing to update.' });

  const { error } = await supabase.from('app_settings').upsert(rows, { onConflict: 'key' });
  if (sendDbError(res, error)) return;
  // Setting the project end date starts a five-year clock toward an irreversible operation, so the
  // change is audited in its own right.
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'retention.policy',
    targetType: 'app_settings', targetId: 'retention', councilId: null, metadata: parsed.data });
  res.json({ ok: true, ...(await retention.retentionPolicy()) });
});

router.post('/retention/deidentify', async (req, res) => {
  const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm : '';
  const out = await retention.execute({ confirm, actorId: req.user.id });
  if (!out.ok && out.code) {
    // Refusals are the normal case and each says exactly what is missing, so a superadmin is never
    // guessing why an irreversible operation declined to run.
    const msg = {
      no_project_end_date: 'Set the project end date first — nothing is due until the study has ended.',
      not_yet_due: `Not due until ${out.due_at}.`,
      confirmation_mismatch: `Type the confirmation phrase exactly: "${retention.CONFIRM_PHRASE}".`,
    }[out.code] ?? 'Refused.';
    return res.status(409).json({ error: msg, code: out.code, due_at: out.due_at });
  }
  // Logged whether or not every target succeeded — a partial pass is the case where a record matters
  // most, and audit_log is excluded from the sweep precisely so this entry survives it.
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'retention.deidentify',
    targetType: 'dataset', targetId: 'research', councilId: null,
    metadata: { ok: out.ok, results: out.results } });
  res.status(out.ok ? 200 : 207).json(out);
});

// ---- Monthly security review (Infrastructure Statement "Security review", ICF §11) -----------
// "ทบทวนด้าน security รายเดือน ... รวมถึง access/audit review และ incident review" — three named
// parts, recorded separately so "was access reviewed in March?" has an answer.

router.get('/security-reviews', async (req, res) => {
  const { limit, offset } = pageParams(req);
  const { data, count, error } = await supabase.from('security_reviews')
    .select('*', { count: 'exact' })
    .order('period_month', { ascending: false }).range(offset, offset + limit - 1);
  if (sendDbError(res, error)) return;
  res.json({ reviews: data ?? [], limit, offset, total: count ?? 0 });
});

const SecurityReviewSchema = z.object({
  // The month under review, normalised to its first day — the unique index is what enforces
  // "monthly" rather than "whenever someone remembers".
  period_month: z.string().trim().regex(/^\d{4}-\d{2}$/),
  access_review: z.string().trim().max(4000).optional(),
  audit_review: z.string().trim().max(4000).optional(),
  incident_review: z.string().trim().max(4000).optional(),
  incidents_found: z.boolean().optional(),
  notes: z.string().trim().max(4000).optional(),
});

router.post('/security-reviews', async (req, res) => {
  const parsed = SecurityReviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  // Each of the three parts must actually say something. A record with all three blank asserts a
  // review happened while carrying no evidence that one did — worse than no record at all.
  if (!(d.access_review || d.audit_review || d.incident_review)) {
    return res.status(400).json({ error: 'Record what was reviewed — access, audit, or incidents.', code: 'empty_review' });
  }
  const { error } = await supabase.from('security_reviews').upsert({
    period_month: `${d.period_month}-01`,
    reviewed_by: req.user.id, reviewed_at: new Date().toISOString(),
    access_review: d.access_review ?? null, audit_review: d.audit_review ?? null,
    incident_review: d.incident_review ?? null,
    incidents_found: d.incidents_found ?? false, notes: d.notes ?? null,
  }, { onConflict: 'period_month' });
  if (sendDbError(res, error)) return;
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'security.review',
    targetType: 'security_review', targetId: d.period_month, councilId: null,
    metadata: { incidents_found: d.incidents_found ?? false } });
  res.json({ ok: true, period_month: d.period_month });
});

module.exports = router;
// Exposed for unit tests (superadmin absent from role enums; specialty/license optional).
module.exports.CreateUserSchema = CreateUserSchema;
module.exports.UpdateUserSchema = UpdateUserSchema;
