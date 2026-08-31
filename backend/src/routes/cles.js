const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { MessageSchema, CreateCleSchema, UpdateCleSchema, ReflectionSchema } = require('../lib/schemas');
const { computeTier1, hasScorableContent, clampDuration } = require('../services/cle-gate');
const { rimplChat } = require('../services/rimpl-client');
const { fetchOwnedPle, ownsFolder, sendDbError } = require('../lib/db-helpers');
const { finalizeScreening, toPassCols } = require('../services/cle-finalize');
const { effectiveLimit, reserveUsage, accrueUsage, refundUsage, RESERVE_ESTIMATE_USD } = require('../lib/usage');
const { settlementDelta, costUsd } = require('../lib/pricing');
const { logEvent } = require('../lib/audit');
const { pilotTestMode, clinicalArtifactsEnabled, holdResultUntilAudited, t1RemediationEnabled, identityVerificationRequired, reflectionRequired } = require('../lib/settings');
const identity = require('../services/identity');
const reflection = require('../services/reflection');
const acceptability = require('../lib/acceptability');
const { creditSettings } = require('../lib/settings');
const { creditFor, creditTable } = require('../services/credit');
const { COMPLETED_STATUSES } = require('../lib/cle-status');
const { scanCle, flagRescueReplyBreach } = require('../services/integrity-scan');

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
// CREC082 ICF §4: identity is verified BEFORE the first PLE, by ThaID or by national ID together
// with the medical licence number. Sits beside requireConsent because the two are the protocol's
// two preconditions for starting a session, and they should be read together.
//
// Off by default (see settings.identityVerificationRequired) — it must be switched on before the
// first participant. When on it fails CLOSED, including on a database error: an identity gate that
// opens when the read fails is not a gate.
async function requireVerifiedIdentity(req, res, next) {
  try {
    if (!(await identityVerificationRequired())) return next();
    if (await identity.isVerified(req.user.id)) return next();
    return res.status(403).json({
      error: 'Identity verification is required before starting a session.',
      code: 'identity_verification_required',
    });
  } catch (e) {
    console.error('[cles] identity gate check failed:', e.message);
    return res.status(503).json({ error: 'Could not verify your identity right now. Please try again.', code: 'identity_check_unavailable' });
  }
}

