const { Router } = require('express');
const { createHash } = require('crypto');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { AssignSchema } = require('../lib/schemas');
const { triggerEvaluation } = require('../services/cle-evaluation');
const { reconcileEvaluations } = require('../services/reconcile');
const { sendDbError, pageParams } = require('../lib/db-helpers');
const { assertSlotAvailable } = require('../lib/accounts');
const { newInviteToken } = require('../lib/invite-token');
const { isMailerEnabled, sendInviteEmail } = require('../lib/mailer');
const { normalizeCanAudit } = require('../lib/dual-role');
const { POSITIONS, checkSpecialty } = require('../lib/specialties');
const { logEvent } = require('../lib/audit');

const router = Router();
router.use(verifyJwt, requireRole('admin', 'superadmin'));

const INVITE_EXPIRY_DAYS = parseInt(process.env.INVITE_EXPIRY_DAYS || '7', 10);
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';
const InviteSchema = z.object({
  // Normalize case so the invites_one_pending unique index (case-sensitive text) can't be bypassed
  // with Doc@x.com vs doc@x.com, and so accept-by-email matches consistently.
  email: z.string().email().transform(e => e.trim().toLowerCase()),
  role: z.enum(['physician', 'auditor', 'admin']),
  // "Special" invite = physician + can_audit (dual role). Meaningless with role 'auditor'.
  can_audit: z.boolean().optional(),
  council_id: z.string().uuid(),
  // The invited member's specialty (under council) + position; inherited on accept.
  specialty_id: z.string().uuid().optional(),
  position: z.enum(POSITIONS).optional(),
});

// Admins are "directors" of exactly one council and see only that council's data; the
// superadmin spans all councils. scopeToCouncil() narrows any query on a table carrying a
// council_id column (cles, professionals, audit_scores, access_requests) for an admin caller;
// sameCouncil() guards single-row actions.
const scopeToCouncil = (req, query) =>
  req.user.role === 'admin' ? query.eq('council_id', req.user.council_id) : query;
const sameCouncil = (req, councilId) =>
  req.user.role !== 'admin' || councilId === req.user.council_id;

// Specialty is the layer UNDER council: an admin is also pinned to their own specialty (the
// pipeline is council × specialty). Applied ONLY to queries on tables carrying a specialty_id
// (cles, professionals) — NOT access_requests, which has none. Skipped when the admin has no
// specialty (e.g. a non-medical council), so it never narrows to the broken `specialty_id is null`.
const scopeBySpecialty = (req, query) =>
  req.user.role === 'admin' && req.user.specialty_id
    ? query.eq('specialty_id', req.user.specialty_id) : query;
const sameSpecialty = (req, specialtyId) =>
  req.user.role !== 'admin' || !req.user.specialty_id || specialtyId === req.user.specialty_id;

// (The access-request approval schemas were retired with the request-access flow — see below.)

router.get('/cles', async (req, res) => {
  const { status } = req.query;
  const { limit, offset } = pageParams(req);   // paginated — never pull the whole 400K-row table
  let query = supabase.from('cles')
    .select('*, professionals!cles_physician_id_fkey(full_name_th, full_name_en, specialty), specialties(name_th, name_en, code)', { count: 'exact' });
  // 'in_progress' is a UI bucket spanning three live statuses; others map 1:1. Filtered server-side
  // so pagination + the Stats drill-down stay correct (not just over already-loaded rows).
  const STATUS_BUCKETS = { in_progress: ['active', 'ended', 'cle_pass'] };
  // Own-property lookup only — a crafted ?status=constructor/toString would otherwise resolve to an
  // inherited Object.prototype function and 500 the query.
  const bucket = status && Object.hasOwn(STATUS_BUCKETS, status) ? STATUS_BUCKETS[status] : null;
  if (status) query = bucket ? query.in('status', bucket) : query.eq('status', status);
  // The CLE list is the assignment surface — test sessions MUST appear here so they can be
  // assigned/scored (feeding the audit system). They carry is_test so the UI can badge them;
  // pass ?only_real=true to hide them. Headline counts live in /stats + /icc (real-only there).
  if (req.query.only_real === 'true') query = query.eq('is_test', false);
  // Optional ?specialty= filter — narrows a superadmin's view to one specialty (harmless for an
  // admin: scopeBySpecialty already pins them, so a foreign id just yields 0 rows).
  if (typeof req.query.specialty === 'string' && req.query.specialty) query = query.eq('specialty_id', req.query.specialty);
  query = scopeBySpecialty(req, scopeToCouncil(req, query));
  const { data, error, count } = await query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (sendDbError(res, error)) return;
  res.setHeader('X-Total-Count', count ?? 0);   // body stays an array (backward-compatible); total in header
  res.json(data);
});

