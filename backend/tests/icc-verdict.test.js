// The verdict a candidate evaluator is judged by.
//
// The point of this file is the THIRD state. A point estimate of 0.78 on nine pairs looks like a
// pass and is not one — the calibration notes record that at around thirty pairs the 95% interval
// spans roughly 0.40 to 0.83, most of the usable range. Calling that a `fail` would be equally
// wrong: it reads as evidence against a candidate when there is no evidence either way. So
// `insufficient` is a first-class answer, and it is decided by the INTERVAL rather than by a
// hand-picked minimum pair count — which would have to guess how noisy the corpus is.

const { verdictFor } = require('../src/services/icc');

const at = (icc, lower, upper, n = 40) => ({ icc, lower, upper, n });

describe('verdictFor', () => {
  test('the whole interval at or above the threshold is a PASS', () => {
    expect(verdictFor(at(0.88, 0.79, 0.94), 0.75)).toMatchObject({ state: 'pass', threshold: 0.75 });
  });

  test('exactly touching the threshold from below counts as a pass', () => {
    // lower === threshold means the data is consistent with meeting the bar and not with missing it.
    expect(verdictFor(at(0.80, 0.75, 0.90), 0.75).state).toBe('pass');
  });

  test('the whole interval below the threshold is a FAIL', () => {
    expect(verdictFor(at(0.40, 0.20, 0.61), 0.75).state).toBe('fail');
  });

  test('an interval that SPANS the threshold is insufficient, not a pass', () => {
    // This is the case the whole thing exists for: the estimate clears the bar, and the data still
    // cannot say whether the bar is met.
    const v = verdictFor(at(0.78, 0.41, 0.92), 0.75);
    expect(v.state).toBe('insufficient');
    expect(v.icc).toBe(0.78);      // the estimate is still reported — it is not hidden, just not decisive
  });

  test('an interval that spans the threshold is insufficient, not a fail either', () => {
    const v = verdictFor(at(0.60, 0.30, 0.85), 0.75);
    expect(v.state).toBe('insufficient');
    // Reporting this as `fail` would read as evidence against the candidate. There is none.
    expect(v.why).toMatch(/more pairs/);
  });

  test('no estimate at all is insufficient — never a fail', () => {
    // iccTwoRater returns nulls for too-few pairs and for zero variance. Neither is evidence.
    expect(verdictFor({ icc: null, lower: null, upper: null, n: 2 }, 0.75).state).toBe('insufficient');
    expect(verdictFor(null, 0.75).state).toBe('insufficient');
  });

  test('the threshold is carried in the verdict, so a reader never has to assume it', () => {
    expect(verdictFor(at(0.93, 0.90, 0.96), 0.9)).toMatchObject({ threshold: 0.9, state: 'pass' });
    // The same numbers against a higher bar are no longer decisive.
    expect(verdictFor(at(0.93, 0.90, 0.96), 0.92).state).toBe('insufficient');
  });

  test('an interval that could not exist is refused, even though it looks convincing', () => {
    // A REAL failure found while building this. The ICC helpers derive their interval from
    // 1/sqrt(n-3) and clamp that denominator so it never divides by zero, which means at two or
    // three pairs they return an interval that was invented rather than estimated.
    //
    // It is convincing in exactly the wrong direction: two pairs that happen to agree clamp toward
    // an ICC of 0.999, and the fabricated interval then sits entirely above 0.75. Before this guard
    // the decisive gate reported `pass` off two data points.
    expect(verdictFor(at(0.999, 0.951, 1.0, 2), 0.75).state).toBe('insufficient');
    expect(verdictFor(at(0.999, 0.951, 1.0, 3), 0.75).state).toBe('insufficient');
    // Four pairs is the first n at which the interval is real, so the rule stops applying there.
    expect(verdictFor(at(0.99, 0.96, 1.0, 4), 0.75).state).toBe('pass');
  });

  test('a wide interval never passes, however good the point estimate looks', () => {
    // n is reported but does NOT decide anything — the interval already encodes what n buys, and
    // how much it buys depends on how noisy the corpus is.
    expect(verdictFor(at(0.95, 0.10, 0.99, 6), 0.75).state).toBe('insufficient');
  });
});
