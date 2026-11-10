// The five-step path score table (#381, ADR 0009): which 27 of the 243 tier paths a build samples, the median (L1)
// regression of each domain on step × tier that fills all 243 from those samples, and the steps whose weaker answers
// score above their best. Package-free, like the other booth scripts, so CI tests it with no install.
import pleGate from '../../backend/src/services/ple-gate.js';

const { WEIGHTS, compositeScore } = pleGate;
const TIERS = 'BRW';
const DOMAINS = Object.keys(WEIGHTS);
// A fitted entry's range (#370). The evaluator itself scores 0-5.
export const FITTED_RANGE = Object.freeze({ min: 1, max: 5 });
const MAX_PIVOTS = 20_000;
const EPS = 1e-9;

/** Every tier path of `k` steps in order, B…B first and W…W last. */
export function tierPaths(k) {
  return Array.from({ length: TIERS.length ** k }, (_, n) => Array.from({ length: k },
    (_, j) => TIERS[Math.floor(n / TIERS.length ** (k - 1 - j)) % TIERS.length]).join(''));
}

const digits = (path) => [...path].map((t) => TIERS.indexOf(t));

/**
 * The 27 tier paths a five-step build samples: over GF(3), with tiers as 0, 1 and 2, every α·1 + β·m + γ·x, where m
 * is the first path of `required` that mixes tiers and x the first vector, in path order, whose pairs (m_j, x_j) all
 * differ.
 * @param {string[]} required the scripted paths, which the design must hold so the re-check reads measured samples
 * @returns {string[]} the design, sorted
 */
export function fractionalDesign(required) {
  const k = required[0].length;
  const mixed = required.find((p) => new Set(p).size > 1);
  if (!mixed) throw new Error('a fractional design needs a scripted path that mixes tiers');
  const m = digits(mixed);
  // Distinct pairs make every two columns (1, m_j, x_j) linearly independent, so each step sees each tier 9 times and
  // each pair of steps each tier pair 3 times; the span holds B…B, R…R, W…W and m.
  const x = tierPaths(k).map(digits).find((v) => new Set(v.map((xj, j) => `${m[j]}${xj}`)).size === k);
  if (!x) throw new Error(`no balanced design holds ${mixed}: it gives one tier to more than 3 steps`);
  const span = [0, 1, 2].flatMap((a) => [0, 1, 2].flatMap((b) => [0, 1, 2].map((c) =>
    m.map((mj, j) => TIERS[(a + b * mj + c * x[j]) % 3]).join(''))));
  const design = [...new Set(span)].sort();
  if (design.length !== 27) throw new Error(`the design for ${mixed} repeats paths: ${k} steps are too few`);
  const off = required.filter((p) => !design.includes(p));
  if (off.length) throw new Error(`the design for ${mixed} does not hold ${off.join(', ')}`);
  return design;
}

// One row of the main-effects design: the intercept, then per step "tier R" and "tier W", B being the baseline.
const effectRow = (path) => [1, ...[...path].flatMap((t) => [t === 'R' ? 1 : 0, t === 'W' ? 1 : 0])];

/**
 * Least absolute deviations as an exact linear program: minimise Σ(u + v) subject to Xβ⁺ − Xβ⁻ + u − v = y, every
 * variable ≥ 0, on a dense simplex tableau. Each row starts with u basic, or v on a row negated for y < 0, so no
 * phase 1 is needed. LAD programs are highly degenerate, so the entering and leaving choices both follow Bland's
 * rule, which cannot cycle.
 * @returns {number[]} β
 */
