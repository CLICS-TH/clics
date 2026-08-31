// Stratified audit sampling — the draw itself, before any database is involved.
//
// What was there before: manual one-at-a-time assignment, i.e. a convenience sample. The ICC is
// estimated on whatever got audited, so a subset drawn from the middle of the score distribution
// understates disagreement at the extremes — where a credit decision is most contested.
const {
  mulberry32, seedFrom, bandPool, allocate, stratifiedSample, auditorEligibility, assignRoundRobin,
} = require('../src/services/audit-sampling');

const pool = (n, scoreFn = (i) => (i * 7) % 100) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, score: scoreFn(i) }));

describe('reproducibility — the whole point', () => {
  test('the same seed draws the same PLEs', () => {
    const a = stratifiedSample(pool(47), { target: 20, seed: 'round-1' });
    const b = stratifiedSample(pool(47), { target: 20, seed: 'round-1' });
    expect(a.selected.map(x => x.id)).toEqual(b.selected.map(x => x.id));
  });

  test('a different seed draws a different sample', () => {
    const a = stratifiedSample(pool(47), { target: 20, seed: 'round-1' });
    const b = stratifiedSample(pool(47), { target: 20, seed: 'round-2' });
    expect(a.selected.map(x => x.id)).not.toEqual(b.selected.map(x => x.id));
  });

  test('a text seed and its hash are the same draw — the log can carry the readable one', () => {
    const label = stratifiedSample(pool(47), { target: 20, seed: '2026-10-round-1' });
    const int = stratifiedSample(pool(47), { target: 20, seed: seedFrom('2026-10-round-1') });
    expect(int.selected.map(x => x.id)).toEqual(label.selected.map(x => x.id));
  });

  test('the PRNG is stable, not Math.random() — a fixed seed gives fixed numbers', () => {
    const r = mulberry32(12345);
    const first = [r(), r(), r()];
    const again = mulberry32(12345);
    expect([again(), again(), again()]).toEqual(first);
    expect(first.every(x => x >= 0 && x < 1)).toBe(true);
  });
});

describe('bands are quantiles, not equal score widths', () => {
  // PIS-7 composites cluster in the middle. Equal-width bands would leave the tails nearly empty and
  // the sample would drift back toward the middle — the bias stratification exists to remove.
  const clustered = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, score: 60 + (i % 5) })),
    { id: 'lo1', score: 10 }, { id: 'lo2', score: 12 },
    { id: 'hi1', score: 97 }, { id: 'hi2', score: 99 },
  ];

  test('every band gets a comparable share even on a clustered distribution', () => {
    const { boundaries } = bandPool(clustered, 5);
    expect(boundaries).toHaveLength(5);
    for (const b of boundaries) expect(b.available).toBeGreaterThan(0);
  });

  test('EVERY band is represented — the sparse tail is not allocated zero', () => {
    // This is the regression that motivated the 'equal' default. Under proportional allocation the
    // bottom band (2 of 44 PLEs) got 10 x 2/44 = 0.45 -> floor 0: a sample containing no low-scoring
    // PLE at all, still described as stratified.
    const r = stratifiedSample(clustered, { target: 10, seed: 's' });
    for (const b of r.per_band) expect(b.sampled).toBeGreaterThan(0);
    expect(Math.min(...r.selected.map(x => x.score))).toBeLessThan(30);
  });

  test('equal allocation over-samples the sparse band on purpose; proportional does not', () => {
    const equal = stratifiedSample(clustered, { target: 10, seed: 's', allocation: 'equal' });
    const prop = stratifiedSample(clustered, { target: 10, seed: 's', allocation: 'proportional' });
    expect(equal.per_band[0].sampled).toBe(2);   // the whole sparse band
    expect(prop.per_band[0].sampled).toBe(0);    // proportional to its 2/44 share
    // Both are legitimate designs; which one ran is recorded on the result.
    expect(equal.allocation).toBe('equal');
    expect(prop.allocation).toBe('proportional');
  });

  test('boundaries are reported, so a sample can be explained after the fact', () => {
    const r = stratifiedSample(pool(47), { target: 20, seed: 's' });
    expect(r.per_band).toHaveLength(5);
    for (const b of r.per_band) {
      expect(b).toHaveProperty('min');
      expect(b).toHaveProperty('max');
      expect(b).toHaveProperty('available');
      expect(b).toHaveProperty('sampled');
    }
  });
});

describe('allocation is proportional AND exact', () => {
  test('quotas sum to the target — naive rounding would drift', () => {
    expect(allocate([9, 9, 9, 9, 9], 20).reduce((a, b) => a + b, 0)).toBe(20);
    expect(allocate([7, 13, 4, 21, 9], 33).reduce((a, b) => a + b, 0)).toBe(33);
  });

  test('a band that cannot fill its quota gives the places back, it does not shrink the sample', () => {
    const q = allocate([2, 10, 10, 10, 10], 40);
    expect(q[0]).toBe(2);                          // capped at what it holds
    expect(q.reduce((a, b) => a + b, 0)).toBe(40); // and the total still lands
  });

  test('proportional mode still sums exactly too', () => {
    expect(allocate([2, 10, 10, 10, 10], 20, 'proportional').reduce((a, b) => a + b, 0)).toBe(20);
    expect(allocate([7, 13, 4, 21, 9], 33, 'proportional').reduce((a, b) => a + b, 0)).toBe(33);
  });

  test('asking for more than exists returns everything and SAYS so', () => {
    const r = stratifiedSample(pool(12), { target: 100, seed: 's' });
    expect(r.selected).toHaveLength(12);
    expect(r.requested).toBe(100);
    expect(r.shortfall).toBe(88);   // stated, so 12 cannot be mistaken for a 100-case sample
  });

  test('no PLE is drawn twice', () => {
    const r = stratifiedSample(pool(47), { target: 40, seed: 's' });
    expect(new Set(r.selected.map(x => x.id)).size).toBe(r.selected.length);
  });
});

