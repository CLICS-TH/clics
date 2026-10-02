// Small, dependency-free statistics for the tutor-reply audit.
//
// Every rate this harness reports goes out with a Wilson interval, because the bank is ~80 items and
// a per-category slice is often 5-15: "9/10 passed" and "90% pass" are not the same claim, and the
// interval is what stops the second from being read as the first. Agreement between judges is
// Cohen's kappa (nominal) and quadratically weighted kappa (the 0-3 ordinal rubric).

/** Wilson score interval for k successes in n trials. Returns null bounds for n = 0 — "no data" is
 *  not "0%", and a report that prints 0% for an empty slice invites exactly the wrong reading. */
export function wilson(k, n, z = 1.959963984540054) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n < 0 || k < 0 || k > n) {
    throw new RangeError(`wilson: need 0 <= k <= n, got k=${k} n=${n}`);
  }
  if (n === 0) return { k, n, p: null, lo: null, hi: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Clamp floating-point dust: at k = 0 the lower bound is exactly 0, at k = n the upper is exactly 1.
  return { k, n, p, lo: k === 0 ? 0 : Math.max(0, centre - half), hi: k === n ? 1 : Math.min(1, centre + half) };
}

/** Binomial(n, p) probability mass for every k = 0..n, exact up to floating point. Built in log space,
 *  so n in the hundreds and p near 0 or 1 cannot underflow an intermediate the way p^n can. */
export function binomPmf(n, p) {
  if (!Number.isInteger(n) || n < 0 || !(p >= 0 && p <= 1)) throw new RangeError(`binomPmf: need integer n >= 0 and 0 <= p <= 1, got n=${n} p=${p}`);
  if (p === 0 || p === 1) return Array.from({ length: n + 1 }, (_, k) => ((p === 0 ? k === 0 : k === n) ? 1 : 0));
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  const out = new Array(n + 1);
  let lc = 0;                                   // log C(n, k), built incrementally
  for (let k = 0; k <= n; k++) {
    if (k > 0) lc += Math.log(n - k + 1) - Math.log(k);
    out[k] = Math.exp(lc + k * lp + (n - k) * lq);
  }
  return out;
}

/** P(X >= k) for X ~ Binomial(n, p). k <= 0 is 1; k > n is 0. */
export function binomUpper(k, n, p = 0.5) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const pmf = binomPmf(n, p);
  let s = 0;
  for (let i = k; i <= n; i++) s += pmf[i];
  return Math.min(1, s);
}

/** "k/n (p%, 95% CI lo–hi%)" — the one format every report line uses. */
export function fmtRate({ k, n, p, lo, hi }) {
  if (!n) return `${k}/${n} (no data)`;
  const f = (x) => (x * 100).toFixed(1);
  return `${k}/${n} (${f(p)}%, 95% CI ${f(lo)}–${f(hi)}%)`;
}

/**
 * Cohen's kappa for two raters over paired nominal labels.
 * @param {Array<[any, any]>} pairs
 * @param {{weights?: 'none'|'linear'|'quadratic', categories?: any[]}} opts
 *   `categories` fixes the ordered category set (required for weighted kappa so the distance between
 *   0 and 3 is known even if nobody used 1 or 2).
 * @returns {{kappa:number|null, po:number|null, pe:number|null, n:number}}
 *   kappa is null when it is undefined (n = 0, or pe = 1: both raters used one identical category
 *   throughout — perfect agreement with zero information, which kappa cannot score).
 */
export function cohenKappa(pairs, { weights = 'none', categories } = {}) {
  const n = pairs.length;
  if (!n) return { kappa: null, po: null, pe: null, n: 0 };
  const cats = categories ?? [...new Set(pairs.flat())].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
  const idx = new Map(cats.map((c, i) => [c, i]));
  for (const [a, b] of pairs) {
    if (!idx.has(a) || !idx.has(b)) throw new RangeError(`cohenKappa: label outside categories: ${a} / ${b}`);
  }
  const k = cats.length;
  const span = Math.max(1, k - 1);
  // Agreement weight: 1 on the diagonal, falling with distance.
  const w = (i, j) => {
    if (weights === 'none') return i === j ? 1 : 0;
    const d = Math.abs(i - j) / span;
    return weights === 'linear' ? 1 - d : 1 - d * d;
  };
  const obs = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const [a, b] of pairs) obs[idx.get(a)][idx.get(b)] += 1;
  const rowM = obs.map((r) => r.reduce((s, x) => s + x, 0) / n);
  const colM = cats.map((_, j) => obs.reduce((s, r) => s + r[j], 0) / n);
  let po = 0;
  let pe = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      po += w(i, j) * (obs[i][j] / n);
      pe += w(i, j) * rowM[i] * colM[j];
    }
  }
  const kappa = Math.abs(1 - pe) < 1e-12 ? null : (po - pe) / (1 - pe);
  return { kappa, po, pe, n };
}

/* ------------------------------------------------------------- seeded RNG */

/** 32-bit FNV-1a of a string — the seed for a per-item PRNG, so an item's A/B order depends only on
 *  (seed, item id) and NOT on which other items are in the run. Re-running with --limit or --ids
 *  must not reshuffle the items that remain. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: tiny, well-distributed, and deterministic across Node versions. Not cryptographic —
 *  it only has to be unpredictable to a judge reading one packet, not to an adversary. */
export function rng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with an injected PRNG. Returns a new array. */
export function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