function leastAbsolute(X, y) {
  const n = X.length;
  const p = X[0].length;
  const width = 2 * (p + n);
  const rhs = width;
  const tableau = X.map((xi, i) => {
    const sign = y[i] < 0 ? -1 : 1;
    const row = new Float64Array(width + 1);
    xi.forEach((v, j) => { row[j] = sign * v; row[p + j] = -sign * v; });
    row[2 * p + i] = sign;
    row[2 * p + n + i] = -sign;
    row[rhs] = sign * y[i];
    return row;
  });
  const basis = y.map((yi, i) => (yi < 0 ? 2 * p + n + i : 2 * p + i));
  // Reduced costs: every u and v costs 1 and so does every starting basic variable, so c_j − Σ_i T_ij.
  const reduced = new Float64Array(width + 1);
  reduced.fill(1, 2 * p, width);
  for (const row of tableau) for (let j = 0; j <= width; j += 1) reduced[j] -= row[j];

  for (let pivots = 0; pivots < MAX_PIVOTS; pivots += 1) {
    let enter = -1;
    for (let j = 0; j < width && enter < 0; j += 1) if (reduced[j] < -EPS) enter = j;
    if (enter < 0) {
      const beta = new Array(p).fill(0);
      basis.forEach((b, i) => {
        if (b < p) beta[b] += tableau[i][rhs];
        else if (b < 2 * p) beta[b - p] -= tableau[i][rhs];
      });
      return beta;
    }
    let least = Infinity;
    for (const row of tableau) if (row[enter] > EPS) least = Math.min(least, row[rhs] / row[enter]);
    if (least === Infinity) throw new Error('the median regression is unbounded, which a sum of absolute values cannot be');
    let leave = -1;
    tableau.forEach((row, i) => {
      if (row[enter] > EPS && row[rhs] / row[enter] <= least + EPS && (leave < 0 || basis[i] < basis[leave])) leave = i;
    });
    const pivotRow = tableau[leave];
    const pivot = pivotRow[enter];
    for (let j = 0; j <= width; j += 1) pivotRow[j] /= pivot;
    for (const row of [...tableau, reduced]) {
      const f = row[enter];
      if (row !== pivotRow && f !== 0) for (let j = 0; j <= width; j += 1) row[j] -= f * pivotRow[j];
    }
    basis[leave] = enter;
  }
  throw new Error(`the median regression did not converge in ${MAX_PIVOTS} pivots`);
}

const byPathThenValue = ([p, y], [q, z]) => (p === q ? y - z : p < q ? -1 : 1);

/**
 * The five-step table from a build's samples. Per domain, a median (L1) regression on main effects, with tier B the
 * baseline of each step, then every tier path predicted and held to FITTED_RANGE at one decimal. An L1 fit of whole
 * scores is often not unique and the simplex's pick among equal fits follows the row order, so the samples are put
 * in one order first: the same samples give the same table in any order.
 * @param {{ path: string, domains: Record<string, number> }[]} samples every scored sample of the design
 * @returns {{ effects: Record<string, { intercept: number, steps: { B: 0, R: number, W: number }[] }>,
 *   paths: Record<string, Record<string, number>> }} effects unrounded; paths every tier path of the samples' length
 */
export function fitTable(samples) {
  const k = samples[0].path.length;
  const unseen = Array.from({ length: k }, (_, s) => [...TIERS].filter((t) => !samples.some((x) => x.path[s] === t))
    .map((t) => `${t} at step ${s + 1}`)).flat();
  if (unseen.length) throw new Error(`no sample has ${unseen.join(', ')}, so the effect cannot be fitted`);
  const effects = Object.fromEntries(DOMAINS.map((d) => {
    const rows = samples.map((x) => [x.path, x.domains[d]]).sort(byPathThenValue);
    const beta = leastAbsolute(rows.map(([path]) => effectRow(path)), rows.map(([, y]) => y));
    return [d, { intercept: beta[0], steps: Array.from({ length: k }, (_, s) => ({ B: 0, R: beta[1 + 2 * s], W: beta[2 + 2 * s] })) }];
  }));
  const predict = ({ intercept, steps }, path) => [...path].reduce((acc, t, s) => acc + steps[s][t], intercept);
  const entry = (v) => Math.round(Math.min(FITTED_RANGE.max, Math.max(FITTED_RANGE.min, v)) * 10) / 10;
  const paths = Object.fromEntries(tierPaths(k).map((path) => [path,
    Object.fromEntries(DOMAINS.map((d) => [d, entry(predict(effects[d], path))]))]));
  return { effects, paths };
}

/**
 * The steps whose weaker answers score above their best on the composite: likely tier mislabels (ADR 0009). The
 * composite is linear, so a step's W effect is the composite of its W effects per domain, taken to 2 decimals before
 * the comparison so that float dust on an exact tie never flags.
 * @returns {{ step: number, weaker_minus_best: number }[]} step counts from 1
 */
export function mislabels(effects) {
  const k = effects[DOMAINS[0]].steps.length;
  return Array.from({ length: k }, (_, s) => ({
    step: s + 1,
    weaker_minus_best: compositeScore(Object.fromEntries(DOMAINS.map((d) => [d, effects[d].steps[s].W]))),
  })).filter((m) => m.weaker_minus_best > 0);
}

/** A fitted entry's composite, a whole number. */
export const wholeComposite = (domains) => Math.round(compositeScore(domains));
