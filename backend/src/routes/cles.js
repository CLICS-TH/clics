const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { MessageSchema, CreateCleSchema, UpdateCleSchema } = require('../lib/schemas');
const { computeTier1, clampDuration } = require('../services/cle-gate');
const { rimplChat } = require('../services/rimpl-client');
const { fetchOwnedPle, ownsFolder, sendDbError } = require('../lib/db-helpers');
const { finalizeScreening, toPassCols } = require('../services/cle-finalize');
const { effectiveLimit, reserveUsage, settleUsage, refundUsage, RESERVE_ESTIMATE_USD } = require('../lib/usage');
const { logEvent } = require('../lib/audit');
const { pilotTestMode } = require('../lib/settings');

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
    console.error('[cles] budget check failed:', e.message); // fail-open: never block on a meter error
  }
  next();
}

// (toPassCols lives in services/cle-finalize — shared with the reconcile sweep.)

// Create new CLE session
router.post('/', requireConsent, requireBudget, async (req, res) => {
  const parsed = CreateCleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { chief_complaint, folder_id, patient_ref, socratic } = parsed.data;
  if (!(await ownsFolder(req.user.id, folder_id))) {
    return res.status(403).json({ error: 'Folder not found' });
  }

  // Auto-title from the chief complaint (physician can rename later).
  const title = chief_complaint.trim().slice(0, 120);

  const pilotMode = await pilotTestMode();

  // Episode sequencing (CLICS protocol §6.4): a physician produces exactly 3 valid CLEs.
  // episode_number = (# of their PASSED CLEs) + 1, so a retried attempt keeps the same episode
  // until it passes. Block a 4th once 3 have passed — UNLESS Pilot Test Mode is on (testers loop).
  const { count: passedCount, error: countErr } = await supabase.from('cles')
    .select('id', { count: 'exact', head: true })
    .eq('physician_id', req.user.id).eq('status', 'cle_pass').eq('is_test', false);
  if (sendDbError(res, countErr)) return;
  const passed = passedCount ?? 0;
  if (passed >= 3 && !pilotMode) {
    return res.status(403).json({ error: 'You have completed all 3 CLEs for this study.', code: 'cle_limit_reached' });
  }
  const episodeNumber = Math.min(passed + 1, 3);

  // Socratic mode: CLE2 runs as a Socratic clinical-examiner from the first turn. CLE1/CLE3 are
  // natural, UNLESS the physician has failed Tier-1 three times in a row — then this natural session
  // opens in Socratic remediation to help it develop into a qualifying CLE.
  let socraticActive = false, socraticReason = null;
  if (episodeNumber === 2) { socraticActive = true; socraticReason = 'cle2_examiner'; }
  else if ((req.user.consecutive_t1_fails ?? 0) >= 3) { socraticActive = true; socraticReason = 't1_remediation'; }
  // Pilot Test Mode override: a tester directly chooses the mode so they can exercise Socratic
  // (or natural) on demand, regardless of episode. These sessions are flagged is_test below.
  if (pilotMode && typeof socratic === 'boolean') {
    socraticActive = socratic;
    socraticReason = socratic ? 'pilot_test' : null;
  }

  // CLE-NNN study pseudonym — the only session identifier that appears in the research export.
  const { data: ccData } = await supabase.rpc('next_cle_code');
  const cleCode = typeof ccData === 'string' ? ccData : null;

  const { data, error } = await supabase.from('cles').insert({
    physician_id: req.user.id,
    council_id: req.user.council_id,   // denormalized from the physician; scopes admin/auditor access
    status: 'active',
    is_test: pilotMode || undefined,   // Pilot Test Mode sessions never pollute the real study data
    started_at: new Date().toISOString(),
    chief_complaint,
    title,
    folder_id: folder_id ?? null,
    episode_number: episodeNumber,
    socratic_active: socraticActive,
    socratic_reason: socraticReason,
    cle_code: cleCode,
  }).select().single();

  if (sendDbError(res, error)) return;

  // The structured patient identifier (name/HN/…) goes into a PHYSICALLY SEPARATE table that the
  // chat→cloud path, the auditor blind queue, and the de-identified export NEVER read — only the
  // owning physician does. So real patient PII stays out of the cloud AI entirely. Best-effort:
  // a failure here must not strand the session that was just created.
  const ref = patient_ref?.trim();
  if (ref) {
    const { error: refErr } = await supabase.from('cle_patient_refs')
      .insert({ cle_id: data.id, physician_id: req.user.id, patient_ref: ref });
    if (refErr) console.error('[cles] failed to store patient_ref:', refErr.message);
  }
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'cle.create', targetType: 'cle',
    targetId: data.cle_code ?? data.id, councilId: req.user.council_id,
    metadata: { episode_number: episodeNumber, socratic_reason: socraticReason } });
  res.status(201).json({ ...data, patient_ref: ref || null });
});

