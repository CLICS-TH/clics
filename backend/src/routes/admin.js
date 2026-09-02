const { Router } = require('express');
const { createHash } = require('crypto');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { AssignSchema } = require('../lib/schemas');
const { enqueueEvaluation } = require('../services/ple-finalize');
const { reconcileEvaluations } = require('../services/reconcile');
const { minAuditorsPerPle, privacyReviewRequired } = require('../lib/settings');
const identity = require('../services/identity');
const { whereCleared, isCleared, CLEARED, DECISIONS } = require('../lib/privacy-review');
const { stratifiedSample, assignRoundRobin } = require('../services/audit-sampling');
const { scanPle } = require('../services/integrity-scan');
const { sendDbError, pageParams } = require('../lib/db-helpers');
const { assertSlotAvailable } = require('../lib/accounts');
const { newInviteToken } = require('../lib/invite-token');
const { isMailerEnabled, sendInviteEmail } = require('../lib/mailer');
const { normalizeCanAudit } = require('../lib/dual-role');
const { POSITIONS, checkSpecialty } = require('../lib/specialties');
const { logEvent } = require('../lib/audit');
const { compRateCap, cappedPles, PIS7_DIMS } = require('../lib/compensation');
const { COMPLETED_STATUSES } = require('../lib/ple-status');
const ExcelJS = require('exceljs');

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
// council_id column (ples, professionals, audit_scores, access_requests) for an admin caller;
// sameCouncil() guards single-row actions.
const scopeToCouncil = (req, query) =>
  req.user.role === 'admin' ? query.eq('council_id', req.user.council_id) : query;
const sameCouncil = (req, councilId) =>
  req.user.role !== 'admin' || councilId === req.user.council_id;

// Specialty is the layer UNDER council: an admin is also pinned to their own specialty (the
// pipeline is council × specialty). Applied ONLY to queries on tables carrying a specialty_id
// (ples, professionals) — NOT access_requests, which has none. Skipped when the admin has no
// specialty (e.g. a non-medical council), so it never narrows to the broken `specialty_id is null`.
const scopeBySpecialty = (req, query) =>
  req.user.role === 'admin' && req.user.specialty_id
    ? query.eq('specialty_id', req.user.specialty_id) : query;
const sameSpecialty = (req, specialtyId) =>
  req.user.role !== 'admin' || !req.user.specialty_id || specialtyId === req.user.specialty_id;

// (The access-request approval schemas were retired with the request-access flow — see below.)

router.get('/ples', async (req, res) => {
  const { status } = req.query;
  const { limit, offset } = pageParams(req);   // paginated — never pull the whole 400K-row table
  let query = supabase.from('ples')
    .select('*, professionals!ples_physician_id_fkey(full_name_th, full_name_en, specialty), specialties(name_th, name_en, code)', { count: 'exact' });
  // 'in_progress' is a UI bucket spanning three live statuses; others map 1:1. Filtered server-side
  // so pagination + the Stats drill-down stay correct (not just over already-loaded rows).
  const STATUS_BUCKETS = { in_progress: ['active', 'ended', 'ple_pass'] };
  // Own-property lookup only — a crafted ?status=constructor/toString would otherwise resolve to an
  // inherited Object.prototype function and 500 the query.
  const bucket = status && Object.hasOwn(STATUS_BUCKETS, status) ? STATUS_BUCKETS[status] : null;
  if (status) query = bucket ? query.in('status', bucket) : query.eq('status', status);
  // The PLE list is the assignment surface — test sessions MUST appear here so they can be
  // assigned/scored (feeding the audit system). They carry is_test so the UI can badge them;
  // pass ?only_real=true to hide them. Headline counts live in /stats + /icc (real-only there).
  if (req.query.only_real === 'true') query = query.eq('is_test', false);
  // Optional ?specialty= filter — narrows a superadmin's view to one specialty (harmless for an
  // admin: scopeBySpecialty already pins them, so a foreign id just yields 0 rows).
  if (typeof req.query.specialty === 'string' && req.query.specialty) query = query.eq('specialty_id', req.query.specialty);
  query = scopeBySpecialty(req, scopeToCouncil(req, query));
  const { data, error, count } = await query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (sendDbError(res, error)) return;
  // How many auditors are assigned to each row (multi-auditor pilot) — one extra query for the page so
  // the assign UI can show "Assigned (N)" and keep offering the dropdown until enough raters are added.
  const ids = (data ?? []).map(r => r.id);
  const assignCounts = {};
  // SUBMITTED scores, which is a different number from assignments. An auditor can be assigned and
  // never score; the manuscript's ">= 3 blinded auditors" is a claim about scores that exist, not
  // invitations that were sent, so the target has to be measured against audit_scores.
  const scoreCounts = {};
  if (ids.length) {
    const [{ data: aRows }, { data: sRows }] = await Promise.all([
      supabase.from('audit_assignments').select('ple_id').in('ple_id', ids),
      supabase.from('audit_scores').select('ple_id').in('ple_id', ids),
    ]);
    for (const a of aRows ?? []) assignCounts[a.ple_id] = (assignCounts[a.ple_id] ?? 0) + 1;
    for (const s of sRows ?? []) scoreCounts[s.ple_id] = (scoreCounts[s.ple_id] ?? 0) + 1;
  }
  const minAuditors = await minAuditorsPerPle();
  res.setHeader('X-Total-Count', count ?? 0);   // body stays an array (backward-compatible); total in header
  res.setHeader('X-Min-Auditors', minAuditors); // the target the flags below were computed against
  res.json((data ?? []).map(r => {
    const scored = scoreCounts[r.id] ?? 0;
    return {
      ...r,
      assignment_count: assignCounts[r.id] ?? 0,
      scored_count: scored,
      min_auditors: minAuditors,
      // A BADGE, not a gate. Nothing downstream reads this to withhold a result.
      meets_auditor_target: scored >= minAuditors,
    };
  }));
});

router.get('/ples/flagged', async (req, res) => {
  let query = supabase
    .from('ples')
    .select('*, professionals!ples_physician_id_fkey(full_name_th, full_name_en), specialties(name_th, name_en, code)')
    .eq('status', 'ple_flag_t2');
  query = scopeBySpecialty(req, scopeToCouncil(req, query));
  const { data, error } = await query.order('ended_at');
  if (sendDbError(res, error)) return;
  res.json(data);
});

