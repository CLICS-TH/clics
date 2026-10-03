const { Router } = require('express');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { ScoreSchema, PrivacyConcernSchema, SCORE_ATTESTATIONS } = require('../lib/schemas');
const { compositeScore } = require('../services/ple-gate');
const { computeICC21 } = require('../services/icc');
const { logEvent } = require('../lib/audit');
const { effectiveLimit, reserveUsage, accrueUsage, refundUsage, RESERVE_ESTIMATE_USD, effectiveTokenLimit, budgetState } = require('../lib/usage');
const { settlementDelta } = require('../lib/pricing');
const { rimplAuditDiscuss } = require('../services/rimpl-client');
const { isRimplRefusal, AI_REFUSED_MESSAGE } = require('../lib/rimpl-refusal');
const { peerCalibrationEnabled, privacyReviewRequired, calibrationRevealLocked } = require('../lib/settings');
const { whereCleared, isCleared } = require('../lib/privacy-review');
const reflection = require('../services/reflection');
const { PIS7_DIMS: CALIB_DIMS, meanByDim } = require('../lib/compensation');

// Access gate (multi-auditor pilot): an auditor may act on a PLE if they're explicitly assigned via
// audit_assignments OR they're the legacy single assignee (ples.auditor_id). One source of truth so
// the queue / view / score / discuss gates can't drift apart.
async function isAssignedAuditor(pleId, auditorId, legacyAuditorId) {
  if (legacyAuditorId && legacyAuditorId === auditorId) return true;
  const { data } = await supabase.from('audit_assignments')
    .select('ple_id').eq('ple_id', pleId).eq('auditor_id', auditorId).maybeSingle();
  return !!data;
}

// Auditors must record their confidentiality + COI consent (Appendix 04/15) before scoring — the
// same consented_at signal physicians use, set via POST /auth/consent {context:'auditor'}.
function requireAuditorConsent(req, res, next) {
  if (!req.user.consented_at) {
    return res.status(403).json({ error: 'Auditor consent (confidentiality + COI) is required before scoring.', code: 'auditor_consent_required' });
  }
  next();
}

const router = Router();
router.use(verifyJwt, requireRole('auditor'));

