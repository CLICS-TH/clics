// The ICC confidence intervals (services/icc.js), which decide every agreement gate through
// verdictFor. Two independent checks, because no R or Python stats package is available to compare
// against in CI:
//
//   1. The two-way bounds are re-derived here from the a/b form of McGraw & Wong (1996) that R's
//      irr::icc uses, which is written differently from the module's form. Same numbers = no algebra
//      slip in either.
//   2. COVERAGE. Simulate data with a known true ICC and count how often the interval contains it.
//      That is the property a confidence interval claims, so it checks the statistic, not the code.
//
// Coverage measured at 2,000 reps per scenario when this was written (2026-10):
//   one-way (exact)            0.953
//   two-way McGraw–Wong        0.918–0.957 — the method is an approximation, slightly liberal
//   the Fisher-z it replaced   0.891–0.992 — and 0.891 at n=27, ICC 0.86, i.e. the D18 regime
const { iccTwoWay, iccOneWay, iccTwoWayAverage } = require('../src/services/icc');
const { fQuantile } = require('../src/services/f-dist');

function msTerms(rows) {
  const n = rows.length, k = rows[0].length;
  const grand = rows.flat().reduce((a, v) => a + v, 0) / (n * k);
  const rm = rows.map(r => r.reduce((a, v) => a + v, 0) / k);
  const cm = Array.from({ length: k }, (_, j) => rows.reduce((a, r) => a + r[j], 0) / n);
  const SSr = k * rm.reduce((a, m) => a + (m - grand) ** 2, 0);
  const SSc = n * cm.reduce((a, m) => a + (m - grand) ** 2, 0);
  const SSt = rows.flat().reduce((a, v) => a + (v - grand) ** 2, 0);
  return { n, k, MSr: SSr / (n - 1), MSc: SSc / (k - 1), MSe: (SSt - SSr - SSc) / ((n - 1) * (k - 1)) };
}

// irr::icc, unit = "single", type = "agreement", written out from its source form.
function irrAgreementSingle(rows) {
  const { n, k, MSr, MSc, MSe } = msTerms(rows);
  const r = (MSr - MSe) / (MSr + (k - 1) * MSe + (k / n) * (MSc - MSe));
  const a = (k * r) / (n * (1 - r));
  const b = 1 + (k * r * (n - 1)) / (n * (1 - r));
  const v = (a * MSc + b * MSe) ** 2 / ((a * MSc) ** 2 / (k - 1) + (b * MSe) ** 2 / ((n - 1) * (k - 1)));
  const FL = fQuantile(0.975, n - 1, v);
  const FU = fQuantile(0.975, v, n - 1);
  return {
    lower: (n * (MSr - FL * MSe)) / (FL * (k * MSc + (k * n - k - n) * MSe) + n * MSr),
    upper: (n * (FU * MSr - MSe)) / (k * MSc + (k * n - k - n) * MSe + n * FU * MSr),
  };
}

const THREE = [[4,4,5],[2,3,2],[5,5,5],[1,2,1],[3,3,4],[5,4,5],[2,2,3],[4,5,4]];
const PAIRS = [[80,75],[62,68],[91,88],[55,60],[73,70],[84,86],[49,52],[66,64]];
const BIASED = [[3,3,5],[1,1,3],[4,4,6],[2,2,4],[5,5,7],[1,2,3],[4,3,6],[2,3,4]];

describe('two-way bounds equal the irr::icc derivation', () => {
  test.each([['pairs', PAIRS], ['three raters', THREE], ['a biased rater', BIASED]])('%s', (_, rows) => {
    const ref = irrAgreementSingle(rows);
    const got = iccTwoWay(rows);
    expect(got.lower).toBeCloseTo(Math.max(ref.lower, 0), 3);
    expect(got.upper).toBeCloseTo(Math.min(ref.upper, 1), 3);
  });

  test('a rater bias widens the interval', () => {
    const shifted = THREE.map(([a, b, c]) => [a, b, c + 1]);
    const plain = iccTwoWay(THREE), biased = iccTwoWay(shifted);
    expect(biased.upper - biased.lower).toBeGreaterThan(plain.upper - plain.lower);
  });

  test('average measures are the single-measure bounds stepped up by Spearman-Brown', () => {
    const ref = irrAgreementSingle(THREE);
    const sb = (r) => (3 * r) / (1 + 2 * r);
    const got = iccTwoWayAverage(THREE);
    expect(got.lower).toBeCloseTo(sb(ref.lower), 3);
    expect(got.upper).toBeCloseTo(sb(ref.upper), 3);
  });
});