describe('integrity-flagged PLEs are force-included', () => {
  const withFlags = [
    ...pool(30),
    { id: 'flag1', score: 61, forced: true },
    { id: 'flag2', score: 62, forced: true },
  ];

  test('a flagged PLE is always selected regardless of its band', () => {
    const ids = stratifiedSample(withFlags, { target: 5, seed: 's' }).selected.map(x => x.id);
    expect(ids).toContain('flag1');
    expect(ids).toContain('flag2');
  });

  test('a forced PLE does NOT eat a random slot — the random part keeps its size', () => {
    const r = stratifiedSample(withFlags, { target: 5, seed: 's' });
    expect(r.forced_included).toBe(2);
    expect(r.selected).toHaveLength(7);   // 5 drawn + 2 forced, not 5 total
  });
});

describe('auditorEligibility — one rule set, shared with the manual /assign path', () => {
  const ple = { id: 'p1', physician_id: 'doc1', council_id: 'co1', specialty_id: 'sp1' };
  const ok = { id: 'aud1', role: 'auditor', status: 'active', council_id: 'co1', specialty_id: 'sp1' };

  test.each([
    ['an active auditor in the same council + specialty', ok, true, null],
    ['a can_audit physician', { ...ok, id: 'aud2', role: 'physician', can_audit: true }, true, null],
    ['a plain physician', { ...ok, role: 'physician', can_audit: false }, false, 'not_an_active_auditor'],
    ['a suspended auditor', { ...ok, status: 'suspended' }, false, 'not_an_active_auditor'],
    ['the physician who ran the session', { ...ok, id: 'doc1' }, false, 'own_session'],
    ['another council', { ...ok, council_id: 'co2' }, false, 'cross_council'],
    ['another specialty', { ...ok, specialty_id: 'sp2' }, false, 'cross_specialty'],
  ])('%s', (_label, auditor, expected, reason) => {
    const r = auditorEligibility(auditor, ple);
    expect(r.ok).toBe(expected);
    if (reason) expect(r.reason).toBe(reason);
  });

  test('a PLE with no specialty still assigns (pre-migration sessions)', () => {
    expect(auditorEligibility({ ...ok, specialty_id: 'sp9' }, { ...ple, specialty_id: null }).ok).toBe(true);
  });
});

describe('round-robin assignment', () => {
  const auditors = ['a1', 'a2', 'a3'].map(id => ({ id, role: 'auditor', status: 'active', council_id: 'co1', specialty_id: 'sp1' }));
  const ples = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, physician_id: 'doc1', council_id: 'co1', specialty_id: 'sp1' }));

  test('load is spread evenly at 1 auditor per PLE', () => {
    const { assignments, load } = assignRoundRobin(ples, auditors, { perPle: 1, seed: 7 });
    expect(assignments).toHaveLength(9);
    expect(Object.values(load).sort()).toEqual([3, 3, 3]);
  });

  test('3 auditors per PLE gives every PLE all three, still evenly', () => {
    const { assignments, load, unassignable } = assignRoundRobin(ples, auditors, { perPle: 3, seed: 7 });
    expect(assignments).toHaveLength(27);
    expect(Object.values(load).sort()).toEqual([9, 9, 9]);
    expect(unassignable).toHaveLength(0);
  });

  test('an auditor is never assigned their own session', () => {
    const own = [{ id: 'x1', physician_id: 'a1', council_id: 'co1', specialty_id: 'sp1' }];
    const { assignments } = assignRoundRobin(own, auditors, { perPle: 3, seed: 7 });
    expect(assignments.map(a => a.auditor_id)).not.toContain('a1');
    expect(assignments).toHaveLength(2);
  });

  test('no eligible auditor is REPORTED, not silently skipped', () => {
    // The live gap: 3 auditors cover 3 of 19 physician specialties.
    const orphan = [{ id: 'x1', physician_id: 'doc1', council_id: 'co1', specialty_id: 'sp-unstaffed' }];
    const { assignments, unassignable } = assignRoundRobin(orphan, auditors, { perPle: 1, seed: 7 });
    expect(assignments).toHaveLength(0);
    expect(unassignable).toEqual([{ ple_id: 'x1', reason: 'no_eligible_auditor' }]);
  });

  test('too few eligible auditors for the target is reported with the shortfall', () => {
    const { unassignable } = assignRoundRobin(ples.slice(0, 1), auditors.slice(0, 2), { perPle: 3, seed: 7 });
    expect(unassignable[0]).toMatchObject({ reason: 'fewer_eligible_auditors_than_target', got: 2, wanted: 3 });
  });

  test('the roster start is seeded, so the first auditor is not loaded on every run', () => {
    const first = (seed) => assignRoundRobin(ples.slice(0, 1), auditors, { perPle: 1, seed }).assignments[0].auditor_id;
    const picks = new Set([first(1), first(2), first(3), first(4), first(5), first(6)]);
    expect(picks.size).toBeGreaterThan(1);
  });
});