// Investigate a session transcript (admin scoped to own council; superadmin any council).
router.get('/ples/:id/transcript', async (req, res) => {
  const { data: ple, error } = await supabase.from('ples')
    .select('id, council_id, specialty_id, status, chief_complaint, title, started_at, ended_at, turn_count, token_count, professionals!ples_physician_id_fkey(full_name_th, full_name_en, pseudonym), specialties(name_th, name_en, code)')
    .eq('id', req.params.id).maybeSingle();
  // A query/embed failure (e.g. an ambiguous-FK embed after a table rename — the PLE→PLE incident)
  // must surface as a 500. maybeSingle() makes "no rows" a clean { data: null, error: null }, so a
  // genuine not-found still 404s below; we must NOT let a query error fall through to that 404, which
  // the dashboard misreads as "outside your council".
  if (sendDbError(res, error)) return;
  if (!ple) return res.status(404).json({ error: 'Not found' });
  // Admin is scoped to own council AND own specialty; superadmin (no council) sees all.
  if (!sameCouncil(req, ple.council_id) || !sameSpecialty(req, ple.specialty_id)) return res.status(404).json({ error: 'Not found' });

  const { data: messages, error: msgErr } = await supabase.from('messages')
    .select('role, content, refs, socratic_question, created_at')
    .eq('ple_id', req.params.id).order('created_at');
  if (sendDbError(res, msgErr)) return;   // a messages-fetch error must not silently render an empty transcript
  res.json({ ple, messages: messages ?? [] });
});

// ---- Identity verification (CREC082 ICF §4) --------------------------------------------------
// The administrator's side. The licence lookup attached to a submission is EVIDENCE — it can show
// that a licence exists and the name on it matches, not that the person who typed it is that
// person — so a human makes the call. ThaID, when it lands, is the route that proves possession and
// will not need this queue.
//
// NOTE what is absent: no endpoint here returns a national ID, encrypted or otherwise. The reviewer
// sees the last four digits, which is enough to confirm they are looking at the right record and
// not enough to be the identifier.

router.get('/identity-queue', async (req, res) => {
  const { limit, offset } = pageParams(req);
  const status = ['pending', 'verified', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  let q = supabase.from('identity_verifications')
    .select('id, professional_id, method, status, national_id_last4, license_number, license_check_status, license_check_source, submitted_at, decided_at, reject_reason, professionals!identity_verifications_professional_id_fkey(full_name_th, full_name_en, pseudonym, council_id, specialty_id)', { count: 'exact' })
    .eq('status', status);
  const { data, count, error } = await q.order('submitted_at', { ascending: true }).range(offset, offset + limit - 1);
  if (sendDbError(res, error)) return;
  // Council scoping is applied in JS: the council lives on the embedded professional, not on
  // identity_verifications, and denormalising it onto this table would put another copy of a
  // physician's affiliation next to their national ID for no gain.
  const rows = (data ?? []).filter(r => sameCouncil(req, r.professionals?.council_id ?? null));
  res.json({ verifications: rows, limit, offset, total: count ?? 0 });
});

const IdentityDecisionSchema = z.object({
  decision: z.enum(['verified', 'rejected']),
  reason: z.string().trim().max(500).optional(),
});

router.post('/identity/:id/decide', async (req, res) => {
  const parsed = IdentityDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { decision, reason } = parsed.data;
  // A rejection the physician cannot act on is a dead end — they resubmit the same thing and are
  // refused again. Say what was wrong.
  if (decision === 'rejected' && !reason) {
    return res.status(400).json({ error: 'A reason is required when rejecting.', code: 'reason_required' });
  }

  const { data: row, error: rErr } = await supabase.from('identity_verifications')
    .select('id, professional_id, status, professionals!identity_verifications_professional_id_fkey(council_id)')
    .eq('id', req.params.id).maybeSingle();
  if (sendDbError(res, rErr)) return;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!sameCouncil(req, row.professionals?.council_id ?? null)) return res.status(404).json({ error: 'Not found' });

  const out = await identity.decide({ verificationId: req.params.id, decidedBy: req.user.id, decision, reason });
  if (!out.ok) return res.status(500).json({ error: 'Could not record the decision.', code: out.code });

  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'identity.decide',
    targetType: 'professional', targetId: row.professional_id,
    councilId: row.professionals?.council_id ?? null,
    metadata: { decision, from: row.status, has_reason: !!reason } });
  res.json({ ok: true, status: out.status });
});

// ---- Privacy review (CREC082 ICF §5-6) -----------------------------------------------------
// The human half of the privacy gate. rimpl's pii-filter screens the OUTBOUND cloud call; this is a
// person reading the stored transcript before any expert rater sees it. The protocol commits to
// doing this for 100% of sessions, and to quarantining / de-identifying / excluding anything that
// carries patient data — so the queue is "everything scored but not yet cleared", not a sample.

// The queue. Council- and specialty-scoped like every other admin read, so a reviewer only ever
// sees sessions they are already entitled to investigate.
router.get('/privacy-queue', async (req, res) => {
  const { limit, offset } = pageParams(req);
  let q = supabase.from('ples')
    // privacy_review_note is SELECTED, not decorative: the dashboard renders it, and an auditor who
    // stops an assessment to report a suspected identifier puts their reason here. Without it the
    // reviewer sees a quarantined session and no statement of why — which is the whole report.
    .select('id, ple_code, council_id, specialty_id, status, privacy_review_status, privacy_review_note, privacy_reviewed_at, privacy_concern_open, privacy_concern_by, privacy_concern_at, privacy_concern_note, ended_at, turn_count, token_count, is_test', { count: 'exact' })
    .eq('status', 'evaluated');
  // Default view is the work: sessions nobody has looked at yet. `?status=quarantined` etc. lets a
  // reviewer revisit their own earlier decisions, which they must be able to do — a quarantine that
  // cannot be reversed after redaction would silently destroy usable data.
  //
  // Whitelisted, and unrecognised values fall back to 'pending' rather than through. An arbitrary
  // status matched no rows and rendered as "every session has been reviewed", which is the most
  // misleading answer a privacy queue can give.
  const pStatus = DECISIONS.includes(req.query.status) ? req.query.status : 'pending';
  q = q.eq('privacy_review_status', pStatus);
  q = scopeBySpecialty(req, scopeToCouncil(req, q));
  // Oldest first: the queue is work to clear, and a session waiting longest is the one holding up
  // its physician's result and its auditors' assignment.
  const { data, count, error } = await q.order('ended_at', { ascending: true }).range(offset, offset + limit - 1);
  if (sendDbError(res, error)) return;
  res.json({ ples: data ?? [], limit, offset, total: count ?? 0 });
});

