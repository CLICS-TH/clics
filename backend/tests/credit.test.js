// CME credit conversion — built, DEFAULT OFF.
const { creditFor, creditTable, normaliseCuts, DEFAULTS } = require('../src/services/credit');

describe('bands', () => {
  test.each([
    [10, 1, 0], [49.9, 1, 0],
    [50, 2, 0.5], [64.9, 2, 0.5],
    [65, 3, 1], [74.9, 3, 1],
    [75, 4, 1.5], [84.9, 4, 1.5],
    [85, 5, 2], [100, 5, 2],
  ])('composite %s -> band %s, %s credits', (score, band, credits) => {
    const r = creditFor(score);
    expect(r.band).toBe(band);
    expect(r.credits).toBe(credits);
  });

  test('a score exactly ON a cut lands in the HIGHER band', () => {
    // Stated because it is the kind of thing a refactor silently flips, and a physician on a
    // boundary must not lose half a credit to it.
    expect(creditFor(75).band).toBe(4);
    expect(creditFor(74.999).band).toBe(3);
  });
});

describe('OFF by default — the whole point of shipping it dormant', () => {
  test('credits are a PREVIEW and awarded_credits is null', () => {
    const r = creditFor(80);
    expect(r.enabled).toBe(false);
    expect(r.credits).toBe(1.5);        // what it WOULD be
    expect(r.awarded_credits).toBeNull(); // what was actually awarded: nothing
  });

  test('turning it on moves the same number into awarded_credits', () => {
    const r = creditFor(80, { enabled: true });
    expect(r.enabled).toBe(true);
    expect(r.awarded_credits).toBe(1.5);
  });
});

describe('policy is data, not code', () => {
  test('cuts and values are overridable without touching the module', () => {
    const r = creditFor(70, { cuts: [40, 60, 80], values: [0, 1, 2, 3], enabled: true });
    expect(r.band).toBe(3);
    expect(r.awarded_credits).toBe(2);
  });

  test('base unit scales every band', () => {
    expect(creditFor(85, { baseUnit: 3 }).credits).toBe(6);   // 2 x 3
  });

  test('out-of-order cuts are sorted, not left to make a band unreachable', () => {
    // An unreachable band looks like "nobody ever scores Very Good" rather than like a config error.
    expect(normaliseCuts([85, 50, 75, 65])).toEqual([50, 65, 75, 85]);
    expect(normaliseCuts([])).toEqual(DEFAULTS.cuts);
    expect(normaliseCuts(['x', null])).toEqual(DEFAULTS.cuts);
  });

  test('null and empty string do not coerce to a cut at 0', () => {
    // Number(null) === 0 and Number('') === 0, both finite. Unguarded, a config of [null] becomes a
    // single cut at 0, band 1 becomes unreachable, and every physician silently lands a band high.
    expect(normaliseCuts([null])).toEqual(DEFAULTS.cuts);
    expect(normaliseCuts([''])).toEqual(DEFAULTS.cuts);
    expect(normaliseCuts([null, 60])).toEqual([60]);
  });

  test('cuts outside 0-100 are dropped — a composite cannot reach them', () => {
    expect(normaliseCuts([-10, 50, 150])).toEqual([50]);
  });

  test('duplicate cuts collapse instead of creating an empty band', () => {
    expect(normaliseCuts([50, 50, 65])).toEqual([50, 65]);
  });
});

describe('creditTable — the physician preview', () => {
  test('covers 0-100 with no gap between bands', () => {
    const t = creditTable();
    expect(t).toHaveLength(5);
    expect(t[0].min).toBe(0);
    expect(t[4].max).toBe(100);
    for (let i = 1; i < t.length; i++) expect(t[i].min).toBe(t[i - 1].max);
  });

  test('every band carries a Thai label — the physician surface is Thai-primary', () => {
    for (const b of creditTable()) {
      expect(typeof b.band_label.th).toBe('string');
      expect(b.band_label.th.length).toBeGreaterThan(0);
    }
  });
});

test('a non-numeric composite is null, not NaN credits', () => {
  expect(creditFor(undefined)).toBeNull();
  expect(creditFor('n/a')).toBeNull();
});
