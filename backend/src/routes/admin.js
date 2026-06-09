const { Router } = require('express');
const { createHash } = require('crypto');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { AssignSchema } = require('../lib/schemas');
const { triggerEvaluation } = require('../services/ple-evaluation');
const { sendDbError, pageParams } = require('../lib/db-helpers');
const { assertSlotAvailable, nextPseudonym } = require('../lib/accounts');
const { newInviteToken } = require('../lib/invite-token');

const router = Router();
router.use(verifyJwt, requireRole('admin', 'superadmin'));

const INVITE_EXPIRY_DAYS = parseInt(process.env.INVITE_EXPIRY_DAYS || '7', 10);
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';
const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['physician', 'auditor']),
  council_id: z.string().uuid(),
});

// Admins are "directors" of exactly one council and see only that council's data; the
// superadmin spans all councils. scopeToCouncil() narrows any query on a table carrying a
// council_id column (ples, professionals, audit_scores, access_requests) for an admin caller;
// sameCouncil() guards single-row actions.
const scopeToCouncil = (req, query) =>
  req.user.role === 'admin' ? query.eq('council_id', req.user.council_id) : query;
const sameCouncil = (req, councilId) =>
  req.user.role !== 'admin' || councilId === req.user.council_id;

// Auditors are INVITE-ONLY (an A/B invite activates them; there is no license gate), so the legacy
// access-request approval can grant only admin/physician — never auditor.
const ApproveSchema = z.object({ granted_role: z.enum(['admin', 'physician']).optional() });
const RejectSchema = z.object({ note: z.string().max(500).optional() });

router.get('/ples', async (req, res) => {
  const { status } = req.query;
  const { limit, offset } = pageParams(req);   // paginated — never pull the whole 400K-row table
  let query = supabase.from('ples')
    .select('*, professionals!ples_physician_id_fkey(full_name_th, full_name_en, specialty)', { count: 'exact' });
  // 'in_progress' is a UI bucket spanning three live statuses; others map 1:1. Filtered server-side
  // so pagination + the Stats drill-down stay correct (not just over already-loaded rows).
  const STATUS_BUCKETS = { in_progress: ['active', 'ended', 'cle_pass'] };
  if (status) query = STATUS_BUCKETS[status] ? query.in('status', STATUS_BUCKETS[status]) : query.eq('status', status);
  // The PLE list is the assignment surface — test sessions MUST appear here so they can be
  // assigned/scored (feeding the audit system). They carry is_test so the UI can badge them;
  // pass ?only_real=true to hide them. Headline counts live in /stats + /icc (real-only there).
  if (req.query.only_real === 'true') query = query.eq('is_test', false);
  query = scopeToCouncil(req, query);
  const { data, error, count } = await query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (sendDbError(res, error)) return;
  res.setHeader('X-Total-Count', count ?? 0);   // body stays an array (backward-compatible); total in header
  res.json(data);
});

router.get('/ples/flagged', async (req, res) => {
  let query = supabase
    .from('ples')
    .select('*, professionals!ples_physician_id_fkey(full_name_th, full_name_en)')
    .eq('status', 'cle_flag_t2');
  query = scopeToCouncil(req, query);
  const { data, error } = await query.order('ended_at');
  if (sendDbError(res, error)) return;
  res.json(data);
});

