// ICC generalised past two raters.
//
// Why this exists: services/icc.js was hardcoded to k = 2 (`const k = 2`). With three blinded
// auditors per CLE — the design the manuscript describes — it could not express the statistic it
// names, and the 2026-06 soak worked around it by pooling all rater PAIRS, which is an
// approximation, not ICC(2,1).
//
// Every expected value below was cross-checked against an independent textbook-ANOVA implementation
// written separately in Python, not against this module's own output. A test that only asserts a
// function equals itself proves nothing about the statistic.
const { computeICC21, iccTwoWay, iccOneWay } = require('../src/services/icc');

// Balanced 8 subjects x 3 raters.
const THREE = [[4,4,5],[2,3,2],[5,5,5],[1,2,1],[3,3,4],[5,4,5],[2,2,3],[4,5,4]];
// Same subjects, but each scored by however many auditors happened to be assigned — a rotating pool.
const RAGGED = [[4,4,5],[2,3],[5,5,5],[1,2],[3,3,4],[5,4,5,5],[2,2,3],[4,5]];
const PAIRS = [[80,75],[62,68],[91,88],[55,60],[73,70],[84,86],[49,52],[66,64]];
// Rater C carries a constant +2 bias.
const BIASED = [[3,3,5],[1,1,3],[4,4,6],[2,2,4],[5,5,7],[1,2,3],[4,3,6],[2,3,4]];

describe('no regression: the k=2 path is byte-identical to the old one', () => {
  test('iccTwoWay(pairs) reproduces computeICC21 exactly — point estimate AND interval', () => {
    const legacy = computeICC21(PAIRS.map(([ai, human]) => ({ ai, human })));
    const next = iccTwoWay(PAIRS);

    expect(next.icc).toBe(legacy.icc);
    expect(next.lower).toBe(legacy.lower);
    expect(next.upper).toBe(legacy.upper);
    expect(next.n).toBe(legacy.n);
    expect(next.interpretation).toBe(legacy.interpretation);
  });

  test('the existing call sites keep the shape they read', () => {
    const r = computeICC21(PAIRS.map(([ai, human]) => ({ ai, human })));
    expect(r).toMatchObject({ icc: 0.958, lower: 0.782, upper: 0.993, n: 8, interpretation: 'Excellent' });
  });
});

describe('ICC(2,1) over three raters', () => {
  test('matches the independent ANOVA reference', () => {
    expect(iccTwoWay(THREE).icc).toBe(0.852);   // python reference: 0.852
  });

  test('reports k and the model it used, so a caption cannot claim the wrong statistic', () => {
    expect(iccTwoWay(THREE)).toMatchObject({ k: 3, n: 8, model: 'ICC(2,1)' });
  });

  test('k can be pinned explicitly', () => {
    expect(iccTwoWay(THREE, { k: 3 }).k).toBe(3);
  });

  test('perfect agreement across three raters is ~1', () => {
    const perfect = [[1,1,1],[2,2,2],[3,3,3],[4,4,4],[5,5,5]];
    expect(iccTwoWay(perfect).icc).toBeGreaterThan(0.99);
  });

  test('identical scores everywhere is insufficient variance, not a spurious -0.999', () => {
    const flat = [[3,3,3],[3,3,3],[3,3,3],[3,3,3]];
    expect(iccTwoWay(flat).icc).toBeNull();
    expect(iccTwoWay(flat).interpretation).toMatch(/insufficient variance/i);
  });
});

describe('a ragged matrix is REPORTED, never silently trimmed', () => {
  // The pilot has already been burnt once by this: the headline 0.811 was partly an artifact of a
  // failed evaluation dropping out (n 33 -> 30). Excluding cases to tidy a number is the same
  // mistake wearing a different hat, so exclusions have to be visible in the result itself.
  test('iccTwoWay states how many rows it excluded and the full rater distribution', () => {
    const r = iccTwoWay(RAGGED);
    expect(r.rater_counts).toEqual({ 2: 3, 3: 4, 4: 1 });   // the WHOLE cohort, not the analysed part
    expect(r.k).toBe(3);
    expect(r.n).toBe(4);                                     // only the 3-rater rows are analysable
    expect(r.n_excluded).toBe(4);                            // and it says so
  });

  test('a balanced cohort excludes nothing', () => {
    expect(iccTwoWay(THREE).n_excluded).toBe(0);
  });
});

describe('ICC(1,1) — the model that actually fits a rotating auditor pool', () => {
  test('handles the ragged matrix natively, using every rating', () => {
    const r = iccOneWay(RAGGED);
    expect(r.icc).toBe(0.831);          // python reference: 0.831
    expect(r.n).toBe(8);                // all 8 CLEs, none dropped
    expect(r.n_ratings).toBe(22);   // 3+2+3+2+3+4+3+2
    expect(r.model).toBe('ICC(1,1)');
  });

  test('the adjusted group size k0 collapses to k on a balanced cohort', () => {
    expect(iccOneWay(THREE).k0).toBe(3);
    expect(iccOneWay(THREE).icc).toBe(0.852);  // python reference: 0.852
  });

  test('k0 is between the smallest and largest group when unbalanced', () => {
    const { k0 } = iccOneWay(RAGGED);
    expect(k0).toBeGreaterThan(2);
    expect(k0).toBeLessThan(4);
  });

  test('it is the CONSERVATIVE model — rater bias it cannot identify stays in the error term', () => {
    // The whole reason to offer both. A rater with a constant +2 offset is a rater main effect;
    // two-way can see and partially isolate it, one-way pools it into disagreement. Reporting the
    // two-way figure over a rotating pool would claim to have removed an effect the design cannot
    // even estimate — so the lower number is the honest one there.
    expect(iccOneWay(BIASED).icc).toBeLessThan(iccTwoWay(BIASED).icc);
  });
});

describe('degenerate inputs return null rather than a number nobody should quote', () => {
  test.each([
    ['fewer than 2 subjects', [[4, 4, 5]]],
    ['empty', []],
    ['undefined', undefined],
  ])('%s', (_label, input) => {
    expect(iccTwoWay(input)).toBeNull();
    expect(iccOneWay(input)).toBeNull();
  });

  test('one rating per subject cannot be correlated within subject', () => {
    expect(iccOneWay([[3], [4], [5], [6]])).toBeNull();
  });

  test('non-numeric rows are dropped before the maths, not coerced to NaN', () => {
    const withJunk = [...THREE, ['n/a', 3, 4]];
    expect(iccTwoWay(withJunk).icc).toBe(0.852);   // unchanged by the junk row
  });
});
