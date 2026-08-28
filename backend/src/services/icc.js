// Intraclass correlation for CLICS reliability reporting.
//
// TWO models live here, and picking the wrong one is the easiest way to publish a number that does
// not mean what the caption says:
//
//   iccTwoWay  — ICC(2,1). Two-way random effects, absolute agreement, single measurement.
//                Assumes the SAME raters scored every subject (raters crossed with subjects), so it
//                can separate rater bias (MSc) from disagreement (MSe). This is the right model for
//                AI-vs-human: column A is always the same instrument.
//
//   iccOneWay  — ICC(1,1). One-way random effects, single measurement.
//                Assumes each subject was scored by a DIFFERENT, randomly drawn set of raters, so
//                rater identity is nested in subject and cannot be estimated separately. This is the
//                right model for a rotating auditor pool: with 3 auditors drawn per CLE from a
//                roster, the raters are not crossed, and reporting ICC(2,1) over them would claim to
//                have removed a rater effect the design cannot even identify.
//
// Both are RATER-SYMMETRIC — nothing distinguishes column A from column B — so the same routines
// measure AI<->human, candidate(shadow)<->human, or AI<->candidate agreement.
function iccTwoRater(input) {
  const pairs = input.map(p => ({ a: p.a ?? p.ai, b: p.b ?? p.human }));
  const n = pairs.length;
  if (n < 2) return null;

  const k = 2;
  const grandMean = pairs.reduce((a, p) => a + p.a + p.b, 0) / (n * k);
  const rowMeans = pairs.map(p => (p.a + p.b) / 2);
  const colMeans = [
    pairs.reduce((a, p) => a + p.a, 0) / n,
    pairs.reduce((a, p) => a + p.b, 0) / n,
  ];

  const SSr = k * rowMeans.reduce((a, m) => a + (m - grandMean) ** 2, 0);
  const SSc = n * colMeans.reduce((a, m) => a + (m - grandMean) ** 2, 0);
  const SStotal = pairs.reduce((a, p) => a + (p.a - grandMean) ** 2 + (p.b - grandMean) ** 2, 0);
  const SSe = SStotal - SSr - SSc;

  // Degenerate: every score is identical (both raters, same value on every pair) — common per-domain
  // when a 0-5 domain is scored the same across sessions. There is no variance to partition, so ICC
  // is undefined. Return a clear 'insufficient variance' result instead of the spurious -0.999
  // 'Below target' the MSe floor produced (perfect agreement was being reported as the worst case).
  if (SStotal < 1e-9) {
    return { icc: null, lower: null, upper: null, n, interpretation: 'Insufficient variance (identical scores)' };
  }

  const MSr = SSr / (n - 1);
  const MSc = SSc / (k - 1);
  const MSe = Math.max(SSe / ((n - 1) * (k - 1)), 0.0001);

  const icc = (MSr - MSe) / (MSr + (k - 1) * MSe + k * (MSc - MSe) / n);

  const safeIcc = Math.min(Math.max(icc, -0.999), 0.999);
  const z = 0.5 * Math.log((1 + safeIcc) / (1 - safeIcc));
  const se = 1 / Math.sqrt(Math.max(n - 3, 1));
  const lower = Math.tanh(z - 1.96 * se);
  const upper = Math.tanh(z + 1.96 * se);

  // Label off the clamped value so it matches the displayed icc (a wildly negative raw value still
  // reads as 'Below target', never flips the bands).
  const label = safeIcc >= 0.95 ? 'Excellent'
    : safeIcc >= 0.85 ? 'Very Good'
    : safeIcc >= 0.75 ? 'Good'
    : 'Below target (< 0.75)';

  return {
    icc: Math.round(safeIcc * 1000) / 1000,
    lower: Math.round(Math.max(lower, 0) * 1000) / 1000,
    upper: Math.round(Math.min(upper, 1) * 1000) / 1000,
    n,
    interpretation: label,
  };
}

// Back-compatible name for the AI-vs-human call sites. Same function, same numbers — { ai, human }
// is just the { a, b } pair spelled with the served evaluator in column A.
function computeICC21(pairs) {
  return iccTwoRater(pairs);
}

