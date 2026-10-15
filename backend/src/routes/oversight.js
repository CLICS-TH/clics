// Tier-3 (analyst) + Tier-4 (ethics) READ-ONLY oversight (CLICS_Proposal §9.4 access tiers).
// These roles NEVER see transcripts — RLS grants them no ples/messages policy, and these endpoints
// expose only aggregates + the audit log. analyst: aggregate de-identified data. ethics: + audit log.
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { sendDbError, pageParams } = require('../lib/db-helpers');
const { computeICC21, iccTwoRater, verdictFor } = require('../services/icc');
const { pairedSets } = require('../services/agreement');
const { raterSpread } = require('../services/rater-spread');
const { iccGates } = require('../lib/settings');
const { verifyChain } = require('../services/audit-chain');

const router = Router();
router.use(verifyJwt, requireRole('analyst', 'ethics', 'superadmin'));

// Aggregate PLE status counts (de-identified). Both roles.
router.get('/stats', async (req, res) => {
  const includeTest = req.query.include_test === 'true';
  const { data, error } = await supabase.rpc('ple_status_counts', { p_council: null, p_include_test: includeTest });
  if (sendDbError(res, error)) return;
  const counts = Object.fromEntries((data ?? []).map(r => [r.status, Number(r.n)]));
  res.json({ counts, total: Object.values(counts).reduce((a, n) => a + n, 0) });
});

