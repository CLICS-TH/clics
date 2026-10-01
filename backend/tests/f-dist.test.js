// The F quantile behind every ICC interval (services/f-dist.js). Expected values are printed F-table
// entries (and t² / z² identities), not this module's own output.
const { fQuantile, fCdf } = require('../src/services/f-dist');

describe('fQuantile matches printed F tables', () => {
  test.each([
    [0.975, 1, 1, 647.79],
    [0.975, 5, 10, 4.236],
    [0.95, 3, 20, 3.098],
    [0.99, 2, 10, 7.559],
    [0.95, 10, 30, 2.165],
    [0.99, 5, 5, 10.97],
    [0.95, 1, 10, 2.228 ** 2],      // F(1, v) = t(v)²
    [0.95, 1, 1e6, 1.95996 ** 2],   // ... and t(∞) = z
  ])('F_%s(%s, %s) ≈ %s', (p, d1, d2, ref) => {
    expect(Math.abs(fQuantile(p, d1, d2) - ref) / ref).toBeLessThan(0.001);
  });

  test('is the inverse of the CDF', () => {
    expect(fCdf(fQuantile(0.3, 7, 13), 7, 13)).toBeCloseTo(0.3, 10);
  });

  test('obeys the reciprocal identity F_p(a, b) = 1 / F_(1-p)(b, a)', () => {
    expect(fQuantile(0.025, 4, 9) * fQuantile(0.975, 9, 4)).toBeCloseTo(1, 10);
  });

  test('non-integer degrees of freedom (the Satterthwaite v) work', () => {
    const q = fQuantile(0.975, 7, 3.6);
    expect(q).toBeGreaterThan(fQuantile(0.975, 7, 4));
    expect(q).toBeLessThan(fQuantile(0.975, 7, 3));
  });

  test('undefined degrees of freedom give NaN, never a number', () => {
    expect(fQuantile(0.975, 0, 5)).toBeNaN();
    expect(fQuantile(0.975, 5, NaN)).toBeNaN();
  });
});