router.get('/queue', async (req, res) => {
  // PLEs assigned to me: the multi-auditor join table UNION the legacy single-assignee pointer. Merged
  // in JS (two small queries) to avoid PostgREST .or()/.in() quoting pitfalls; pilot-scale row counts.
  const { data: assigns } = await supabase.from('audit_assignments').select('ple_id').eq('auditor_id', req.user.id);
  const assignedIds = [...new Set((assigns ?? []).map(a => a.ple_id))];
  // EXPOSURE 4 of 4 (see backend/lib/privacy-review.js). Belt and braces: assignment is already
  // gated, but a session assigned BEFORE the gate existed — or quarantined after being assigned —
  // must drop out of the queue rather than sit there waiting to be opened.
  const privacyRequired = await privacyReviewRequired();
  // `privacy_concern_open` is filtered UNCONDITIONALLY, outside whereCleared. whereCleared is a no-op
  // when the privacy gate is off, and "a rater reported a suspected identifier" must take the session
  // out of the queue either way — that report is not a function of a setting.
  const base = () => whereCleared(supabase.from('ples')
    .select('id, status, ended_at, turn_count, token_count')
    .eq('status', 'evaluated').eq('privacy_concern_open', false), privacyRequired);
  const [legacy, viaAssign] = await Promise.all([
    base().eq('auditor_id', req.user.id),
    assignedIds.length ? base().in('id', assignedIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (legacy.error) return res.status(500).json({ error: legacy.error.message });
  if (viaAssign.error) return res.status(500).json({ error: viaAssign.error.message });
  const byId = new Map();
  for (const p of [...(legacy.data ?? []), ...(viaAssign.data ?? [])]) byId.set(p.id, p);
  const ples = [...byId.values()].sort((a, b) => String(a.ended_at).localeCompare(String(b.ended_at)));

  // Flag which assigned PLEs this auditor has ALREADY scored, so the queue can mark them and
  // surface the ones still to score (rather than locking the whole list as "already evaluated").
  const ids = ples.map(p => p.id);
  let scored = new Set();
  if (ids.length) {
    const { data: rows } = await supabase
      .from('audit_scores').select('ple_id').eq('auditor_id', req.user.id).in('ple_id', ids);
    scored = new Set((rows ?? []).map(r => r.ple_id));
  }
  res.json(ples.map(p => ({ ...p, scored: scored.has(p.id) })));
});

router.get('/ples/:id', async (req, res) => {
  const { data: ple, error: pleErr } = await supabase
    .from('ples').select('id, status, turn_count, token_count, ended_at, auditor_id, privacy_review_status, privacy_concern_open')
    .eq('id', req.params.id).maybeSingle();
  if (pleErr) return res.status(500).json({ error: 'Could not load the assigned session' });
  if (!ple || !(await isAssignedAuditor(ple.id, req.user.id, ple.auditor_id))) {
    return res.status(404).json({ error: 'Not found or not assigned' });
  }
  // Mirror the queue gate on the direct URL: an old bookmark must not expose a session whose
  // clearance was revoked or whose rater reported a new privacy concern.
  if (ple.privacy_concern_open || !isCleared(ple, await privacyReviewRequired())) {
    return res.status(404).json({ error: 'Not found or not assigned' });
  }

  // Transcript + this auditor's own score are independent — fetch together.
  const [messageResult, scoreResult] = await Promise.all([
    supabase.from('messages').select('role, content, refs, socratic_question, created_at')
      .eq('ple_id', req.params.id).order('created_at'),
    supabase.from('audit_scores').select('*').eq('ple_id', req.params.id).eq('auditor_id', req.user.id).maybeSingle(),
  ]);
  if (messageResult.error || scoreResult.error) {
    return res.status(500).json({ error: 'Could not load the complete scoring evidence' });
  }
  let messages;
  try {
    messages = await reflection.withReflection(req.params.id, messageResult.data ?? [], { strict: true });
  } catch {
    return res.status(500).json({ error: 'Could not load the complete scoring evidence' });
  }
  const existing = scoreResult.data;

  // REVEAL SURFACE 1 of 4. The other three are /discuss, /icc and /calibration below; a lock that
  // covers only this one is theatre, because the same auditor can read the AI comparison off any of
  // them. Keep all four in step.
  const revealLocked = await calibrationRevealLocked();

  let aiEval = null, peerAvg = null, peerN = 0;
  if (existing && !revealLocked) {
    // .order+limit(1)+maybeSingle, NOT .single(): a dup-eval race (possible until migration-eval-unique
    // is applied) leaves two rows, on which .single() errors and returns null — the auditor's post-score
    // AI-reveal panel would silently never render. Degrade to the first (earliest) evaluation.
    const { data } = await supabase
      .from('ai_evaluations').select('*').eq('ple_id', req.params.id)
      .order('evaluated_at', { ascending: true }).limit(1).maybeSingle();
    aiEval = data;

    // Peer-calibration (toggle): mean PIS-7 across the OTHER auditors who scored this PLE — self is
    // excluded so "vs auditor average" is a true peer comparison (not diluted by the viewer's own
    // numbers). Shown once ≥1 other auditor has scored. Post-submit only — `existing` gates this
    // exactly like the AI reveal, so the blind audit holds.
    if (await peerCalibrationEnabled()) {
      const { data: peers } = await supabase
        .from('audit_scores').select('d1,d2,d3,d4,d5,d6,d7').eq('ple_id', req.params.id).neq('auditor_id', req.user.id);
      if (peers && peers.length >= 1) { peerN = peers.length; peerAvg = meanByDim(peers); }
    }
  }

  // `reveal_locked` travels with the response so the client can SAY why the pane is empty. A blank
  // panel with no explanation reads as a bug and generates the support question the lock exists to
  // avoid answering mid-round.
  res.json({ ple, messages, audit_score: existing ?? null, ai_evaluation: aiEval, peer_avg: peerAvg, peer_n: peerN, reveal_locked: revealLocked });
});

router.post('/ples/:id/score', requireAuditorConsent, async (req, res) => {
  const parsed = ScoreSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // An auditor may only score a session that is assigned to them, in their own council, and
  // never one they ran themselves. (The audit_scores_guard trigger is the DB-level backstop.)
  const { data: ple } = await supabase
    .from('ples').select('id, auditor_id, council_id, physician_id').eq('id', req.params.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (!(await isAssignedAuditor(ple.id, req.user.id, ple.auditor_id))) return res.status(403).json({ error: 'Not assigned to you' });
  if (ple.physician_id === req.user.id) return res.status(403).json({ error: 'You cannot score your own session.' });
  if (ple.council_id !== req.user.council_id) return res.status(403).json({ error: 'Cross-council scoring is not allowed.' });

  const { data: existing } = await supabase
    .from('audit_scores').select('id').eq('ple_id', req.params.id).eq('auditor_id', req.user.id).maybeSingle();
  if (existing) return res.status(409).json({ error: 'Already scored' });

  // Re-checked here, not only in the browser. The submit control is disabled until every box is
  // ticked, but a disabled button is a courtesy to the rater — it is not the gate. An assessment that
  // reached the database without these confirmations is one the approved form says was never
  // completed, and no later analysis can tell the difference.
  const attestations = parsed.data.attestations ?? {};
  const missing = SCORE_ATTESTATIONS.filter((k) => attestations[k] !== true);
  if (missing.length) {
    return res.status(400).json({
      error: 'กรุณายืนยันให้ครบก่อนส่ง / Every pre-submit confirmation is required.',
      code: 'attestations_required', missing,
    });
  }

  const { notes, attestations: _a, ...scores } = parsed.data;
  // compositeScore iterates the seven fixed weight keys, so the anchor fields travelling in `scores`
  // cannot reach the arithmetic. Named here because the object it receives is wider than its inputs.
  const composite = compositeScore(scores);

  const { error } = await supabase.from('audit_scores').insert({
    ple_id: req.params.id, auditor_id: req.user.id,
    ...scores, composite_score: composite, notes, attestations,
  });
  // The SELECT above is a friendly pre-check; the UNIQUE(ple_id, auditor_id) constraint on audit_scores
  // is the backstop for a true concurrent double-submit — the loser surfaces as 23505, not a dup row.
  // (Multi-auditor relies on this being per-(ple,auditor): N auditors = N rows, never 2 for one auditor.)
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Already scored' });
    return res.status(500).json({ error: error.message });
  }

  logEvent({ actorId: req.user.id, actorRole: 'auditor', action: 'audit.score', targetType: 'ple',
    targetId: req.params.id, councilId: ple.council_id, metadata: { composite_score: composite } });

  res.json({ composite_score: composite });
});

// Stop the assessment and report a suspected identifier, INSTEAD of submitting a score.
//
// The approved form tells a rater who sees possible patient data to stop and notify the research team
// immediately. Until now their only options were to score it anyway or to say nothing, because there
// was nowhere to put the report.
//
// Routed into the EXISTING privacy review rather than a parallel queue: the reviewer workflow is
// already there, and returning the session to 'pending' puts the report at the top of the work list
// the reviewer actually opens. `privacy_concern_open` is what takes it out of this auditor's queue,
// and it does so whether or not the privacy gate is switched on.
router.post('/ples/:id/privacy-concern', requireAuditorConsent, async (req, res) => {
  const parsed = PrivacyConcernSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: ple } = await supabase
    .from('ples').select('id, auditor_id, council_id, physician_id, privacy_review_status, privacy_concern_open').eq('id', req.params.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (!(await isAssignedAuditor(ple.id, req.user.id, ple.auditor_id))) return res.status(403).json({ error: 'Not assigned to you' });
  if (ple.council_id !== req.user.council_id) return res.status(403).json({ error: 'Cross-council access is not allowed.' });
  // Same self-scoring guard the score route carries. A stale or hand-made self-assignment must not
  // let a physician quarantine their own session — that is a way to withdraw a session from the
  // study without withdrawing from the study.
  if (ple.physician_id === req.user.id) return res.status(403).json({ error: 'You cannot act on your own session.' });
  // A concern is already open: nothing to add, and re-reporting would overwrite the first reporter's
  // statement and reset the clock on a session someone is already looking at.
  if (ple.privacy_concern_open) {
    return res.status(409).json({ error: 'A privacy concern is already open on this session.', code: 'concern_already_open' });
  }

  // WRITES NO privacy_review_* FIELD. Reporting is not reviewing: stamping privacy_reviewed_by with
  // the reporter's own id recorded them as the person who had cleared it, and writing 'quarantined'
  // filed the report into the reviewer's already-decided bucket instead of their work queue.
  // 'pending' is the truth — a human decision is genuinely owed on this session again.
  const { error } = await supabase.from('ples').update({
    privacy_review_status: 'pending',
    privacy_concern_open: true,
    privacy_concern_by: req.user.id,
    privacy_concern_at: new Date().toISOString(),
    privacy_concern_note: parsed.data.note,
  }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  logEvent({ actorId: req.user.id, actorRole: 'auditor', action: 'privacy.concern_reported', targetType: 'ple',
    targetId: req.params.id, councilId: ple.council_id });

  res.json({ ok: true, privacy_review_status: 'pending', privacy_concern_open: true });
});

router.get('/icc', async (req, res) => {
  // REVEAL SURFACE 3 of 4. One agreement number across every PLE this auditor has scored still tells
  // them which way they sit relative to the AI, which is enough to drift on. `locked` rather than a
  // bare n:0 — "no data yet" and "withheld for this round" must not look alike.
  if (await calibrationRevealLocked()) return res.json({ icc: null, n: 0, locked: true });

  const { data } = await supabase
    .from('audit_scores').select('ple_id, composite_score').eq('auditor_id', req.user.id);

  if (!data?.length) return res.json({ icc: null, n: 0 });

  const pleIds = data.map(s => s.ple_id);
  const { data: aiScores } = await supabase
    .from('ai_evaluations').select('ple_id, composite_score').in('ple_id', pleIds);

  const pairs = data.flatMap(audit => {
    const ai = aiScores?.find(a => a.ple_id === audit.ple_id);
    return ai ? [{ ai: Number(ai.composite_score), human: Number(audit.composite_score) }] : [];
  });

  const iccResult = computeICC21(pairs);
  res.json(iccResult ?? { icc: null, n: pairs.length });
});

// ── Auditor AI discussion chat ───────────────────────────────────────────────────────────────────
// After scoring, an auditor may chat with an AI calibration tutor about the evaluation. Metered
// against the SEPARATE auditor budget pool (so a dual-role user's physician budget is untouched).
const DiscussMsgSchema = z.object({
  message: z.string().min(1).max(4000),
  language: z.enum(['th', 'en']).default('th'),
});

// No requireAuditorConsent here: discussion is only reachable AFTER a score exists (checked below),
// and scoring already enforces the confidentiality + COI consent — so the gate is redundant, and a
// fresh check would wrongly block an auditor whose score predates their consent record.
router.post('/ples/:id/discuss', async (req, res) => {
  const parsed = DiscussMsgSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: ple } = await supabase
    .from('ples').select('id, auditor_id, council_id, physician_id').eq('id', req.params.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (!(await isAssignedAuditor(ple.id, req.user.id, ple.auditor_id))) return res.status(403).json({ error: 'Not assigned to you' });

  // Blind-audit gate: discussion only AFTER the auditor has submitted their score AND an AI eval exists
  // (the discussion reveals AI per-domain scores + rationale, so it must never precede scoring).
  const { data: auditScore } = await supabase.from('audit_scores')
    .select('d1, d2, d3, d4, d5, d6, d7, composite_score')
    .eq('ple_id', req.params.id).eq('auditor_id', req.user.id).single();
  if (!auditScore) return res.status(403).json({ error: 'Score this session before discussing it.', code: 'score_required' });
  // REVEAL SURFACE 2 of 4. The discussion hands over the AI's per-domain scores AND its rationale —
  // the single most contaminating thing an auditor could read mid-round. Checked after the
  // score-required gate so the more specific refusal still wins.
  if (await calibrationRevealLocked()) {
    return res.status(403).json({ error: 'AI discussion is closed for this calibration round.', code: 'reveal_locked' });
  }
  const { data: aiEval } = await supabase.from('ai_evaluations')
    .select('d1, d2, d3, d4, d5, d6, d7, composite_score, domain_rationale')
    .eq('ple_id', req.params.id).order('evaluated_at', { ascending: true }).limit(1).maybeSingle();
  if (!aiEval) return res.status(409).json({ error: 'No AI evaluation available to discuss yet.' });

  const { message, language } = parsed.data;

  // Reserve against the AUDITOR pool before the paid call; reconcile on success, refund on failure.
  // Both ceilings ($ and tokens) close the door atomically in the RPC.
  const [limit, tokenLimit] = await Promise.all([effectiveLimit(req.user, 'auditor'), effectiveTokenLimit(req.user, 'auditor')]);
  const reservation = await reserveUsage(req.user.id, limit, RESERVE_ESTIMATE_USD, 'auditor', tokenLimit);
  if (!reservation.ok) {
    const b = await budgetState(req.user, 'auditor');
    return res.status(403).json({
      error: b.reason === 'tokens'
        ? `Auditor AI usage limit reached (${(b.tokenLimit ?? tokenLimit).toLocaleString('en-US')} tokens). Contact an administrator.`
        : `Auditor AI usage limit reached ($${limit.toFixed(2)}). Contact an administrator.`,
      code: 'budget_exceeded', reason: b.reason ?? 'cost',
    });
  }

  // Transcript (de-identified on-prem by RIMPL), patient_ref (scrub hints only), prior discussion turns.
  const { data: transcript } = await supabase.from('messages')
    .select('role, content').eq('ple_id', req.params.id).order('created_at');
  const { data: pref } = await supabase.from('ple_patient_refs')
    .select('patient_ref').eq('ple_id', req.params.id).maybeSingle();
  const { data: prior } = await supabase.from('audit_discussions')
    .select('role, content').eq('ple_id', req.params.id).eq('auditor_id', req.user.id).order('created_at');

  let rimplResponse;
  try {
    rimplResponse = await rimplAuditDiscuss({
      history: (prior ?? []).map(p => ({ role: p.role, content: p.content })),
      message, language,
      transcript: transcript ?? [],
      ai_scores: { d1: aiEval.d1, d2: aiEval.d2, d3: aiEval.d3, d4: aiEval.d4, d5: aiEval.d5, d6: aiEval.d6, d7: aiEval.d7, composite_score: aiEval.composite_score },
      ai_rationale: aiEval.domain_rationale ?? null,
      auditor_scores: auditScore,
      patient_ref: pref?.patient_ref ?? null, // scrubbed on-prem; never reaches the cloud
    });
  } catch (err) {
    // Declined by the model's safeguards: billed, so settle the AUDITOR pool to the real cost (same rule
    // as the physician chat turn in routes/ples.js) rather than refunding it.
    if (isRimplRefusal(err)) {
      const { input_tokens: inT, output_tokens: outT, provider } = err.usage;
      await accrueUsage(req.user.id, inT, outT, settlementDelta({
        estimate: RESERVE_ESTIMATE_USD, inputTokens: inT, outputTokens: outT,
        applied: reservation.applied, provider,
      }), 'auditor');
      console.warn(`[auditor] discuss turn declined by the model's safeguards (category ${err.category ?? 'none'})`);
      // COPY PENDING (#136), as in routes/ples.js.
      return res.status(422).json({ error: AI_REFUSED_MESSAGE, code: 'ai_refused' });
    }
    await refundUsage(req.user.id, RESERVE_ESTIMATE_USD, reservation.applied, 'auditor');
    return res.status(502).json({ error: `RIMPL unavailable: ${err.message}`, code: 'rimpl_unavailable' });
  }

  // Both rows MUST carry the token columns: a heterogeneous array insert unifies the column set, and
  // PostgREST sends NULL (not DEFAULT) for keys missing on a row — which would violate the not-null
  // default-0 token columns. So set 0 explicitly on the auditor turn.
  const { error: insErr } = await supabase.from('audit_discussions').insert([
    // provider / model / prompt_version are nullable with no default, so NULL on the auditor's own
    // turn is exactly right — it was not produced by any model.
    { ple_id: req.params.id, auditor_id: req.user.id, role: 'auditor', content: message, input_tokens: 0, output_tokens: 0 },
    { ple_id: req.params.id, auditor_id: req.user.id, role: 'assistant', content: rimplResponse.content,
      input_tokens: rimplResponse.input_tokens ?? 0, output_tokens: rimplResponse.output_tokens ?? 0,
      provider: rimplResponse.provider ?? null, model: rimplResponse.model ?? null,
      prompt_version: rimplResponse.prompt_version ?? null },
  ]);
  if (insErr) console.error('[auditor] audit_discussions insert failed:', insErr.message);
  if (insErr) {
    await refundUsage(req.user.id, RESERVE_ESTIMATE_USD, reservation.applied, 'auditor'); // not saved — release
    return res.status(500).json({ error: 'Failed to save the message. Please try again.' });
  }

  // Settle against the AUDITOR pool at the rate of the provider that actually served the turn (local
  // = $0, so the delta is −estimate and the reservation is released rather than stranded). Same
  // costOverride route as the physician chat turn — see routes/ples.js for why usage.js stays
  // provider-agnostic.
  await accrueUsage(req.user.id, rimplResponse.input_tokens ?? 0, rimplResponse.output_tokens ?? 0, settlementDelta({
    estimate: RESERVE_ESTIMATE_USD,
    inputTokens: rimplResponse.input_tokens ?? 0, outputTokens: rimplResponse.output_tokens ?? 0,
    applied: reservation.applied,
    provider: rimplResponse.provider,
  }), 'auditor');
  logEvent({ actorId: req.user.id, actorRole: 'auditor', action: 'audit.discuss', targetType: 'ple',
    targetId: req.params.id, councilId: ple.council_id });

  res.json({ content: rimplResponse.content });
});

router.get('/ples/:id/discussion', async (req, res) => {
  // Only an assigned auditor may read their own discussion thread.
  const { data: ple } = await supabase.from('ples').select('id, auditor_id').eq('id', req.params.id).single();
  if (!ple || !(await isAssignedAuditor(ple.id, req.user.id, ple.auditor_id))) return res.status(404).json({ error: 'Not found or not assigned' });
  const { data } = await supabase.from('audit_discussions')
    .select('role, content, created_at').eq('ple_id', req.params.id).eq('auditor_id', req.user.id).order('created_at');
  res.json(data ?? []);
});

// Per-dimension calibration: this auditor's MEAN PIS-7 (d1–d7) vs the AI's MEAN, across the PLEs
// they've scored that also have an AI evaluation (same pairing as /icc, but per-domain means instead
// of a composite ICC). Powers the aggregate radar on the auditor home hero. n=0 → nothing to plot.
router.get('/calibration', async (req, res) => {
  // REVEAL SURFACE 4 of 4. The home-page radar plots this auditor against the AI and against their
  // peers per domain — the most directly imitable view of all.
  if (await calibrationRevealLocked()) return res.json({ n: 0, auditor: null, ai: null, peer: null, locked: true });

  const { data: audits } = await supabase
    .from('audit_scores').select('ple_id, d1, d2, d3, d4, d5, d6, d7').eq('auditor_id', req.user.id);
  if (!audits?.length) return res.json({ n: 0, auditor: null, ai: null, peer: null });

  const pleIds = audits.map(a => a.ple_id);
  const { data: aiRows } = await supabase
    .from('ai_evaluations').select('ple_id, d1, d2, d3, d4, d5, d6, d7').in('ple_id', pleIds);
  const aiById = new Map((aiRows ?? []).map(r => [r.ple_id, r]));

  const sumA = Object.fromEntries(CALIB_DIMS.map(d => [d, 0]));
  const sumAi = Object.fromEntries(CALIB_DIMS.map(d => [d, 0]));
  let n = 0;
  for (const a of audits) {
    const ai = aiById.get(a.ple_id);
    if (!ai) continue; // only pairs with a matching AI evaluation count (mirrors /icc)
    n++;
    for (const d of CALIB_DIMS) { sumA[d] += Number(a[d] || 0); sumAi[d] += Number(ai[d] || 0); }
  }
  if (!n) return res.json({ n: 0, auditor: null, ai: null, peer: null });

  const auditor = Object.fromEntries(CALIB_DIMS.map(d => [d, sumA[d] / n]));
  const ai = Object.fromEntries(CALIB_DIMS.map(d => [d, sumAi[d] / n]));

  // Peer-calibration (toggle): the OTHER auditors' MEAN across the same paired PLEs — each PLE's
  // mean-across-other-auditors, then averaged across PLEs (so a PLE with many raters isn't overweighted).
  // Self is excluded so this mirrors the per-PLE "vs other auditors" comparison.
  let peer = null;
  if (await peerCalibrationEnabled()) {
    const pairedIds = audits.filter(a => aiById.has(a.ple_id)).map(a => a.ple_id);
    const { data: peerRows } = pairedIds.length
      ? await supabase.from('audit_scores').select('ple_id, d1,d2,d3,d4,d5,d6,d7').in('ple_id', pairedIds).neq('auditor_id', req.user.id)
      : { data: [] };
    const byPle = new Map();
    for (const s of peerRows ?? []) {
      if (!byPle.has(s.ple_id)) byPle.set(s.ple_id, []);
      byPle.get(s.ple_id).push(s);
    }
    const sumPeer = Object.fromEntries(CALIB_DIMS.map(d => [d, 0]));
    let np = 0;
    for (const rows of byPle.values()) {
      const m = meanByDim(rows);
      if (!m) continue;
      np++;
      for (const d of CALIB_DIMS) sumPeer[d] += m[d];
    }
    if (np) peer = Object.fromEntries(CALIB_DIMS.map(d => [d, sumPeer[d] / np]));
  }
  res.json({ n, auditor, ai, peer });
});

module.exports = router;