router.get('/cles/flagged', async (req, res) => {
  let query = supabase
    .from('cles')
    .select('*, professionals!cles_physician_id_fkey(full_name_th, full_name_en), specialties(name_th, name_en, code)')
    .eq('status', 'cle_flag_t2');
  query = scopeBySpecialty(req, scopeToCouncil(req, query));
  const { data, error } = await query.order('ended_at');
  if (sendDbError(res, error)) return;
  res.json(data);
});

// Investigate a session transcript (admin scoped to own council; superadmin any council).
router.get('/cles/:id/transcript', async (req, res) => {
  const { data: cle, error } = await supabase.from('cles')
    .select('id, council_id, specialty_id, status, chief_complaint, title, started_at, ended_at, turn_count, token_count, professionals!cles_physician_id_fkey(full_name_th, full_name_en, pseudonym), specialties(name_th, name_en, code)')
    .eq('id', req.params.id).maybeSingle();
  // A query/embed failure (e.g. an ambiguous-FK embed after a table rename — the PLE→CLE incident)
  // must surface as a 500. maybeSingle() makes "no rows" a clean { data: null, error: null }, so a
  // genuine not-found still 404s below; we must NOT let a query error fall through to that 404, which
  // the dashboard misreads as "outside your council".
  if (sendDbError(res, error)) return;
  if (!cle) return res.status(404).json({ error: 'Not found' });
  // Admin is scoped to own council AND own specialty; superadmin (no council) sees all.
  if (!sameCouncil(req, cle.council_id) || !sameSpecialty(req, cle.specialty_id)) return res.status(404).json({ error: 'Not found' });

  const { data: messages, error: msgErr } = await supabase.from('messages')
    .select('role, content, refs, socratic_question, created_at')
    .eq('cle_id', req.params.id).order('created_at');
  if (sendDbError(res, msgErr)) return;   // a messages-fetch error must not silently render an empty transcript
  res.json({ cle, messages: messages ?? [] });
});

// Council list for dashboard labels/selectors (admin + superadmin).
router.get('/councils', async (_req, res) => {
  const { data, error } = await supabase
    .from('councils').select('id, code, name_th, name_en, active').order('sort');
  if (sendDbError(res, error)) return;
  res.json(data ?? []);
});

// Specialty list for the user create/edit dropdowns + onboarding picker (the layer under council).
// ?council_id= scopes to one council; omitted returns all (superadmin overview).
router.get('/specialties', async (req, res) => {
  let query = supabase.from('specialties')
    .select('id, council_id, code, name_th, name_en, active').eq('active', true).order('sort');
  if (typeof req.query.council_id === 'string' && req.query.council_id) query = query.eq('council_id', req.query.council_id);
  const { data, error } = await query;
  if (sendDbError(res, error)) return;
  res.json(data ?? []);
});

router.post('/cles/:id/approve', async (req, res) => {
  const { data: cle } = await supabase.from('cles').select('*').eq('id', req.params.id).single();
  // Council check FIRST: a foreign-council id must be an opaque 404 regardless of its status.
  if (!cle || !sameCouncil(req, cle.council_id)) return res.status(404).json({ error: 'Not found' });
  if (cle.status !== 'cle_flag_t2') return res.status(400).json({ error: 'Not a flagged CLE' });

  // Conditional update: a double-clicked Approve must not re-trigger the (paid) AI evaluation.
  // Only the click that actually flips cle_flag_t2 → cle_pass proceeds; any racer gets 409.
  const { data: flipped, error } = await supabase.from('cles')
    .update({ status: 'cle_pass' }).eq('id', req.params.id).eq('status', 'cle_flag_t2').select('id');
  if (sendDbError(res, error)) return;
  if (!flipped?.length) return res.status(409).json({ error: 'Already processed' });

  const { data: messages, error: msgErr } = await supabase
    .from('messages').select('role, content').eq('cle_id', req.params.id).order('created_at');
  // The flag was already consumed (status=cle_pass). On a transient messages-query failure DON'T feed
  // an empty transcript to the evaluator (it would persist a bogus score) — leave it at cle_pass for
  // the scheduled reconcile sweep to retry.
  if (msgErr || !messages?.length) {
    console.error('[admin approve] messages fetch failed/empty — deferring to reconcile:', msgErr?.message);
    return res.json({ ok: true, evaluation: 'deferred' });
  }
  const transcript = messages.map(m => ({ role: m.role, content: m.content }));
  // Patient identifier → scrubbed on-prem before the cloud eval. Admin is NOT the owner → read by
  // cle_id only (service-role bypasses RLS).
  const { data: apprRef } = await supabase.from('cle_patient_refs')
    .select('patient_ref').eq('cle_id', req.params.id).maybeSingle();

  // Fire-and-forget: evaluate + persist (same path as the physician /end flow).
  triggerEvaluation(req.params.id, transcript, cle.physician_id, apprRef?.patient_ref ?? null)
    .catch(e => console.error('[admin approve] evaluation failed:', e.message));

  res.json({ ok: true });
});