router.post('/', requireConsent, requireVerifiedIdentity, requireBudget, async (req, res) => {
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
  // episode_number = (# of their COMPLETED CLEs) + 1, so a retried attempt keeps the same episode
  // until it passes. Block a 4th once 3 have completed — UNLESS Pilot Test Mode is on (testers loop).
  // COMPLETED_STATUSES, not 'cle_pass' alone: a scored CLE moves straight on to 'evaluated', so
  // filtering on 'cle_pass' counted zero and left every physician stuck at episode 1 forever.
  const { count: passedCount, error: countErr } = await supabase.from('cles')
    .select('id', { count: 'exact', head: true })
    .eq('physician_id', req.user.id).in('status', COMPLETED_STATUSES).eq('is_test', false);
  if (sendDbError(res, countErr)) return;
  const passed = passedCount ?? 0;
  if (passed >= 3 && !pilotMode) {
    return res.status(403).json({ error: 'You have completed all 3 CLEs for this study.', code: 'cle_limit_reached' });
  }
  const episodeNumber = Math.min(passed + 1, 3);

  // Socratic mode is NOT an experimental condition. The CREC082 protocol is explicit — PLE
  // Instruction Sheet §4 and ICF §3 — that it is "a standardized rescue ... not an experimental
  // arm": a learning scaffold the system may open MID-SESSION, after 4 physician-AI exchanges, when
  // the conversation still is not qualifying or has drifted off topic.
  //
  // An earlier build allocated one of the physician's 3 episodes to Socratic by hashing their id and
  // opened that session in examiner mode from the first turn. That is a randomised trial arm, i.e.
  // the precise thing the protocol tells the ethics committee the study does not do, so it is gone:
  // no session now starts in Socratic mode on account of which episode it is. The rescue is decided
  // during the conversation and lives in the rimpl chat path, not here.
  let socraticActive = false, socraticReason = null;

  // A physician who has failed Tier-1 three times running may open in Socratic remediation. This is
  // a support path rather than a study condition, but it is ALSO not in the approved protocol, so it
  // is off by default and must be switched on deliberately and recorded as a deviation.
  // Cheap local check first so the common path costs no settings read.
  if ((req.user.consecutive_t1_fails ?? 0) >= 3 && await t1RemediationEnabled()) {
    socraticActive = true;
    socraticReason = 't1_remediation';
  }
  // Pilot Test Mode override: a tester directly chooses the mode so they can exercise Socratic
  // (or natural) on demand. These sessions are flagged is_test below.
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
    specialty_id: req.user.specialty_id ?? null,   // denormalized too; scopes the council × specialty pipeline
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
    .select('id, title, chief_complaint, folder_id, status, episode_number, started_at, ended_at, turn_count, token_count, c1_pass, c2_pass, c3_pass, c4_pass, c5_pass, c6_pass')
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
  // Hold-until-audited: drop snapshots for CLEs no auditor has scored yet, so the trend (and the
  // dashboard "latest score", which reads the last snapshot) can't leak a held score. See /evaluation.
  let rows = data ?? [];
  let held = 0;
  if (rows.length && await holdResultUntilAudited()) {
    const cleIds = [...new Set(rows.map(r => r.cle_id))];
    const { data: scored } = await supabase.from('audit_scores').select('cle_id').in('cle_id', cleIds);
    const scoredSet = new Set((scored ?? []).map(s => s.cle_id));
    held = cleIds.filter(id => !scoredSet.has(id)).length;
    rows = rows.filter(r => scoredSet.has(r.cle_id));
  }
  // `held` is the COUNT of the physician's own episodes still awaiting an auditor — never a score,
  // never a domain, nothing the hold exists to withhold. It is here because without it the filter
  // above is indistinguishable from having done nothing at all: the portal received a bare [] and
  // told a physician whose work was sitting in the audit queue to "pass an episode first".
  //
  // Opt-in on the query string, because the portal (Vercel) and this API (Railway) deploy
  // separately and browsers cache the portal. A client that has not asked for the new shape — an
  // older lpdp.html, which tests `!data.length` — must keep receiving the bare array, or the
  // deploy window shows every physician the very empty state this change exists to prevent.
  if (req.query.held === '1') return res.json({ snapshots: rows, held });
  res.json(rows);
});

// Get single CLE with messages
// ---- Acceptability questionnaire (CREC082 ICF §3 step 4, Protocol objective 5) ----------------
// ONE per physician, at the end of participation. A named secondary outcome in the SAP, so without
// it there is simply nothing to report on acceptability, burden, or the privacy experience.
//
// "brief acceptability questionnaire หนึ่งครั้งเมื่อสิ้นสุดการเข้าร่วม โดยปกติหลัง PLE ครั้งสุดท้าย
//  (ไม่เกิน 3 ครั้ง). กรณีถอนตัวก่อนครบ 3 PLE participant มีสิทธิไม่ตอบแบบสอบถามโดยไม่มีผลใด."
//
// That last sentence is why eligibility is "has completed at least one PLE" rather than "has
// completed three": a physician who withdraws early is still entitled to answer, and still entitled
// not to.

router.get('/acceptability', requireConsent, async (req, res) => {
  const [{ count }, { data: existing }] = await Promise.all([
    supabase.from('cles').select('id', { count: 'exact', head: true })
      .eq('physician_id', req.user.id).in('status', COMPLETED_STATUSES).eq('is_test', false),
    supabase.from('acceptability_responses')
      .select('answers, comments, skipped, submitted_at').eq('physician_id', req.user.id).maybeSingle(),
  ]);
  const completed = count ?? 0;
  res.json({
    // The item set travels with the request so the portal never carries a second copy of the wording
    // that could drift from the approved instrument.
    items: acceptability.ITEMS,
    instrument_version: acceptability.INSTRUMENT_VERSION,
    scale: { min: acceptability.SCALE_MIN, max: acceptability.SCALE_MAX },
    completed_ples: completed,
    eligible: completed >= 1,
    response: existing ?? null,
  });
});

