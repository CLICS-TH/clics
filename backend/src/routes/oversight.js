// Tier-3 (analyst) + Tier-4 (ethics) READ-ONLY oversight (CLICS_Proposal §9.4 access tiers).
// These roles NEVER see transcripts — RLS grants them no cles/messages policy, and these endpoints
// expose only aggregates + the audit log. analyst: aggregate de-identified data. ethics: + audit log.
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { sendDbError, pageParams } = require('../lib/db-helpers');
const { computeICC21, iccTwoRater } = require('../services/icc');

const router = Router();
router.use(verifyJwt, requireRole('analyst', 'ethics', 'superadmin'));

// Aggregate CLE status counts (de-identified). Both roles.
router.get('/stats', async (req, res) => {
  const includeTest = req.query.include_test === 'true';
  const { data, error } = await supabase.rpc('cle_status_counts', { p_council: null, p_include_test: includeTest });
  if (sendDbError(res, error)) return;
  const counts = Object.fromEntries((data ?? []).map(r => [r.status, Number(r.n)]));
  res.json({ counts, total: Object.values(counts).reduce((a, n) => a + n, 0) });
});

// Overall + per-domain ICC(2,1) over all scored sessions — aggregate only, no transcripts. Both roles.
const ICC_DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
router.get('/icc', async (req, res) => {
  const includeTest = req.query.include_test === 'true';
  const { data: auditScores } = await supabase
    .from('audit_scores').select('cle_id, composite_score, d1,d2,d3,d4,d5,d6,d7');
  if (!auditScores?.length) return res.json({ overall: null, per_domain: {}, n: 0 });
  const scoredIds = [...new Set(auditScores.map(a => a.cle_id))];
  const { data: aiScores, error: aiErr } = await supabase
    .from('ai_evaluations').select('cle_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('cle_id', scoredIds);
  if (sendDbError(res, aiErr)) return;
  // A dropped error here would empty testOf and silently invert the include_test=false default.
  const { data: cles, error: clesErr } = await supabase.from('cles').select('id, is_test').in('id', scoredIds);
  if (sendDbError(res, clesErr)) return;
  const testOf = Object.fromEntries((cles ?? []).map(p => [p.id, p.is_test]));
  const aiBy = Object.fromEntries((aiScores ?? []).map(s => [s.cle_id, s]));
  // One human value per CLE (mean across auditors) before pairing — ICC(2,1) assumes one human rating
  // per subject, so a multi-auditor CLE must not contribute N pairs reusing the same AI value. With a
  // single auditor the mean equals that score (correct in both modes).
  const byCle = new Map();
  for (const a of auditScores) {
    if (!byCle.has(a.cle_id)) byCle.set(a.cle_id, []);
    byCle.get(a.cle_id).push(a);
  }
  const pairs = [];
  for (const [cleId, rows] of byCle) {
    const ai = aiBy[cleId];
    if (!ai || (!includeTest && testOf[cleId])) continue;
    const mean = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0) / rows.length;
    const audit = { composite_score: mean('composite_score') };
    for (const d of ICC_DOMAINS) audit[d] = mean(d);
    pairs.push({ ai, audit });
  }
  const overall = computeICC21(pairs.map(p => ({ ai: Number(p.ai.composite_score), human: Number(p.audit.composite_score) })));
  const per_domain = {};
  for (const d of ICC_DOMAINS) per_domain[d] = computeICC21(pairs.map(p => ({ ai: Number(p.ai[d]), human: Number(p.audit[d]) })));
  res.json({ overall, per_domain, n: pairs.length });
});

// Three-way ICC: Claude vs auditor, candidate (shadow) vs auditor, Claude vs candidate.
//
// BLINDING CONTROL. shadow_evaluations holds a SECOND, never-served AI score of the same CLE. If it
// ever reached an auditor it would anchor them and destroy the very ICC it exists to measure. The
// table is RLS deny-all, but the backend runs as the SERVICE ROLE and therefore BYPASSES RLS — so
// this role gate is the only protection. The guard is restated on the route (the router-level one
// above already applies) so a future refactor cannot silently widen it. Shadow data must NEVER be
// added to routes/auditor.js, nor rendered on any auditor-reachable page.
//
// Human auditors are the REFERENCE STANDARD; Claude is not. ai_vs_shadow is a cheap early signal and
// a correlated-error check only — two models agreeing proves they are similar, possibly similarly
// wrong. Only the two *_vs_human arms are acceptance evidence.
const SHADOW_COLS = 'cle_id, provider, model_version, composite_score, d1,d2,d3,d4,d5,d6,d7, error, evaluated_at';