const PrivacyDecisionSchema = z.object({
  decision: z.enum(['passed', 'redacted', 'quarantined', 'excluded']),
  // Free text, and required for anything that is not a clean pass. A quarantine with no stated
  // reason is unreviewable later, and "why was this session excluded?" is a question the ethics
  // committee is entitled to ask about any row.
  note: z.string().trim().max(2000).optional(),
});

router.post('/ples/:id/privacy-review', async (req, res) => {
  const parsed = PrivacyDecisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { decision, note } = parsed.data;
  if (decision !== 'passed' && !note) {
    return res.status(400).json({ error: 'A note is required for anything other than a clean pass.', code: 'note_required' });
  }

  const { data: ple, error: cErr } = await supabase.from('ples')
    .select('id, ple_code, council_id, specialty_id, privacy_review_status').eq('id', req.params.id).maybeSingle();
  if (sendDbError(res, cErr)) return;
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (!sameCouncil(req, ple.council_id) || !sameSpecialty(req, ple.specialty_id)) return res.status(404).json({ error: 'Not found' });

  // A decision RESOLVES any open rater report — that is what "until it is resolved" means for the
  // auditor queue. The reporter's own columns are left intact: who raised it and what they said stay
  // on the record after the reviewer has answered.
  const { error } = await supabase.from('ples').update({
    privacy_review_status: decision,
    privacy_reviewed_at: new Date().toISOString(),
    privacy_reviewed_by: req.user.id,
    privacy_review_note: note ?? null,
    privacy_concern_open: false,
  }).eq('id', req.params.id);
  if (sendDbError(res, error)) return;

  // Every decision is logged, including a pass. "Who cleared this transcript, and when?" has to be
  // answerable for all 100% of sessions, not only the ones where something was found.
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'ple.privacy_review',
    targetType: 'ple', targetId: ple.ple_code ?? req.params.id, councilId: ple.council_id,
    metadata: { decision, from: ple.privacy_review_status ?? 'pending', has_note: !!note } });
  res.json({ ok: true, privacy_review_status: decision });
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

router.post('/ples/:id/approve', async (req, res) => {
  const { data: ple } = await supabase.from('ples').select('*').eq('id', req.params.id).single();
  // Council check FIRST: a foreign-council id must be an opaque 404 regardless of its status.
  if (!ple || !sameCouncil(req, ple.council_id)) return res.status(404).json({ error: 'Not found' });
  if (ple.status !== 'ple_flag_t2') return res.status(400).json({ error: 'Not a flagged PLE' });

  // Conditional update: a double-clicked Approve must not re-trigger the (paid) AI evaluation.
  // Only the click that actually flips ple_flag_t2 → ple_pass proceeds; any racer gets 409.
  const { data: flipped, error } = await supabase.from('ples')
    .update({ status: 'ple_pass' }).eq('id', req.params.id).eq('status', 'ple_flag_t2').select('id');
  if (sendDbError(res, error)) return;
  if (!flipped?.length) return res.status(409).json({ error: 'Already processed' });

  // ENQUEUE, don't evaluate: the drain loads the transcript (incl. any reflection) and scores it FIFO
  // under the bounded concurrency — the same path as the physician /end flow. See services/eval-drain.js.
  await enqueueEvaluation(req.params.id);
  res.json({ ok: true, evaluation: 'queued' });
});

// Re-run the PIS-7 evaluation for a PLE that passed the gate but whose evaluation never landed
// (e.g. a transient RIMPL error left it stuck at ple_pass with no ai_evaluation). Unlike the
// fire-and-forget /end path, this awaits the result. It refuses to touch an already-evaluated PLE
// (409), so it can only recover stranded sessions — it never re-judges or overrides a score.
router.post('/ples/:id/reevaluate', async (req, res) => {
  const { data: ple } = await supabase.from('ples').select('*').eq('id', req.params.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (!sameCouncil(req, ple.council_id)) return res.status(404).json({ error: 'Not found' });
  if (!['ple_pass', 'evaluated'].includes(ple.status)) {
    return res.status(400).json({ error: 'PLE has not passed the PLE gate' });
  }
  const { data: existing } = await supabase
    .from('ai_evaluations').select('id').eq('ple_id', ple.id).maybeSingle();
  if (existing) return res.status(409).json({ error: 'Already evaluated' });

  const { count: msgCount, error: msgErr } = await supabase
    .from('messages').select('id', { count: 'exact', head: true }).eq('ple_id', ple.id);
  if (sendDbError(res, msgErr)) return;
  if (!msgCount) return res.status(409).json({ error: 'No transcript to evaluate.' });
  // Since the evaluation drain, this no longer scores inline — a second writer would race the drain
  // and could double-score. It puts the recovery at the FRONT of the queue and reports 'queued'; the
  // admin list shows the row flip to 'evaluated' when the drain lands it.
  await enqueueEvaluation(ple.id, { front: true });
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'ple.reevaluate', targetType: 'ple',
    targetId: ple.ple_code ?? ple.id, councilId: ple.council_id });
  res.json({ ok: true, status: 'queued' });
});