router.post('/acceptability', requireConsent, async (req, res) => {
  const skipped = req.body?.skipped === true;
  const comments = typeof req.body?.comments === 'string' ? req.body.comments.trim().slice(0, 5000) : null;

  const check = skipped ? { ok: true, answers: {} } : acceptability.validateAnswers(req.body?.answers ?? {});
  if (!check.ok) return res.status(400).json({ error: 'Invalid answers.', code: check.code, item: check.item });

  const { count } = await supabase.from('cles').select('id', { count: 'exact', head: true })
    .eq('physician_id', req.user.id).in('status', COMPLETED_STATUSES).eq('is_test', false);
  if ((count ?? 0) < 1) {
    return res.status(409).json({ error: 'Complete a learning episode first.', code: 'no_completed_ple' });
  }

  // Unique on physician_id — the questionnaire is about the SYSTEM, not a session, so a resubmission
  // corrects the one response rather than adding a second.
  const { error } = await supabase.from('acceptability_responses').upsert({
    physician_id: req.user.id,
    answers: { ...check.answers, _instrument_version: acceptability.INSTRUMENT_VERSION },
    comments: skipped ? null : (comments || null),
    skipped,
    submitted_at: new Date().toISOString(),
  }, { onConflict: 'physician_id' });
  if (error) {
    console.error('[cles] acceptability save failed:', error.message);
    return res.status(500).json({ error: 'Could not save your answers. Please try again.' });
  }

  // No answer content in the log — only that a response landed. The responses are research data and
  // belong in one place, not scattered through an audit trail.
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'cle.acceptability',
    targetType: 'professional', targetId: req.user.id, councilId: req.user.council_id ?? null,
    metadata: { skipped, answered: Object.keys(check.answers).length, instrument: acceptability.INSTRUMENT_VERSION } });
  res.json({ ok: true, skipped });
});

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
      artifacts: await clinicalArtifactsEnabled(), // superadmin toggle → allow side-panel artifacts
      // CREC082 PLE Instruction Sheet §4 rescue. Both are latches: a rescued session stays rescued,
      // and a session that has qualified does not un-qualify — so RIMPL can skip the classifier.
      rescue_active: cle.rescue_activated_at != null,
      already_qualified: cle.qualified_at != null,
      // Rounds this rescue has already run, so RIMPL can stop paying to re-ask a question whose
      // answer has not changed. Derived, not stored: rescue_exchanges_before is the turn count at
      // activation, so the difference IS the number of rounds spent in rescue.
      rescue_rounds: Math.max(0, (cle.turn_count ?? 0) - (cle.rescue_exchanges_before ?? 0)),
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

  // Socratic rescue bookkeeping (CREC082 §4). RIMPL decides; the backend is where it becomes a fact.
  // The SAP analyses trigger rate, activation point, and exchanges before/after, so an unrecorded
  // rescue is a lost data point — but it is still only bookkeeping, so it rides along with the turn
  // counters rather than getting its own write that could fail on its own.
  const rescue = rimplResponse.rescue ?? null;
  const rescueCols = {};
  if (rescue?.activated && cle.rescue_activated_at == null) {
    rescueCols.rescue_activated_at = new Date().toISOString();
    rescueCols.rescue_reason = rescue.reason;                       // 'off_topic' | 'not_qualifying'
    rescueCols.rescue_exchanges_before = rescue.exchanges_before ?? null;
    rescueCols.socratic_active = true;
    rescueCols.socratic_reason = 'protocol_rescue';
  }
  // Latch the moment the session first met the CREC §1 qualifying test, so later turns skip the
  // classifier. Also the honest answer to "when did this become a PLE?", which the rescue analysis
  // needs in order to count exchanges AFTER an activation.
  if (rescue && rescue.qualifying && cle.qualified_at == null) {
    rescueCols.qualified_at = new Date().toISOString();
    // Qualifying ENDS a protocol rescue, whichever flag arrives first. Without this, two turns in
    // flight could set qualified_at and rescue_activated_at from the same pre-rescue snapshot; the
    // qualified latch would then suppress every later assessment, no `recovered` could ever fire,
    // and the session would stay in examiner mode until it ended.
    if (cle.socratic_reason === 'protocol_rescue') rescueCols.socratic_active = false;
  }
  // The session came back. The rescue is a loop that ends when the conversation qualifies again, so
  // this is where it ends — and it is the "return to PLE eligibility" the analysis plan asks for.
  // Unobservable before, because a rescued session was assessed exactly once and so could never be
  // seen recovering; the rescue simply ran until the session ended.
  if (rescue?.recovered) {
    rescueCols.socratic_active = false;
    rescueCols.rescue_outcome = 'recovered';
    // socratic_reason deliberately stays 'protocol_rescue'. Clearing it would erase the fact that
    // this session was ever rescued, which is the thing the analysis is about.
    //
    // Turn counts, not timestamps: rescue_activated_at and qualified_at already bracket the rescue
    // in time, but the plan reports EXCHANGES, and no arithmetic on two timestamps yields a turn
    // count. cle.turn_count is the count before this turn, so +1 includes the one being served.
    if (cle.rescue_exchanges_before != null && cle.rescue_exchanges_after == null) {
      rescueCols.rescue_exchanges_after = Math.max(0, (cle.turn_count ?? 0) + 1 - cle.rescue_exchanges_before);
    }
  }
  // The rescue gave up. A bounded intervention has to end somewhere, and ending it silently is what
  // the round cap originally did: the session stopped being re-assessed, kept `socratic_active`, and
  // so ran to the end on the general examiner prompt with nothing in the row to say the rescue had
  // stopped working. Closed out here on the same terms as a recovery, differing only in the outcome.
  if (rescue?.exhausted) {
    rescueCols.socratic_active = false;
    rescueCols.rescue_outcome = 'exhausted';
    if (cle.rescue_exchanges_before != null && cle.rescue_exchanges_after == null) {
      rescueCols.rescue_exchanges_after = Math.max(0, (cle.turn_count ?? 0) + 1 - cle.rescue_exchanges_before);
    }
  }
  // Re-assessing every round costs a classifier call per round, and that spend belongs to the study,
  // not to the physician: the system chose the intervention. Charging their budget for it would
  // penalise exactly the people whose conversation had not yet qualified. Accumulated per episode
  // rather than in a per-user pool, because it is not attributable to anyone's quota.
  if (rescue?.assessment && (rescue.assessment.input_tokens || rescue.assessment.output_tokens)) {
    const { input_tokens: aIn = 0, output_tokens: aOut = 0, provider: aProv } = rescue.assessment;
    rescueCols.rescue_assessment_tokens = (cle.rescue_assessment_tokens ?? 0) + aIn + aOut;
    rescueCols.rescue_assessment_cost_usd =
      Number(cle.rescue_assessment_cost_usd ?? 0) + costUsd(aIn, aOut, aProv ?? undefined);
  }
  if (rescue?.reply_check && rescue.reply_check.ok === false) {
    // The rescue prompt forbids diagnosing and caps the questions at two; this reply broke one of
    // those. Don't block — the physician already has the reply, and suppressing it would cost them
    // the turn for OUR error. Record it instead: console.error alone put the violation in the
    // hosting provider's log retention, where "did any rescue turn give a diagnosis?" — a question
    // CREC082 §4 invites the ethics committee to ask — could not be answered from the dataset.
    try {
      await flagRescueReplyBreach({ cleId: req.params.id, check: rescue.reply_check, turn: (cle.turn_count ?? 0) + 1 });
    } catch (e) {
      console.error('[cles] failed to record a rescue post-check breach:', req.params.id, e.message);
    }
  }

  const { error: counterErr } = await supabase.from('cles').update({
    turn_count: (cle.turn_count ?? 0) + 1,
    token_count: (cle.token_count ?? 0) + (rimplResponse.token_count ?? 0) + physicianTokens,
    input_tokens: (cle.input_tokens ?? 0) + turnIn,
    output_tokens: (cle.output_tokens ?? 0) + turnOut,
    ...rescueCols,
  }).eq('id', req.params.id);
  if (counterErr) console.error('[cles] failed to update counters:', counterErr.message);

  // Settle the reservation to the turn's REAL cost, priced against the provider that ACTUALLY served
  // it (rimpl reports it; the on-prem model is $0). We compute the delta here and pass it as
  // accrueUsage's existing signed `costOverride` rather than teaching usage.js about providers: the
  // meter module already accepts a signed cost, so this needs zero change to the shared pool/RPC
  // mechanics — the least invasive of the two options, and it keeps vendor rates in one file.
  // The tokens are still reported (p_in/p_out) even at $0, so usage reporting stays truthful.
  // A local turn settles to −estimate, which RELEASES the reservation: skipping the settle "because
  // it's free" would strand $0.02 on the meter every turn and throttle the physician for free tokens.
  await accrueUsage(req.user.id, turnIn, turnOut, settlementDelta({
    estimate: RESERVE_ESTIMATE_USD,
    inputTokens: turnIn, outputTokens: turnOut,
    applied: reservation.applied,
    provider: rimplResponse.provider,
  }));

  res.json(rimplResponse);
});