// List physician's own CLEs
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('cles')
    .select('id, title, chief_complaint, folder_id, status, started_at, ended_at, turn_count, token_count, c1_pass, c2_pass, c3_pass, c4_pass, c5_pass, c6_pass')
    .eq('physician_id', req.user.id)
    .order('started_at', { ascending: false });
  if (sendDbError(res, error)) return;
  res.json(data);
});

// Rename a conversation and/or move it between folders
router.patch('/:id', async (req, res) => {
  const parsed = UpdateCleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { title, folder_id } = parsed.data;

  if (folder_id !== undefined && !(await ownsFolder(req.user.id, folder_id))) {
    return res.status(403).json({ error: 'Folder not found' });
  }

  const patch = {};
  if (title !== undefined) patch.title = title;
  if (folder_id !== undefined) patch.folder_id = folder_id;

  const { data, error } = await supabase
    .from('cles').update(patch)
    .eq('id', req.params.id).eq('physician_id', req.user.id)
    .select('id, title, chief_complaint, folder_id, status, started_at, turn_count, token_count').single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// Delete a conversation (and its data).
router.delete('/:id', async (req, res) => {
  const { data: cle } = await fetchOwnedPle(req.params.id, req.user.id, 'id');
  if (!cle) return res.status(404).json({ error: 'Not found' });

  // messages / ai_evaluations / audit_scores cascade on delete; lpdp_snapshots FK has no
  // ON DELETE CASCADE, so remove those rows first to avoid a foreign-key violation.
  await supabase.from('lpdp_snapshots').delete().eq('cle_id', req.params.id);

  const { error } = await supabase
    .from('cles').delete().eq('id', req.params.id).eq('physician_id', req.user.id);
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

// Get single CLE with messages
router.get('/:id', async (req, res) => {
  const { data: cle, error } = await fetchOwnedPle(req.params.id, req.user.id);
  if (error || !cle) return res.status(404).json({ error: 'Not found' });

  const { data: messages } = await supabase
    .from('messages').select('*').eq('cle_id', req.params.id).order('created_at');

  // The private patient identifier is read ONLY here, scoped to the owning physician.
  const { data: ref } = await supabase.from('cle_patient_refs')
    .select('patient_ref').eq('cle_id', req.params.id).eq('physician_id', req.user.id).maybeSingle();

  res.json({ ...cle, patient_ref: ref?.patient_ref ?? null, messages: messages ?? [] });
});

// Send a message turn
router.post('/:id/message', requireConsent, requireBudget, async (req, res) => {
  const parsed = MessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: cle } = await fetchOwnedPle(req.params.id, req.user.id);
  if (!cle || cle.status !== 'active') return res.status(400).json({ error: 'CLE not active' });

  const { data: history } = await supabase
    .from('messages').select('role, content').eq('cle_id', req.params.id).order('created_at');

  // The physician's structured patient identifier — sent to RIMPL (on-prem) ONLY so it can scrub the
  // name from the narrative before the cloud call (never forwarded to the cloud). Owner-scoped read.
  const { data: pref } = await supabase.from('cle_patient_refs')
    .select('patient_ref').eq('cle_id', req.params.id).eq('physician_id', req.user.id).maybeSingle();

  const { message, language } = parsed.data;

  // ATOMICALLY reserve this turn's estimated cost before the paid call — closes the parallel-turn
  // TOCTOU where concurrent turns all passed requireBudget's stale read before any spend landed.
  // Reconciled to the real cost on success; refunded on any failure below.
  const limit = await effectiveLimit(req.user);
  const reservation = await reserveUsage(req.user.id, limit);
  if (!reservation.ok) {
    return res.status(403).json({
      error: `AI usage limit reached ($${limit.toFixed(2)}). Contact an administrator.`,
      code: 'budget_exceeded',
    });
  }

  let rimplResponse;
  try {
    rimplResponse = await rimplChat({
      cle_id: req.params.id, history: history ?? [], message, language,
      chief_complaint: cle.chief_complaint, // give the AI the case context
      patient_ref: pref?.patient_ref ?? null, // scrubbed on-prem; never reaches the cloud
      socratic: cle.socratic_active === true, // CLE2 / remediation → Socratic clinical-examiner mode
    });
  } catch (err) {
    await refundUsage(req.user.id, RESERVE_ESTIMATE_USD, reservation.applied); // no turn delivered — release the reservation
    // Stable machine code (matches the /health/deep readiness signal + the repo's code: convention).
    return res.status(502).json({ error: `RIMPL unavailable: ${err.message}`, code: 'rimpl_unavailable' });
  }

  const physicianTokens = Math.ceil(message.length / 4);

  const { error: msgErr1 } = await supabase.from('messages').insert({
    cle_id: req.params.id, role: 'physician',
    content: message, token_count: physicianTokens,
  });
  const { error: msgErr2 } = await supabase.from('messages').insert({
    cle_id: req.params.id, role: 'assistant',
    content: rimplResponse.content,
    refs: rimplResponse.refs,
    socratic_question: rimplResponse.socratic_question,
    token_count: rimplResponse.token_count,
  });
  // Don't pretend success if the turn wasn't saved — let the client retry.
  if (msgErr1 || msgErr2) {
    console.error('[cles] failed to persist message:', (msgErr1 || msgErr2).message);
    await refundUsage(req.user.id, RESERVE_ESTIMATE_USD, reservation.applied); // turn not saved — release the reservation
    return res.status(500).json({ error: 'Failed to save the message. Please try again.' });
  }

  const turnIn = rimplResponse.input_tokens ?? 0;
  const turnOut = rimplResponse.output_tokens ?? 0;
  const { error: counterErr } = await supabase.from('cles').update({
    turn_count: (cle.turn_count ?? 0) + 1,
    token_count: (cle.token_count ?? 0) + (rimplResponse.token_count ?? 0) + physicianTokens,
    input_tokens: (cle.input_tokens ?? 0) + turnIn,
    output_tokens: (cle.output_tokens ?? 0) + turnOut,
  }).eq('id', req.params.id);
  if (counterErr) console.error('[cles] failed to update counters:', counterErr.message);

  // Settle the reservation to the turn's REAL Claude cost (adds actual − estimate + the real tokens
  // when the estimate was applied; the full actual when reserve failed open — never runs negative).
  await settleUsage(req.user.id, RESERVE_ESTIMATE_USD, turnIn, turnOut, reservation.applied);

  res.json(rimplResponse);
});

// End session and run CLE quality gate
router.post('/:id/end', requireConsent, async (req, res) => {
  const { data: cle } = await fetchOwnedPle(req.params.id, req.user.id);
  if (!cle || cle.status !== 'active') return res.status(400).json({ error: 'CLE not active' });

  const endedAt = new Date();
  const wallClockSeconds = Math.max(0, Math.floor((endedAt - new Date(cle.started_at)) / 1000));
  // Clamp the client-reported active-engagement time to wall-clock (see clampDuration): an unclamped
  // client value lets a physician POST active_seconds:99999 and pass C1's 15-min engagement gate on a
  // seconds-long session.
  const durationSeconds = clampDuration(req.body?.active_seconds, wallClockSeconds);

  // Derive turn/token counts from the SOURCE OF TRUTH (the messages rows), not the cached counters on
  // the cle row — a concurrent /message does a non-atomic read-modify-write on those, so a lost
  // increment could wrongly fail C2 (turns>=4) / C3 (tokens>=800) on a qualifying session. Read here
  // (before the claim) so two racing /end requests both compute correctly; the claim is the sole gate.
  const { data: messages } = await supabase
    .from('messages').select('role, content, token_count').eq('cle_id', req.params.id).order('created_at');
  const msgs = messages ?? [];
  const turnCount = msgs.filter(m => m.role === 'physician').length;
  const tokenCount = msgs.reduce((a, m) => a + (m.token_count ?? 0), 0);

  const tier1 = computeTier1({ duration_seconds: durationSeconds, turn_count: turnCount, token_count: tokenCount });
  const tier1Pass = tier1.c1 && tier1.c2 && tier1.c3;

  // Claim the session AND persist the full deterministic result in ONE atomic update. A double-submit
  // (double-click, two tabs, a retry after a slow response) must never run two evaluations — only the
  // request that flips active->{cle_fail_t1|ended} proceeds; racers see 0 rows and 409. Writing
  // duration/counts/c1-c3/ended_at HERE (no network) means a process death during the tier-2 call
  // below leaves a fully-recoverable 'ended' row: reconcile re-runs only the missing tier-2 step.
  const claimStatus = tier1Pass ? 'ended' : 'cle_fail_t1';
  const { data: claimed, error: claimErr } = await supabase.from('cles').update({
    status: claimStatus, ended_at: endedAt.toISOString(),
    duration_seconds: durationSeconds, turn_count: turnCount, token_count: tokenCount,
    ...toPassCols(tier1),
  }).eq('id', req.params.id).eq('status', 'active').select('id');
  if (sendDbError(res, claimErr)) return;
  if (!claimed || claimed.length === 0) return res.status(409).json({ error: 'CLE not active' });

  // CLICS §6.4 remediation counter: 3 consecutive Tier-1 fails open Socratic remediation on the
  // physician's NEXT natural session; any pass resets it. ONLY a natural, real (non-test) session
  // feeds it — a Socratic session (CLE2 / remediation) is not part of the "natural fails" signal, and
  // a Pilot Test Mode session must never pollute the real counter. Best-effort — never block /end.
  if (cle.socratic_reason === null && !cle.is_test) {
    const { error: rtErr } = await supabase.rpc('record_t1_outcome', { p_id: cle.physician_id, p_pass: tier1Pass });
    if (rtErr) console.error('[cles] record_t1_outcome failed:', rtErr.message);
  }

  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'cle.end', targetType: 'cle',
    targetId: cle.cle_code ?? req.params.id, councilId: cle.council_id ?? null, metadata: { tier1_pass: tier1Pass } });

  if (!tier1Pass) return res.json({ status: 'cle_fail_t1', criteria: tier1 });

  // Tier-1 passed: run tier-2 criteria (retried) and finalize. On a PERSISTENT RIMPL failure the
  // session stays 'ended' (recoverable) and reconcile retries it — a transient blip must NOT
  // permanently demote a qualifying session to manual QA.
  const transcript = msgs.map(m => ({ role: m.role, content: m.content }));
  // Patient identifier → scrubbed from the transcript on-prem before the cloud eval (never forwarded).
  const { data: endRef } = await supabase.from('cle_patient_refs')
    .select('patient_ref').eq('cle_id', req.params.id).eq('physician_id', req.user.id).maybeSingle();
  try {
    const out = await finalizeScreening({
      cleId: req.params.id, physicianId: cle.physician_id, transcript, tier1,
      patient_ref: endRef?.patient_ref ?? null,
    });
    res.json(out);
  } catch (err) {
    console.error(`[cles] /end tier-2 finalize failed for ${req.params.id} — left 'ended' for reconcile:`, err.message);
    res.status(202).json({ status: 'ended', criteria: tier1, pending: 'tier2' });
  }
});

// Get AI evaluation result
router.get('/:id/evaluation', async (req, res) => {
  const { data: cle } = await fetchOwnedPle(req.params.id, req.user.id, 'status');
  if (!cle) return res.status(404).json({ error: 'Not found' });
  if (cle.status !== 'evaluated') return res.status(202).json({ status: cle.status });

  // .order+limit(1)+maybeSingle, NOT .single(): if a dup-eval race left two ai_evaluations rows
  // (possible until migration-eval-unique is applied), .single() errors on >1 row and returns null —
  // the physician's earned score reads as "missing." Degrade to the FIRST (earliest) evaluation instead.
  const { data: eval_ } = await supabase
    .from('ai_evaluations').select('*').eq('cle_id', req.params.id)
    .order('evaluated_at', { ascending: true }).limit(1).maybeSingle();
  res.json(eval_);
});

module.exports = router;
