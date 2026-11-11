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
// A dual value within this of ±1 counts as ±1; a residual within it of a bound meets the bound.
const TIE = 1e-7;
// A gradient, pivot or distance under this, relative to its scale, is rounding noise.
const NOISE = 1e-10;

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
 * @returns {{ beta: number[], dual: number[] }} β at the vertex reached, and a dual optimum d (|d_i| ≤ 1, Xᵀd = 0):
 *   column u_i's reduced cost is 1 − d_i and v_i's is 1 + d_i
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
      return { beta, dual: y.map((_, i) => 1 - reduced[2 * p + i]) };
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

const dot = (a, b) => a.reduce((acc, v, i) => acc + v * b[i], 0);

/**
 * Householder QR of a matrix, given as rows, of full column rank: R, upper triangular, and b ↦ Qᵀb.
 * @param {string} dependent the error to throw when a column depends on the ones before it
 */
function householder(A, dependent) {
  const m = A.length;
  const n = A[0].length;
  const M = A.map((row) => Float64Array.from(row));
  const scale = Math.max(...A.flatMap((row) => row.map(Math.abs)));
  const reflectors = [];
  for (let k = 0; k < n; k += 1) {
    const v = new Float64Array(m);
    for (let i = k; i < m; i += 1) v[i] = M[i][k];
    const norm = Math.hypot(...v);
    if (!(norm > NOISE * scale)) throw new Error(dependent);
    v[k] += v[k] > 0 ? norm : -norm;
    const vv = dot(v, v);
    for (let j = k; j < n; j += 1) {
      const f = (2 * M.reduce((acc, row, i) => acc + v[i] * row[j], 0)) / vv;
      for (let i = k; i < m; i += 1) M[i][j] -= f * v[i];
    }
    reflectors.push([v, vv]);
  }
  return {
    R: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (j < i ? 0 : M[i][j]))),
    qt: (b) => reflectors.reduce((z, [v, vv]) => {
      const f = (2 * dot(v, z)) / vv;
      return z.map((zi, i) => zi - f * v[i]);
    }, [...b]),
  };
}

/** x with Rx = z, for R upper triangular. */
function backSubstitute(R, z) {
  const x = new Array(R.length).fill(0);
  for (let i = R.length - 1; i >= 0; i -= 1) {
    let s = z[i];
    for (let j = i + 1; j < R.length; j += 1) s -= R[i][j] * x[j];
    x[i] = s / R[i][i];
  }
  return x;
}

/** x with Rᵀx = z, for R upper triangular. */
function forwardSubstitute(R, z) {
  const x = new Array(R.length).fill(0);
  for (let i = 0; i < R.length; i += 1) {
    let s = z[i];
    for (let j = 0; j < i; j += 1) s -= R[j][i] * x[j];
    x[i] = s / R[i][i];
  }
  return x;
}

/**
 * Lawson and Hanson's NNLS (Solving Least Squares Problems, 1974, ch. 23): the u ≥ 0 that minimises ‖Σ_j u_j c_j − b‖.
 * The set of positive weights grows by the column of steepest descent that is independent of it, and shrinks when a
 * least-squares step would take a weight below 0.
 */
function nonNegative(columns, b) {
  const m = b.length;
  const u = new Array(columns.length).fill(0);
  const passive = [];
  const matrix = (set) => Array.from({ length: m }, (_, i) => set.map((j) => columns[j][i]));
  const lost = 'the non-negative least squares lost the independence of its columns';
  const rounds = 3 * columns.length;
  for (let round = 0; round < rounds; round += 1) {
    const residual = b.map((bi, i) => columns.reduce((acc, c, j) => acc - c[i] * u[j], bi));
    const gradient = columns.map((c) => dot(c, residual));
    const basis = passive.length ? householder(matrix(passive), lost) : null;
    const independent = (j) => !basis
      || Math.hypot(...basis.qt(columns[j]).slice(passive.length)) > NOISE * Math.hypot(...columns[j]);
    const enter = gradient.map((_, j) => j).filter((j) => !passive.includes(j) && gradient[j] > NOISE)
      .sort((i, j) => gradient[j] - gradient[i]).find(independent);
    if (enter === undefined) return u;
    passive.push(enter);
    for (;;) {
      const { R, qt } = householder(matrix(passive), lost);
      const s = backSubstitute(R, qt(b).slice(0, passive.length));
      if (s.every((v) => v > 0)) {
        passive.forEach((j, k) => { u[j] = s[k]; });
        break;
      }
      let step = Infinity;
      let leaving = -1;
      passive.forEach((j, k) => {
        const ratio = u[j] - s[k] > 0 ? u[j] / (u[j] - s[k]) : 0;
        if (s[k] <= 0 && ratio < step) { step = ratio; leaving = j; }
      });
      passive.forEach((j, k) => { u[j] += step * (s[k] - u[j]); });
      u[leaving] = 0;
      for (let k = passive.length - 1; k >= 0; k -= 1) if (!(u[passive[k]] > 0)) passive.splice(k, 1);
    }
  }
  throw new Error(`the non-negative least squares did not converge in ${rounds} rounds`);
}