// ---------------------------------------------------------------------------------------------
// Shared tail: Fisher-z CI + interpretation bands. Factored out so the two models cannot drift
// apart in how they present a result — only the point estimate differs, never the labelling.
function finish(icc, n, extra = {}) {
  const safeIcc = Math.min(Math.max(icc, -0.999), 0.999);
  const z = 0.5 * Math.log((1 + safeIcc) / (1 - safeIcc));
  const se = 1 / Math.sqrt(Math.max(n - 3, 1));
  const label = safeIcc >= 0.95 ? 'Excellent'
    : safeIcc >= 0.85 ? 'Very Good'
    : safeIcc >= 0.75 ? 'Good'
    : 'Below target (< 0.75)';
  return {
    icc: Math.round(safeIcc * 1000) / 1000,
    lower: Math.round(Math.max(Math.tanh(z - 1.96 * se), 0) * 1000) / 1000,
    upper: Math.round(Math.min(Math.tanh(z + 1.96 * se), 1) * 1000) / 1000,
    n,
    interpretation: label,
    ...extra,
  };
}

// How many raters scored each subject. Reported on every k-rater result, never used to filter:
// the pilot has already been burnt once by a headline ICC that was partly an artifact of cases
// dropping out (n 33 -> 30). A cohort you cannot see is a cohort you cannot check.
function raterCounts(rows) {
  const dist = {};
  for (const r of rows) dist[r.length] = (dist[r.length] || 0) + 1;
  return dist;
}

/**
 * ICC(2,1) over k raters — two-way random, absolute agreement, single measurement.
 *
 * @param {number[][]} rows  one array of scores per subject
 * @param {object} [opts]
 * @param {number} [opts.k]  the rater count to analyse. Defaults to the most common row length.
 *
 * REQUIRES A BALANCED DESIGN, because a two-way model has to estimate a rater main effect and
 * cannot do so from a ragged matrix. Rows of a different length are EXCLUDED — and the result says
 * so, in `n_excluded` and `rater_counts`, rather than quietly shrinking the denominator. If most of
 * your rows are ragged, that is a signal to use iccOneWay, not to trim until this one runs.
 */
function iccTwoWay(rows, { k } = {}) {
  const clean = (rows || []).filter(r => Array.isArray(r) && r.every(v => Number.isFinite(Number(v))));
  const counts = raterCounts(clean);
  const width = k ?? Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a] || b - a)[0]);
  if (!Number.isFinite(width) || width < 2) return null;

  const mat = clean.filter(r => r.length === width).map(r => r.map(Number));
  const n = mat.length;
  const excluded = clean.length - n;
  if (n < 2) return null;

  const grand = mat.reduce((a, r) => a + r.reduce((x, v) => x + v, 0), 0) / (n * width);
  const rowMeans = mat.map(r => r.reduce((x, v) => x + v, 0) / width);
  const colMeans = Array.from({ length: width }, (_, j) => mat.reduce((a, r) => a + r[j], 0) / n);

  const SSr = width * rowMeans.reduce((a, m) => a + (m - grand) ** 2, 0);
  const SSc = n * colMeans.reduce((a, m) => a + (m - grand) ** 2, 0);
  const SStotal = mat.reduce((a, r) => a + r.reduce((x, v) => x + (v - grand) ** 2, 0), 0);
  const SSe = SStotal - SSr - SSc;

  if (SStotal < 1e-9) {
    return { icc: null, lower: null, upper: null, n, k: width, n_excluded: excluded,
      rater_counts: counts, model: 'ICC(2,1)', interpretation: 'Insufficient variance (identical scores)' };
  }

  const MSr = SSr / (n - 1);
  const MSc = SSc / (width - 1);
  const MSe = Math.max(SSe / ((n - 1) * (width - 1)), 0.0001);
  const icc = (MSr - MSe) / (MSr + (width - 1) * MSe + width * (MSc - MSe) / n);

  return finish(icc, n, { k: width, n_excluded: excluded, rater_counts: counts, model: 'ICC(2,1)' });
}

