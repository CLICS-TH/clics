import test from 'node:test';
import assert from 'node:assert/strict';
import pleGate from '../../backend/src/services/ple-gate.js';
import { fractionalDesign, fitTable, mislabels, tierPaths } from './path-fit.mjs';

const { compositeScore } = pleGate;
const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const SCRIPTED = ['BBBBB', 'BRWRR', 'WWWWW'];
const DESIGN = fractionalDesign(SCRIPTED);
const ALL = tierPaths(5);

function assertBalanced(design) {
  assert.equal(design.length, 27);
  assert.equal(new Set(design).size, 27, 'no path repeats');
  assert.ok(design.every((p) => /^[BRW]{5}$/.test(p)), 'every path is five tier letters');
  for (let s = 0; s < 5; s += 1) {
    for (const t of 'BRW') assert.equal(design.filter((p) => p[s] === t).length, 9, `tier ${t} at step ${s + 1}`);
  }
  for (let s = 0; s < 5; s += 1) {
    for (let q = s + 1; q < 5; q += 1) {
      for (const pair of ['BB', 'BR', 'BW', 'RB', 'RR', 'RW', 'WB', 'WR', 'WW']) {
        assert.equal(design.filter((p) => p[s] + p[q] === pair).length, 3, `tiers ${pair} at steps ${s + 1} and ${q + 1}`);
      }
    }
  }
}

test('the five-step design is 27 distinct paths holding every scripted path, with each tier 9 times at every step and each tier pair 3 times at every pair of steps', () => {
  assertBalanced(DESIGN);
  for (const p of SCRIPTED) assert.ok(DESIGN.includes(p), `holds ${p}`);
  assert.deepEqual(DESIGN, [...DESIGN].sort());
});

test('another mixed scripted path gets its own balanced design that holds it', () => {
  const design = fractionalDesign(['BBBBB', 'BRWBR', 'WWWWW']);
  assertBalanced(design);
  for (const p of ['BBBBB', 'BRWBR', 'WWWWW']) assert.ok(design.includes(p), `holds ${p}`);
});

test('a mixed path that gives one tier to 4 steps has no balanced design, and a second mixed path off the design is refused', () => {
  assert.throws(() => fractionalDesign(['BBBBB', 'BBBBR', 'WWWWW']), /no balanced design holds BBBBR/);
  assert.throws(() => fractionalDesign(['BBBBB', 'BRWRR', 'BRWBR']), /does not hold BRWBR/);
});

// A per-domain main-effects model: an intercept per domain, decimal step effects that differ by step and a little by
// domain, B the baseline.
const STEP_EFFECTS = [{ R: -0.3, W: -0.9 }, { R: -0.2, W: -0.5 }, { R: -0.4, W: -0.7 }, { R: -0.1, W: -0.3 }, { R: -0.25, W: -0.6 }];
const plantedModel = (stepEffects = STEP_EFFECTS, { skew = 0.05 } = {}) => Object.fromEntries(DOMAINS.map((d, i) => [d, {
  intercept: 4 + 0.05 * i,
  steps: stepEffects.map((e) => ({ B: 0, R: e.R, W: e.W - skew * i })),
}]));
const predict = ({ intercept, steps }, path) => [...path].reduce((acc, t, s) => acc + steps[s][t], intercept);

// Three samples per design path at model − a, model and model + a, with a varying by path and domain, so each path's
// median sits on the model.
const samplesOn = (model) => DESIGN.flatMap((path, pi) => [-1, 0, 1].map((sign) => ({
  path,
  domains: Object.fromEntries(DOMAINS.map((d, di) => [d, predict(model[d], path) + sign * (0.2 + 0.1 * ((pi + di) % 5))])),
})));

// The least-squares fit of the same main effects: on an orthogonal design with equal replication its prediction is
// ȳ + Σ_s (ȳ_{s,t_s} − ȳ), where ȳ_{s,t} is the mean of the samples with tier t at step s.
function leastSquares(samples, d) {
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const all = mean(samples.map((x) => x.domains[d]));
  const at = (s, t) => mean(samples.filter((x) => x.path[s] === t).map((x) => x.domains[d]));
  return (path) => [...path].reduce((acc, t, s) => acc + at(s, t) - all, all);
}

const largestMove = (before, after) => Math.max(...DOMAINS.flatMap((d) => ALL.map((p) => Math.abs(after(d, p) - before(d, p)))));

test('a 21-point outlier sample moves the median fit less than least squares, and the median fit still recovers every planted effect', () => {
  const model = plantedModel();
  const clean = samplesOn(model);
  const top = clean.findLastIndex((x) => x.path === 'BRWRR');
  const dirty = clean.map((x, i) => (i === top ? { path: x.path, domains: Object.fromEntries(DOMAINS.map((d) => [d, x.domains[d] + 1.05])) } : x));
  assert.equal(Math.round((compositeScore(dirty[top].domains) - compositeScore(clean[top].domains)) * 100) / 100, 21, 'the outlier is 21 composite points');

  const medianBefore = fitTable(clean).effects;
  const medianAfter = fitTable(dirty).effects;
  const median = largestMove((d, p) => predict(medianBefore[d], p), (d, p) => predict(medianAfter[d], p));
  const before = Object.fromEntries(DOMAINS.map((d) => [d, leastSquares(clean, d)]));
  const after = Object.fromEntries(DOMAINS.map((d) => [d, leastSquares(dirty, d)]));
  const ols = largestMove((d, p) => before[d](p), (d, p) => after[d](p));

  assert.ok(Math.abs(ols - (11 * 1.05) / 81) < 1e-9, `least squares moves by 11 × 1.05 / 81 at the outlier's path, moved ${ols}`);
  assert.ok(median < 1e-6, `the median fit does not move, moved ${median}`);
  assert.ok(median < ols);
  for (const d of DOMAINS) {
    assert.ok(Math.abs(medianAfter[d].intercept - model[d].intercept) < 0.1, `${d} intercept`);
    model[d].steps.forEach((e, s) => {
      for (const t of ['R', 'W']) {
        assert.ok(Math.abs(medianAfter[d].steps[s][t] - e[t]) < 0.1, `${d} step ${s + 1} ${t}: ${medianAfter[d].steps[s][t]} for ${e[t]}`);
      }
    });
  }
});

