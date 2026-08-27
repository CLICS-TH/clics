const { Router } = require('express');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { ScoreSchema } = require('../lib/schemas');
const { compositeScore } = require('../services/cle-gate');
const { computeICC21 } = require('../services/icc');
const { logEvent } = require('../lib/audit');
const { effectiveLimit, reserveUsage, accrueUsage, refundUsage, RESERVE_ESTIMATE_USD } = require('../lib/usage');
const { settlementDelta } = require('../lib/pricing');
const { rimplAuditDiscuss } = require('../services/rimpl-client');
const { peerCalibrationEnabled, privacyReviewRequired } = require('../lib/settings');
const { whereCleared } = require('../lib/privacy-review');
const { PIS7_DIMS: CALIB_DIMS, meanByDim } = require('../lib/compensation');

// Access gate (multi-auditor pilot): an auditor may act on a CLE if they're explicitly assigned via
// audit_assignments OR they're the legacy single assignee (cles.auditor_id). One source of truth so
// the queue / view / score / discuss gates can't drift apart.
async function isAssignedAuditor(cleId, auditorId, legacyAuditorId) {
  if (legacyAuditorId && legacyAuditorId === auditorId) return true;
  const { data } = await supabase.from('audit_assignments')
    .select('cle_id').eq('cle_id', cleId).eq('auditor_id', auditorId).maybeSingle();
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
  // CLEs assigned to me: the multi-auditor join table UNION the legacy single-assignee pointer. Merged
  // in JS (two small queries) to avoid PostgREST .or()/.in() quoting pitfalls; pilot-scale row counts.
  const { data: assigns } = await supabase.from('audit_assignments').select('cle_id').eq('auditor_id', req.user.id);
  const assignedIds = [...new Set((assigns ?? []).map(a => a.cle_id))];
  // EXPOSURE 4 of 4 (see backend/lib/privacy-review.js). Belt and braces: assignment is already
  // gated, but a session assigned BEFORE the gate existed — or quarantined after being assigned —
  // must drop out of the queue rather than sit there waiting to be opened.
  const privacyRequired = await privacyReviewRequired();
  const base = () => whereCleared(supabase.from('cles')
    .select('id, status, ended_at, turn_count, token_count').eq('status', 'evaluated'), privacyRequired);
  const [legacy, viaAssign] = await Promise.all([
    base().eq('auditor_id', req.user.id),
    assignedIds.length ? base().in('id', assignedIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (legacy.error) return res.status(500).json({ error: legacy.error.message });
  if (viaAssign.error) return res.status(500).json({ error: viaAssign.error.message });
  const byId = new Map();
  for (const p of [...(legacy.data ?? []), ...(viaAssign.data ?? [])]) byId.set(p.id, p);
  const cles = [...byId.values()].sort((a, b) => String(a.ended_at).localeCompare(String(b.ended_at)));

  // Flag which assigned CLEs this auditor has ALREADY scored, so the queue can mark them and
  // surface the ones still to score (rather than locking the whole list as "already evaluated").
  const ids = cles.map(p => p.id);
  let scored = new Set();
  if (ids.length) {
    const { data: rows } = await supabase
      .from('audit_scores').select('cle_id').eq('auditor_id', req.user.id).in('cle_id', ids);
    scored = new Set((rows ?? []).map(r => r.cle_id));
  }
  res.json(cles.map(p => ({ ...p, scored: scored.has(p.id) })));
});

router.get('/cles/:id', async (req, res) => {
  const { data: cle } = await supabase
    .from('cles').select('id, status, turn_count, token_count, ended_at, auditor_id')
    .eq('id', req.params.id).single();
  if (!cle || !(await isAssignedAuditor(cle.id, req.user.id, cle.auditor_id))) {
    return res.status(404).json({ error: 'Not found or not assigned' });
  }

  // Transcript + this auditor's own score are independent — fetch together.
  const [{ data: messages }, { data: existing }] = await Promise.all([
    supabase.from('messages').select('role, content, refs, socratic_question, created_at')
      .eq('cle_id', req.params.id).order('created_at'),
    supabase.from('audit_scores').select('*').eq('cle_id', req.params.id).eq('auditor_id', req.user.id).maybeSingle(),
  ]);

  let aiEval = null, peerAvg = null, peerN = 0;
  if (existing) {
    // .order+limit(1)+maybeSingle, NOT .single(): a dup-eval race (possible until migration-eval-unique
    // is applied) leaves two rows, on which .single() errors and returns null — the auditor's post-score
    // AI-reveal panel would silently never render. Degrade to the first (earliest) evaluation.
    const { data } = await supabase
      .from('ai_evaluations').select('*').eq('cle_id', req.params.id)
      .order('evaluated_at', { ascending: true }).limit(1).maybeSingle();
    aiEval = data;

    // Peer-calibration (toggle): mean PIS-7 across the OTHER auditors who scored this CLE — self is
    // excluded so "vs auditor average" is a true peer comparison (not diluted by the viewer's own
    // numbers). Shown once ≥1 other auditor has scored. Post-submit only — `existing` gates this
    // exactly like the AI reveal, so the blind audit holds.
    if (await peerCalibrationEnabled()) {
      const { data: peers } = await supabase
        .from('audit_scores').select('d1,d2,d3,d4,d5,d6,d7').eq('cle_id', req.params.id).neq('auditor_id', req.user.id);
      if (peers && peers.length >= 1) { peerN = peers.length; peerAvg = meanByDim(peers); }
    }
  }

  res.json({ cle, messages: messages ?? [], audit_score: existing ?? null, ai_evaluation: aiEval, peer_avg: peerAvg, peer_n: peerN });
});

router.post('/cles/:id/score', requireAuditorConsent, async (req, res) => {
  const parsed = ScoreSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // An auditor may only score a session that is assigned to them, in their own council, and
  // never one they ran themselves. (The audit_scores_guard trigger is the DB-level backstop.)
  const { data: cle } = await supabase
    .from('cles').select('id, auditor_id, council_id, physician_id').eq('id', req.params.id).single();
  if (!cle) return res.status(404).json({ error: 'Not found' });
  if (!(await isAssignedAuditor(cle.id, req.user.id, cle.auditor_id))) return res.status(403).json({ error: 'Not assigned to you' });
  if (cle.physician_id === req.user.id) return res.status(403).json({ error: 'You cannot score your own session.' });
  if (cle.council_id !== req.user.council_id) return res.status(403).json({ error: 'Cross-council scoring is not allowed.' });

  const { data: existing } = await supabase
    .from('audit_scores').select('id').eq('cle_id', req.params.id).eq('auditor_id', req.user.id).maybeSingle();
  if (existing) return res.status(409).json({ error: 'Already scored' });

  const { notes, ...scores } = parsed.data;
  const composite = compositeScore(scores);

  const { error } = await supabase.from('audit_scores').insert({
    cle_id: req.params.id, auditor_id: req.user.id,
    ...scores, composite_score: composite, notes,
  });
  // The SELECT above is a friendly pre-check; the UNIQUE(cle_id, auditor_id) constraint on audit_scores
  // is the backstop for a true concurrent double-submit — the loser surfaces as 23505, not a dup row.
  // (Multi-auditor relies on this being per-(cle,auditor): N auditors = N rows, never 2 for one auditor.)
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Already scored' });
    return res.status(500).json({ error: error.message });
  }

  logEvent({ actorId: req.user.id, actorRole: 'auditor', action: 'audit.score', targetType: 'cle',
    targetId: req.params.id, councilId: cle.council_id, metadata: { composite_score: composite } });

  res.json({ composite_score: composite });
});

router.get('/icc', async (req, res) => {
  const { data } = await supabase
    .from('audit_scores').select('cle_id, composite_score').eq('auditor_id', req.user.id);

  if (!data?.length) return res.json({ icc: null, n: 0 });

  const cleIds = data.map(s => s.cle_id);
  const { data: aiScores } = await supabase
    .from('ai_evaluations').select('cle_id, composite_score').in('cle_id', cleIds);

  const pairs = data.flatMap(audit => {
    const ai = aiScores?.find(a => a.cle_id === audit.cle_id);
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
router.post('/cles/:id/discuss', async (req, res) => {
  const parsed = DiscussMsgSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: cle } = await supabase
    .from('cles').select('id, auditor_id, council_id, physician_id').eq('id', req.params.id).single();
  if (!cle) return res.status(404).json({ error: 'Not found' });
  if (!(await isAssignedAuditor(cle.id, req.user.id, cle.auditor_id))) return res.status(403).json({ error: 'Not assigned to you' });

  // Blind-audit gate: discussion only AFTER the auditor has submitted their score AND an AI eval exists
  // (the discussion reveals AI per-domain scores + rationale, so it must never precede scoring).
  const { data: auditScore } = await supabase.from('audit_scores')
    .select('d1, d2, d3, d4, d5, d6, d7, composite_score')
    .eq('cle_id', req.params.id).eq('auditor_id', req.user.id).single();
  if (!auditScore) return res.status(403).json({ error: 'Score this session before discussing it.', code: 'score_required' });
  const { data: aiEval } = await supabase.from('ai_evaluations')
    .select('d1, d2, d3, d4, d5, d6, d7, composite_score, domain_rationale')
    .eq('cle_id', req.params.id).order('evaluated_at', { ascending: true }).limit(1).maybeSingle();
  if (!aiEval) return res.status(409).json({ error: 'No AI evaluation available to discuss yet.' });

  const { message, language } = parsed.data;

  // Reserve against the AUDITOR pool before the paid call; reconcile on success, refund on failure.
  const limit = await effectiveLimit(req.user, 'auditor');
  const reservation = await reserveUsage(req.user.id, limit, RESERVE_ESTIMATE_USD, 'auditor');
  if (!reservation.ok) {
    return res.status(403).json({
      error: `Auditor AI usage limit reached ($${limit.toFixed(2)}). Contact an administrator.`,
      code: 'budget_exceeded',
    });
  }

  // Transcript (de-identified on-prem by RIMPL), patient_ref (scrub hints only), prior discussion turns.
  const { data: transcript } = await supabase.from('messages')
    .select('role, content').eq('cle_id', req.params.id).order('created_at');
  const { data: pref } = await supabase.from('cle_patient_refs')
    .select('patient_ref').eq('cle_id', req.params.id).maybeSingle();
  const { data: prior } = await supabase.from('audit_discussions')
    .select('role, content').eq('cle_id', req.params.id).eq('auditor_id', req.user.id).order('created_at');

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
    await refundUsage(req.user.id, RESERVE_ESTIMATE_USD, reservation.applied, 'auditor');
    return res.status(502).json({ error: `RIMPL unavailable: ${err.message}`, code: 'rimpl_unavailable' });
  }

  // Both rows MUST carry the token columns: a heterogeneous array insert unifies the column set, and
  // PostgREST sends NULL (not DEFAULT) for keys missing on a row — which would violate the not-null
  // default-0 token columns. So set 0 explicitly on the auditor turn.
  const { error: insErr } = await supabase.from('audit_discussions').insert([
    { cle_id: req.params.id, auditor_id: req.user.id, role: 'auditor', content: message, input_tokens: 0, output_tokens: 0 },
    { cle_id: req.params.id, auditor_id: req.user.id, role: 'assistant', content: rimplResponse.content,
      input_tokens: rimplResponse.input_tokens ?? 0, output_tokens: rimplResponse.output_tokens ?? 0 },
  ]);
  if (insErr) console.error('[auditor] audit_discussions insert failed:', insErr.message);
  if (insErr) {
    await refundUsage(req.user.id, RESERVE_ESTIMATE_USD, reservation.applied, 'auditor'); // not saved — release
    return res.status(500).json({ error: 'Failed to save the message. Please try again.' });
  }

  // Settle against the AUDITOR pool at the rate of the provider that actually served the turn (local
  // = $0, so the delta is −estimate and the reservation is released rather than stranded). Same
  // costOverride route as the physician chat turn — see routes/cles.js for why usage.js stays
  // provider-agnostic.
  await accrueUsage(req.user.id, rimplResponse.input_tokens ?? 0, rimplResponse.output_tokens ?? 0, settlementDelta({
    estimate: RESERVE_ESTIMATE_USD,
    inputTokens: rimplResponse.input_tokens ?? 0, outputTokens: rimplResponse.output_tokens ?? 0,
    applied: reservation.applied,
    provider: rimplResponse.provider,
  }), 'auditor');
  logEvent({ actorId: req.user.id, actorRole: 'auditor', action: 'audit.discuss', targetType: 'cle',
    targetId: req.params.id, councilId: cle.council_id });

  res.json({ content: rimplResponse.content });
});

router.get('/cles/:id/discussion', async (req, res) => {
  // Only an assigned auditor may read their own discussion thread.
  const { data: cle } = await supabase.from('cles').select('id, auditor_id').eq('id', req.params.id).single();
  if (!cle || !(await isAssignedAuditor(cle.id, req.user.id, cle.auditor_id))) return res.status(404).json({ error: 'Not found or not assigned' });
  const { data } = await supabase.from('audit_discussions')
    .select('role, content, created_at').eq('cle_id', req.params.id).eq('auditor_id', req.user.id).order('created_at');
  res.json(data ?? []);
});

// Per-dimension calibration: this auditor's MEAN PIS-7 (d1–d7) vs the AI's MEAN, across the CLEs
// they've scored that also have an AI evaluation (same pairing as /icc, but per-domain means instead
// of a composite ICC). Powers the aggregate radar on the auditor home hero. n=0 → nothing to plot.
router.get('/calibration', async (req, res) => {
  const { data: audits } = await supabase
    .from('audit_scores').select('cle_id, d1, d2, d3, d4, d5, d6, d7').eq('auditor_id', req.user.id);
  if (!audits?.length) return res.json({ n: 0, auditor: null, ai: null, peer: null });

  const cleIds = audits.map(a => a.cle_id);
  const { data: aiRows } = await supabase
    .from('ai_evaluations').select('cle_id, d1, d2, d3, d4, d5, d6, d7').in('cle_id', cleIds);
  const aiById = new Map((aiRows ?? []).map(r => [r.cle_id, r]));

  const sumA = Object.fromEntries(CALIB_DIMS.map(d => [d, 0]));
  const sumAi = Object.fromEntries(CALIB_DIMS.map(d => [d, 0]));
  let n = 0;
  for (const a of audits) {
    const ai = aiById.get(a.cle_id);
    if (!ai) continue; // only pairs with a matching AI evaluation count (mirrors /icc)
    n++;
    for (const d of CALIB_DIMS) { sumA[d] += Number(a[d] || 0); sumAi[d] += Number(ai[d] || 0); }
  }
  if (!n) return res.json({ n: 0, auditor: null, ai: null, peer: null });

  const auditor = Object.fromEntries(CALIB_DIMS.map(d => [d, sumA[d] / n]));
  const ai = Object.fromEntries(CALIB_DIMS.map(d => [d, sumAi[d] / n]));

  // Peer-calibration (toggle): the OTHER auditors' MEAN across the same paired CLEs — each CLE's
  // mean-across-other-auditors, then averaged across CLEs (so a CLE with many raters isn't overweighted).
  // Self is excluded so this mirrors the per-CLE "vs other auditors" comparison.
  let peer = null;
  if (await peerCalibrationEnabled()) {
    const pairedIds = audits.filter(a => aiById.has(a.cle_id)).map(a => a.cle_id);
    const { data: peerRows } = pairedIds.length
      ? await supabase.from('audit_scores').select('cle_id, d1,d2,d3,d4,d5,d6,d7').in('cle_id', pairedIds).neq('auditor_id', req.user.id)
      : { data: [] };
    const byCle = new Map();
    for (const s of peerRows ?? []) {
      if (!byCle.has(s.cle_id)) byCle.set(s.cle_id, []);
      byCle.get(s.cle_id).push(s);
    }
    const sumPeer = Object.fromEntries(CALIB_DIMS.map(d => [d, 0]));
    let np = 0;
    for (const rows of byCle.values()) {
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