// Investigate a session transcript (admin scoped to own council; superadmin any council).
router.get('/ples/:id/transcript', async (req, res) => {
  const { data: ple } = await supabase.from('ples')
    .select('id, council_id, status, chief_complaint, title, started_at, ended_at, turn_count, token_count, professionals!ples_physician_id_fkey(full_name_th, full_name_en, pseudonym)')
    .eq('id', req.params.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (!sameCouncil(req, ple.council_id)) return res.status(404).json({ error: 'Not found' });

  const { data: messages } = await supabase.from('messages')
    .select('role, content, refs, socratic_question, created_at')
    .eq('ple_id', req.params.id).order('created_at');
  res.json({ ple, messages: messages ?? [] });
});

// Council list for dashboard labels/selectors (admin + superadmin).
router.get('/councils', async (_req, res) => {
  const { data, error } = await supabase
    .from('councils').select('id, code, name_th, name_en, active').order('sort');
  if (sendDbError(res, error)) return;
  res.json(data ?? []);
});

router.post('/ples/:id/approve', async (req, res) => {
  const { data: ple } = await supabase.from('ples').select('*').eq('id', req.params.id).single();
  if (!ple || ple.status !== 'cle_flag_t2') return res.status(400).json({ error: 'Not a flagged PLE' });
  if (!sameCouncil(req, ple.council_id)) return res.status(404).json({ error: 'Not found' });

  const { error } = await supabase.from('ples').update({ status: 'cle_pass' }).eq('id', req.params.id);
  if (sendDbError(res, error)) return;

  const { data: messages } = await supabase
    .from('messages').select('role, content').eq('ple_id', req.params.id).order('created_at');
  const transcript = (messages ?? []).map(m => ({ role: m.role, content: m.content }));

  // Fire-and-forget: evaluate + persist (same path as the physician /end flow).
  triggerEvaluation(req.params.id, transcript, ple.physician_id)
    .catch(e => console.error('[admin approve] evaluation failed:', e.message));

  res.json({ ok: true });
});

// Re-run the PIS-7 evaluation for a PLE that passed the gate but whose evaluation never landed
// (e.g. a transient RIMPL error left it stuck at cle_pass with no ai_evaluation). Unlike the
// fire-and-forget /end path, this awaits the result. It refuses to touch an already-evaluated PLE
// (409), so it can only recover stranded sessions — it never re-judges or overrides a score.
router.post('/ples/:id/reevaluate', async (req, res) => {
  const { data: ple } = await supabase.from('ples').select('*').eq('id', req.params.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (!sameCouncil(req, ple.council_id)) return res.status(404).json({ error: 'Not found' });
  if (!['cle_pass', 'evaluated'].includes(ple.status)) {
    return res.status(400).json({ error: 'PLE has not passed the CLE gate' });
  }
  const { data: existing } = await supabase
    .from('ai_evaluations').select('id').eq('ple_id', ple.id).maybeSingle();
  if (existing) return res.status(409).json({ error: 'Already evaluated' });

  const { data: messages } = await supabase
    .from('messages').select('role, content').eq('ple_id', ple.id).order('created_at');
  const transcript = (messages ?? []).map(m => ({ role: m.role, content: m.content }));
  try {
    await triggerEvaluation(ple.id, transcript, ple.physician_id);
    res.json({ ok: true, status: 'evaluated' });
  } catch (e) {
    res.status(502).json({ error: `Evaluation failed: ${e.message}` });
  }
});

router.post('/ples/:id/reject', async (req, res) => {
  let query = supabase.from('ples')
    .update({ status: 'cle_fail_t1' }).eq('id', req.params.id).eq('status', 'cle_flag_t2');
  query = scopeToCouncil(req, query);
  const { error } = await query;
  if (sendDbError(res, error)) return;
  res.json({ ok: true });
});

router.post('/ples/:id/assign', async (req, res) => {
  const parsed = AssignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const auditorId = parsed.data.auditor_id;

  const { data: ple } = await supabase.from('ples')
    .select('id, status, council_id, physician_id').eq('id', req.params.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (!sameCouncil(req, ple.council_id)) return res.status(404).json({ error: 'Not found' });
  if (ple.status !== 'evaluated') return res.status(400).json({ error: 'PLE is not ready for assignment' });

  // The auditor must be an active auditor in the SAME council, and never the physician who ran it.
  const { data: auditor } = await supabase.from('professionals')
    .select('id, role, status, council_id').eq('id', auditorId).single();
  if (!auditor || auditor.role !== 'auditor' || auditor.status !== 'active') {
    return res.status(400).json({ error: 'Not an active auditor' });
  }
  if (auditor.id === ple.physician_id) {
    return res.status(409).json({ error: 'An auditor cannot be assigned to their own session.' });
  }
  if (auditor.council_id !== ple.council_id) {
    return res.status(409).json({ error: 'Cross-council assignment is not allowed.' });
  }

  const { error } = await supabase.from('ples')
    .update({ auditor_id: auditorId })
    .eq('id', req.params.id)
    .eq('status', 'evaluated');
  if (sendDbError(res, error)) return;
  res.json({ ok: true });
});

// Read-only auditor list for the assignment dropdown — admins need this but
// GET /admin/users is superadmin-only, so expose just the auditors to admin+superadmin.
router.get('/auditors', async (req, res) => {
  let query = supabase
    .from('professionals')
    .select('id, full_name_th, full_name_en')
    .eq('role', 'auditor')
    .eq('status', 'active');
  query = scopeToCouncil(req, query);   // admins only assign auditors from their own council
  const { data, error } = await query.order('full_name_th');
  if (sendDbError(res, error)) return;
  res.json(data);
});

// ---- Access-request approval queue (admin + superadmin) -------------------

// List access requests. Default (no query) = the pending queue (unchanged). ?status=approved|rejected
// filters to that outcome; ?status=all returns the full onboarding trail. Reviewed rows carry the
// reviewer's name so admins can see who approved/rejected whom and when.
router.get('/access-requests', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  let query = supabase.from('access_requests').select('*').order('created_at');
  if (status !== 'all') {
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be one of: pending, approved, rejected, all' });
    }
    query = query.eq('status', status);
  }
  query = scopeToCouncil(req, query);   // admins review only their own council's requests
  const { data, error } = await query;
  if (sendDbError(res, error)) return;

  // Attach reviewer names for any reviewed rows (no fragile FK-name embed; one extra lookup).
  const reviewerIds = [...new Set((data ?? []).map(r => r.reviewed_by).filter(Boolean))];
  let reviewers = {};
  if (reviewerIds.length) {
    const { data: revs } = await supabase
      .from('professionals').select('id, full_name_en, full_name_th, pseudonym').in('id', reviewerIds);
    reviewers = Object.fromEntries((revs ?? []).map(p => [p.id, p]));
  }
  res.json((data ?? []).map(r => ({ ...r, reviewer: r.reviewed_by ? reviewers[r.reviewed_by] ?? null : null })));
});

// Approve a request into a role slot. Approval ASSIGNS the role (requesters never self-assign).
// admin may grant physician/auditor; only superadmin may grant admin; superadmin isn't grantable.
router.post('/access-requests/:id/approve', async (req, res) => {
  const parsed = ApproveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: reqRow, error: reqErr } = await supabase
    .from('access_requests').select('*').eq('id', req.params.id).single();
  if (reqErr || !reqRow) return res.status(404).json({ error: 'Request not found' });
  if (reqRow.status !== 'pending') return res.status(409).json({ error: 'Request already processed' });
  if (!reqRow.auth_user_id) return res.status(400).json({ error: 'Request has no pending auth user' });
  // An admin may only approve requests for their own council.
  if (!sameCouncil(req, reqRow.council_id)) return res.status(404).json({ error: 'Request not found' });

  const grantedRole = parsed.data.granted_role || reqRow.requested_role || 'physician';
  if (grantedRole === 'auditor') {
    return res.status(400).json({ error: 'Auditors are created via invite links, not access-request approval.' });
  }
  if (grantedRole === 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only a superadmin can grant the admin role.' });
  }

  const slot = await assertSlotAvailable(grantedRole, reqRow.council_id);
  if (!slot.ok) return res.status(409).json({ error: slot.error });

  const insert = {
    id: reqRow.auth_user_id,
    role: grantedRole,
    council_id: reqRow.council_id,
    full_name_th: reqRow.full_name_th || reqRow.full_name_en || 'Unknown',
    full_name_en: reqRow.full_name_en || reqRow.full_name_th || 'Unknown',
    specialty: reqRow.specialty ?? null,
    status: 'active',
  };
  if (grantedRole === 'physician') insert.pseudonym = await nextPseudonym();

  const { error: profErr } = await supabase.from('professionals').insert(insert);
  if (profErr) return res.status(500).json({ error: profErr.message });

  // Link the on-prem identity vault row to the new professional (OAuth requests only).
  if (reqRow.provider !== 'email') {
    await supabase.from('oauth_identities')
      .update({ professional_id: reqRow.auth_user_id }).eq('auth_user_id', reqRow.auth_user_id);
  }

  const { error: updErr } = await supabase.from('access_requests')
    .update({ status: 'approved', reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (sendDbError(res, updErr)) return;

  res.json({ ok: true, professional_id: reqRow.auth_user_id, role: grantedRole, pseudonym: insert.pseudonym ?? null });
});

router.post('/access-requests/:id/reject', async (req, res) => {
  const parsed = RejectSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: reqRow } = await supabase
    .from('access_requests').select('*').eq('id', req.params.id).single();
  if (!reqRow) return res.status(404).json({ error: 'Request not found' });
  if (reqRow.status !== 'pending') return res.status(409).json({ error: 'Request already processed' });

  // Remove the pending auth user + any vault row so the email/identity can re-apply later.
  if (reqRow.auth_user_id) {
    await supabase.from('oauth_identities').delete().eq('auth_user_id', reqRow.auth_user_id);
    await supabase.auth.admin.deleteUser(reqRow.auth_user_id).catch(() => {});
  }

  const { error } = await supabase.from('access_requests')
    .update({ status: 'rejected', note: parsed.data.note ?? null, reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (sendDbError(res, error)) return;
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
  const auditsBy = {};
  (audits ?? []).forEach(s => { (auditsBy[s.ple_id] ??= []).push(s); });
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
// sessions. Safe + idempotent (skips anything already evaluated).
router.post('/reconcile-evaluations', async (req, res) => {
  // Batch-bounded: recover up to 200 stranded sessions per call (re-run to drain more).
  const { data: stuck } = await supabase.from('ples').select('id, physician_id').eq('status', 'cle_pass').limit(200);
  let recovered = 0, failed = 0;
  for (const p of stuck ?? []) {
    const { data: ex } = await supabase.from('ai_evaluations').select('id').eq('ple_id', p.id).maybeSingle();
    if (ex) continue;
    const { data: msgs } = await supabase.from('messages').select('role, content').eq('ple_id', p.id).order('created_at');
    try { await triggerEvaluation(p.id, (msgs ?? []).map(m => ({ role: m.role, content: m.content })), p.physician_id); recovered++; }
    catch { failed++; }
  }
  res.json({ stuck: (stuck ?? []).length, recovered, failed });
});

// De-identified study export (admin + superadmin): pseudonym-keyed sessions + AI + auditor scores.
// Only pseudonyms (P-NNN) leave here — no names/emails. For the research team.
router.get('/export', async (req, res) => {
  // Page-bounded: pull one page of sessions, then ONLY that page's physicians + scores (so the
  // research export streams in chunks instead of loading every physician + ple at 80K scale).
  const { limit, offset } = pageParams(req, { def: 200, max: 1000 });
  let pq = scopeToCouncil(req, supabase.from('ples')
    .select('id, physician_id, status, turn_count, token_count, duration_seconds, started_at', { count: 'exact' }));
  const { data: ples, count } = await pq.order('started_at').range(offset, offset + limit - 1);
  const pleIds = (ples ?? []).map(p => p.id);
  const physIds = [...new Set((ples ?? []).map(p => p.physician_id))];
  const empty = Promise.resolve({ data: [] });
  const { data: pros } = await (physIds.length ? supabase.from('professionals').select('id, pseudonym').in('id', physIds) : empty);
  const pseudo = Object.fromEntries((pros ?? []).map(p => [p.id, p.pseudonym]));
  const { data: ai } = await (pleIds.length ? supabase.from('ai_evaluations').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('ple_id', pleIds) : empty);
  const aiBy = Object.fromEntries((ai ?? []).map(e => [e.ple_id, e]));
  const { data: audits } = await (pleIds.length ? supabase.from('audit_scores').select('ple_id, auditor_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('ple_id', pleIds) : empty);
  // Auditors are study staff, not research subjects — pseudonymize their id too so the exported
  // file carries no reversible identity (stable A-<hash>: same auditor → same label across exports).
  const auditorTag = (id) => 'A-' + createHash('sha256').update(String(id)).digest('hex').slice(0, 8);
  const audBy = {};
  (audits ?? []).forEach(s => { (audBy[s.ple_id] ??= []).push({ auditor: auditorTag(s.auditor_id), composite: Number(s.composite_score), d1: s.d1, d2: s.d2, d3: s.d3, d4: s.d4, d5: s.d5, d6: s.d6, d7: s.d7 }); });
  const sessions = (ples ?? []).map(p => {
    const e = aiBy[p.id];
    return {
      cle_id: p.id, physician: pseudo[p.physician_id] ?? null, status: p.status,
      turns: p.turn_count, tokens: p.token_count, duration_seconds: p.duration_seconds, started_at: p.started_at,
      ai_composite: e ? Number(e.composite_score) : null,
      ai_domains: e ? { d1: e.d1, d2: e.d2, d3: e.d3, d4: e.d4, d5: e.d5, d6: e.d6, d7: e.d7 } : null,
      auditor_scores: audBy[p.id] ?? [],
    };
  });
  res.setHeader('X-Total-Count', count ?? 0);
  res.json({ exported_at: new Date().toISOString(), n: sessions.length, total: count ?? 0, limit, offset, sessions });
});

// ---- Invite links (A/B create a physician or auditor bound to an email) -------------------

// Create an invite. Admin (B) may only invite into their OWN council; superadmin (A) any council.
// Slot-prechecked so we never issue an invite that can't be redeemed. Returns the raw accept
// link ONCE (the DB stores only the token hash).
router.post('/invites', async (req, res) => {
  const parsed = InviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, role, council_id } = parsed.data;
  if (!sameCouncil(req, council_id)) return res.status(403).json({ error: 'You can only invite into your own council.' });

  const slot = await assertSlotAvailable(role, council_id);
  if (!slot.ok) return res.status(409).json({ error: slot.error });

  const { raw, hash } = newInviteToken();
  const expires_at = new Date(Date.now() + INVITE_EXPIRY_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.from('invites').insert({
    token_hash: hash, email, role, council_id, created_by: req.user.id, status: 'pending', expires_at,
  }).select('id, email, role, council_id, status, expires_at, created_at').single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A pending invite for this email and role already exists.' });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ ...data, accept_url: `${SITE_URL}/invite.html?token=${raw}` });
});

// List invites (admins see only their council; superadmin all). Optional ?status= filter.
router.get('/invites', async (req, res) => {
  let q = supabase.from('invites')
    .select('id, email, role, council_id, status, expires_at, accepted_at, created_at')
    .order('created_at', { ascending: false });
  if (typeof req.query.status === 'string') q = q.eq('status', req.query.status);
  q = scopeToCouncil(req, q);
  const { data, error } = await q;
  if (sendDbError(res, error)) return;
  res.json(data ?? []);
});

// Revoke a pending invite (own council for admins). Refuses an already-accepted one.
router.delete('/invites/:id', async (req, res) => {
  const { data: inv } = await supabase.from('invites').select('id, council_id, status').eq('id', req.params.id).single();
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (!sameCouncil(req, inv.council_id)) return res.status(404).json({ error: 'Not found' });
  if (inv.status === 'accepted') return res.status(409).json({ error: 'Invite already accepted.' });
  const { error } = await supabase.from('invites').update({ status: 'revoked' }).eq('id', req.params.id);
  if (sendDbError(res, error)) return;
  res.json({ ok: true });
});

// (License verification + the manual-verify override were retired 2026-06-09 — onboarding is
// Google self-service + A/B invites, and an invite activates an auditor with no license gate.)

module.exports = router;