/**
 * ICC(A,k) — two-way, absolute agreement, AVERAGE measures. The SAP's interrater statistic.
 *
 * The distinction from iccTwoWay is what is being called reliable. ICC(A,1) answers "how reliable is
 * ONE rater?"; ICC(A,k) answers "how reliable is the MEAN of the k raters?" — and since averaging
 * cancels independent error, the second is always the larger number. Reporting an average-measures
 * figure as if it were single-measure overstates reliability, which is why the SAP names them
 * separately: ICC(A,1) for AI-vs-humans, ICC(A,3) for the human panel whose MEAN is what the AI is
 * compared against.
 *
 *   ICC(A,1) = (MSR - MSE) / (MSR + (k-1)MSE + k(MSC - MSE)/n)
 *   ICC(A,k) = (MSR - MSE) / (MSR +          (MSC - MSE)/n)
 *
 * Same mean squares, one term dropped. (Spearman-Brown, k·r/(1+(k-1)r), gives the identical value
 * here — it cancels exactly for absolute agreement — but computing from the MS terms directly keeps
 * one derivation rather than two that could drift.)
 *
 * NAMING: McGraw & Wong's ICC(A,1)/ICC(A,k) and Shrout & Fleiss's ICC(2,1)/ICC(2,k) are the same
 * quantities. The SAP uses the A-form, so results carry both labels.
 *
 * "Two-way mixed" (the SAP's primary) and "two-way random" (its interrater) share this formula; the
 * models differ in how the rater effect is INTERPRETED, not in how absolute agreement is computed.
 *
 * Balanced design required, exactly as iccTwoWay — ragged rows are excluded and counted.
 */
function iccTwoWayAverage(rows, { k } = {}) {
  const clean = (rows || []).filter(r => Array.isArray(r) && r.every(v => Number.isFinite(Number(v))));
  const counts = raterCounts(clean);
  const width = k ?? Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a] || b - a)[0]);
  if (!Number.isFinite(width) || width < 2) return null;

  const mat = clean.filter(r => r.length === width).map(r => r.map(Number));
  const n = mat.length;
  const excluded = clean.length - n;
  if (n < 2) return null;

  const grand = mat.reduce((a, r) => a + r.reduce((x, v) => x + v, 0), 0) / (n * width);
  const rowMeans = mat.map(r => r.reduce((x, v) => x + v, 0) / width);
  const colMeans = Array.from({ length: width }, (_, j) => mat.reduce((a, r) => a + r[j], 0) / n);

  const SSr = width * rowMeans.reduce((a, m) => a + (m - grand) ** 2, 0);
  const SSc = n * colMeans.reduce((a, m) => a + (m - grand) ** 2, 0);
  const SStotal = mat.reduce((a, r) => a + r.reduce((x, v) => x + (v - grand) ** 2, 0), 0);
  const SSe = SStotal - SSr - SSc;

  const labels = { model: `ICC(A,${width})`, model_alt: `ICC(2,${width})`, measure: 'average' };
  if (SStotal < 1e-9) {
    return { icc: null, lower: null, upper: null, n, k: width, n_excluded: excluded,
      rater_counts: counts, ...labels, interpretation: 'Insufficient variance (identical scores)' };
  }

  const MSr = SSr / (n - 1);
  const MSc = SSc / (width - 1);
  const MSe = Math.max(SSe / ((n - 1) * (width - 1)), 0.0001);
  const icc = (MSr - MSe) / (MSr + (MSc - MSe) / n);

  // Fisher-z, matching the single-measure path. An exact average-measures interval is F-based; the
  // approximation is kept so the two statistics are never presented with intervals built different
  // ways, which would make them look more comparable or less comparable than they are.
  return finish(icc, n, { k: width, n_excluded: excluded, rater_counts: counts, ...labels });
}

/**
 * ICC(1,1) — one-way random, single measurement. Handles a RAGGED matrix natively.
 *
 * This is the model for a rotating auditor pool: each CLE is scored by whichever auditors were
 * assigned to it, so rater is nested in subject. Because the design cannot identify a rater main
 * effect, there is no MSc term — disagreement and rater bias are pooled into MSw, which makes this
 * the CONSERVATIVE choice. It is never inflated by a rater effect the design cannot see.
 *
 * Unbalanced group sizes use the standard adjusted k0 = (N - sum(ki^2)/N) / (n-1), which reduces to
 * k exactly when every subject has k raters.
 */
