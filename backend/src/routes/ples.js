const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { MessageSchema, CreatePleSchema, UpdatePleSchema } = require('../lib/schemas');
const { computeTier1, clampDuration } = require('../services/cle-gate');
const { rimplChat, rimplEvaluateCriteria } = require('../services/rimpl-client');
const { fetchOwnedPle, ownsFolder, sendDbError } = require('../lib/db-helpers');
const { triggerEvaluation } = require('../services/ple-evaluation');
const { effectiveLimit, accrueUsage, reserveUsage, settleUsage, refundUsage, RESERVE_ESTIMATE_USD } = require('../lib/usage');

const router = Router();
router.use(verifyJwt, requireRole('physician'));

// Human-subjects pilot: any route that creates OR extends study data (start a session,
// send a turn, finalize) requires recorded informed consent. Read/rename/delete are not
// gated (a non-consenting physician has no sessions to act on, and may still tidy up).
function requireConsent(req, res, next) {
  if (!req.user.consented_at) {
    return res.status(403).json({ error: 'Informed consent required before starting a session.', code: 'consent_required' });
  }
  next();
}

// Pilot AI-cost budget: once a physician's running cost reaches their effective limit, block
// starting a new session and sending further turns (strict, per-turn). Finalizing an open session
// (/end) is intentionally NOT gated, so a session is never stranded and its evaluation still runs.
async function requireBudget(req, res, next) {
  try {
    const limit = await effectiveLimit(req.user);
    if (Number(req.user.usage_cost_usd ?? 0) >= limit) {
      return res.status(403).json({
        error: `AI usage limit reached ($${limit.toFixed(2)}). Contact an administrator.`,
        code: 'budget_exceeded',
      });
    }
  } catch (e) {
    console.error('[ples] budget check failed:', e.message); // fail-open: never block on a meter error
  }
  next();
}

// CLE-gate booleans live in the c1_pass..c6_pass columns; map {c1..} -> {c1_pass..}.
const toPassCols = (crit) => Object.fromEntries(Object.entries(crit).map(([k, v]) => [`${k}_pass`, v]));

// Create new PLE session
router.post('/', requireConsent, requireBudget, async (req, res) => {
  const parsed = CreatePleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { chief_complaint, folder_id, patient_ref } = parsed.data;
  if (!(await ownsFolder(req.user.id, folder_id))) {
    return res.status(403).json({ error: 'Folder not found' });
  }

  // Auto-title from the chief complaint (physician can rename later).
  const title = chief_complaint.trim().slice(0, 120);

  const { data, error } = await supabase.from('ples').insert({
    physician_id: req.user.id,
    council_id: req.user.council_id,   // denormalized from the physician; scopes admin/auditor access
    status: 'active',
    started_at: new Date().toISOString(),
    chief_complaint,
    title,
    folder_id: folder_id ?? null,
  }).select().single();

  if (sendDbError(res, error)) return;

  // The structured patient identifier (name/HN/…) goes into a PHYSICALLY SEPARATE table that the
  // chat→cloud path, the auditor blind queue, and the de-identified export NEVER read — only the
  // owning physician does. So real patient PII stays out of the cloud AI entirely. Best-effort:
  // a failure here must not strand the session that was just created.
  const ref = patient_ref?.trim();
  if (ref) {
    const { error: refErr } = await supabase.from('ple_patient_refs')
      .insert({ ple_id: data.id, physician_id: req.user.id, patient_ref: ref });
    if (refErr) console.error('[ples] failed to store patient_ref:', refErr.message);
  }
  res.status(201).json({ ...data, patient_ref: ref || null });
});

// List physician's own PLEs
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('ples')
    .select('id, title, chief_complaint, folder_id, status, started_at, ended_at, turn_count, token_count, c1_pass, c2_pass, c3_pass, c4_pass, c5_pass, c6_pass')
    .eq('physician_id', req.user.id)
    .order('started_at', { ascending: false });
  if (sendDbError(res, error)) return;
  res.json(data);
});