router.post('/ples/:id/reject', async (req, res) => {
  // Mirror /approve: council check FIRST (opaque 404), then a conditional flip whose row count
  // distinguishes a real reject from a no-op — the old handler returned {ok:true} for a nonexistent
  // /foreign-council /already-processed /double-clicked id without touching anything.
  const { data: ple } = await supabase.from('ples').select('id, council_id, status').eq('id', req.params.id).single();
  if (!ple || !sameCouncil(req, ple.council_id)) return res.status(404).json({ error: 'Not found' });
  if (ple.status !== 'ple_flag_t2') return res.status(400).json({ error: 'Not a flagged PLE' });

  const { data: flipped, error } = await supabase.from('ples')
    .update({ status: 'ple_fail_t1' }).eq('id', req.params.id).eq('status', 'ple_flag_t2').select('id');
  if (sendDbError(res, error)) return;
  if (!flipped?.length) return res.status(409).json({ error: 'Already processed' });
  res.json({ ok: true });
});

router.post('/ples/:id/assign', async (req, res) => {
  const parsed = AssignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const auditorId = parsed.data.auditor_id;

  const { data: ple } = await supabase.from('ples')
    .select('id, status, council_id, specialty_id, physician_id, privacy_review_status').eq('id', req.params.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (!sameCouncil(req, ple.council_id) || !sameSpecialty(req, ple.specialty_id)) return res.status(404).json({ error: 'Not found' });
  if (ple.status !== 'evaluated') return res.status(400).json({ error: 'PLE is not ready for assignment' });
  // EXPOSURE 1 of 4 (see lib/privacy-review.js). CREC082 promises a human reads every transcript
  // before it reaches an expert rater; handing this one over now would break that promise directly.
  if (!isCleared(ple, await privacyReviewRequired())) {
    return res.status(409).json({
      error: 'This session has not passed privacy review yet.', code: 'privacy_review_pending',
      privacy_review_status: ple.privacy_review_status ?? 'pending',
    });
  }

  // The assignee must be an active auditor (or a "special" can_audit physician) in the SAME
  // council AND specialty, and never the physician who ran the session.
  const { data: auditor } = await supabase.from('professionals')
    .select('id, role, status, council_id, specialty_id, can_audit').eq('id', auditorId).single();
  const canAudit = auditor && (auditor.role === 'auditor' || auditor.can_audit === true);
  if (!auditor || !canAudit || auditor.status !== 'active') {
    return res.status(400).json({ error: 'Not an active auditor' });
  }
  if (auditor.id === ple.physician_id) {
    return res.status(409).json({ error: 'An auditor cannot be assigned to their own session.' });
  }
  if (auditor.council_id !== ple.council_id) {
    return res.status(409).json({ error: 'Cross-council assignment is not allowed.' });
  }
  // Specialty pipeline: an auditor only scores sessions in their own specialty (enforced only when
  // the session carries one, so pre-migration PLEs without a specialty still assign).
  if (ple.specialty_id && auditor.specialty_id !== ple.specialty_id) {
    return res.status(409).json({ error: 'Cross-specialty assignment is not allowed.' });
  }

  // Record the assignment in the join table (multi-auditor pilot — idempotent on (ple_id, auditor_id)),
  // then keep the legacy single-assignee pointer in sync (latest assignee = primary, back-compat with
  // the single-auditor queue/UI). The peer radar reads every auditor's score regardless of who's primary.
  const { error: aErr } = await supabase.from('audit_assignments')
    .upsert({ ple_id: req.params.id, auditor_id: auditorId, assigned_by: req.user.id }, { onConflict: 'ple_id,auditor_id' });
  if (sendDbError(res, aErr)) return;
  const { error } = await supabase.from('ples')
    .update({ auditor_id: auditorId })
    .eq('id', req.params.id)
    .eq('status', 'evaluated')
    .in('privacy_review_status', CLEARED); // EXPOSURE 2 of 4 — re-checked at write time
  if (sendDbError(res, error)) return;
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'ple.assign', targetType: 'ple',
    targetId: req.params.id, councilId: ple.council_id, metadata: { auditor_id: auditorId } });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Integrity flags — deterministic gaming/delegation signals for one PLE.
//
// NEVER exposed to the physician. A flag routes a session to human review; showing it would both tip
// off anyone actually gaming the system and brand an honest physician on a false positive. The
// table's RLS has no physician read policy and these routes sit behind the admin guard.
//
// PII: the scan reads RAW message content, including the physician's OTHER sessions for the
// cross-session signal. That is deliberate and is why the detector is arithmetic rather than a model
// — see the constraint block at the top of services/integrity.js. Nothing here may ever call an AI.
router.post('/ples/:id/integrity-scan', async (req, res) => {
  const { data: ple } = await supabase.from('ples')
    .select('id, council_id, specialty_id, physician_id, is_test').eq('id', req.params.id).maybeSingle();
  if (!ple || !sameCouncil(req, ple.council_id) || !sameSpecialty(req, ple.specialty_id)) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Same scan the session runs automatically at /end (services/integrity-scan.js). Kept as a manual
  // trigger too: a re-scan after a transcript grows, or after a threshold is recalibrated, has to be
  // possible without waiting for the physician to end another session.
  let result;
  try {
    result = await scanPle({ pleId: req.params.id, physicianId: ple.physician_id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'ple.integrity_scan', targetType: 'ple',
    targetId: req.params.id, councilId: ple.council_id,
    metadata: { signals: result.flags.map(f => f.signal), turns: result.scanned_turns, corpus_cles: result.corpus_cles, trigger: 'manual' } });

  res.json({ ok: true, ple_id: req.params.id, flags: result.flags, scanned_turns: result.scanned_turns });
});

/*
 * The integrity queue.
 *
 * WHY IT EXISTS. Until this endpoint the detector was write-only: services/integrity-scan.js has run
 * on every /end since it shipped, flags have accumulated in ple_integrity_flags, and the ONLY way to
 * read one was to already know a PLE id and call /ples/:id/integrity. The flags did have one
 * indirect effect — a flagged PLE is forced into the audit sample — but nobody could see the
 * evidence that forced it. A detector nobody can read is a detector nobody can act on or correct.
 *
 * SEVERITY ORDERS THE WORK, IT DOES NOT RANK PHYSICIANS. Every comment in services/integrity.js
 * applies at this surface too: a flag routes a session to a human and never penalises anyone. The
 * response deliberately carries `evidence` so the reader sees WHY, including the genre counters that
 * separate a pasted case note from pasted reasoning — the distinction that decides whether there is
 * anything wrong at all.
 */
const SEVERITIES = ['low', 'medium', 'high'];

router.get('/integrity-queue', async (req, res) => {
  const { limit, offset } = pageParams(req);

  let fq = supabase.from('ple_integrity_flags').select('ple_id, signal, severity, evidence, created_at');
  // Unrecognised values fall back to "everything" rather than through: a typo'd severity matching no
  // rows would render as "no session has ever been flagged", the most misleading answer here.
  if (SEVERITIES.includes(req.query.severity)) fq = fq.eq('severity', req.query.severity);
  const { data: flags, error: fErr } = await fq.order('created_at', { ascending: false });
  if (sendDbError(res, fErr)) return;

  const byPle = new Map();
  for (const f of flags ?? []) {
    if (!byPle.has(f.ple_id)) byPle.set(f.ple_id, []);
    byPle.get(f.ple_id).push({ signal: f.signal, severity: f.severity, evidence: f.evidence, created_at: f.created_at });
  }
  if (!byPle.size) return res.json({ ples: [], limit, offset, total: 0 });

  // Council/specialty scoping happens HERE, on the PLE rows — the flag table carries no council, so
  // filtering it directly would leak the existence of another council's flagged sessions.
  const { data: ples, error: cErr } = await scopeBySpecialty(req, scopeToCouncil(req,
    supabase.from('ples')
      .select('id, ple_code, council_id, specialty_id, status, physician_id, ended_at, turn_count, token_count, is_test')
      .in('id', [...byPle.keys()])));
  if (sendDbError(res, cErr)) return;

  const rank = { high: 3, medium: 2, low: 1 };
  const worst = (fs) => Math.max(...fs.map((f) => rank[f.severity] ?? 0));
  const rows = (ples ?? [])
    .map((c) => ({ ...c, flags: byPle.get(c.id) ?? [] }))
    // Worst severity first, then most recent — the queue is work, and a 'high' waiting is the
    // session most likely to be holding up a decision.
    .sort((a, b) => worst(b.flags) - worst(a.flags) || String(b.ended_at ?? '').localeCompare(String(a.ended_at ?? '')));

  res.json({ ples: rows.slice(offset, offset + limit), limit, offset, total: rows.length });
});

router.get('/ples/:id/integrity', async (req, res) => {
  const { data: ple } = await supabase.from('ples')
    .select('id, council_id, specialty_id').eq('id', req.params.id).maybeSingle();
  if (!ple || !sameCouncil(req, ple.council_id) || !sameSpecialty(req, ple.specialty_id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const { data, error } = await supabase.from('ple_integrity_flags')
    .select('signal, severity, evidence, created_at').eq('ple_id', req.params.id).order('created_at');
  if (sendDbError(res, error)) return;
  res.json(data ?? []);
});

// ---------------------------------------------------------------------------------------------
// Stratified audit sampling — pick WHICH evaluated PLEs go to human review, by score band.
//
// Replaces convenience sampling (whoever an admin clicked) with a seeded, reproducible, proportional
// draw. The ICC is estimated on the audited subset, so a subset drawn from the middle of the score
// distribution understates disagreement at the extremes — where a credit decision is most contested.
//
// Writes nothing unless asked: dry_run defaults TRUE. Assignment is the irreversible half (it makes
// PLEs visible in auditors' queues), so the default is the half you can look at first.
const SampleSchema = z.object({
  target: z.number().int().min(1).max(500),
  // Any string or number. Recorded in audit_log so the draw can be re-run and checked; a run label
  // ('2026-10-round-1') is more use to a reviewer than an opaque integer.
  seed: z.union([z.string().min(1).max(120), z.number()]).optional(),
  band_count: z.number().int().min(2).max(10).default(5),
  // 'equal' (default) gives every band the same quota, deliberately over-sampling sparse extremes —
  // see services/audit-sampling.allocate. 'proportional' mirrors the cohort distribution instead.
  allocation: z.enum(['equal', 'proportional']).default('equal'),
  auditors_per_cle: z.number().int().min(1).max(10).optional(),
  council_id: z.string().uuid().optional(),
  specialty_id: z.string().uuid().optional(),
  // Default false: a PLE that already has an auditor is already in the audited set, and re-drawing
  // it would spend the sample on coverage that exists.
  include_assigned: z.boolean().default(false),
  include_test: z.boolean().default(false),
  dry_run: z.boolean().default(true),
});

router.post('/ples/sample', async (req, res) => {
  const parsed = SampleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const o = parsed.data;
  const perPle = o.auditors_per_cle ?? await minAuditorsPerPle();

  // --- the pool: evaluated PLEs in scope ------------------------------------------------------
  // EXPOSURE 3 of 4: the sampler draws the audit set. An uncleared session must never enter the
  // pool — being sampled IS being handed to a rater.
  let q = whereCleared(
    supabase.from('ples').select('id, ple_code, council_id, specialty_id, physician_id, auditor_id, is_test')
      .eq('status', 'evaluated'),
    await privacyReviewRequired());
  if (o.council_id) q = q.eq('council_id', o.council_id);
  if (o.specialty_id) q = q.eq('specialty_id', o.specialty_id);
  if (!o.include_test) q = q.eq('is_test', false);
  q = scopeBySpecialty(req, scopeToCouncil(req, q));   // an admin can never reach another council
  const { data: ples, error: cErr } = await q;
  if (sendDbError(res, cErr)) return;
  if (!ples?.length) return res.json({ ok: true, dry_run: o.dry_run, pool_size: 0, selected: [], note: 'No evaluated PLEs match this scope.' });

  const ids = ples.map(c => c.id);
  const [{ data: evals }, { data: assigned }, flagged] = await Promise.all([
    supabase.from('ai_evaluations').select('ple_id, composite_score').in('ple_id', ids),
    supabase.from('audit_assignments').select('ple_id').in('ple_id', ids),
    // Integrity flags force a PLE into the sample. The table arrives with the fraud detector; before
    // that migration it does not exist, and a missing table must not take the sampler down with it.
    supabase.from('ple_integrity_flags').select('ple_id').in('ple_id', ids)
      .then(r => r, () => ({ data: [] })),
  ]);
  const scoreOf = Object.fromEntries((evals ?? []).map(e => [e.ple_id, Number(e.composite_score)]));
  const hasAssignment = new Set((assigned ?? []).map(a => a.ple_id));
  const isFlagged = new Set((flagged?.data ?? []).map(f => f.ple_id));

  const pool = ples
    // No AI score means no band to place it in. Reported rather than dropped in silence.
    .filter(c => Number.isFinite(scoreOf[c.id]))
    .filter(c => o.include_assigned || !hasAssignment.has(c.id))
    .map(c => ({ id: c.id, score: scoreOf[c.id], forced: isFlagged.has(c.id), ple: c }));
  const unscored = ples.length - ples.filter(c => Number.isFinite(scoreOf[c.id])).length;

  const draw = stratifiedSample(pool, {
    target: o.target, seed: o.seed ?? `${req.user.id}:${o.target}`,
    bandCount: o.band_count, allocation: o.allocation,
  });

  // --- the auditors ---------------------------------------------------------------------------
  let aq = supabase.from('professionals').select('id, role, status, council_id, specialty_id, can_audit')
    .eq('status', 'active').or('role.eq.auditor,can_audit.eq.true');
  aq = scopeToCouncil(req, aq);
  const { data: auditors, error: aErr } = await aq;
  if (sendDbError(res, aErr)) return;

  const plan = assignRoundRobin(draw.selected.map(x => x.ple), auditors ?? [], { perPle, seed: draw.seed });

  const summary = {
    ok: true,
    dry_run: o.dry_run,
    seed: draw.seed,
    seed_input: draw.seed_input,
    band_boundaries: draw.per_band,
    allocation: draw.allocation,
    pool_size: draw.pool_size,
    requested: draw.requested,
    selected_count: draw.selected.length,
    forced_included: draw.forced_included,
    shortfall: draw.shortfall,
    unscored_excluded: unscored,
    auditors_per_cle: perPle,
    assignments_planned: plan.assignments.length,
    // Never a silent success: a run that could assign 4 of 40 says so, per PLE and with a reason.
    unassignable: plan.unassignable,
    auditor_load: plan.load,
    selected: draw.selected.map(x => ({ id: x.id, ple_code: x.ple.ple_code, score: x.score, forced: !!x.forced })),
  };

  if (o.dry_run) return res.json(summary);

  if (plan.assignments.length) {
    const { error: insErr } = await supabase.from('audit_assignments')
      .upsert(plan.assignments.map(a => ({ ...a, assigned_by: req.user.id })), { onConflict: 'ple_id,auditor_id' });
    if (sendDbError(res, insErr)) return;

    // Keep the legacy single-assignee pointer in sync, exactly as /ples/:id/assign does — the
    // queue/UI still reads ples.auditor_id as "primary".
    const primary = new Map();
    for (const a of plan.assignments) if (!primary.has(a.ple_id)) primary.set(a.ple_id, a.auditor_id);
    for (const [pleId, auditorId] of primary) {
      await supabase.from('ples').update({ auditor_id: auditorId }).eq('id', pleId).eq('status', 'evaluated');
    }
  }

  // The seed and the band boundaries are the sample's provenance. Without them in the log, "these 40
  // were drawn at random" is an assertion; with them it is a claim anyone can re-run.
  logEvent({
    actorId: req.user.id, actorRole: req.user.role, action: 'ple.sample', targetType: 'ple',
    councilId: o.council_id ?? req.user.council_id ?? null,
    metadata: {
      seed: draw.seed, seed_input: draw.seed_input, band_count: o.band_count, allocation: o.allocation,
      band_boundaries: draw.per_band, target: o.target, selected: draw.selected.map(x => x.id),
      forced_included: draw.forced_included, auditors_per_cle: perPle,
      assignments: plan.assignments.length, unassignable: plan.unassignable.length,
    },
  });

  res.json(summary);
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
  // Optional ?council= / ?specialty= so a superadmin can pre-filter the dropdown to the PLE's
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
  const { data: rows, error } = await supabase.rpc('ple_status_counts', { p_council: councilId, p_include_test: includeTest });
  if (!error && Array.isArray(rows)) {
    const counts = {}; let total = 0;
    for (const r of rows) { counts[r.status] = Number(r.n); total += Number(r.n); }
    return res.json({ total, ...counts });
  }
  let q = supabase.from('ples').select('status');
  if (!includeTest) q = q.eq('is_test', false);
  const { data: ples } = await scopeToCouncil(req, q);
  const counts = (ples ?? []).reduce((acc, p) => { acc[p.status] = (acc[p.status] ?? 0) + 1; return acc; }, {});
  res.json({ total: ples?.length ?? 0, ...counts });
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

  const { data: ples } = await supabase
    .from('ples')
    .select('id, status, chief_complaint, turn_count, token_count, started_at, folder_id')
    .eq('physician_id', req.params.id).order('started_at').limit(500);   // defensive cap on a prolific physician
  const ids = (ples ?? []).map(p => p.id);
  const empty = Promise.resolve({ data: [] });

  const [{ data: ai }, { data: audits }, { data: folders }, { data: lpdp }] = await Promise.all([
    ids.length ? supabase.from('ai_evaluations').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('ple_id', ids) : empty,
    ids.length ? supabase.from('audit_scores').select('ple_id, auditor_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('ple_id', ids) : empty,
    supabase.from('ple_folders').select('id, name').eq('physician_id', req.params.id),
    supabase.from('lpdp_snapshots').select('ple_id, composite_score, domain_scores, snapshot_at').eq('physician_id', req.params.id).order('snapshot_at'),
  ]);

  const aiBy = Object.fromEntries((ai ?? []).map(e => [e.ple_id, e]));

  // Auditor names — WHO scored each session, for admin accountability/traceability on this internal
  // profile view. (Distinct from GET /export, which pseudonymizes auditors as A-<hash> because that
  // file leaves the system.) Auditors are study staff, not research subjects.
  const auditorIds = [...new Set((audits ?? []).map(s => s.auditor_id))];
  const { data: auditorRows } = auditorIds.length
    ? await supabase.from('professionals').select('id, full_name_th, full_name_en').in('id', auditorIds)
    : { data: [] };
  const auditorName = Object.fromEntries((auditorRows ?? []).map(a => [a.id, a.full_name_th || a.full_name_en]));

  const auditsBy = {};
  (audits ?? []).forEach(s => { (auditsBy[s.ple_id] ??= []).push({ ...s, auditor_name: auditorName[s.auditor_id] ?? null }); });
  const folderName = Object.fromEntries((folders ?? []).map(f => [f.id, f.name]));

  const sessions = (ples ?? []).map(p => ({
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
  // research export streams in chunks instead of loading every physician + ple at 80K scale).
  // Default to REAL sessions only — test sessions must not silently pollute the research export
  // (mirrors /stats + /icc). ?include_test=true opts them in, and is_test is emitted so they're
  // distinguishable either way.
  const includeTest = req.query.include_test === 'true';
  const { limit, offset } = pageParams(req, { def: 200, max: 1000 });
  let pq = supabase.from('ples')
    .select('id, ple_code, physician_id, episode_number, socratic_active, socratic_reason, status, turn_count, token_count, duration_seconds, started_at, is_test', { count: 'exact' });
  if (!includeTest) pq = pq.eq('is_test', false);
  pq = scopeToCouncil(req, pq);
  const { data: ples, count, error: plesErr } = await pq.order('started_at').range(offset, offset + limit - 1);
  if (sendDbError(res, plesErr)) return; // a DB error must not look like an empty research export
  const pleIds = (ples ?? []).map(p => p.id);
  const physIds = [...new Set((ples ?? []).map(p => p.physician_id))];
  const empty = Promise.resolve({ data: [] });
  const { data: pros } = await (physIds.length ? supabase.from('professionals').select('id, pseudonym').in('id', physIds) : empty);
  const pseudo = Object.fromEntries((pros ?? []).map(p => [p.id, p.pseudonym]));
  const { data: ai } = await (pleIds.length ? supabase.from('ai_evaluations').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7, model_version, prompt_version, rubric_version').in('ple_id', pleIds) : empty);
  const aiBy = Object.fromEntries((ai ?? []).map(e => [e.ple_id, e]));
  const { data: audits } = await (pleIds.length ? supabase.from('audit_scores').select('ple_id, auditor_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('ple_id', pleIds) : empty);
  // Auditors are study staff, not research subjects — pseudonymize their id to the protocol's
  // EXP-NNN code (CLICS §9.2). Fall back to a stable A-<hash> only if an auditor predates the code
  // backfill, so the export never carries a reversible identity.
  const audIds = [...new Set((audits ?? []).map(s => s.auditor_id))];
  const { data: auditors } = await (audIds.length ? supabase.from('professionals').select('id, exp_code').in('id', audIds) : empty);
  const expCode = Object.fromEntries((auditors ?? []).map(a => [a.id, a.exp_code]));
  const auditorTag = (id) => expCode[id] || ('A-' + createHash('sha256').update(String(id)).digest('hex').slice(0, 8));
  const audBy = {};
  (audits ?? []).forEach(s => { (audBy[s.ple_id] ??= []).push({ auditor: auditorTag(s.auditor_id), composite: Number(s.composite_score), d1: s.d1, d2: s.d2, d3: s.d3, d4: s.d4, d5: s.d5, d6: s.d6, d7: s.d7 }); });
  const sessions = (ples ?? []).map(p => {
    const e = aiBy[p.id];
    return {
      ple_id: p.id, ple_code: p.ple_code ?? null, physician: pseudo[p.physician_id] ?? null,
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

// Multi-sheet XLSX export (superadmin): the study data, one sheet per category (PLEs / AI evaluations /
// Auditor scores / Compensation / Participants). PSEUDONYMIZED (P-NNN physicians, EXP-NNN auditors) —
// honors the PII boundary, so no real names/emails/patient refs leave here. Pilot-scale (capped at CAP
// rows/sheet; truncation is logged + flagged on a Notes sheet, never silent). Audit-logged.
const EXPORT_CAP = 5000;
router.get('/export.xlsx', async (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only.' });
  const includeTest = req.query.include_test === 'true';

  let cq = supabase.from('ples').select('id, ple_code, physician_id, council_id, specialty_id, episode_number, socratic_active, socratic_reason, status, turn_count, token_count, duration_seconds, started_at, is_test', { count: 'exact' });
  if (!includeTest) cq = cq.eq('is_test', false);
  const { data: ples, count, error: plesErr } = await cq.order('started_at').range(0, EXPORT_CAP - 1);
  if (sendDbError(res, plesErr)) return;
  const truncated = (count ?? 0) > EXPORT_CAP;
  const pleIds = (ples ?? []).map(c => c.id);
  const physIds = [...new Set((ples ?? []).map(c => c.physician_id))];
  const empty = Promise.resolve({ data: [] });

  const [{ data: pros }, { data: councils }, { data: specs }, { data: ai }, { data: audits }, { data: allPros }] = await Promise.all([
    physIds.length ? supabase.from('professionals').select('id, pseudonym').in('id', physIds) : empty,
    supabase.from('councils').select('id, code'),
    supabase.from('specialties').select('id, code'),
    pleIds.length ? supabase.from('ai_evaluations').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7, model_version, prompt_version, rubric_version').in('ple_id', pleIds) : empty,
    pleIds.length ? supabase.from('audit_scores').select('ple_id, auditor_id, composite_score, d1,d2,d3,d4,d5,d6,d7, scored_at').in('ple_id', pleIds) : empty,
    supabase.from('professionals').select('pseudonym, exp_code, role, can_audit, council_id, specialty_id, position').limit(EXPORT_CAP),
  ]);
  const pseudo = Object.fromEntries((pros ?? []).map(p => [p.id, p.pseudonym]));
  const councilCode = Object.fromEntries((councils ?? []).map(c => [c.id, c.code]));
  const specCode = Object.fromEntries((specs ?? []).map(s => [s.id, s.code]));
  const pleCode = Object.fromEntries((ples ?? []).map(c => [c.id, c.ple_code ?? c.id]));

  const audIds = [...new Set((audits ?? []).map(s => s.auditor_id))];
  const { data: auditors } = audIds.length ? await supabase.from('professionals').select('id, exp_code').in('id', audIds) : { data: [] };
  const expCode = Object.fromEntries((auditors ?? []).map(a => [a.id, a.exp_code]));
  const auditorTag = (id) => expCode[id] || ('A-' + createHash('sha256').update(String(id)).digest('hex').slice(0, 8));

  // Compensation (computed from THIS page's PLEs — consistent with the export window).
  const { rate, cap } = await compRateCap();
  const passByPhys = {};
  for (const c of ples ?? []) if (COMPLETED_STATUSES.includes(c.status) && !c.is_test) passByPhys[c.physician_id] = (passByPhys[c.physician_id] ?? 0) + 1;

  const wb = new ExcelJS.Workbook();
  const addSheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = columns.map(c => ({ header: c.h, key: c.k, width: c.w ?? 16 }));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(r);
  };

  addSheet('PLEs',
    [{ h: 'PLE', k: 'ple', w: 16 }, { h: 'Physician', k: 'phys', w: 10 }, { h: 'Council', k: 'council', w: 10 }, { h: 'Specialty', k: 'spec', w: 12 }, { h: 'Episode', k: 'ep', w: 8 }, { h: 'Socratic', k: 'soc', w: 9 }, { h: 'Status', k: 'status', w: 12 }, { h: 'Turns', k: 'turns', w: 7 }, { h: 'Tokens', k: 'tokens', w: 9 }, { h: 'Duration (s)', k: 'dur', w: 11 }, { h: 'Started', k: 'started', w: 20 }, { h: 'Test', k: 'test', w: 6 }],
    (ples ?? []).map(c => ({ ple: c.ple_code ?? c.id, phys: pseudo[c.physician_id] ?? '', council: councilCode[c.council_id] ?? '', spec: specCode[c.specialty_id] ?? '', ep: c.episode_number ?? '', soc: c.socratic_active ? 'yes' : 'no', status: c.status, turns: c.turn_count ?? '', tokens: c.token_count ?? '', dur: c.duration_seconds ?? '', started: c.started_at ?? '', test: c.is_test ? 'yes' : 'no' })));

  addSheet('AI evaluations',
    [{ h: 'PLE', k: 'ple', w: 16 }, { h: 'Composite', k: 'comp', w: 10 }, ...PIS7_DIMS.map(d => ({ h: d.toUpperCase(), k: d, w: 6 })), { h: 'Model', k: 'model', w: 18 }, { h: 'Prompt', k: 'prompt', w: 12 }, { h: 'Rubric', k: 'rubric', w: 12 }],
    (ai ?? []).map(e => ({ ple: pleCode[e.ple_id] ?? e.ple_id, comp: Number(e.composite_score), d1: e.d1, d2: e.d2, d3: e.d3, d4: e.d4, d5: e.d5, d6: e.d6, d7: e.d7, model: e.model_version ?? '', prompt: e.prompt_version ?? '', rubric: e.rubric_version ?? '' })));

  addSheet('Auditor scores',
    [{ h: 'PLE', k: 'ple', w: 16 }, { h: 'Auditor', k: 'aud', w: 12 }, { h: 'Composite', k: 'comp', w: 10 }, ...PIS7_DIMS.map(d => ({ h: d.toUpperCase(), k: d, w: 6 })), { h: 'Scored', k: 'scored', w: 20 }],
    (audits ?? []).map(s => ({ ple: pleCode[s.ple_id] ?? s.ple_id, aud: auditorTag(s.auditor_id), comp: Number(s.composite_score), d1: s.d1, d2: s.d2, d3: s.d3, d4: s.d4, d5: s.d5, d6: s.d6, d7: s.d7, scored: s.scored_at ?? '' })));

  addSheet('Compensation',
    [{ h: 'Physician', k: 'phys', w: 10 }, { h: 'Completed PLEs', k: 'done', w: 14 }, { h: 'Amount (THB)', k: 'amt', w: 14 }],
    Object.keys(passByPhys).map(id => { const done = cappedPles(passByPhys[id], cap); return { phys: pseudo[id] ?? '', done, amt: done * rate }; }));

  addSheet('Participants',
    [{ h: 'Code', k: 'code', w: 12 }, { h: 'Role', k: 'role', w: 12 }, { h: 'Can audit', k: 'audit', w: 9 }, { h: 'Council', k: 'council', w: 10 }, { h: 'Specialty', k: 'spec', w: 12 }, { h: 'Position', k: 'pos', w: 14 }],
    (allPros ?? []).map(p => ({ code: p.pseudonym || p.exp_code || '', role: p.role, audit: p.can_audit ? 'yes' : 'no', council: councilCode[p.council_id] ?? '', spec: specCode[p.specialty_id] ?? '', pos: p.position ?? '' })));

  if (truncated) {
    addSheet('Notes', [{ h: 'Note', k: 'note', w: 80 }],
      [{ note: `Truncated: ${count} PLEs match but only the first ${EXPORT_CAP} are included. Narrow the window or raise EXPORT_CAP.` }]);
  }

  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'export.xlsx', targetType: 'export',
    metadata: { ples: pleIds.length, truncated, include_test: includeTest } });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="clics-export.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

// Compensation report (admin + superadmin): per-physician payout = min(passed PLEs, cap) × rate, where
// rate + cap are superadmin-configurable (app_settings comp_rate_thb / comp_cap_cles; cap 0 = no cap).
// Defaults ฿500/PLE, cap 3 (CLICS_Proposal §12 / Appendix 03). PSEUDONYMIZED report — the actual payout
// (real names + decrypted payment details) lives in the superadmin-only /admin/payouts. Derived from
// ples (no schema change). Pilot-scale: completed non-test PLEs are well under the PostgREST 1000-row cap.
router.get('/compensation', async (req, res) => {
  const { rate, cap } = await compRateCap();
  let q = supabase.from('ples').select('physician_id').in('status', COMPLETED_STATUSES).eq('is_test', false);
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
    const completed = cappedPles(countByPhys[id], cap);
    return { physician: pseudo[id] ?? null, completed_cles: completed, amount_thb: completed * rate };
  }).sort((a, b) => String(a.physician).localeCompare(String(b.physician)));
  const total_thb = recipients.reduce((a, r) => a + r.amount_thb, 0);
  res.json({ rate_thb_per_cle: rate, cap_cles: cap, n: recipients.length, total_thb, recipients });
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
