// Agreement statistics for the probe harness, computed with PRODUCTION's composite and estimator.
//
// WHY THIS EXISTS. model-agreement.mjs, e2-compare.mjs, repeat-consistency.mjs and compare-sessions.mjs
// each carried their own composite — the UNWEIGHTED d1..d7 sum, 0–35 — and the first two their own
// ICC(A,1), "written out so the formula is auditable next to the number". Production computes neither.
// A physician's credit is decided on rimpl's WEIGHTED composite (d2 counts twice d6 or d7), and
// GET /oversight/icc and the Model Lock gate use backend icc.js with an F-based interval. So the probes
// reported one run as 0.726 while the verdict tool reported 0.735 for the same rows, and the probes'
// figure had no interval.
// Every number here comes from the production modules instead:
//   rimpl/src/lib/composite.js    compositeOf  — weighted ×20, 0–100
//   backend/src/services/icc.js   iccTwoRater  — ICC(A,1) with the McGraw & Wong F-based 95% CI
// Both load with NO packages, and that is load-bearing: CI's probe job runs on a bare checkout with no
// npm install. agreement-stats.test.mjs fails if either ever pulls one in.
//
// WHAT IS DELIBERATELY NOT HERE. Σ|Δ| (Σ over d1..d7 of |local − cloud|, or of each domain's range
// across repeats) stays unweighted, in the scripts that print it. It is a per-domain INTEGER count of
// disagreement that mirrors rimpl's consistency rule and the published "noise ≤ 2" bar; weighting it
// would silently change what that bar means.
//
// Pure: scores in, numbers out. No I/O, no network, never any transcript text.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compositeOf } = require('../../rimpl/src/lib/composite.js');
const { iccTwoRater } = require('../../backend/src/services/icc.js');

// Re-exported so a test can prove these are production's own functions, not look-alikes.
export { compositeOf, iccTwoRater };

export const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
export const COMPOSITE_SCALE = 'PIS-7 weighted composite, rimpl/src/lib/composite.js compositeOf (×20, 0–100)';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
// Sample SD (n − 1). Null below two values: one number has no spread, and 0 would read as "agreed".
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1));
};
const round2 = (v) => Math.round(v * 100) / 100;
const hasAllDomains = (s) => s != null && typeof s === 'object' && DOMAINS.every((d) => Number.isFinite(s[d]));
// A row only counts when BOTH arms carry all seven scores. Anything else is excluded AND counted in
// n_excluded, never quietly dropped: a cohort you cannot see is a cohort you cannot check.
const scoredRows = (rows) => (rows ?? []).filter((r) => hasAllDomains(r?.local) && hasAllDomains(r?.cloud));

/**
 * Local-vs-cloud agreement on the weighted composite.
 *
 * @param {{id?, local:{d1..d7}, cloud:{d1..d7}}[]} pairedRows  model-agreement.mjs report rows with both arms scored
 * @returns {{scale, n, n_excluded, composites:{id, local, cloud, delta}[], local_mean, cloud_mean,
 *            bias, bias_sd, limits:{lower, upper}|null, icc}}
 *   delta and bias are local − cloud. bias_sd and the Bland–Altman limits (bias ± 1.96·SD) are null
 *   below two rows. `icc` is iccTwoRater's result verbatim — {icc, lower, upper, n, interpretation} —
 *   or null below two rows; with no variance at all it is iccTwoRater's own "Insufficient variance"
 *   result, whose icc/lower/upper are null rather than a number that looks like a measurement.
 */
export function compositeAgreement(pairedRows) {
  const scored = scoredRows(pairedRows);
  const composites = scored.map((r) => {
    const local = compositeOf(r.local);
    const cloud = compositeOf(r.cloud);
    return { id: r.id ?? null, local, cloud, delta: local - cloud };
  });
  const deltas = composites.map((c) => c.delta);
  const bias = mean(deltas);
  const biasSd = sd(deltas);
  return {
    scale: COMPOSITE_SCALE,
    n: composites.length,
    n_excluded: (pairedRows ?? []).length - composites.length,
    composites,
    local_mean: mean(composites.map((c) => c.local)),
    cloud_mean: mean(composites.map((c) => c.cloud)),
    bias,
    bias_sd: biasSd,
    limits: bias == null || biasSd == null ? null : { lower: bias - 1.96 * biasSd, upper: bias + 1.96 * biasSd },
    // Column a = local, b = cloud, as screening-verdict.mjs and methodology-figures.mjs pass them.
    // ICC(A,1) is rater-symmetric, so the order only fixes the sign convention of `bias`.
    icc: iccTwoRater(composites.map((c) => ({ a: c.local, b: c.cloud }))),
  };
}

/**
 * Per-domain agreement: each domain's 0–5 scores, local vs cloud. No weight applies to a single
 * domain, but the ICC is production's, so a per-domain figure here means what the same figure means
 * in screening-verdict.mjs.
 *
 * @returns {Record<string, {n, n_excluded, local_mean, cloud_mean, mean_delta, mean_abs_delta, exact,
 *            within_1, icc}>}  keyed d1..d7; means are null when n = 0, icc as in compositeAgreement.
 */
export function domainAgreement(pairedRows) {
  const scored = scoredRows(pairedRows);
  const excluded = (pairedRows ?? []).length - scored.length;
  return Object.fromEntries(DOMAINS.map((d) => {
    const deltas = scored.map((r) => r.local[d] - r.cloud[d]);
    return [d, {
      n: scored.length,
      n_excluded: excluded,
      local_mean: mean(scored.map((r) => r.local[d])),
      cloud_mean: mean(scored.map((r) => r.cloud[d])),
      mean_delta: mean(deltas),
      mean_abs_delta: mean(deltas.map(Math.abs)),
      exact: deltas.filter((x) => x === 0).length,
      within_1: deltas.filter((x) => Math.abs(x) <= 1).length,
      icc: iccTwoRater(scored.map((r) => ({ a: r.local[d], b: r.cloud[d] }))),
    }];
  }));
}

/**
 * How far ONE model's weighted composite moves across repeats of the same fixture.
 *
 * @param {{d1..d7}[]} runs  one parsed score set per repeat
 * @returns {{scale, n, n_excluded, composites:number[], range:number|null, sd:number|null}}
 *   range and sd are null below two runs. One run has a spread of zero by construction, not by
 *   measurement, and counting it as "no noise" is the flattering error e2-compare.mjs caught once.
 */
export function compositeSpread(runs) {
  const list = runs ?? [];
  const composites = list.filter(hasAllDomains).map(compositeOf);
  return {
    scale: COMPOSITE_SCALE,
    n: composites.length,
    n_excluded: list.length - composites.length,
    composites,
    // Rounded to compositeOf's own 2 dp. Today's weights make every composite a whole number, but a
    // difference of two 2-dp values carries float noise in general (64.35 − 61.2 = 3.1499999999999915).
    range: composites.length < 2 ? null : round2(Math.max(...composites) - Math.min(...composites)),
    sd: sd(composites),
  };
}
