const { computeTier1, compositeScore, clampDuration } = require('../src/services/ple-gate');

describe('computeTier1', () => {
  test('passes when all criteria met', () => {
    const result = computeTier1({ duration_seconds: 700, turn_count: 5, token_count: 12000 });
    expect(result).toEqual({ c1: true, c2: true, c3: true });
  });

  test('fails c1 when duration < 600s', () => {
    expect(computeTier1({ duration_seconds: 500, turn_count: 5, token_count: 12000 }).c1).toBe(false);
  });

  test('fails c2 when turn_count < 4', () => {
    expect(computeTier1({ duration_seconds: 700, turn_count: 3, token_count: 12000 }).c2).toBe(false);
  });

  test('fails c3 when token_count < 10000', () => {
    expect(computeTier1({ duration_seconds: 700, turn_count: 5, token_count: 9000 }).c3).toBe(false);
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

  test('rounds away IEEE-754 float dust to 2dp', () => {
    // {d7:3} -> 3*0.10*20 = 6, but raw float is 6.000000000000001
    const v = compositeScore({ d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0, d7: 3 });
    expect(v).toBe(6);
    expect(Number.isInteger(v * 100)).toBe(true); // clean 2dp, no trailing dust
  });
});

describe('clampDuration (C1 anti-gaming)', () => {
  test('clamps an inflated client active_seconds to wall-clock', () => {
    expect(clampDuration(99999, 120)).toBe(120); // a seconds-long session can't claim 10+ min
  });
  test('keeps a legitimate active time below wall-clock', () => {
    expect(clampDuration(840, 1000)).toBe(840); // idle time excluded, under elapsed
  });
  test('falls back to wall-clock when the client reports nothing/garbage', () => {
    expect(clampDuration(undefined, 950)).toBe(950);
    expect(clampDuration('abc', 950)).toBe(950);
    expect(clampDuration(-5, 950)).toBe(950);
  });
  test('a clamped fake CANNOT pass C1 while wall-clock is under 600s', () => {
    const duration = clampDuration(100000, 300); // claimed 27h, actually 5 min
    expect(computeTier1({ duration_seconds: duration, turn_count: 9, token_count: 12000 }).c1).toBe(false);
  });
});
