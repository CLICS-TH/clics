const { Router } = require('express');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { AssignSchema } = require('../lib/schemas');
const { triggerEvaluation } = require('../services/ple-evaluation');
const { sendDbError } = require('../lib/db-helpers');
const { assertSlotAvailable, nextPseudonym } = require('../lib/accounts');

const router = Router();
router.use(verifyJwt, requireRole('admin', 'superadmin'));

const ApproveSchema = z.object({ granted_role: z.enum(['admin', 'physician', 'auditor']).optional() });
const RejectSchema = z.object({ note: z.string().max(500).optional() });

router.get('/ples', async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('ples').select('*, professionals!ples_physician_id_fkey(full_name_th, full_name_en, specialty)');
  if (status) query = query.eq('status', status);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (sendDbError(res, error)) return;
  res.json(data);
});

router.get('/ples/flagged', async (req, res) => {
  const { data, error } = await supabase
    .from('ples')
    .select('*, professionals!ples_physician_id_fkey(full_name_th, full_name_en)')
    .eq('status', 'cle_flag_t2')
    .order('ended_at');
  if (sendDbError(res, error)) return;
  res.json(data);
});

router.post('/ples/:id/approve', async (req, res) => {
  const { data: ple } = await supabase.from('ples').select('*').eq('id', req.params.id).single();
  if (!ple || ple.status !== 'cle_flag_t2') return res.status(400).json({ error: 'Not a flagged PLE' });

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
  const { error } = await supabase.from('ples')
    .update({ status: 'cle_fail_t1' }).eq('id', req.params.id).eq('status', 'cle_flag_t2');
  if (sendDbError(res, error)) return;
  res.json({ ok: true });
});

router.post('/ples/:id/assign', async (req, res) => {
  const parsed = AssignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { error } = await supabase.from('ples')
    .update({ auditor_id: parsed.data.auditor_id })
    .eq('id', req.params.id)
    .eq('status', 'evaluated');
  if (sendDbError(res, error)) return;
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

  const grantedRole = parsed.data.granted_role || reqRow.requested_role || 'physician';
  if (grantedRole === 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only a superadmin can grant the admin role.' });
  }

  const slot = await assertSlotAvailable(grantedRole);
  if (!slot.ok) return res.status(409).json({ error: slot.error });

  const insert = {
    id: reqRow.auth_user_id,
    role: grantedRole,
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
  const { data: ples } = await supabase.from('ples').select('status');
  const total = ples?.length ?? 0;
  const counts = (ples ?? []).reduce((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});
  res.json({ total, ...counts });
});

// Per-physician score explorer (admin + superadmin): the physician + all their sessions, each joined
// with its AI evaluation and auditor scores, plus the LPDP trajectory and folder names. Powers the
// "click a user → see their scores" view and the by-status / by-case / by-folder groupings.
router.get('/physicians/:id/profile', async (req, res) => {
  const { data: physician } = await supabase
    .from('professionals').select('id, full_name_th, full_name_en, specialty, pseudonym, role')
    .eq('id', req.params.id).single();
  if (!physician) return res.status(404).json({ error: 'Not found' });

  const { data: ples } = await supabase
    .from('ples')
    .select('id, status, chief_complaint, turn_count, token_count, started_at, folder_id')
    .eq('physician_id', req.params.id).order('started_at');
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

module.exports = router;