// Re-run the PIS-7 evaluation for a CLE that passed the gate but whose evaluation never landed
// (e.g. a transient RIMPL error left it stuck at cle_pass with no ai_evaluation). Unlike the
// fire-and-forget /end path, this awaits the result. It refuses to touch an already-evaluated CLE
// (409), so it can only recover stranded sessions — it never re-judges or overrides a score.
router.post('/cles/:id/reevaluate', async (req, res) => {
  const { data: cle } = await supabase.from('cles').select('*').eq('id', req.params.id).single();
  if (!cle) return res.status(404).json({ error: 'Not found' });
  if (!sameCouncil(req, cle.council_id)) return res.status(404).json({ error: 'Not found' });
  if (!['cle_pass', 'evaluated'].includes(cle.status)) {
    return res.status(400).json({ error: 'CLE has not passed the CLE gate' });
  }
  const { data: existing } = await supabase
    .from('ai_evaluations').select('id').eq('cle_id', cle.id).maybeSingle();
  if (existing) return res.status(409).json({ error: 'Already evaluated' });

  const { data: messages, error: msgErr } = await supabase
    .from('messages').select('role, content').eq('cle_id', cle.id).order('created_at');
  if (sendDbError(res, msgErr)) return;
  if (!messages?.length) return res.status(409).json({ error: 'No transcript to evaluate.' });
  const transcript = messages.map(m => ({ role: m.role, content: m.content }));
  // Patient identifier → scrubbed on-prem before the cloud eval (read by cle_id; service-role, non-owner).
  const { data: reevalRef } = await supabase.from('cle_patient_refs')
    .select('patient_ref').eq('cle_id', cle.id).maybeSingle();
  try {
    await triggerEvaluation(cle.id, transcript, cle.physician_id, reevalRef?.patient_ref ?? null);
    logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'cle.reevaluate', targetType: 'cle',
      targetId: cle.cle_code ?? cle.id, councilId: cle.council_id });
    res.json({ ok: true, status: 'evaluated' });
  } catch (e) {
    res.status(502).json({ error: `Evaluation failed: ${e.message}` });
  }
});

router.post('/cles/:id/reject', async (req, res) => {
  // Mirror /approve: council check FIRST (opaque 404), then a conditional flip whose row count
  // distinguishes a real reject from a no-op — the old handler returned {ok:true} for a nonexistent
  // /foreign-council /already-processed /double-clicked id without touching anything.
  const { data: cle } = await supabase.from('cles').select('id, council_id, status').eq('id', req.params.id).single();
  if (!cle || !sameCouncil(req, cle.council_id)) return res.status(404).json({ error: 'Not found' });
  if (cle.status !== 'cle_flag_t2') return res.status(400).json({ error: 'Not a flagged CLE' });

  const { data: flipped, error } = await supabase.from('cles')
    .update({ status: 'cle_fail_t1' }).eq('id', req.params.id).eq('status', 'cle_flag_t2').select('id');
  if (sendDbError(res, error)) return;
  if (!flipped?.length) return res.status(409).json({ error: 'Already processed' });
  res.json({ ok: true });
});

router.post('/cles/:id/assign', async (req, res) => {
  const parsed = AssignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const auditorId = parsed.data.auditor_id;

  const { data: cle } = await supabase.from('cles')
    .select('id, status, council_id, specialty_id, physician_id').eq('id', req.params.id).single();
  if (!cle) return res.status(404).json({ error: 'Not found' });
  if (!sameCouncil(req, cle.council_id) || !sameSpecialty(req, cle.specialty_id)) return res.status(404).json({ error: 'Not found' });
  if (cle.status !== 'evaluated') return res.status(400).json({ error: 'CLE is not ready for assignment' });

  // The assignee must be an active auditor (or a "special" can_audit physician) in the SAME
  // council AND specialty, and never the physician who ran the session.
  const { data: auditor } = await supabase.from('professionals')
    .select('id, role, status, council_id, specialty_id, can_audit').eq('id', auditorId).single();
  const canAudit = auditor && (auditor.role === 'auditor' || auditor.can_audit === true);
  if (!auditor || !canAudit || auditor.status !== 'active') {
    return res.status(400).json({ error: 'Not an active auditor' });
  }
  if (auditor.id === cle.physician_id) {
    return res.status(409).json({ error: 'An auditor cannot be assigned to their own session.' });
  }
  if (auditor.council_id !== cle.council_id) {
    return res.status(409).json({ error: 'Cross-council assignment is not allowed.' });
  }
  // Specialty pipeline: an auditor only scores sessions in their own specialty (enforced only when
  // the session carries one, so pre-migration CLEs without a specialty still assign).
  if (cle.specialty_id && auditor.specialty_id !== cle.specialty_id) {
    return res.status(409).json({ error: 'Cross-specialty assignment is not allowed.' });
  }

  const { error } = await supabase.from('cles')
    .update({ auditor_id: auditorId })
    .eq('id', req.params.id)
    .eq('status', 'evaluated');
  if (sendDbError(res, error)) return;
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'cle.assign', targetType: 'cle',
    targetId: req.params.id, councilId: cle.council_id, metadata: { auditor_id: auditorId } });
  res.json({ ok: true });
});

