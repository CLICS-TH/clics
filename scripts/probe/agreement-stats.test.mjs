// Tests for the probes' shared agreement statistics.
//
// They pin the two things the probes had wrong: WHICH composite, and WHICH estimator. Until 2026-10,
// model-agreement.mjs and e2-compare.mjs reported agreement on an unweighted d1..d7 sum through their
// own ICC(A,1), so one run read 0.726 there and 0.735 in the verdict tool, and repeat-consistency.mjs
// showed a third composite scale. Every expectation below holds ONLY for production's weighted
// composite and production's estimator: revert to a sum, swap a weight, or slip a private ICC back in,
// and a test here goes red. Run with:
//   node --test scripts/probe/*.test.mjs
// It must also pass with no node_modules anywhere, because CI's probe job never runs npm install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  compositeAgreement, domainAgreement, compositeSpread, compositeOf, iccTwoRater, DOMAINS,
} from './agreement-stats.mjs';

const require = createRequire(import.meta.url);
// Loaded here directly, so "equal to production" is checked against production itself rather than
// against whatever the module under test chooses to export.
const production = {
  compositeOf: require('../../rimpl/src/lib/composite.js').compositeOf,
  iccTwoRater: require('../../backend/src/services/icc.js').iccTwoRater,
};

// 20 × each published weight (rimpl/src/lib/versions.js: d2 0.20, d6 and d7 0.10, the rest 0.15): the
// composite points one step in that domain is worth. PINNED, not read from versions.js, so a changed
// weight fails here instead of being followed. A real rubric change bumps RUBRIC_VERSION and updates
// this line in the same commit, with its mirrors in backend ple-gate.js and audit-dashboard lib/labels.ts.
const STEP = { d1: 3, d2: 4, d3: 3, d4: 3, d5: 3, d6: 2, d7: 2 };
const oracle = (s) => DOMAINS.reduce((a, d) => a + STEP[d] * s[d], 0);
const unweighted = (s) => DOMAINS.reduce((a, d) => a + s[d], 0);

const S = (...v) => Object.fromEntries(DOMAINS.map((d, i) => [d, v[i]]));
const all = (v) => S(v, v, v, v, v, v, v);
const nans = (v, at = '$') => (typeof v === 'number' && Number.isNaN(v) ? [at]
  : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => nans(x, `${at}.${k}`)) : []);

// Six paired rows with real spread. The local arm leans on d2 and the cloud arm on d6/d7, which is
// exactly where weighting and summing part ways: on these rows the two scales give different ICCs AND
// different intervals, so an equality check against the weighted figure cannot pass after a revert.
const ROWS = [
  { id: 'a', local: S(4, 5, 4, 4, 3, 2, 2), cloud: S(4, 3, 4, 4, 3, 4, 4) },
  { id: 'b', local: S(2, 3, 2, 2, 2, 1, 1), cloud: S(2, 2, 2, 2, 2, 3, 2) },
  { id: 'c', local: S(5, 5, 4, 5, 4, 3, 3), cloud: S(5, 4, 5, 4, 4, 4, 5) },
  { id: 'd', local: S(3, 4, 3, 3, 3, 1, 2), cloud: S(3, 2, 3, 3, 3, 3, 3) },
  { id: 'e', local: S(1, 2, 1, 2, 1, 1, 1), cloud: S(2, 1, 1, 1, 2, 2, 2) },
  { id: 'f', local: S(4, 4, 3, 3, 4, 2, 2), cloud: S(3, 3, 3, 4, 4, 3, 4) },
];

test('the shared functions ARE production\'s, not look-alikes', () => {
  assert.equal(compositeOf, production.compositeOf, 'compositeOf must be rimpl/src/lib/composite.js');
  assert.equal(iccTwoRater, production.iccTwoRater, 'iccTwoRater must be backend/src/services/icc.js');
});

test('all 5s is 100 and all 0s is 0: the weighted ×20 scale, not the 0–35 sum', () => {
  assert.equal(compositeOf(all(5)), 100);
  assert.equal(compositeOf(all(0)), 0, 'a 0 is a legal rubric score, so the floor is 0, not 20');
  const r = compositeAgreement([{ id: 'top', local: all(5), cloud: all(5) }]);
  assert.deepEqual(r.composites, [{ id: 'top', local: 100, cloud: 100, delta: 0 }]);
});

test('one step in d2 moves the composite by exactly 4 (0.20 × 20) on every surface', () => {
  const base = all(3);
  const bumped = { ...base, d2: 4 };
  assert.equal(compositeOf(bumped) - compositeOf(base), 4);
  assert.equal(compositeAgreement([{ local: bumped, cloud: base }]).bias, 4, 'an unweighted sum gives 1');
  assert.equal(compositeSpread([base, bumped]).range, 4, 'an unweighted sum gives 1');
});

