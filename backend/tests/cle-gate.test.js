const { computeTier1, compositeScore } = require('../src/services/cle-gate');

describe('computeTier1', () => {
  test('passes when all criteria met', () => {
    const result = computeTier1({ duration_seconds: 960, turn_count: 5, token_count: 900 });
    expect(result).toEqual({ c1: true, c2: true, c3: true });
  });

  test('fails c1 when duration < 900s', () => {
    expect(computeTier1({ duration_seconds: 800, turn_count: 5, token_count: 900 }).c1).toBe(false);
  });

  test('fails c2 when turn_count < 4', () => {
    expect(computeTier1({ duration_seconds: 960, turn_count: 3, token_count: 900 }).c2).toBe(false);
  });

  test('fails c3 when token_count < 800', () => {
    expect(computeTier1({ duration_seconds: 960, turn_count: 5, token_count: 700 }).c3).toBe(false);
  });

  test('handles missing fields as 0', () => {
    expect(computeTier1({})).toEqual({ c1: false, c2: false, c3: false });
  });
});

describe('compositeScore', () => {
  test('all 5s gives 100', () => {
    const scores = { d1: 5, d2: 5, d3: 5, d4: 5, d5: 5, d6: 5, d7: 5 };
    expect(compositeScore(scores)).toBeCloseTo(100, 1);
  });

  test('all zeros gives 0', () => {
    expect(compositeScore({ d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0 })).toBe(0);
  });

  test('d1=4(15%) + d2=3(20%) = 24', () => {
    // (4*0.15 + 3*0.20) * 20 = (0.60 + 0.60) * 20 = 24
    expect(compositeScore({ d1: 4, d2: 3, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0 })).toBeCloseTo(24, 1);
  });
});