// Members list — dual-role: an admin sees ONLY their own council's members (read-only in the
// dashboard); superadmin sees all (scopeToCouncil is a no-op for them). Lives here (not
// superadmin.js) because this router is mounted first on /admin and would shadow it anyway.
// All user MUTATIONS (create/edit/status/usage) remain superadmin-only in routes/superadmin.js.
router.get('/users', async (req, res) => {
  const { limit, offset } = pageParams(req);   // paginated — never pull all 80K professionals at once
  let query = supabase.from('professionals')
    // Newest first: a just-created user must be visible on the reloaded first page.
    .select('*, specialties(name_th, name_en, code)', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  // Server-side status filter (the UI hides deactivated members by default) — applied before
  // pagination so X-Total-Count stays correct.
  if (req.query.status === 'active' || req.query.status === 'deactivated') {
    query = query.eq('status', req.query.status);
  }
  // Optional ?q= search — case-insensitive on the Thai/English names (professionals carries NO
  // email column; emails live in auth.users). Server-side (filters compose with ?status and
  // count:'exact', so pagination + X-Total-Count stay correct). q is sanitized first: commas,
  // parens and % would break PostgREST .or() syntax; if nothing survives, skip the filter.
  if (typeof req.query.q === 'string') {
    const q = req.query.q.replace(/[,()%]/g, ' ').trim();
    if (q) query = query.or(`full_name_th.ilike.*${q}*,full_name_en.ilike.*${q}*`);
  }
  // Optional ?role= filter (allowlisted). 'special' is the dual-role pair (physician + can_audit);
  // every other allowed value is a plain role match. Unknown values fall through with no filter,
  // mirroring how ?status= ignores anything but active/deactivated.
  if (req.query.role === 'special') {
    query = query.eq('role', 'physician').eq('can_audit', true);
  } else if (['physician', 'admin', 'auditor', 'superadmin'].includes(req.query.role)) {
    query = query.eq('role', req.query.role);
  }
  // Optional ?council= filter — narrows the superadmin's view to one council. Harmless for an admin:
  // scopeToCouncil below still pins them to their own council, so a foreign id just yields 0 rows.
  if (typeof req.query.council === 'string' && req.query.council) {
    query = query.eq('council_id', req.query.council);
  }
  // Optional ?specialty= filter (superadmin convenience; admins are pinned by scopeBySpecialty).
  // Comma-separated → multi-select (OR within the dimension); a single value is just .in([one]).
  const specialtyIds = String(req.query.specialty || '').split(',').map(s => s.trim()).filter(Boolean);
  if (specialtyIds.length) query = query.in('specialty_id', specialtyIds);
  // Optional ?position= filter — medical training level (the superadmin user-page filter). Same
  // comma-separated multi-select shape.
  const positions = String(req.query.position || '').split(',').map(s => s.trim()).filter(Boolean);
  if (positions.length) query = query.in('position', positions);
  query = scopeBySpecialty(req, scopeToCouncil(req, query));
  const { data, error, count } = await query;
  if (sendDbError(res, error)) return;
  res.setHeader('X-Total-Count', count ?? 0);
  res.json(data);
});

// Read-only auditor list for the assignment dropdown: active pure auditors PLUS "special"
// can_audit physicians (id+names — /users above returns full rows of every role).
router.get('/auditors', async (req, res) => {
  let query = supabase
    .from('professionals')
    .select('id, full_name_th, full_name_en, role, can_audit, council_id, specialty_id, specialties(name_th, name_en, code)')
    .or('role.eq.auditor,can_audit.eq.true')
    .eq('status', 'active');
  // Optional ?council= / ?specialty= so a superadmin can pre-filter the dropdown to the CLE's
  // council+specialty (assignment requires same-council AND same-specialty, so a mixed list would
  // otherwise offer auditors that 409 on assign).
  if (typeof req.query.council === 'string' && req.query.council) query = query.eq('council_id', req.query.council);
  if (typeof req.query.specialty === 'string' && req.query.specialty) query = query.eq('specialty_id', req.query.specialty);
  query = scopeBySpecialty(req, scopeToCouncil(req, query));   // admins only assign auditors in their own council+specialty
  const { data, error } = await query.order('full_name_th');
  if (sendDbError(res, error)) return;
  res.json(data);
});

// ---- Access-request approval queue — RETIRED (2026-06-10) -------------------
// The self-service request-access flow was removed (onboarding = Google self-service + A/B
// invites), so the approval queue went with it. The access_requests table is kept as a
// historical record. 404 stubs (not silent removal) so stale clients fail loudly.
router.get('/access-requests', (_req, res) => res.status(404).json({ error: 'The access-request queue was retired — onboarding is Google sign-in + invites.' }));
router.post('/access-requests/:id/approve', (_req, res) => res.status(404).json({ error: 'The access-request queue was retired.' }));
router.post('/access-requests/:id/reject', (_req, res) => res.status(404).json({ error: 'The access-request queue was retired.' }));

// ---- Auditor-rights requests (the "special" dual role) ----------------------
// A physician asks to ALSO audit (POST /auth/request-auditor). Admins see their own council's
// queue (GET below), but approving/rejecting is a ROLE MUTATION — superadmin ONLY (approve flips
// professionals.can_audit=true). Lives in access_requests with requested_role='auditor'.
router.get('/auditor-requests', async (req, res) => {
  let q = supabase.from('access_requests').select('*')
    .eq('requested_role', 'auditor').eq('provider', 'role_request').eq('status', 'pending')
    .order('created_at');
  q = scopeToCouncil(req, q);
  const { data, error } = await q;
  if (sendDbError(res, error)) return;
  res.json(data ?? []);
});

router.post('/auditor-requests/:id/approve', async (req, res) => {
  // Role mutations are superadmin-only — an admin may see the queue but never grant can_audit.
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only.' });
  const { data: r } = await supabase.from('access_requests').select('*').eq('id', req.params.id).single();
  if (!r || r.requested_role !== 'auditor' || r.provider !== 'role_request') return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'Request already processed' });
  if (!sameCouncil(req, r.council_id)) return res.status(404).json({ error: 'Request not found' });

  // Re-validate the professional NOW — the request row is stale. can_audit is valid only on an
  // ACTIVE physician (normalizeCanAudit / the can_audit_physician_only CHECK); a since-promoted
  // (admin/auditor) or deactivated account must not be granted audit rights off an old request.
  const { data: prof } = await supabase.from('professionals')
    .select('id, role, status').eq('id', r.auth_user_id).maybeSingle();
  if (!prof) return res.status(404).json({ error: 'Professional not found' });
  if (prof.role !== 'physician' || prof.status !== 'active') {
    return res.status(409).json({ error: 'Auditor rights apply only to an active physician.' });
  }

  // Claim the request atomically (pending -> approved) so a concurrent approve+reject can't both
  // act and leave can_audit granted on a 'rejected' request.
  const { data: claimed } = await supabase.from('access_requests')
    .update({ status: 'approved', reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('status', 'pending').select('id');
  if (!claimed?.length) return res.status(409).json({ error: 'Request already processed' });

  const { error: upErr } = await supabase.from('professionals').update({ can_audit: true }).eq('id', r.auth_user_id);
  if (sendDbError(res, upErr)) return;
  res.json({ ok: true, professional_id: r.auth_user_id, can_audit: true });
});

router.post('/auditor-requests/:id/reject', async (req, res) => {
  // Same lock as /approve: deciding a role request is superadmin-only.
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only.' });
  const { data: r } = await supabase.from('access_requests').select('*').eq('id', req.params.id).single();
  if (!r || r.requested_role !== 'auditor' || r.provider !== 'role_request') return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'Request already processed' });
  if (!sameCouncil(req, r.council_id)) return res.status(404).json({ error: 'Request not found' });
  // Atomic claim (pending -> rejected) — mirror /approve so a concurrent approve+reject can't race.
  const { data: claimed, error } = await supabase.from('access_requests')
    .update({ status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('status', 'pending').select('id');
  if (sendDbError(res, error)) return;
  if (!claimed?.length) return res.status(409).json({ error: 'Request already processed' });
  res.json({ ok: true });
});

router.get('/stats', async (req, res) => {
  const includeTest = req.query.include_test === 'true';
  const councilId = req.user.role === 'admin' ? req.user.council_id : null;
  // SQL GROUP BY via RPC (no whole-table load). Fall back to the JS count pre-migration.
  const { data: rows, error } = await supabase.rpc('cle_status_counts', { p_council: councilId, p_include_test: includeTest });
  if (!error && Array.isArray(rows)) {
    const counts = {}; let total = 0;
    for (const r of rows) { counts[r.status] = Number(r.n); total += Number(r.n); }
    return res.json({ total, ...counts });
  }
  let q = supabase.from('cles').select('status');
  if (!includeTest) q = q.eq('is_test', false);
  const { data: cles } = await scopeToCouncil(req, q);
  const counts = (cles ?? []).reduce((acc, p) => { acc[p.status] = (acc[p.status] ?? 0) + 1; return acc; }, {});
  res.json({ total: cles?.length ?? 0, ...counts });
});

// Per-physician score explorer (admin + superadmin): the physician + all their sessions, each joined
// with its AI evaluation and auditor scores, plus the LPDP trajectory and folder names. Powers the
// "click a user → see their scores" view and the by-status / by-case / by-folder groupings.
router.get('/physicians/:id/profile', async (req, res) => {
  const { data: physician } = await supabase
    .from('professionals').select('id, full_name_th, full_name_en, specialty, pseudonym, role, council_id')
    .eq('id', req.params.id).single();
  if (!physician) return res.status(404).json({ error: 'Not found' });
  // An admin may only inspect physicians in their own council.
  if (!sameCouncil(req, physician.council_id)) return res.status(404).json({ error: 'Not found' });

  const { data: cles } = await supabase
    .from('cles')
    .select('id, status, chief_complaint, turn_count, token_count, started_at, folder_id')
    .eq('physician_id', req.params.id).order('started_at').limit(500);   // defensive cap on a prolific physician
  const ids = (cles ?? []).map(p => p.id);
  const empty = Promise.resolve({ data: [] });

  const [{ data: ai }, { data: audits }, { data: folders }, { data: lpdp }] = await Promise.all([
    ids.length ? supabase.from('ai_evaluations').select('cle_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('cle_id', ids) : empty,
    ids.length ? supabase.from('audit_scores').select('cle_id, auditor_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('cle_id', ids) : empty,
    supabase.from('cle_folders').select('id, name').eq('physician_id', req.params.id),
    supabase.from('lpdp_snapshots').select('cle_id, composite_score, domain_scores, snapshot_at').eq('physician_id', req.params.id).order('snapshot_at'),
  ]);

  const aiBy = Object.fromEntries((ai ?? []).map(e => [e.cle_id, e]));

  // Auditor names — WHO scored each session, for admin accountability/traceability on this internal
  // profile view. (Distinct from GET /export, which pseudonymizes auditors as A-<hash> because that
  // file leaves the system.) Auditors are study staff, not research subjects.
  const auditorIds = [...new Set((audits ?? []).map(s => s.auditor_id))];
  const { data: auditorRows } = auditorIds.length
    ? await supabase.from('professionals').select('id, full_name_th, full_name_en').in('id', auditorIds)
    : { data: [] };
  const auditorName = Object.fromEntries((auditorRows ?? []).map(a => [a.id, a.full_name_th || a.full_name_en]));

  const auditsBy = {};
  (audits ?? []).forEach(s => { (auditsBy[s.cle_id] ??= []).push({ ...s, auditor_name: auditorName[s.auditor_id] ?? null }); });
  const folderName = Object.fromEntries((folders ?? []).map(f => [f.id, f.name]));

  const sessions = (cles ?? []).map(p => ({
    ...p,
    folder_name: p.folder_id ? (folderName[p.folder_id] ?? null) : null,
    ai: aiBy[p.id] ?? null,
    audits: auditsBy[p.id] ?? [],
  }));

  res.json({ physician, sessions, lpdp: lpdp ?? [] });
});

// Defensive sweep: re-evaluate any session that passed the gate but never got an AI score (e.g. a
// transient RIMPL failure exhausted the retries). Keeps a study from silently losing credit-eligible
// sessions. Safe + idempotent (skips anything already evaluated). The same sweep also runs on a
// schedule (RECONCILE_INTERVAL_MS in index.js); this endpoint is the manual/on-demand trigger.
router.post('/reconcile-evaluations', async (req, res) => {
  // Sweeps EVERY council (and burns AI spend) — ops-level, so superadmin only. The 6h
  // scheduler in index.js covers the routine case; admins don't need the manual trigger.
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only.' });
  res.json(await reconcileEvaluations());
});

// De-identified study export (admin + superadmin): pseudonym-keyed sessions + AI + auditor scores.
// Only pseudonyms (P-NNN) leave here — no names/emails. For the research team.
router.get('/export', async (req, res) => {
  // Page-bounded: pull one page of sessions, then ONLY that page's physicians + scores (so the
  // research export streams in chunks instead of loading every physician + cle at 80K scale).
  // Default to REAL sessions only — test sessions must not silently pollute the research export
  // (mirrors /stats + /icc). ?include_test=true opts them in, and is_test is emitted so they're
  // distinguishable either way.
  const includeTest = req.query.include_test === 'true';
  const { limit, offset } = pageParams(req, { def: 200, max: 1000 });
  let pq = supabase.from('cles')
    .select('id, cle_code, physician_id, episode_number, socratic_active, socratic_reason, status, turn_count, token_count, duration_seconds, started_at, is_test', { count: 'exact' });
  if (!includeTest) pq = pq.eq('is_test', false);
  pq = scopeToCouncil(req, pq);
  const { data: cles, count, error: clesErr } = await pq.order('started_at').range(offset, offset + limit - 1);
  if (sendDbError(res, clesErr)) return; // a DB error must not look like an empty research export
  const cleIds = (cles ?? []).map(p => p.id);
  const physIds = [...new Set((cles ?? []).map(p => p.physician_id))];
  const empty = Promise.resolve({ data: [] });
  const { data: pros } = await (physIds.length ? supabase.from('professionals').select('id, pseudonym').in('id', physIds) : empty);
  const pseudo = Object.fromEntries((pros ?? []).map(p => [p.id, p.pseudonym]));
  const { data: ai } = await (cleIds.length ? supabase.from('ai_evaluations').select('cle_id, composite_score, d1,d2,d3,d4,d5,d6,d7, model_version, prompt_version, rubric_version').in('cle_id', cleIds) : empty);
  const aiBy = Object.fromEntries((ai ?? []).map(e => [e.cle_id, e]));
  const { data: audits } = await (cleIds.length ? supabase.from('audit_scores').select('cle_id, auditor_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('cle_id', cleIds) : empty);
  // Auditors are study staff, not research subjects — pseudonymize their id to the protocol's
  // EXP-NNN code (CLICS §9.2). Fall back to a stable A-<hash> only if an auditor predates the code
  // backfill, so the export never carries a reversible identity.
  const audIds = [...new Set((audits ?? []).map(s => s.auditor_id))];
  const { data: auditors } = await (audIds.length ? supabase.from('professionals').select('id, exp_code').in('id', audIds) : empty);
  const expCode = Object.fromEntries((auditors ?? []).map(a => [a.id, a.exp_code]));
  const auditorTag = (id) => expCode[id] || ('A-' + createHash('sha256').update(String(id)).digest('hex').slice(0, 8));
  const audBy = {};
  (audits ?? []).forEach(s => { (audBy[s.cle_id] ??= []).push({ auditor: auditorTag(s.auditor_id), composite: Number(s.composite_score), d1: s.d1, d2: s.d2, d3: s.d3, d4: s.d4, d5: s.d5, d6: s.d6, d7: s.d7 }); });
  const sessions = (cles ?? []).map(p => {
    const e = aiBy[p.id];
    return {
      cle_id: p.id, cle_code: p.cle_code ?? null, physician: pseudo[p.physician_id] ?? null,
      // Experimental-design fields (CLICS §6.4) so the research team can analyse the Socratic effect.
      episode_number: p.episode_number ?? null, socratic_active: p.socratic_active ?? false, socratic_reason: p.socratic_reason ?? null,
      status: p.status, is_test: p.is_test,
      turns: p.turn_count, tokens: p.token_count, duration_seconds: p.duration_seconds, started_at: p.started_at,
      ai_composite: e ? Number(e.composite_score) : null,
      ai_domains: e ? { d1: e.d1, d2: e.d2, d3: e.d3, d4: e.d4, d5: e.d5, d6: e.d6, d7: e.d7 } : null,
      // §10.2 locked-version provenance, per evaluation — lets the team verify scoring stability.
      evaluator_version: e ? { model: e.model_version, prompt: e.prompt_version, rubric: e.rubric_version } : null,
      auditor_scores: audBy[p.id] ?? [],
    };
  });
  res.setHeader('X-Total-Count', count ?? 0);
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'export', targetType: 'export',
    councilId: req.user.council_id, metadata: { n: sessions.length, include_test: includeTest, offset } });
  res.json({ exported_at: new Date().toISOString(), n: sessions.length, total: count ?? 0, limit, offset, sessions });
});

// Compensation report (admin + superadmin): per-physician payout = min(passed CLEs, 3) × ฿500,
// capped at ฿1500 (CLICS_Proposal §12 / Appendix 03). REPORTING ONLY — no payment is processed.
// Derived from cles (no schema change). Pilot-scale: passed non-test CLEs are ≤ ~225, well under the
// PostgREST 1000-row cap; revisit with an RPC if the cohort ever grows past that.
const COMP_RATE_THB = 500, COMP_CAP_CLES = 3;
router.get('/compensation', async (req, res) => {
  let q = supabase.from('cles').select('physician_id').eq('status', 'cle_pass').eq('is_test', false);
  q = scopeToCouncil(req, q);
  const { data: rows, error } = await q;
  if (sendDbError(res, error)) return;
  const countByPhys = {};
  for (const r of rows ?? []) countByPhys[r.physician_id] = (countByPhys[r.physician_id] ?? 0) + 1;
  const physIds = Object.keys(countByPhys);
  const empty = Promise.resolve({ data: [] });
  const { data: pros } = await (physIds.length ? supabase.from('professionals').select('id, pseudonym').in('id', physIds) : empty);
  const pseudo = Object.fromEntries((pros ?? []).map(p => [p.id, p.pseudonym]));
  const recipients = physIds.map((id) => {
    const completed = Math.min(countByPhys[id], COMP_CAP_CLES);
    return { physician: pseudo[id] ?? null, completed_cles: completed, amount_thb: completed * COMP_RATE_THB };
  }).sort((a, b) => String(a.physician).localeCompare(String(b.physician)));
  const total_thb = recipients.reduce((a, r) => a + r.amount_thb, 0);
  res.json({ rate_thb_per_cle: COMP_RATE_THB, cap_cles: COMP_CAP_CLES, n: recipients.length, total_thb, recipients });
});

// ---- Invite links (A/B create a physician or auditor bound to an email; A may also ----------
// ---- invite an admin — see the superadmin-only guard below) --------------------------------

// Create an invite. Admin (B) may only invite into their OWN council; superadmin (A) any council.
// Slot-prechecked so we never issue an invite that can't be redeemed. Returns the raw accept
// link ONCE (the DB stores only the token hash).
router.post('/invites', async (req, res) => {
  const parsed = InviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, role, council_id, specialty_id, position } = parsed.data;
  const can_audit = normalizeCanAudit(role, parsed.data.can_audit); // Special = physician+auditor
  // Creating a council ADMIN is a role-power grant — superadmin only (an admin must never be
  // able to mint another admin). Mirrors the auditor-request approve/reject guard.
  if (role === 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin only.' });
  }
  if (!sameCouncil(req, council_id)) return res.status(403).json({ error: 'You can only invite into your own council.' });

  // Specialty (under council) is required for the invited role when the council has any.
  const spec = await checkSpecialty(role, council_id, specialty_id);
  if (!spec.ok) return res.status(400).json({ error: spec.error });

  const slot = await assertSlotAvailable(role, council_id);
  if (!slot.ok) return res.status(409).json({ error: slot.error });

  const { raw, hash } = newInviteToken();
  const expires_at = new Date(Date.now() + INVITE_EXPIRY_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.from('invites').insert({
    token_hash: hash, email, role, can_audit, council_id, specialty_id: specialty_id ?? null,
    position: position ?? null, created_by: req.user.id, status: 'pending', expires_at,
  }).select('id, email, role, can_audit, council_id, specialty_id, position, status, expires_at, created_at').single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A pending invite for this email and role already exists.' });
    return res.status(500).json({ error: error.message });
  }

  // Deliver the accept link by email — FAIL-SOFT: the invite is already created, so a mail
  // failure must never fail the request; the admin still gets accept_url to share manually.
  const accept_url = `${SITE_URL}/invite.html?token=${raw}`;
  let email_sent = false;
  if (isMailerEnabled()) {
    const { data: council } = await supabase.from('councils').select('name_th, name_en').eq('id', council_id).maybeSingle();
    email_sent = await sendInviteEmail({
      to: email, acceptUrl: accept_url, role, can_audit,
      councilNameTh: council?.name_th, councilNameEn: council?.name_en, expiresAt: expires_at,
    });
    if (email_sent) {
      // Best-effort stamp; never break invite creation over it (e.g. a pre-migration DB) — but do
      // log: supabase-js RESOLVES with { error }, so a silent .then would hide real failures.
      await supabase.from('invites').update({ email_sent_at: new Date().toISOString() }).eq('id', data.id)
        .then(({ error: e }) => { if (e) console.error('[invites] email_sent_at stamp failed:', e.message); },
              (e) => console.error('[invites] email_sent_at stamp failed:', e.message));
    }
  }
  res.status(201).json({ ...data, accept_url, email_sent });
});

// List invites (admins see only their council; superadmin all). Optional ?status= filter.
router.get('/invites', async (req, res) => {
  let q = supabase.from('invites')
    .select('id, email, role, can_audit, council_id, status, expires_at, accepted_at, email_sent_at, created_at')
    .order('created_at', { ascending: false });
  if (typeof req.query.status === 'string') q = q.eq('status', req.query.status);
  q = scopeToCouncil(req, q);
  const { data, error } = await q;
  if (sendDbError(res, error)) return;
  res.json(data ?? []);
});

// Delete an invite (own council for admins). A PENDING invite is revoked — it stays in the
// history so the admin can see it was cancelled. Hard-removing a history row (revoked /
// accepted / expired) requires the EXPLICIT ?purge=1 flag: without it, a double-clicked
// Revoke (first click revokes, second lands on the now-revoked row) must NOT escalate
// into silently destroying the history entry.
router.delete('/invites/:id', async (req, res) => {
  const { data: inv } = await supabase.from('invites').select('id, council_id, status').eq('id', req.params.id).single();
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (!sameCouncil(req, inv.council_id)) return res.status(404).json({ error: 'Not found' });
  if (inv.status === 'pending') {
    const { error } = await supabase.from('invites').update({ status: 'revoked' }).eq('id', req.params.id);
    if (sendDbError(res, error)) return;
    return res.json({ ok: true });
  }
  if (req.query.purge !== '1') {
    return res.status(409).json({ error: 'Invite already processed — pass ?purge=1 to remove it from history.' });
  }
  const { error } = await supabase.from('invites').delete().eq('id', req.params.id);
  if (sendDbError(res, error)) return;
  res.json({ deleted: true });
});

// (License verification + the manual-verify override were retired 2026-06-09 — onboarding is
// Google self-service + A/B invites, and an invite activates an auditor with no license gate.)

module.exports = router;
