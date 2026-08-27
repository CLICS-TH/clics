// Weighted kappa — CREC082 SAP, "Additional agreement: weighted kappa, Bland–Altman, mean
// difference/limits of agreement". Bland–Altman already exists (audit-dashboard
// components/BlandAltmanPlot.tsx); this is the missing one.
//
// WHY THIS AND NOT ICC. The PIS-7 domains are ordinal, 0-5, and the two statistics answer different
// questions about them. ICC treats the scores as interval and asks how much of the variance is
// between sessions rather than between raters. Kappa asks how often two raters land on the SAME
// category, corrected for the agreement you would get by chance from their marginal habits alone —
// which is the question that matters when a rater who marks everything a 3 and a rater who marks
// everything a 3 agree perfectly, and have told you nothing.
//
// QUADRATIC weights, not linear or unweighted. Unweighted kappa treats 3-vs-4 and 3-vs-0 as the same
// failure, which is plainly wrong for an ordinal rubric where adjacent scores are near-agreement.
// Quadratic weighting penalises by the SQUARE of the distance, so a two-band miss counts four times
// an adjacent one — and quadratic-weighted kappa on an ordinal scale is numerically equivalent to
// ICC(A,1) under the same design, which makes the two figures in the SAP mutually checkable rather
// than two unrelated numbers.

const PIS7_MIN = 0, PIS7_MAX = 5;

// disagreement weight, 0 at the diagonal and 1 at the corners
const quadratic = (i, j, c) => ((i - j) ** 2) / ((c - 1) ** 2);
const linear    = (i, j, c) => Math.abs(i - j) / (c - 1);

/**
 * Weighted Cohen's kappa between two raters over an ordinal scale.
 *
 * @param {Array<{a:number,b:number}>} pairs  one pair per subject
 * @param {object} [opts]
 * @param {number} [opts.min=0] [opts.max=5]  the scale, so absent categories still occupy the matrix
 * @param {'quadratic'|'linear'} [opts.weights='quadratic']
 *
 * Rater-symmetric, like the ICC routines here: nothing distinguishes column a from column b, so the
 * same call measures AI-vs-human or human-vs-human.
 */
function weightedKappa(pairs, { min = PIS7_MIN, max = PIS7_MAX, weights = 'quadratic' } = {}) {
  const w = weights === 'linear' ? linear : quadratic;
  const clean = (pairs || [])
    .map(p => ({ a: Math.round(Number(p.a ?? p.ai)), b: Math.round(Number(p.b ?? p.human)) }))
    // Out-of-range is dropped rather than clamped: clamping a 7 to a 5 would invent an agreement.
    .filter(p => Number.isFinite(p.a) && Number.isFinite(p.b)
      && p.a >= min && p.a <= max && p.b >= min && p.b <= max);
  const n = clean.length;
  const excluded = (pairs || []).length - n;
  if (n < 2) return null;

  // The FULL scale defines the matrix, not the observed values. Sizing it to what happened would
  // make the weights depend on the sample — the same disagreement would be penalised differently in
  // two cohorts, and the numbers would stop being comparable.
  const c = max - min + 1;

  const O = Array.from({ length: c }, () => new Array(c).fill(0));
  for (const p of clean) O[p.a - min][p.b - min] += 1;

  const rowSum = O.map(r => r.reduce((x, v) => x + v, 0));
  const colSum = Array.from({ length: c }, (_, j) => O.reduce((x, r) => x + r[j], 0));

  let obs = 0, exp = 0;
  for (let i = 0; i < c; i++) {
    for (let j = 0; j < c; j++) {
      const wt = w(i, j, c);
      obs += wt * (O[i][j] / n);
      exp += wt * ((rowSum[i] / n) * (colSum[j] / n));
    }
  }

  // exp === 0 means every rating from BOTH raters fell in one category. Perfect agreement, and
  // chance agreement is also perfect, so kappa is 0/0 — undefined, not 1. Saying so beats returning
  // a confident number that describes nothing. (Same failure mode the ICC routines report as
  // 'Insufficient variance'.)
  if (exp < 1e-12) {
    return { kappa: null, n, n_excluded: excluded, weights, scale: [min, max],
      interpretation: 'Undefined (all ratings in one category — no chance-corrected signal)' };
  }

  const kappa = 1 - obs / exp;
  const safe = Math.min(Math.max(kappa, -1), 1);

  // Landis & Koch bands, the convention these are read against.
  const label = safe >= 0.81 ? 'Almost perfect'
    : safe >= 0.61 ? 'Substantial'
    : safe >= 0.41 ? 'Moderate'
    : safe >= 0.21 ? 'Fair'
    : safe >= 0.00 ? 'Slight'
    : 'Worse than chance';

  return {
    kappa: Math.round(safe * 1000) / 1000,
    n, n_excluded: excluded, weights, scale: [min, max],
    // Exact agreement rate, reported alongside because kappa alone hides it: a low kappa on a cohort
    // where raters agreed exactly 80% of the time means the marginals were skewed, not that the
    // raters disagreed.
    exact_agreement: Math.round((clean.filter(p => p.a === p.b).length / n) * 1000) / 1000,
    interpretation: label,
  };
}

/**
 * Weighted kappa per PIS-7 domain (d1..d7), plus the pooled figure over all domains.
 *
 * Per-domain is what the SAP's "PIS-7 domain-level agreement" needs: a composite that agrees well
 * can still hide one domain where raters systematically diverge, and that domain is the one whose
 * anchors need rewriting.
 */
const PIS7_DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

function weightedKappaByDomain(rows, opts = {}) {
  const byDomain = {};
  const pooled = [];
  for (const d of PIS7_DOMAINS) {
    const pairs = (rows || [])
      .map(r => ({ a: r.a?.[d], b: r.b?.[d] }))
      .filter(p => p.a != null && p.b != null);
    byDomain[d] = weightedKappa(pairs, opts);
    pooled.push(...pairs);
  }
  return { domains: byDomain, pooled: weightedKappa(pooled, opts) };
}

module.exports = { weightedKappa, weightedKappaByDomain, PIS7_DOMAINS, PIS7_MIN, PIS7_MAX };
