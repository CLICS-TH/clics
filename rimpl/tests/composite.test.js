// compositeOf — the weighted PIS-7 composite a physician's credit is decided on.
//
// It lives in lib/composite.js so the probe harness (which cannot load zod on CI's bare checkout) can
// compute the identical number, and lib/pis7.js re-exports it. "Identical" only holds while there is
// ONE definition: if the two files ever each carried their own copy, an edit to one would silently
// split the probes' agreement figures from the composite production credits. So: the same function.
const composite = require('../src/lib/composite');
const pis7 = require('../src/lib/pis7');
const { WEIGHTS } = require('../src/lib/versions');

const S = (...v) => Object.fromEntries(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map((d, i) => [d, v[i]]));

test('pis7 re-exports the one definition, not a copy', () => {
  expect(pis7.compositeOf).toBe(composite.compositeOf);
});

test('the range is 0–100 (0 is a legal rubric score)', () => {
  expect(composite.compositeOf(S(5, 5, 5, 5, 5, 5, 5))).toBe(100);
  expect(composite.compositeOf(S(0, 0, 0, 0, 0, 0, 0))).toBe(0);
});

test('each domain moves the composite by its weight × 20', () => {
  const base = composite.compositeOf(S(3, 3, 3, 3, 3, 3, 3));
  for (const [d, w] of Object.entries(WEIGHTS)) {
    expect(composite.compositeOf({ ...S(3, 3, 3, 3, 3, 3, 3), [d]: 4 }) - base).toBeCloseTo(w * 20, 9);
  }
});