describe('coverage — the interval contains the true ICC about 95% of the time', () => {
  // Seeded, so the test is deterministic; 400 reps keeps it fast. The band is wide enough for
  // 400-rep noise (SE ≈ 0.011) around the 2,000-rep figures in the header.
  let seed;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const norm = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());

  function coverage({ oneWay, n, k, vs, vr, ve, reps = 400 }) {
    seed = 20261001;
    const truth = vs / (vs + vr + ve);
    let hit = 0;
    for (let t = 0; t < reps; t++) {
      const bias = Array.from({ length: k }, () => norm() * Math.sqrt(vr));
      const rows = Array.from({ length: n }, () => {
        const s = norm() * Math.sqrt(vs);
        return Array.from({ length: k }, (_, j) =>
          s + (oneWay ? norm() * Math.sqrt(vr) : bias[j]) + norm() * Math.sqrt(ve));
      });
      const res = oneWay ? iccOneWay(rows) : iccTwoWay(rows, { k });
      if (truth >= res.lower && truth <= res.upper) hit++;
    }
    return hit / reps;
  }

  test('two-way, 27 pairs at ICC ≈ 0.86 (the D18 regime)', () => {
    const c = coverage({ n: 27, k: 2, vs: 8, vr: 0.3, ve: 1 });
    expect(c).toBeGreaterThan(0.89);
    expect(c).toBeLessThan(0.99);
  });

  test('two-way, 8 pairs', () => {
    const c = coverage({ n: 8, k: 2, vs: 4, vr: 0.5, ve: 1 });
    expect(c).toBeGreaterThan(0.90);
    expect(c).toBeLessThan(0.99);
  });

  test('one-way, 20 subjects × 3 raters (exact interval)', () => {
    const c = coverage({ oneWay: true, n: 20, k: 3, vs: 2, vr: 0.5, ve: 1 });
    expect(c).toBeGreaterThan(0.92);
    expect(c).toBeLessThan(0.98);
  });
});

describe('pairsNeededTwoRater — the ladder screening-verdict prints', () => {
  const { pairsNeededTwoRater } = require('../src/services/icc');
  test('the F-based ladder at a 0.75 bar', () => {
    expect([0.95, 0.92, 0.9, 0.88, 0.85].map((r) => pairsNeededTwoRater(r, 0.75))).toEqual([7, 12, 17, 26, 50]);
  });
  test('no rung when the truth is not above the bar', () => {
    expect(pairsNeededTwoRater(0.75, 0.75)).toBeNull();
    expect(pairsNeededTwoRater(0.6, 0.75)).toBeNull();
  });
});

describe('average measures never invert (review finding, 2026-10)', () => {
  // A disagreeing 3-rater panel: the single-measure lower bound falls below the Spearman-Brown pole
  // at -1/(k-1). Stepped up naively it came out positive, clamped to 1, and the interval read
  // [1.00, 0.80] — which verdictFor called a PASS.
  const DISAGREE = [[36, 28, 61], [47, 56, 93], [45, 98, 7], [58, 65, 16]];
  const { verdictFor } = require('../src/services/icc');

  test('lower <= upper, and the lower bound clamps to 0', () => {
    const r = iccTwoWayAverage(DISAGREE);
    expect(r.lower).toBeLessThanOrEqual(r.upper);
    expect(r.lower).toBe(0);
  });

  test('a panel that does not agree is never a pass', () => {
    expect(verdictFor(iccTwoWayAverage(DISAGREE), 0.75).state).not.toBe('pass');
  });
});

describe('one-way bounds equal an independent derivation', () => {
  // Shrout & Fleiss (1979) ICC(1,1) interval, balanced case, written out with its degrees of freedom
  // named: F = MSb/MSw on (n-1, n(k-1)). A swapped df pair passes the coverage tests above, so the
  // bounds are pinned here explicitly.
  test('THREE', () => {
    const n = THREE.length, k = 3;
    const grand = THREE.flat().reduce((a, v) => a + v, 0) / (n * k);
    const rm = THREE.map((r) => r.reduce((a, v) => a + v, 0) / k);
    const MSb = (k * rm.reduce((a, m) => a + (m - grand) ** 2, 0)) / (n - 1);
    const MSw = THREE.reduce((a, r, i) => a + r.reduce((x, v) => x + (v - rm[i]) ** 2, 0), 0) / (n * (k - 1));
    const F = MSb / MSw;
    const FL = F / fQuantile(0.975, n - 1, n * (k - 1));
    const FU = F * fQuantile(0.975, n * (k - 1), n - 1);
    const got = iccOneWay(THREE);
    expect(got.lower).toBeCloseTo((FL - 1) / (FL + k - 1), 3);
    expect(got.upper).toBeCloseTo((FU - 1) / (FU + k - 1), 3);
    expect(got).toMatchObject({ lower: 0.609, upper: 0.965 });
  });
});

describe('ICC(A,k) point estimate past the Spearman-Brown pole (found 2026-10)', () => {
  const { verdictFor } = require('../src/services/icc');
  // Two raters in complete disagreement. The closed form (MSR-MSE)/(MSR+(MSC-MSE)/n) has BOTH terms
  // negative here and returned +0.999 'Excellent'.
  const OPPOSED = [[1, 5], [5, 1], [2, 4], [4, 2]];

  test('complete disagreement is never reported as agreement', () => {
    const r = iccTwoWayAverage(OPPOSED);
    expect(r.icc).toBeLessThan(0);
    expect(r.interpretation).toBe('Below target (< 0.75)');
    expect(verdictFor(r, 0.75).state).not.toBe('pass');
  });

  test('away from the pole the estimate is unchanged: it still equals the closed form', () => {
    for (const rows of [THREE, PAIRS, BIASED]) {
      const { n, k, MSr, MSc, MSe } = msTerms(rows);
      const closed = (MSr - MSe) / (MSr + (MSc - MSe) / n);
      expect(iccTwoWayAverage(rows).icc).toBeCloseTo(Math.min(closed, 0.999), 3);
      expect(k).toBeGreaterThan(1);
    }
  });
});
