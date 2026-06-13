const { computeICC21 } = require('../src/services/icc');

describe('computeICC21', () => {
  test('returns null for fewer than 2 pairs', () => {
    expect(computeICC21([{ ai: 80, human: 75 }])).toBeNull();
  });

  test('returns high ICC for near-identical ratings', () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({ ai: 70 + i, human: 70 + i + 1 }));
    const result = computeICC21(pairs);
    expect(result.icc).toBeGreaterThan(0.90);
    expect(result.n).toBe(10);
  });

  test('returns low ICC for random-like ratings', () => {
    const pairs = [
      { ai: 90, human: 40 }, { ai: 50, human: 85 }, { ai: 70, human: 30 },
      { ai: 40, human: 90 }, { ai: 60, human: 75 },
    ];
    expect(computeICC21(pairs).icc).toBeLessThan(0.5);
  });

  test('identical scores → null ICC with insufficient-variance note, NOT -0.999 Below target', () => {
    // Perfect AI–human agreement (common per-domain on 0-5 integers) used to report icc:-0.999
    // 'Below target' — exactly backwards. It must now read as a degenerate/insufficient-variance case.
    const result = computeICC21(Array.from({ length: 6 }, () => ({ ai: 80, human: 80 })));
    expect(result.icc).toBeNull();
    expect(result.interpretation).toMatch(/insufficient variance/i);
    expect(result.n).toBe(6);
  });

  test('result has lower, upper, interpretation', () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({ ai: 60 + i * 1.5, human: 62 + i * 1.5 }));
    const result = computeICC21(pairs);
    expect(result).toHaveProperty('lower');
    expect(result).toHaveProperty('upper');
    expect(result).toHaveProperty('interpretation');
    expect(result.lower).toBeLessThanOrEqual(result.icc);
    expect(result.upper).toBeGreaterThanOrEqual(result.icc);
  });
});