// Overall + per-domain ICC(2,1) over all scored sessions — aggregate only, no transcripts. Both roles.
const ICC_DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
router.get('/icc', async (req, res) => {
  const includeTest = req.query.include_test === 'true';
  const { data: auditScores } = await supabase
    .from('audit_scores').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7');
  if (!auditScores?.length) return res.json({ overall: null, per_domain: {}, n: 0 });
  const scoredIds = [...new Set(auditScores.map(a => a.ple_id))];
  const { data: aiScores, error: aiErr } = await supabase
    .from('ai_evaluations').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('ple_id', scoredIds);
  if (sendDbError(res, aiErr)) return;
  // A dropped error here would empty testOf and silently invert the include_test=false default.
  const { data: ples, error: plesErr } = await supabase.from('ples').select('id, is_test').in('id', scoredIds);
  if (sendDbError(res, plesErr)) return;
  const testOf = Object.fromEntries((ples ?? []).map(p => [p.id, p.is_test]));
  const aiBy = Object.fromEntries((aiScores ?? []).map(s => [s.ple_id, s]));
  // One human value per PLE (mean across auditors) before pairing — ICC(2,1) assumes one human rating
  // per subject, so a multi-auditor PLE must not contribute N pairs reusing the same AI value. With a
  // single auditor the mean equals that score (correct in both modes).
  const byPle = new Map();
  for (const a of auditScores) {
    if (!byPle.has(a.ple_id)) byPle.set(a.ple_id, []);
    byPle.get(a.ple_id).push(a);
  }
  const pairs = [];
  for (const [pleId, rows] of byPle) {
    const ai = aiBy[pleId];
    if (!ai || (!includeTest && testOf[pleId])) continue;
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
// BLINDING CONTROL. shadow_evaluations holds a SECOND, never-served AI score of the same PLE. If it
// ever reached an auditor it would anchor them and destroy the very ICC it exists to measure. The
// table is RLS deny-all, but the backend runs as the SERVICE ROLE and therefore BYPASSES RLS — so
// this role gate is the only protection. The guard is restated on the route (the router-level one
// above already applies) so a future refactor cannot silently widen it. Shadow data must NEVER be
// added to routes/auditor.js, nor rendered on any auditor-reachable page.
//
// Human auditors are the REFERENCE STANDARD; Claude is not. ai_vs_shadow is a cheap early signal and
// a correlated-error check only — two models agreeing proves they are similar, possibly similarly
// wrong. Only the two *_vs_human arms are acceptance evidence, and only candidate_vs_human decides.

const emptyArm = () => ({ overall: null, per_domain: Object.fromEntries(ICC_DOMAINS.map(d => [d, null])), n: 0, verdict: null });

router.get('/icc/three-way', requireRole('analyst', 'ethics', 'superadmin'), async (req, res) => {
  const includeTest = req.query.include_test === 'true';
  // Express 4 does not route an async rejection to the error middleware — an unguarded throw here
  // leaves the client hanging rather than returning a 500. The thresholds have code defaults, so a
  // settings read that fails should degrade to them, not take the whole panel down.
  let gates;
  try { gates = await iccGates(); } catch { gates = { screening: 0.75, decisive: 0.75 }; }

  // SCOPE. Every number below is computed over the AUDITED universe — PLEs carrying at least one
  // auditor score, after the same is_test filter GET /icc uses. That bounds the queries identically
  // (audit_scores is small; ples is not) and makes `coverage` a readable funnel:
  // human -> +ai -> +shadow -> all three.
  // Every select below MUST check `error`. Dropping it turns a transient fault into a 200 carrying
  // confident wrong numbers: a failed `ples` read empties testOf, which silently inverts the
  // include_test=false default and folds sandbox PLEs into the headline acceptance figure with no
  // signal anywhere. Only the shadow select has a legitimate degrade path (unapplied migration).
  // Assembly lives in services/agreement.js so the Model Lock route asks this same question through
  // the same code. A second implementation would drift, and the two places it would drift between
  // are the screen a human reads and the gate that freezes the study's measuring instrument.
  const sets = await pairedSets({ includeTest });
  if (!sets.ok) { sendDbError(res, sets.error); return; }
  if (sets.empty) {
    return res.json({
      arms: { ai_vs_human: emptyArm(), shadow_vs_human: null, ai_vs_shadow: null },
      coverage: { ples_with_human: 0, ples_with_ai: 0, ples_with_shadow: 0, ples_all_three: 0, shadow_failed: 0, shadow_contract_rate: null, shadow_ineligible: 0 },
      shadow: { available: false, provider: null, model_version: null, prompt_version: null },
      gates: {
        screening: { arm: 'ai_vs_shadow', ...verdictFor(null, gates.screening) },
        decisive: { arm: 'shadow_vs_human', ...verdictFor(null, gates.decisive) },
      },
    });
  }
  const { humanBy, aiBy, shadowBy, withAi, allThree, compareIds, candidate, shadowAvailable, shadowFailed, shadowIneligible } = sets;
  const shadowAttempts = shadowBy.size + shadowFailed;

  // CONTRACT RATE — corpus-wide, not cohort-scoped. The figures above count only this candidate's
  // runs on PLEs that happen to have been audited, which early in a pilot is a handful. But "can this
  // model hold the PIS-7 JSON contract" is a property of the MODEL, not of the audit backlog, and it
  // is the most disqualifying number here — so it must be measured over every run recorded for this
  // candidate. Deliberately NOT is_test-filtered: a sandbox transcript exercises the contract exactly
  // as a real one does. Count-only (head), so this stays cheap.
  // Scoped to the candidate's prompt_version as well (services/agreement.js groups by it): the
  // addendum is what changed between local prompt versions, and it is aimed squarely at the JSON
  // contract, so a contract rate pooled across two addenda describes neither prompt.
  let corpusScored = null, corpusFailed = null;
  if (candidate) {
    const forCandidate = () => {
      const q = supabase.from('shadow_evaluations')
        .select('ple_id', { count: 'exact', head: true })
        .eq('provider', candidate.provider).eq('model_version', candidate.model_version);
      return candidate.prompt_version == null ? q.is('prompt_version', null) : q.eq('prompt_version', candidate.prompt_version);
    };
    const [okRes, errRes] = await Promise.all([forCandidate().is('error', null), forCandidate().not('error', 'is', null)]);
    // Best-effort: a failure here must not break the arms — fall back to the cohort figures.
    if (!okRes.error && !errRes.error) { corpusScored = okRes.count ?? 0; corpusFailed = errRes.count ?? 0; }
  }
  const corpusAttempts = corpusScored == null ? null : corpusScored + corpusFailed;

  const arm = (ids, pick, threshold) => {
    // Defensive: compareIds is already the intersection, so nothing is dropped here today. But an
    // async handler that throws never sends a response at all (no error middleware on this router) —
    // the client just hangs. A future edit that widens the id set should cost an honest, smaller n,
    // not a dead request.
    const pairs = ids.map(pick).filter(p => p.a && p.b);
    const per_domain = {};
    for (const d of ICC_DOMAINS) per_domain[d] = iccTwoRater(pairs.map(p => ({ a: Number(p.a[d]), b: Number(p.b[d]) })));
    const overall = iccTwoRater(pairs.map(p => ({ a: Number(p.a.composite_score), b: Number(p.b.composite_score) })));
    return {
      overall,
      per_domain,
      n: pairs.length,
      // The composite is what the gate is defined against, so the verdict reads `overall` and not the
      // per-domain figures — a domain clearing the bar while the composite does not is a finding to
      // report, never a pass.
      verdict: verdictFor(overall, threshold),
    };
  };

  // Both human-referenced arms are judged against the DECISIVE bar, because that is the comparison
  // that matters: the human raters are the reference standard, and it is the same question asked of
  // the incumbent and the candidate. Only candidate-vs-incumbent uses the screening bar.
  const aiVsHuman = arm(compareIds, id => ({ a: aiBy.get(id), b: humanBy.get(id) }), gates.decisive);
  const shadowVsHuman = shadowAvailable ? arm(compareIds, id => ({ a: shadowBy.get(id), b: humanBy.get(id) }), gates.decisive) : null;
  const aiVsShadow = shadowAvailable ? arm(compareIds, id => ({ a: aiBy.get(id), b: shadowBy.get(id) }), gates.screening) : null;

  res.json({
    arms: { ai_vs_human: aiVsHuman, shadow_vs_human: shadowVsHuman, ai_vs_shadow: aiVsShadow },
    // The two stages of the candidate decision, lifted out of the arms so a reader does not have to
    // know which arm answers which question. Screening can reject a candidate before a single human
    // rater exists; only the decisive stage can accept one.
    gates: {
      screening: { arm: 'ai_vs_shadow', ...verdictFor(aiVsShadow?.overall ?? null, gates.screening) },
      decisive: { arm: 'shadow_vs_human', ...verdictFor(shadowVsHuman?.overall ?? null, gates.decisive) },
    },
    coverage: {
      ples_with_human: humanBy.size,
      ples_with_ai: withAi.length,
      ples_with_shadow: shadowBy.size,
      ples_all_three: allThree.length,
      // Cohort-scoped: this candidate's runs on the audited, is_test-filtered PLEs the arms use.
      shadow_failed: shadowFailed,
      shadow_contract_rate: shadowAttempts ? Math.round((shadowBy.size / shadowAttempts) * 1000) / 1000 : null,
      // Corpus-wide: EVERY run recorded for this candidate. This is the model's real contract rate and
      // the one a swap decision should be read against; the cohort figures above are a subset of it.
      shadow_scored_corpus: corpusScored,
      shadow_failed_corpus: corpusFailed,
      shadow_contract_rate_corpus: corpusAttempts ? Math.round((corpusScored / corpusAttempts) * 1000) / 1000 : null,
      // Shadow rows from a provider that may not evaluate (the tutor model, `local-tutor`): never a
      // candidate, never in an arm — and counted here, because a row left out silently is a row
      // nobody asks about. Non-zero means something wrote one; rimpl refuses to.
      shadow_ineligible: shadowIneligible,
    },
    shadow: {
      available: shadowAvailable,
      provider: candidate?.provider ?? null,
      model_version: candidate?.model_version ?? null,
      // Additive. The candidate is one (provider, model_version, prompt_version) group; rows under
      // another prompt version are a different candidate and are NOT in these arms.
      prompt_version: candidate?.prompt_version ?? null,
    },
  });
});

// Audit trail — Tier-4 ethics committee (+ superadmin); analysts are excluded.
// Can the raters discriminate at all? Aggregate only — no transcripts, no names.
//
// This exists because the 2026-08-28 baseline read ICC = -0.315 and the cause was invisible in the
// product: five episodes scored 74-80 by humans and 71-91 by the AI. ICC asks whether two raters RANK
// subjects the same way, and six points of human range leaves nothing to rank. Without this screen
// that reads as "the AI disagrees with our experts" rather than as "the measurement cannot yet
// measure", and the two call for opposite work.
router.get('/rater-spread', async (req, res) => {
  // Express 4 does not route an async rejection to the error middleware — an unguarded throw here
  // leaves the client hanging rather than returning a 500.
  let result;
  try {
    result = await raterSpread({ includeTest: req.query.include_test === 'true' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!result.ok) return sendDbError(res, result.error) ? undefined : res.status(500).json({ error: 'unknown' });
  res.json(result);
});

router.get('/audit-log', requireRole('ethics', 'superadmin'), async (req, res) => {
  const { limit, offset } = pageParams(req, { def: 100, max: 500 });
  const { data, count, error } = await supabase
    .from('audit_log').select('*', { count: 'exact' })
    .order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (sendDbError(res, error)) return;
  res.setHeader('X-Total-Count', count ?? 0);
  res.json({ total: count ?? 0, limit, offset, events: data ?? [] });
});

// Does the audit trail still link, row to row? The database recomputes its own hash chain
// (db/migration-audit-log-chain.sql) and names the first row that does not. Same roles as the log.
// Pass ?anchor_seq=&anchor_hash= — a head recorded earlier, held outside Supabase — to also detect a
// truncated tail or a re-hashed chain; only an anchored pass reports `intact`. `broken` is still a
// 200: the answer IS the finding, and the ethics view must show it.
router.get('/audit-log/verify', requireRole('ethics', 'superadmin'), async (req, res) => {
  const { anchor_seq: seqRaw, anchor_hash: hashRaw } = req.query;
  let anchor = null;
  if (seqRaw != null || hashRaw != null) {
    const seq = Number(seqRaw);
    if (!Number.isSafeInteger(seq) || seq < 1 || !/^[0-9a-f]{64}$/i.test(String(hashRaw || ''))) {
      return res.status(400).json({ error: 'anchor_seq must be a positive integer and anchor_hash 64 hex characters' });
    }
    anchor = { seq, hash: String(hashRaw).toLowerCase() };
  }
  const result = await verifyChain(anchor);
  if (result.status === 'error') return res.status(500).json(result);
  res.json(result);
});

module.exports = router;