// End session and run CLE quality gate
router.post('/:id/end', requireConsent, async (req, res) => {
  const { data: cle } = await fetchOwnedPle(req.params.id, req.user.id);
  if (!cle || cle.status !== 'active') return res.status(400).json({ error: 'CLE not active' });

  const endedAt = new Date();
  const wallClockSeconds = Math.max(0, Math.floor((endedAt - new Date(cle.started_at)) / 1000));
  // Clamp the client-reported active-engagement time to wall-clock (see clampDuration): an unclamped
  // client value lets a physician POST active_seconds:99999 and pass C1's 10-min engagement gate on a
  // seconds-long session.
  const durationSeconds = clampDuration(req.body?.active_seconds, wallClockSeconds);

  // Derive turn/token counts from the SOURCE OF TRUTH (the messages rows), not the cached counters on
  // the cle row — a concurrent /message does a non-atomic read-modify-write on those, so a lost
  // increment could wrongly fail C2 (turns>=4) / C3 (tokens>=10000) on a qualifying session. Read here
  // (before the claim) so two racing /end requests both compute correctly; the claim is the sole gate.
  const { data: messages } = await supabase
    .from('messages').select('role, content, token_count').eq('cle_id', req.params.id).order('created_at');
  const msgs = messages ?? [];
  const turnCount = msgs.filter(m => m.role === 'physician').length;
  const tokenCount = msgs.reduce((a, m) => a + (m.token_count ?? 0), 0);

  const counts = { duration_seconds: durationSeconds, turn_count: turnCount, token_count: tokenCount };
  // c1-c3 are recorded, not enforced — see services/cle-gate.js. CREC082 §1 defines a qualifying PLE
  // by four QUALITIES (c4-c7, assessed in cle-finalize.js), not by minutes or tokens, so a concise
  // but genuinely reflective session must reach the classifier rather than being rejected unscored.
  const tier1 = computeTier1(counts);
  // The only remaining hard stop, and it is not a quality bar: an empty conversation has nothing to
  // classify, so spending a paid classifier call on it would buy nothing.
  const scorable = hasScorableContent(counts);

  // Claim the session AND persist the full deterministic result in ONE atomic update. A double-submit
  // (double-click, two tabs, a retry after a slow response) must never run two evaluations — only the
  // request that flips active->{cle_fail_t1|ended} proceeds; racers see 0 rows and 409. Writing
  // duration/counts/c1-c3/ended_at HERE (no network) means a process death during the tier-2 call
  // below leaves a fully-recoverable 'ended' row: reconcile re-runs only the missing tier-2 step.
  const claimStatus = scorable ? 'ended' : 'cle_fail_t1';
  const { data: claimed, error: claimErr } = await supabase.from('cles').update({
    status: claimStatus, ended_at: endedAt.toISOString(),
    duration_seconds: durationSeconds, turn_count: turnCount, token_count: tokenCount,
    ...toPassCols(tier1),
  }).eq('id', req.params.id).eq('status', 'active').select('id');
  if (sendDbError(res, claimErr)) return;
  if (!claimed || claimed.length === 0) return res.status(409).json({ error: 'CLE not active' });

  // The consecutive-failure counter used to be fed from the tier-1 verdict here. Tier-1 no longer
  // IS a verdict, so feeding it from here would record a pass for every session that reached /end
  // and silently reset the counter forever. It now runs in cle-finalize.js off the qualifying
  // result, which is the outcome the counter was always trying to describe.

  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'cle.end', targetType: 'cle',
    targetId: cle.cle_code ?? req.params.id, councilId: cle.council_id ?? null,
    metadata: { scorable, tier1_metadata: tier1 } });

  // Integrity scan (CREC082 §1 excludes "passive copying of AI answers" from what counts as a PLE).
  // HERE, right after the claim, because this is the first moment the transcript is final: the
  // session is no longer 'active', so no further turn can be appended, and the reflection is a row
  // in its own table rather than a message. Running it on EVERY ended session — including the
  // unscorable ones — keeps the claim simple: every session that ended was scanned.
  //
  // Awaited inside try/catch rather than fired and forgotten: it makes the scan deterministic for
  // tests and for reconcile, and three indexed queries are nothing beside the classifier call this
  // same handler is about to make. What it must never do is cost the physician the session they
  // just finished — a detector fault is OUR problem, so it is logged and the response continues.
  //
  // F2 (cross-session reuse) is inherently late-binding: this scan compares against the sessions
  // that exist NOW. If a LATER session copies this one, the flag lands on the later session — the
  // one that did the reusing — which is the right place for it, so nothing needs backfilling.
  try {
    const scan = await scanCle({ cleId: req.params.id, physicianId: cle.physician_id });
    if (scan.flags.length) {
      logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'cle.integrity_scan', targetType: 'cle',
        targetId: cle.cle_code ?? req.params.id, councilId: cle.council_id ?? null,
        metadata: { signals: scan.flags.map(f => f.signal), turns: scan.scanned_turns, trigger: 'end' } });
    }
  } catch (e) {
    console.error('[cles] integrity scan failed at /end (session unaffected):', req.params.id, e.message);
  }

  // Nothing to classify. Recorded, not judged — the physician simply never had a conversation.
  if (!scorable) return res.json({ status: 'cle_fail_t1', criteria: tier1 });

  // The reflection is SCORED EVIDENCE, not a follow-up survey: PIS-7 is assessed on "transcript และ
  // reflection", and the D6 anchor starts at "0: ไม่มี reflection". Screening the session now would
  // judge c6 — one of the four qualifying elements — on a transcript the protocol says is
  // incomplete, and would do it silently.
  //
  // So stop here and let the physician write it. The session rests at 'ended', which is ALREADY the
  // system's recoverable "tier-1 done, tier-2 pending" state: POST /cles/:id/reflection finalises it,
  // and a session abandoned here is picked up by reconcile's existing sweep. Nothing new is needed
  // for the failure case.
  if (await reflectionRequired() && !(await reflection.getFor(req.params.id))) {
    return res.json({ status: 'ended', pending: 'reflection', criteria: tier1 });
  }

  // Tier-1 passed: run tier-2 criteria (retried) and finalize. On a PERSISTENT RIMPL failure the
  // session stays 'ended' (recoverable) and reconcile retries it — a transient blip must NOT
  // permanently demote a qualifying session to manual QA.
  const transcript = await reflection.withReflection(req.params.id, msgs.map(m => ({ role: m.role, content: m.content })));
  // Patient identifier → scrubbed from the transcript on-prem before the cloud eval (never forwarded).
  const { data: endRef } = await supabase.from('cle_patient_refs')
    .select('patient_ref').eq('cle_id', req.params.id).eq('physician_id', req.user.id).maybeSingle();
  try {
    const out = await finalizeScreening({
      cleId: req.params.id, physicianId: cle.physician_id, transcript, tier1,
      patient_ref: endRef?.patient_ref ?? null,
      cle, // socratic_reason + is_test, so the consecutive-failure counter can skip the sessions it must
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

  // Blinded test round: when the superadmin "hold result until audited" toggle is ON, withhold the
  // physician's score until an expert auditor has submitted one for this CLE (so physicians can't see/
  // compare scores before review). The result page polls this endpoint and reveals once an auditor scores.
  if (await holdResultUntilAudited()) {
    const { data: audited } = await supabase
      .from('audit_scores').select('id').eq('cle_id', req.params.id).limit(1).maybeSingle();
    if (!audited) return res.status(202).json({ status: 'pending_review' });
  }

  // .order+limit(1)+maybeSingle, NOT .single(): if a dup-eval race left two ai_evaluations rows
  // (possible until migration-eval-unique is applied), .single() errors on >1 row and returns null —
  // the physician's earned score reads as "missing." Degrade to the FIRST (earliest) evaluation instead.
  const { data: eval_ } = await supabase
    .from('ai_evaluations').select('*').eq('cle_id', req.params.id)
    .order('evaluated_at', { ascending: true }).limit(1).maybeSingle();
  if (!eval_) return res.json(eval_);

  // Credit band. Attached HERE rather than on GET /cles/:id because this is where the score is —
  // composite_score lives on ai_evaluations, not on cles — and because this endpoint already sits
  // behind the hold-until-audited gate above. Hanging it off the CLE row instead would both read an
  // undefined score and hand the physician a band while their result was supposed to be withheld.
  //
  // While credit_conversion_enabled = 0 this is a PREVIEW: `credits` is what the band WOULD be worth
  // and `awarded_credits` is null. The UI keys its "ยังไม่นับเป็นหน่วยกิต CME" wording off `enabled`,
  // not off the presence of this object.
  const settings = await creditSettings();
  const credit = { ...creditFor(eval_.composite_score, settings), table: creditTable(settings) };
  res.json({ ...eval_, credit });
});


// ---- Post-PLE reflection (CREC082 ICF §3 step 3) ---------------------------------------------
// Submitting one is what releases a session from 'ended' into screening, because the reflection is
// part of what gets screened. Skipping is allowed and recorded — a physician may decline any part of
// participation (ICF §7), and a skipped reflection is itself the reason D6 scores low.

router.get('/:id/reflection', requireConsent, async (req, res) => {
  const { data: cle } = await fetchOwnedPle(req.params.id, req.user.id);
  if (!cle) return res.status(404).json({ error: 'Not found' });
  res.json({ cle_id: cle.id, status: cle.status, reflection: await reflection.getFor(cle.id) });
});

router.post('/:id/reflection', requireConsent, async (req, res) => {
  const parsed = ReflectionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { learned, uncertainty, application, skipped } = parsed.data;

  const { data: cle } = await fetchOwnedPle(req.params.id, req.user.id);
  if (!cle) return res.status(404).json({ error: 'Not found' });
  // A session still running has no reflection to write; one already screened has been scored, and
  // accepting a reflection afterwards would mean the score was computed without evidence that is now
  // on file — worse than not accepting it.
  if (cle.status !== 'ended') {
    return res.status(409).json({ error: 'This session is not awaiting a reflection.', code: 'not_awaiting_reflection', status: cle.status });
  }

  const wrote = await reflection.save({
    cleId: cle.id, physicianId: req.user.id, learned, uncertainty, application, skipped,
  });
  if (!wrote.ok) {
    console.error('[cles] reflection save failed:', wrote.message);
    return res.status(500).json({ error: 'Could not save your reflection. Please try again.' });
  }

  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'cle.reflection', targetType: 'cle',
    targetId: cle.cle_code ?? cle.id, councilId: cle.council_id ?? null, metadata: { skipped: !!skipped } });

  // Now screen it, with the reflection in the transcript. Same shape as /end: a persistent RIMPL
  // failure leaves the session at 'ended' for reconcile rather than flagging a qualifying session.
  const { data: messages } = await supabase.from('messages')
    .select('role, content').eq('cle_id', cle.id).order('created_at');
  const transcript = await reflection.withReflection(cle.id, (messages ?? []).map(m => ({ role: m.role, content: m.content })));
  const { data: pref } = await supabase.from('cle_patient_refs')
    .select('patient_ref').eq('cle_id', cle.id).eq('physician_id', req.user.id).maybeSingle();
  try {
    const out = await finalizeScreening({
      cleId: cle.id, physicianId: req.user.id, transcript,
      tier1: { c1: cle.c1_pass, c2: cle.c2_pass, c3: cle.c3_pass },
      patient_ref: pref?.patient_ref ?? null, cle,
    });
    res.json(out);
  } catch (err) {
    console.error(`[cles] screening after reflection failed for ${cle.id} — left 'ended' for reconcile:`, err.message);
    res.status(202).json({ status: 'ended', pending: 'tier2' });
  }
});


module.exports = router;