// db/migration-shadow-evaluations.sql is DELIBERATELY unapplied in some environments. PostgREST
// surfaces that as a missing relation (PGRST205 / 42P01), which is a KNOWN state, not a fault — so
// degrade to shadow:null instead of 500ing the whole panel. Detected from the error itself, so no
// table-exists probe (and no extra round-trip) is needed.
function isMissingRelation(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (code === 'PGRST205' || code === 'PGRST106' || code === '42P01') return true;
  const msg = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`.toLowerCase();
  return msg.includes('does not exist') || msg.includes('could not find the table') || msg.includes('schema cache');
}

const emptyArm = () => ({ overall: null, per_domain: Object.fromEntries(ICC_DOMAINS.map(d => [d, null])), n: 0 });

router.get('/icc/three-way', requireRole('analyst', 'ethics', 'superadmin'), async (req, res) => {
  const includeTest = req.query.include_test === 'true';

  // SCOPE. Every number below is computed over the AUDITED universe — CLEs carrying at least one
  // auditor score, after the same is_test filter GET /icc uses. That bounds the queries identically
  // (audit_scores is small; cles is not) and makes `coverage` a readable funnel:
  // human -> +ai -> +shadow -> all three.
  // Every select below MUST check `error`. Dropping it turns a transient fault into a 200 carrying
  // confident wrong numbers: a failed `cles` read empties testOf, which silently inverts the
  // include_test=false default and folds sandbox CLEs into the headline acceptance figure with no
  // signal anywhere. Only the shadow select has a legitimate degrade path (unapplied migration).
  const { data: auditScores, error: auditErr } = await supabase
    .from('audit_scores').select('cle_id, composite_score, d1,d2,d3,d4,d5,d6,d7');
  if (sendDbError(res, auditErr)) return;
  if (!auditScores?.length) {
    return res.json({
      arms: { ai_vs_human: emptyArm(), shadow_vs_human: null, ai_vs_shadow: null },
      coverage: { cles_with_human: 0, cles_with_ai: 0, cles_with_shadow: 0, cles_all_three: 0, shadow_failed: 0, shadow_contract_rate: null },
      shadow: { available: false, provider: null, model_version: null },
    });
  }
  const scoredIds = [...new Set(auditScores.map(a => a.cle_id))];
  const { data: aiScores, error: aiErr } = await supabase
    .from('ai_evaluations').select('cle_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('cle_id', scoredIds);
  if (sendDbError(res, aiErr)) return;
  const { data: cles, error: clesErr } = await supabase.from('cles').select('id, is_test').in('id', scoredIds);
  if (sendDbError(res, clesErr)) return;
  const testOf = Object.fromEntries((cles ?? []).map(p => [p.id, p.is_test]));
  const inScope = (cleId) => includeTest || !testOf[cleId];

  // A missing relation (unapplied migration) is a KNOWN state: fall through with no rows, which is
  // indistinguishable from "no candidate corpus yet". Any OTHER db error is a real fault and 500s.
  const shadowRes = await supabase.from('shadow_evaluations').select(SHADOW_COLS).in('cle_id', scoredIds);
  if (shadowRes.error && !isMissingRelation(shadowRes.error)) { sendDbError(res, shadowRes.error); return; }

  // One human value per CLE (mean across auditors) BEFORE pairing — ICC(2,1) assumes one rating per
  // subject per rater, so a multi-auditor CLE must contribute ONE pair, not N pairs reusing the same
  // AI value. With a single auditor the mean equals that score (correct in both modes).
  const byCle = new Map();
  for (const a of auditScores) {
    if (!inScope(a.cle_id)) continue;
    if (!byCle.has(a.cle_id)) byCle.set(a.cle_id, []);
    byCle.get(a.cle_id).push(a);
  }
  const humanBy = new Map();
  for (const [cleId, rows] of byCle) {
    const mean = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0) / rows.length;
    const human = { composite_score: mean('composite_score') };
    for (const d of ICC_DOMAINS) human[d] = mean(d);
    humanBy.set(cleId, human);
  }
  const aiBy = new Map((aiScores ?? []).filter(s => inScope(s.cle_id)).map(s => [s.cle_id, s]));

  // ONE candidate per arm. `provider` is the TRANSPORT ('local'), not the candidate — a second
  // candidate model on the same transport is a SEPARATE paired set. Pooling two models into one arm
  // would report a number that describes neither, so pick the most recent (provider, model_version)
  // by evaluated_at and name it in the response.
  const groups = new Map();
  for (const r of (shadowRes.data ?? [])) {
    if (!inScope(r.cle_id)) continue;
    const key = `${r.provider} ${r.model_version}`;
    const g = groups.get(key) ?? { provider: r.provider, model_version: r.model_version, rows: [], latest: 0 };
    g.rows.push(r);
    g.latest = Math.max(g.latest, Date.parse(r.evaluated_at ?? '') || 0);
    groups.set(key, g);
  }
  const candidate = [...groups.values()].sort((x, y) =>
    (y.latest - x.latest) || String(y.model_version ?? '').localeCompare(String(x.model_version ?? '')))[0] ?? null;

  // FAILED RUNS. A row with `error` set carries no scores (constraint shadow_scored_xor_failed), so
  // it cannot enter an ICC — but it IS counted here, because "the candidate could not produce a
  // valid score set 8% of the time" is a first-class, potentially disqualifying result. Averaging it
  // away would hide exactly the thing a model-swap decision hinges on.
  const shadowBy = new Map();
  let shadowFailed = 0;
  for (const r of candidate?.rows ?? []) {
    if (r.error != null || r.d1 == null) { shadowFailed++; continue; }
    shadowBy.set(r.cle_id, r);   // unique (cle_id, provider, model_version) => at most one row per CLE
  }
  const shadowAvailable = shadowBy.size > 0;
  const shadowAttempts = shadowBy.size + shadowFailed;

  // CONTRACT RATE — corpus-wide, not cohort-scoped. The figures above count only this candidate's
  // runs on CLEs that happen to have been audited, which early in a pilot is a handful. But "can this
  // model hold the PIS-7 JSON contract" is a property of the MODEL, not of the audit backlog, and it
  // is the most disqualifying number here — so it must be measured over every run recorded for this
  // candidate. Deliberately NOT is_test-filtered: a sandbox transcript exercises the contract exactly
  // as a real one does. Count-only (head), so this stays cheap.
  let corpusScored = null, corpusFailed = null;
  if (candidate) {
    const forCandidate = () => supabase.from('shadow_evaluations')
      .select('cle_id', { count: 'exact', head: true })
      .eq('provider', candidate.provider).eq('model_version', candidate.model_version);
    const [okRes, errRes] = await Promise.all([forCandidate().is('error', null), forCandidate().not('error', 'is', null)]);
    // Best-effort: a failure here must not break the arms — fall back to the cohort figures.
    if (!okRes.error && !errRes.error) { corpusScored = okRes.count ?? 0; corpusFailed = errRes.count ?? 0; }
  }
  const corpusAttempts = corpusScored == null ? null : corpusScored + corpusFailed;

  // COMPARABILITY. All arms are computed on the SAME CLEs — the intersection of human + ai + a
  // SCORED shadow row — so the three numbers can honestly be read against each other. With no shadow
  // corpus the set degrades to human-and-ai and ai_vs_human matches GET /icc exactly.
  const withAi = [...humanBy.keys()].filter(id => aiBy.has(id));
  const allThree = withAi.filter(id => shadowBy.has(id));
  const compareIds = shadowAvailable ? allThree : withAi;

  const arm = (ids, pick) => {
    // Defensive: compareIds is already the intersection, so nothing is dropped here today. But an
    // async handler that throws never sends a response at all (no error middleware on this router) —
    // the client just hangs. A future edit that widens the id set should cost an honest, smaller n,
    // not a dead request.
    const pairs = ids.map(pick).filter(p => p.a && p.b);
    const per_domain = {};
    for (const d of ICC_DOMAINS) per_domain[d] = iccTwoRater(pairs.map(p => ({ a: Number(p.a[d]), b: Number(p.b[d]) })));
    return {
      overall: iccTwoRater(pairs.map(p => ({ a: Number(p.a.composite_score), b: Number(p.b.composite_score) }))),
      per_domain,
      n: pairs.length,
    };
  };

  res.json({
    arms: {
      ai_vs_human: arm(compareIds, id => ({ a: aiBy.get(id), b: humanBy.get(id) })),
      shadow_vs_human: shadowAvailable ? arm(compareIds, id => ({ a: shadowBy.get(id), b: humanBy.get(id) })) : null,
      ai_vs_shadow: shadowAvailable ? arm(compareIds, id => ({ a: aiBy.get(id), b: shadowBy.get(id) })) : null,
    },
    coverage: {
      cles_with_human: humanBy.size,
      cles_with_ai: withAi.length,
      cles_with_shadow: shadowBy.size,
      cles_all_three: allThree.length,
      // Cohort-scoped: this candidate's runs on the audited, is_test-filtered CLEs the arms use.
      shadow_failed: shadowFailed,
      shadow_contract_rate: shadowAttempts ? Math.round((shadowBy.size / shadowAttempts) * 1000) / 1000 : null,
      // Corpus-wide: EVERY run recorded for this candidate. This is the model's real contract rate and
      // the one a swap decision should be read against; the cohort figures above are a subset of it.
      shadow_scored_corpus: corpusScored,
      shadow_failed_corpus: corpusFailed,
      shadow_contract_rate_corpus: corpusAttempts ? Math.round((corpusScored / corpusAttempts) * 1000) / 1000 : null,
    },
    shadow: {
      available: shadowAvailable,
      provider: candidate?.provider ?? null,
      model_version: candidate?.model_version ?? null,
    },
  });
});

// Audit trail — Tier-4 ethics committee (+ superadmin); analysts are excluded.
router.get('/audit-log', requireRole('ethics', 'superadmin'), async (req, res) => {
  const { limit, offset } = pageParams(req, { def: 100, max: 500 });
  const { data, count, error } = await supabase
    .from('audit_log').select('*', { count: 'exact' })
    .order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (sendDbError(res, error)) return;
  res.setHeader('X-Total-Count', count ?? 0);
  res.json({ total: count ?? 0, limit, offset, events: data ?? [] });
});

module.exports = router;
