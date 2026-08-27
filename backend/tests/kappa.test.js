// Weighted kappa (CREC082 SAP, "Additional agreement: weighted kappa, Bland–Altman, mean
// difference/limits of agreement"). Bland–Altman already existed; this was the missing statistic.
const { weightedKappa, weightedKappaByDomain } = require('../src/services/kappa');
const { iccTwoWay } = require('../src/services/icc');

const pairs = (arr) => arr.map(([a, b]) => ({ a, b }));

describe('what quadratic weighting buys', () => {
  test('an adjacent miss costs a quarter of a two-band miss', () => {
    // The reason for weighting at all: unweighted kappa treats 3-vs-4 and 3-vs-1 as the same
    // failure, which is wrong for an ordinal rubric where adjacent scores are near-agreement.
    const base = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]];
    const adjacent = weightedKappa(pairs([...base, ...base, [2, 3]])).kappa;
    const twoBand  = weightedKappa(pairs([...base, ...base, [2, 4]])).kappa;
    expect(adjacent).toBeGreaterThan(twoBand);
  });

  test('linear weighting is available and penalises distance less steeply', () => {
    const p = pairs([[0, 0], [1, 2], [2, 4], [3, 3], [4, 5], [5, 5], [0, 1], [4, 4]]);
    const quad = weightedKappa(p, { weights: 'quadratic' }).kappa;
    const lin  = weightedKappa(p, { weights: 'linear' }).kappa;
    expect(quad).not.toBe(lin);
    expect(weightedKappa(p).weights).toBe('quadratic'); // the default
  });
});

describe('chance correction is the point', () => {
  test('two raters who both mark almost everything the same score score LOW despite agreeing often', () => {
    // 90% exact agreement, but almost all of it is the marginals agreeing rather than the raters.
    const p = pairs([...Array(18).fill([3, 3]), [3, 4], [4, 3]]);
    const r = weightedKappa(p);
    expect(r.exact_agreement).toBeGreaterThan(0.85);
    expect(r.kappa).toBeLessThan(r.exact_agreement);   // kappa sees through it
  });

  test('exact agreement is reported alongside, because kappa alone hides it', () => {
    const r = weightedKappa(pairs([[0, 0], [5, 5], [2, 3], [4, 4]]));
    expect(r.exact_agreement).toBe(0.75);
  });

  test('all ratings in one category → undefined, not 1.0', () => {
    // Perfect agreement AND perfect chance agreement: 0/0. Claiming 1.0 would describe nothing.
    const r = weightedKappa(pairs(Array(12).fill([3, 3])));
    expect(r.kappa).toBeNull();
    expect(r.interpretation).toMatch(/Undefined/);
  });

  test('a systematic offset scores worse than chance', () => {
    const r = weightedKappa(pairs(Array.from({ length: 24 }, (_, i) => [i % 6, (i + 3) % 6])));
    expect(r.kappa).toBeLessThan(0);
    expect(r.interpretation).toBe('Worse than chance');
  });
});

describe('the matrix is sized by the SCALE, not the sample', () => {
  test('the same disagreement scores the same whether or not the extremes appear', () => {
    // Sizing the matrix to observed values would make the weights depend on the cohort, so the same
    // disagreement would be penalised differently in two samples and the numbers would stop being
    // comparable across CLEs.
    const narrow = weightedKappa(pairs([[2, 2], [2, 3], [3, 3], [3, 2], [2, 2], [3, 3]]));
    expect(narrow.scale).toEqual([0, 5]);
    expect(narrow.kappa).not.toBeNull();
  });

  test('out-of-range ratings are dropped, never clamped — clamping would invent agreement', () => {
    const r = weightedKappa(pairs([[3, 3], [4, 4], [7, 5], [2, -1], [1, 1]]));
    expect(r.n).toBe(3);
    expect(r.n_excluded).toBe(2);
  });
});

describe('agreement with the ICC implementation', () => {
  test('quadratic-weighted kappa tracks ICC(A,1) — Fleiss & Cohen (1973)', () => {
    // Two independently written statistics converging is a check on both. They are asymptotically
    // equivalent for two raters on an ordinal scale, so a real divergence here means one is wrong.
    const p = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 400; i++) {
      const t = rnd() * 5;
      const q = (v) => Math.max(0, Math.min(5, Math.round(v)));
      p.push({ a: q(t + (rnd() - 0.5) * 1.6), b: q(t + (rnd() - 0.5) * 1.6) });
    }
    const wk = weightedKappa(p).kappa;
    const icc = iccTwoWay(p.map(x => [x.a, x.b])).icc;
    expect(Math.abs(wk - icc)).toBeLessThan(0.02);
  });
});

describe('per-domain reporting', () => {
  test('a composite that agrees can hide one domain that does not', () => {
    // Which is the point of "PIS-7 domain-level agreement" in the SAP: the divergent domain is the
    // one whose anchors need rewriting, and a pooled figure buries it.
    const rows = Array.from({ length: 12 }, (_, i) => ({
      a: { d1: i % 6, d2: i % 6, d3: 3, d4: 3, d5: 3, d6: 3, d7: i % 6 },
      b: { d1: i % 6, d2: (i + 3) % 6, d3: 3, d4: 3, d5: 3, d6: 3, d7: i % 6 }, // d2 systematically off
    }));
    const { domains } = weightedKappaByDomain(rows);
    expect(domains.d1.kappa).toBe(1);
    expect(domains.d2.kappa).toBeLessThan(0);
    expect(domains.d3.kappa).toBeNull();   // constant → undefined, correctly
  });

  test('all seven domains are always present, even when a domain is unusable', () => {
    const { domains, pooled } = weightedKappaByDomain([]);
    expect(Object.keys(domains)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    expect(pooled).toBeNull();  // no data at all
  });
});

describe('too little data', () => {
  test.each([[[]], [[[3, 3]]]])('%j → null rather than a confident number', (arr) => {
    expect(weightedKappa(pairs(arr))).toBeNull();
  });
});