test('each domain\'s step matches its published weight — a swapped weight fails here', () => {
  for (const d of DOMAINS) {
    assert.equal(compositeOf({ ...all(3), [d]: 4 }) - compositeOf(all(3)), STEP[d], `${d} step`);
  }
  // And on every one of the 6^7 possible score sets, not only the ones a test happened to pick.
  let checked = 0;
  const s = {};
  (function walk(i) {
    if (i === DOMAINS.length) { checked++; assert.equal(compositeOf(s), oracle(s)); return; }
    for (let v = 0; v <= 5; v++) { s[DOMAINS[i]] = v; walk(i + 1); }
  })(0);
  assert.equal(checked, 6 ** 7);
});

test('weighted and unweighted rank these two score sets oppositely; the WEIGHTED order is reported', () => {
  // X carries its strength in d2 (0.20), Y in d6/d7 (0.10 each).
  const X = S(3, 5, 3, 3, 3, 1, 1);
  const Y = S(3, 1, 3, 3, 3, 4, 5);
  assert.ok(unweighted(X) < unweighted(Y), 'fixture check: summed, Y is the higher (19 < 22)');

  const ranked = compositeAgreement([{ id: 'x', local: X, cloud: X }, { id: 'y', local: Y, cloud: Y }]);
  assert.deepEqual(ranked.composites.map((c) => [c.id, c.local]), [['x', 60], ['y', 58]]);
  assert.ok(ranked.composites[0].local > ranked.composites[1].local, 'weighted, X is the higher');

  // The same split flips the SIGN of the bias: local scored X and cloud scored Y on one transcript.
  // Weighted, local sits 2 points above cloud; summed, it would read 3 below.
  const flipped = compositeAgreement([{ local: X, cloud: Y }]);
  assert.equal(flipped.bias, 2);
});

test('the composite ICC is iccTwoRater on the same composites — estimate AND interval', () => {
  const r = compositeAgreement(ROWS);
  const pairs = ROWS.map((row) => ({ a: oracle(row.local), b: oracle(row.cloud) }));
  assert.deepEqual(r.composites.map((c) => [c.id, c.local, c.cloud]), ROWS.map((row, i) => [row.id, pairs[i].a, pairs[i].b]));

  const expected = production.iccTwoRater(pairs);
  assert.ok(Number.isFinite(expected.lower) && Number.isFinite(expected.upper), 'fixture check: a real interval exists');
  // deepEqual, not a tolerance: a private ICC(A,1) — unrounded, unclamped, without an interval or with
  // the old Fisher-z one — cannot produce this object.
  assert.deepEqual(r.icc, expected);
  assert.equal(r.n, 6);

  // Fixture check: the unweighted sum gives a different result, so this test really does catch a revert.
  const summed = production.iccTwoRater(ROWS.map((row) => ({ a: unweighted(row.local), b: unweighted(row.cloud) })));
  assert.notDeepEqual(summed, expected);
});

test('bias and Bland–Altman limits are on the weighted composite', () => {
  const r = compositeAgreement(ROWS);
  const deltas = ROWS.map((row) => oracle(row.local) - oracle(row.cloud));
  const bias = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const sd = Math.sqrt(deltas.reduce((a, v) => a + (v - bias) ** 2, 0) / (deltas.length - 1));
  assert.equal(r.bias, bias);
  assert.equal(r.bias_sd, sd);
  assert.deepEqual(r.limits, { lower: bias - 1.96 * sd, upper: bias + 1.96 * sd });
  assert.equal(r.local_mean, ROWS.reduce((a, row) => a + oracle(row.local), 0) / ROWS.length);
});

test('per-domain ICC is iccTwoRater on that domain\'s scores; the counts are exact', () => {
  const per = domainAgreement(ROWS);
  assert.deepEqual(Object.keys(per), DOMAINS);
  for (const d of DOMAINS) {
    assert.deepEqual(per[d].icc, production.iccTwoRater(ROWS.map((row) => ({ a: row.local[d], b: row.cloud[d] }))), d);
  }
  // d2 deltas, local − cloud: 2, 1, 1, 2, 1, 1.
  assert.equal(per.d2.mean_delta, 8 / 6);
  assert.equal(per.d2.mean_abs_delta, 8 / 6);
  assert.equal(per.d2.exact, 0);
  assert.equal(per.d2.within_1, 4);
  assert.equal(per.d2.local_mean, 23 / 6);
  assert.equal(per.d2.cloud_mean, 15 / 6);
  assert.equal(per.d2.n, 6);
});

test('compositeSpread is the weighted composite of each repeat, with its range and SD', () => {
  const runs = [S(3, 3, 3, 3, 3, 3, 3), S(3, 4, 3, 3, 3, 3, 3), S(3, 3, 3, 3, 3, 2, 3)];
  const r = compositeSpread(runs);
  assert.deepEqual(r.composites, [60, 64, 58]);
  assert.equal(r.range, 6, 'an unweighted sum gives 2');
  assert.equal(r.sd, Math.sqrt(((60 - 182 / 3) ** 2 + (64 - 182 / 3) ** 2 + (58 - 182 / 3) ** 2) / 2));
});

