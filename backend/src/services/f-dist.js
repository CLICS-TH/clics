// The F distribution's quantile function — the one piece of numerical machinery the exact ICC
// confidence intervals need (McGraw & Wong 1996). No stats dependency exists in this repo, and
// pulling one in for a single function is a worse trade than ~60 lines checked against reference
// values (tests/f-dist.test.js).
//
//   F CDF:  P(F <= x) = I_{d1·x / (d1·x + d2)}(d1/2, d2/2)     (regularised incomplete beta)
//   quantile: bisection on that CDF. Monotone, so bisection cannot miss; 200 halvings of a
//   bracket that starts at most 1e12 wide is far past double precision.

// Lanczos approximation (g=7, n=9) — accurate to ~15 significant digits for x > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61503916999185, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];
function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Continued fraction for the incomplete beta (modified Lentz).
function betacf(a, b, x) {
  const TINY = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

// Regularised incomplete beta I_x(a, b).
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b;
}

function fCdf(x, d1, d2) {
  if (!(x > 0)) return 0;
  return ibeta((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2);
}

// Smallest x with P(F <= x) >= p. Returns NaN for degrees of freedom that do not define an F.
function fQuantile(p, d1, d2) {
  if (!(p > 0 && p < 1) || !(d1 > 0) || !(d2 > 0) || !Number.isFinite(d1) || !Number.isFinite(d2)) return NaN;
  let lo = 0;
  let hi = 1;
  while (fCdf(hi, d1, d2) < p) {
    hi *= 2;
    if (hi > 1e12) return Infinity;
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (fCdf(mid, d1, d2) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

module.exports = { fCdf, fQuantile, lgamma, ibeta };