const every = (v) => Object.fromEntries(DOMAINS.map((d) => [d, v]));
const scored = (path, values) => values.map((v) => ({ path, domains: every(v) }));

test('of equally good median fits, the table takes the one closest to least squares', () => {
  // One step. Any B in [2, 4] fits B's {2, 4} equally well, while R {1, 2, 6} and W {1, 2, 3} must sit at their
  // medians, 2. Least squares has B 3, R 3 and W 2; the distance 2(b − 3)² + 3(2 − 3)² + 3(2 − 2)² is least at b = 3.
  const { paths } = fitTable([...scored('B', [2, 4]), ...scored('R', [1, 2, 6]), ...scored('W', [1, 2, 3])]);
  assert.deepEqual(paths, { B: every(3), R: every(2), W: every(2) });
});

test('when least squares lies outside the equally good fits, the table takes their nearest edge, on every path the tied effect moves', () => {
  // Two steps. One sample of 3 on each path without R at step 1 holds the intercept at 3 and every other effect at 0.
  // Step 1's R effect ρ makes RB, RR and RW 3 + ρ; their medians span 4–5, 4–8 and 4–6, so any ρ in [1, 2] is
  // optimal. Each has mean 6, so least squares has ρ = 3, and the distance 12(ρ − 3)² is least at ρ = 2. RR moves to 5
  // although its own mean, 6, lies inside its median span.
  const held = ['BB', 'BR', 'BW', 'WB', 'WR', 'WW'].flatMap((p) => scored(p, [3]));
  const { paths } = fitTable([...held, ...scored('RB', [3, 4, 5, 12]), ...scored('RR', [4, 4, 8, 8]), ...scored('RW', [0, 4, 6, 14])]);
  assert.deepEqual(paths, {
    BB: every(3), BR: every(3), BW: every(3), RB: every(5), RR: every(5), RW: every(5), WB: every(3), WR: every(3), WW: every(3),
  });
});

// mulberry32: a seeded uniform [0, 1).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffled = (xs, random) => xs.map((x) => [random(), x]).sort(([a], [b]) => a - b).map(([, x]) => x);

test('the same whole-number samples in any row order, with the domains in any key order, give the same table', () => {
  const random = seeded(381);
  const tally = (path, t) => [...path].filter((x) => x === t).length;
  const whole = (v) => Math.min(5, Math.max(0, Math.round(v)));
  const samples = DESIGN.flatMap((path) => [0, 1, 2].map(() => ({
    path,
    domains: Object.fromEntries(DOMAINS.map((d) => [d, whole(4.2 - 0.3 * tally(path, 'R') - 0.6 * tally(path, 'W') + 3 * (random() - 0.5))])),
  })));
  const table = fitTable(samples);
  for (let round = 0; round < 5; round += 1) {
    const keys = shuffled(DOMAINS, random);
    const reordered = shuffled(samples, random).map((x) => ({ path: x.path, domains: Object.fromEntries(keys.map((d) => [d, x.domains[d]])) }));
    assert.deepEqual(fitTable(reordered), table, `round ${round + 1}, domains ${keys.join(' ')}`);
  }
});

test('a tier never sampled at some step leaves its effect unfitted, and is refused', () => {
  const samples = samplesOn(plantedModel()).filter((x) => x.path[1] !== 'W');
  assert.throws(() => fitTable(samples), /no sample has W at step 2/);
});

test('paths that hold every tier at every step but tie two steps\' effects together are refused', () => {
  assert.throws(() => fitTable([...scored('BB', [3]), ...scored('RR', [2]), ...scored('WW', [1])]), /do not separate every step × tier effect/);
});

test('a step whose weaker answers score above its best is the one likely mislabel, by its composite effect', () => {
  const reversed = plantedModel(STEP_EFFECTS.map((e, s) => (s === 2 ? { R: 0.2, W: 0.4 } : e)), { skew: 0 });
  assert.deepEqual(mislabels(fitTable(samplesOn(reversed)).effects), [{ step: 3, weaker_minus_best: 8 }], 'W +0.4 on every domain is 20 × 0.4 composite points');
  assert.deepEqual(mislabels(fitTable(samplesOn(plantedModel())).effects), []);
});

test('a step whose weaker and best answers tie on the composite is not flagged, float dust and all', () => {
  // 3(−0.9) + 4(0.1) + 2(0.4) + 2(0.75) = 0 exactly; in floating point the weighted sum is about +2.8e-16.
  const tie = { d1: -0.9, d2: 0.1, d3: 0, d4: 0, d5: 0, d6: 0.4, d7: 0.75 };
  const effects = Object.fromEntries(DOMAINS.map((d) => [d, {
    intercept: 3, steps: Array.from({ length: 5 }, (_, s) => ({ B: 0, R: -0.1, W: s === 1 ? tie[d] : -0.5 })),
  }]));
  assert.deepEqual(mislabels(effects), []);
});
