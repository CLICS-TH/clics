const { Router } = require('express');
const { createHash } = require('crypto');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { AssignSchema } = require('../lib/schemas');
const { triggerEvaluation } = require('../services/ple-evaluation');
const { reconcileEvaluations } = require('../services/reconcile');
const { sendDbError, pageParams } = require('../lib/db-helpers');
const { assertSlotAvailable } = require('../lib/accounts');
const { newInviteToken } = require('../lib/invite-token');
const { isMailerEnabled, sendInviteEmail } = require('../lib/mailer');

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

// (The access-request approval schemas were retired with the request-access flow — see below.)

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

// Members list — dual-role: an admin sees ONLY their own council's members (read-only in the
// dashboard); superadmin sees all (scopeToCouncil is a no-op for them). Lives here (not
// superadmin.js) because this router is mounted first on /admin and would shadow it anyway.
// All user MUTATIONS (create/edit/status/usage) remain superadmin-only in routes/superadmin.js.
router.get('/users', async (req, res) => {
  const { limit, offset } = pageParams(req);   // paginated — never pull all 80K professionals at once
  let query = supabase.from('professionals')
    .select('*', { count: 'exact' }).order('created_at').range(offset, offset + limit - 1);
  query = scopeToCouncil(req, query);
  const { data, error, count } = await query;
  if (sendDbError(res, error)) return;
  res.setHeader('X-Total-Count', count ?? 0);
  res.json(data);
});

// Read-only auditor list for the assignment dropdown (active auditors only, id+names —
// /users above returns full rows of every role).
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

// ---- Access-request approval queue — RETIRED (2026-06-10) -------------------
// The self-service request-access flow was removed (onboarding = Google self-service + A/B
// invites), so the approval queue went with it. The access_requests table is kept as a
// historical record. 404 stubs (not silent removal) so stale clients fail loudly.
router.get('/access-requests', (_req, res) => res.status(404).json({ error: 'The access-request queue was retired — onboarding is Google sign-in + invites.' }));
router.post('/access-requests/:id/approve', (_req, res) => res.status(404).json({ error: 'The access-request queue was retired.' }));
router.post('/access-requests/:id/reject', (_req, res) => res.status(404).json({ error: 'The access-request queue was retired.' }));

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
// sessions. Safe + idempotent (skips anything already evaluated). The same sweep also runs on a
// schedule (RECONCILE_INTERVAL_MS in index.js); this endpoint is the manual/on-demand trigger.
router.post('/reconcile-evaluations', async (req, res) => {
  res.json(await reconcileEvaluations());
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

  // Deliver the accept link by email — FAIL-SOFT: the invite is already created, so a mail
  // failure must never fail the request; the admin still gets accept_url to share manually.
  const accept_url = `${SITE_URL}/invite.html?token=${raw}`;
  let email_sent = false;
  if (isMailerEnabled()) {
    const { data: council } = await supabase.from('councils').select('name_th, name_en').eq('id', council_id).maybeSingle();
    email_sent = await sendInviteEmail({
      to: email, acceptUrl: accept_url, role,
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
    .select('id, email, role, council_id, status, expires_at, accepted_at, email_sent_at, created_at')
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