// Rename a conversation and/or move it between folders
router.patch('/:id', async (req, res) => {
  const parsed = UpdatePleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { title, folder_id } = parsed.data;

  if (folder_id !== undefined && !(await ownsFolder(req.user.id, folder_id))) {
    return res.status(403).json({ error: 'Folder not found' });
  }

  const patch = {};
  if (title !== undefined) patch.title = title;
  if (folder_id !== undefined) patch.folder_id = folder_id;

  const { data, error } = await supabase
    .from('ples').update(patch)
    .eq('id', req.params.id).eq('physician_id', req.user.id)
    .select('id, title, chief_complaint, folder_id, status, started_at, turn_count, token_count').single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// Delete a conversation (and its data).
router.delete('/:id', async (req, res) => {
  const { data: ple } = await fetchOwnedPle(req.params.id, req.user.id, 'id');
  if (!ple) return res.status(404).json({ error: 'Not found' });

  // messages / ai_evaluations / audit_scores cascade on delete; lpdp_snapshots FK has no
  // ON DELETE CASCADE, so remove those rows first to avoid a foreign-key violation.
  await supabase.from('lpdp_snapshots').delete().eq('ple_id', req.params.id);

  const { error } = await supabase
    .from('ples').delete().eq('id', req.params.id).eq('physician_id', req.user.id);
  if (sendDbError(res, error)) return;
  res.json({ ok: true });
});

// Physician's own longitudinal profile (LPDP). Declared before /:id.
router.get('/lpdp/me', async (req, res) => {
  const { data, error } = await supabase
    .from('lpdp_snapshots').select('*')
    .eq('physician_id', req.user.id)
    .order('snapshot_at');
  if (sendDbError(res, error)) return;
  res.json(data);
});

// Get single PLE with messages
router.get('/:id', async (req, res) => {
  const { data: ple, error } = await fetchOwnedPle(req.params.id, req.user.id);
  if (error || !ple) return res.status(404).json({ error: 'Not found' });

  const { data: messages } = await supabase
    .from('messages').select('*').eq('ple_id', req.params.id).order('created_at');

  // The private patient identifier is read ONLY here, scoped to the owning physician.
  const { data: ref } = await supabase.from('ple_patient_refs')
    .select('patient_ref').eq('ple_id', req.params.id).eq('physician_id', req.user.id).maybeSingle();

  res.json({ ...ple, patient_ref: ref?.patient_ref ?? null, messages: messages ?? [] });
});

// Send a message turn
router.post('/:id/message', requireConsent, requireBudget, async (req, res) => {
  const parsed = MessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: ple } = await fetchOwnedPle(req.params.id, req.user.id);
  if (!ple || ple.status !== 'active') return res.status(400).json({ error: 'PLE not active' });

  const { data: history } = await supabase
    .from('messages').select('role, content').eq('ple_id', req.params.id).order('created_at');

  const { message, language } = parsed.data;

  // ATOMICALLY reserve this turn's estimated cost before the paid call — closes the parallel-turn
  // TOCTOU where concurrent turns all passed requireBudget's stale read before any spend landed.
  // Reconciled to the real cost on success; refunded on any failure below.
  const limit = await effectiveLimit(req.user);
  const reserved = await reserveUsage(req.user.id, limit);
  if (!reserved) {
    return res.status(403).json({
      error: `AI usage limit reached ($${limit.toFixed(2)}). Contact an administrator.`,
      code: 'budget_exceeded',
    });
  }

  let rimplResponse;
  try {
    rimplResponse = await rimplChat({
      ple_id: req.params.id, history: history ?? [], message, language,
      chief_complaint: ple.chief_complaint, // give the AI the case context
    });
  } catch (err) {
    await refundUsage(req.user.id, RESERVE_ESTIMATE_USD); // no turn delivered — release the reservation
    return res.status(502).json({ error: `RIMPL unavailable: ${err.message}` });
  }

  const physicianTokens = Math.ceil(message.length / 4);

  const { error: msgErr1 } = await supabase.from('messages').insert({
    ple_id: req.params.id, role: 'physician',
    content: message, token_count: physicianTokens,
  });
  const { error: msgErr2 } = await supabase.from('messages').insert({
    ple_id: req.params.id, role: 'assistant',
    content: rimplResponse.content,
    refs: rimplResponse.refs,
    socratic_question: rimplResponse.socratic_question,
    token_count: rimplResponse.token_count,
  });
  // Don't pretend success if the turn wasn't saved — let the client retry.
  if (msgErr1 || msgErr2) {
    console.error('[ples] failed to persist message:', (msgErr1 || msgErr2).message);
    await refundUsage(req.user.id, RESERVE_ESTIMATE_USD); // turn not saved — release the reservation
    return res.status(500).json({ error: 'Failed to save the message. Please try again.' });
  }

  const turnIn = rimplResponse.input_tokens ?? 0;
  const turnOut = rimplResponse.output_tokens ?? 0;
  const { error: counterErr } = await supabase.from('ples').update({
    turn_count: (ple.turn_count ?? 0) + 1,
    token_count: (ple.token_count ?? 0) + (rimplResponse.token_count ?? 0) + physicianTokens,
    input_tokens: (ple.input_tokens ?? 0) + turnIn,
    output_tokens: (ple.output_tokens ?? 0) + turnOut,
  }).eq('id', req.params.id);
  if (counterErr) console.error('[ples] failed to update counters:', counterErr.message);

  // Settle the reservation to the turn's REAL Claude cost (adds actual − estimate + the real tokens).
  await settleUsage(req.user.id, RESERVE_ESTIMATE_USD, turnIn, turnOut);

  res.json(rimplResponse);
});

// End session and run CLE quality gate
router.post('/:id/end', requireConsent, async (req, res) => {
  const { data: ple } = await fetchOwnedPle(req.params.id, req.user.id);
  if (!ple || ple.status !== 'active') return res.status(400).json({ error: 'PLE not active' });

  // Claim the session atomically BEFORE any paid evaluation work: a double-submit (double-click,
  // two tabs, a client retry after a slow response) must never run two tier-2 RIMPL calls / two
  // PIS-7 evaluations for one PLE. Only the request that flips active->ended proceeds; racers 409.
  const { data: claimed } = await supabase.from('ples')
    .update({ status: 'ended' }).eq('id', req.params.id).eq('status', 'active').select('id');
  if (!claimed || claimed.length === 0) return res.status(409).json({ error: 'PLE not active' });

  const endedAt = new Date();
  const wallClockSeconds = Math.max(0, Math.floor((endedAt - new Date(ple.started_at)) / 1000));
  // Clamp the client-reported active-engagement time to wall-clock (see clampDuration): an unclamped
  // client value lets a physician POST active_seconds:99999 and pass C1's 15-min engagement gate on a
  // seconds-long session.
  const durationSeconds = clampDuration(req.body?.active_seconds, wallClockSeconds);
  const updatedPle = { ...ple, duration_seconds: durationSeconds };

  const tier1 = computeTier1(updatedPle);

  if (!tier1.c1 || !tier1.c2 || !tier1.c3) {
    const { error } = await supabase.from('ples').update({
      status: 'cle_fail_t1', ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds, ...toPassCols(tier1),
    }).eq('id', req.params.id);
    if (sendDbError(res, error)) return;
    return res.json({ status: 'cle_fail_t1', criteria: tier1 });
  }

  const { data: messages } = await supabase
    .from('messages').select('role, content').eq('ple_id', req.params.id).order('created_at');
  const transcript = (messages ?? []).map(m => ({ role: m.role, content: m.content }));

  let tier2 = { c4: false, c5: false, c6: false };
  try {
    const crit = await rimplEvaluateCriteria({ transcript });
    // Keep only the criteria booleans here — allCriteria feeds toPassCols(), which maps every
    // key to a *_pass column; token fields would create non-existent columns.
    tier2 = { c4: crit.c4, c5: crit.c5, c6: crit.c6 };
    await accrueUsage(ple.physician_id, crit.input_tokens, crit.output_tokens);
  } catch {
    // RIMPL down — flag for manual QA
  }

  const allCriteria = { ...tier1, ...tier2 };
  const tier2Pass = tier2.c4 && tier2.c5 && tier2.c6;

  if (!tier2Pass) {
    const { error } = await supabase.from('ples').update({
      status: 'cle_flag_t2', ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds, ...toPassCols(allCriteria),
    }).eq('id', req.params.id);
    if (sendDbError(res, error)) return;
    return res.json({ status: 'cle_flag_t2', criteria: allCriteria });
  }

  const { error } = await supabase.from('ples').update({
    status: 'cle_pass', ended_at: endedAt.toISOString(),
    duration_seconds: durationSeconds, ...toPassCols(allCriteria),
  }).eq('id', req.params.id);
  if (sendDbError(res, error)) return;

  // Fire-and-forget evaluation
  triggerEvaluation(req.params.id, transcript, ple.physician_id).catch(err => {
    console.error(`[EVAL] triggerEvaluation failed for PLE ${req.params.id}:`, err.message);
  });

  res.json({ status: 'cle_pass', criteria: allCriteria });
});

// Get AI evaluation result
router.get('/:id/evaluation', async (req, res) => {
  const { data: ple } = await fetchOwnedPle(req.params.id, req.user.id, 'status');
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (ple.status !== 'evaluated') return res.status(202).json({ status: ple.status });

  const { data: eval_ } = await supabase
    .from('ai_evaluations').select('*').eq('ple_id', req.params.id).single();
  res.json(eval_);
});

module.exports = router;