test('n = 0: every statistic is null or zero, never NaN', () => {
  for (const input of [[], undefined, null]) {
    const c = compositeAgreement(input);
    assert.deepEqual([c.n, c.n_excluded, c.composites, c.local_mean, c.cloud_mean, c.bias, c.bias_sd, c.limits, c.icc],
      [0, 0, [], null, null, null, null, null, null]);
    const s = compositeSpread(input);
    assert.deepEqual([s.n, s.composites, s.range, s.sd], [0, [], null, null]);
    const per = domainAgreement(input);
    for (const d of DOMAINS) {
      assert.deepEqual(per[d], { n: 0, n_excluded: 0, local_mean: null, cloud_mean: null, mean_delta: null,
        mean_abs_delta: null, exact: 0, within_1: 0, icc: null });
    }
    assert.deepEqual(nans({ c, s, per }), []);
  }
});

test('n = 1: a bias exists, but no spread, no limits and no ICC', () => {
  const c = compositeAgreement([{ id: 'only', local: S(4, 4, 4, 4, 4, 4, 4), cloud: all(3) }]);
  assert.equal(c.n, 1);
  assert.equal(c.bias, 20);
  assert.deepEqual([c.bias_sd, c.limits, c.icc], [null, null, null]);
  const s = compositeSpread([all(4)]);
  assert.deepEqual([s.n, s.composites, s.range, s.sd], [1, [80], null, null],
    'one run has no spread by construction; 0 would read as "no noise"');
  assert.equal(domainAgreement([{ local: all(4), cloud: all(3) }]).d1.icc, null);
});

test('identical scores: no variance reads "insufficient", never a fabricated agreement figure', () => {
  const rows = [1, 2, 3].map((i) => ({ id: `same-${i}`, local: all(3), cloud: all(3) }));
  const c = compositeAgreement(rows);
  assert.deepEqual(c.icc, { icc: null, lower: null, upper: null, n: 3, interpretation: 'Insufficient variance (identical scores)' });
  assert.deepEqual(c.icc, production.iccTwoRater(rows.map(() => ({ a: 60, b: 60 }))));
  assert.deepEqual([c.bias, c.bias_sd, c.limits], [0, 0, { lower: 0, upper: 0 }]);
  assert.equal(domainAgreement(rows).d4.icc.icc, null);
  const s = compositeSpread([all(3), all(3), all(3)]);
  assert.deepEqual([s.range, s.sd], [0, 0]);
  assert.deepEqual(nans({ c, s, d: domainAgreement(rows) }), []);
});

test('a row missing an arm or a domain is excluded AND counted, never silently dropped', () => {
  const rows = [
    ...ROWS,
    { id: 'no-local', local: null, cloud: all(3) },
    { id: 'no-d7', local: { ...all(3), d7: undefined }, cloud: all(3) },
    null,
  ];
  const c = compositeAgreement(rows);
  assert.deepEqual([c.n, c.n_excluded], [6, 3]);
  assert.deepEqual(c.icc, compositeAgreement(ROWS).icc, 'the excluded rows must not move the estimate');
  assert.deepEqual([domainAgreement(rows).d1.n, domainAgreement(rows).d1.n_excluded], [6, 3]);
  const s = compositeSpread([all(3), { ...all(3), d2: NaN }, all(4)]);
  assert.deepEqual([s.n, s.n_excluded, s.range], [2, 1, 20]);
});

test('loads without a single package — CI\'s probe job has no npm install', () => {
  // The CI job would fail on a missing package; this fails LOCALLY too, where rimpl/node_modules
  // exists and would otherwise satisfy a require('zod') that crept into composite.js or versions.js.
  // It walks the dependency closure of the two production modules (module.children), not the whole
  // require cache, so a preload in a developer's NODE_OPTIONS cannot trip it.
  const closure = (file, seen = new Set()) => {
    if (!seen.has(file)) {
      seen.add(file);
      for (const child of require.cache[file]?.children ?? []) closure(child.filename, seen);
    }
    return seen;
  };
  const roots = ['../../rimpl/src/lib/composite.js', '../../backend/src/services/icc.js'].map((p) => require.resolve(p));
  const deps = [...new Set(roots.flatMap((root) => [...closure(root)]))];
  assert.ok(deps.some((f) => f.endsWith(path.join('rimpl', 'src', 'lib', 'versions.js'))), 'the walk must see versions.js');
  assert.ok(deps.some((f) => f.endsWith(path.join('backend', 'src', 'services', 'f-dist.js'))), 'the walk must see f-dist.js');
  const fromPackages = deps.filter((f) => f.includes(`${path.sep}node_modules${path.sep}`));
  assert.deepEqual(fromPackages, [], 'the probe statistics must not load anything from node_modules');
});