function iccOneWay(rows) {
  const mat = (rows || [])
    .filter(r => Array.isArray(r) && r.length >= 2 && r.every(v => Number.isFinite(Number(v))))
    .map(r => r.map(Number));
  const n = mat.length;
  if (n < 2) return null;

  const counts = raterCounts(mat);
  const sizes = mat.map(r => r.length);
  const N = sizes.reduce((a, x) => a + x, 0);
  const grand = mat.reduce((a, r) => a + r.reduce((x, v) => x + v, 0), 0) / N;
  const rowMeans = mat.map(r => r.reduce((x, v) => x + v, 0) / r.length);

  const SSb = mat.reduce((a, r, i) => a + r.length * (rowMeans[i] - grand) ** 2, 0);
  const SSw = mat.reduce((a, r, i) => a + r.reduce((x, v) => x + (v - rowMeans[i]) ** 2, 0), 0);

  if (SSb + SSw < 1e-9) {
    return { icc: null, lower: null, upper: null, n, n_ratings: N, rater_counts: counts,
      model: 'ICC(1,1)', interpretation: 'Insufficient variance (identical scores)' };
  }
  if (N === n) return null; // one rating per subject — nothing to correlate within

  const k0 = (N - sizes.reduce((a, x) => a + x * x, 0) / N) / (n - 1);
  const MSb = SSb / (n - 1);
  const MSw = Math.max(SSw / (N - n), 0.0001);
  const icc = (MSb - MSw) / (MSb + (k0 - 1) * MSw);

  return finish(icc, n, {
    n_ratings: N,
    k0: Math.round(k0 * 1000) / 1000,
    rater_counts: counts,
    model: 'ICC(1,1)',
  });
}

/**
 * Does this arm clear its threshold? Decided by the CONFIDENCE INTERVAL, never by the point estimate
 * alone and never by a minimum pair count.
 *
 *   pass          the whole interval sits at or above the threshold — we can conclude it is met
 *   fail          the whole interval sits below it — we can conclude it is not
 *   insufficient  the interval straddles it — the data cannot answer the question yet
 *
 * The third state is the reason this function exists. A point estimate of 0.78 on nine pairs looks
 * like a pass and is not one: the calibration notes already record that at around thirty pairs the
 * 95% interval spans roughly 0.40 to 0.83, which is most of the usable range. Reporting that as
 * `fail` would be equally wrong — it would read as evidence against a candidate when there is no
 * evidence either way — so `insufficient` is a first-class answer, not a variant of failure.
 *
 * Using the interval rather than an arbitrary "at least N pairs" rule means the bar tightens exactly
 * as the data demands: a noisy corpus needs more pairs than a clean one to say anything, and no
 * hand-picked N knows that.
 */
function verdictFor(result, threshold) {
  const icc = result?.icc, lower = result?.lower, upper = result?.upper, n = result?.n ?? 0;
  const base = { threshold, icc: icc ?? null, lower: lower ?? null, upper: upper ?? null, n };
  if (icc == null || lower == null || upper == null) {
    return { ...base, state: 'insufficient', why: 'no estimate — too few pairs, or no variance between them' };
  }
  // The Fisher-z interval is built on 1/sqrt(n-3) and simply does not exist below four pairs; the
  // helpers above clamp that denominator to keep from dividing by zero, which means they return an
  // interval at n=2 or n=3 that was invented rather than estimated.
  //
  // That invented interval is convincing in exactly the wrong direction. Two pairs that happen to
  // agree closely clamp toward an ICC of 0.999, and the clamped interval then sits entirely above
  // 0.75 — so the gate would read `pass` off two data points. Refusing to decide is the only honest
  // answer here, and it is the whole reason this third state exists.
  if (n < 4) {
    return { ...base, state: 'insufficient', why: `${n} pairs cannot support a confidence interval` };
  }
  if (lower >= threshold) return { ...base, state: 'pass', why: `the whole interval is at or above ${threshold}` };
  if (upper < threshold) return { ...base, state: 'fail', why: `the whole interval is below ${threshold}` };
  return { ...base, state: 'insufficient', why: `the interval spans ${threshold} — more pairs are needed to decide` };
}

module.exports = {
  verdictFor, computeICC21, iccTwoRater, iccTwoWay, iccTwoWayAverage, iccOneWay, raterCounts };
