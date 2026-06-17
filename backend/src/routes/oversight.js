// Tier-3 (analyst) + Tier-4 (ethics) READ-ONLY oversight (CLICS_Proposal §9.4 access tiers).
// These roles NEVER see transcripts — RLS grants them no cles/messages policy, and these endpoints
// expose only aggregates + the audit log. analyst: aggregate de-identified data. ethics: + audit log.
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { sendDbError, pageParams } = require('../lib/db-helpers');
const { computeICC21 } = require('../services/icc');

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
  const { data: aiScores } = await supabase
    .from('ai_evaluations').select('cle_id, composite_score, d1,d2,d3,d4,d5,d6,d7').in('cle_id', scoredIds);
  const { data: cles } = await supabase.from('cles').select('id, is_test').in('id', scoredIds);
  const testOf = Object.fromEntries((cles ?? []).map(p => [p.id, p.is_test]));
  const aiBy = Object.fromEntries((aiScores ?? []).map(s => [s.cle_id, s]));
  const pairs = [];
  for (const a of auditScores) {
    const ai = aiBy[a.cle_id];
    if (!ai || (!includeTest && testOf[a.cle_id])) continue;
    pairs.push({ ai, audit: a });
  }
  const overall = computeICC21(pairs.map(p => ({ ai: Number(p.ai.composite_score), human: Number(p.audit.composite_score) })));
  const per_domain = {};
  for (const d of ICC_DOMAINS) per_domain[d] = computeICC21(pairs.map(p => ({ ai: Number(p.ai[d]), human: Number(p.audit[d]) })));
  res.json({ overall, per_domain, n: pairs.length });
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