/**
 * Lawson and Hanson's least distance programming (ch. 23): the shortest w with Ew ≥ f. With u the NNLS of the
 * columns (E_i, f_i) against (0, …, 0, 1) and r = Σ u_i (E_i, f_i) − (0, …, 0, 1), w = −r_{1..p} / r_{p+1}.
 */
function leastDistance(E, f) {
  const p = E[0].length;
  const target = [...new Array(p).fill(0), 1];
  const columns = E.map((row, i) => [...row, f[i]]);
  const u = nonNegative(columns, target);
  const r = target.map((t, k) => columns.reduce((acc, c, i) => acc + c[k] * u[i], -t));
  if (!(r[p] < -NOISE)) throw new Error('the median regression\'s optimal set came out empty, which it cannot be');
  return r.slice(0, p).map((rk) => -rk / r[p]);
}

/**
 * The median (L1) regression of y on X that #381 takes: of every β with the least Σ|y − Xβ|, the one whose fitted
 * values are closest to least squares', the least ‖X(β − β_LS)‖². That distance is strictly convex in β, so the pick
 * is unique whatever the row order or the parametrisation. The LP's dual optimum d marks the optimal set by
 * complementary slackness, with r = y − Xβ: r_i = 0 where |d_i| < 1, r_i ≥ 0 where d_i = 1, r_i ≤ 0 where d_i = −1.
 * With X = QR and w = R(β − β_LS), r_i = e_i − q_i·w for the least-squares residual e, so the pick is the shortest w
 * in the set: Lawson and Hanson's LSI, reduced to least distance.
 */
function medianRegression(X, y) {
  const p = X[0].length;
  const { R, qt } = householder(X, 'the sampled paths do not separate every step × tier effect');
  const { beta: vertex, dual } = leastAbsolute(X, y);
  const ls = backSubstitute(R, qt(y).slice(0, p));
  const e = y.map((yi, i) => yi - dot(X[i], ls));
  const q = X.map((xi) => forwardSubstitute(R, xi));
  const atVertex = y.map((yi, i) => yi - dot(X[i], vertex));
  const E = [];
  const f = [];
  dual.forEach((d, i) => {
    // +1 is r_i ≤ 0, written q_i·w ≥ e_i; −1 is r_i ≥ 0. |d_i| < 1 gives both, so r_i = 0.
    const bounds = [...(d < 1 - TIE ? [1] : []), ...(d > -1 + TIE ? [-1] : [])];
    for (const sign of bounds) {
      if (sign * atVertex[i] > TIE) throw new Error(`the median regression's own optimum breaks its bound at sample ${i}`);
      E.push(q[i].map((v) => sign * v));
      f.push(sign * e[i]);
    }
  });
  const beta = backSubstitute(R, leastDistance(E, f)).map((v, j) => v + ls[j]);
  const absolute = (b) => y.reduce((acc, yi, i) => acc + Math.abs(yi - dot(X[i], b)), 0);
  const [picked, least] = [absolute(beta), absolute(vertex)];
  if (Math.abs(picked - least) > 1e-9 * Math.max(1, least)) {
    throw new Error(`the fit closest to least squares is not a median regression optimum: Σ|r| ${picked} against ${least}`);
  }
  return beta;
}

const byPathThenValue = ([p, y], [q, z]) => (p === q ? y - z : p < q ? -1 : 1);

/**
 * The five-step table from a build's samples. Per domain, a median (L1) regression on main effects, with tier B the
 * baseline of each step, then every tier path predicted and held to FITTED_RANGE at one decimal. An L1 fit of whole
 * scores is often not unique: of the equally good fits it takes the one closest to least squares (medianRegression),
 * which is unique. The samples are still put in one order first, so that the arithmetic, down to the last digit
 * before rounding, is the same in any order.
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
    const beta = medianRegression(rows.map(([path]) => effectRow(path)), rows.map(([, y]) => y));
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
