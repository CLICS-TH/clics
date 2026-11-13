import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdicts, summaryMarkdown, bandFor, gapFor, normalQuantile, SIGMA } from './sandbox-verdict.mjs';

const GROUPS = ['best', 'mixed', 'weakest', 'strong', 'average', 'weak'];
const RUNS = Object.fromEntries(GROUPS.map((g) => [g, 3]));
const BASE = { best: 48, mixed: 45, weakest: 35, strong: 47, average: 47, weak: 44 };
/** A case whose every group scores BASE + shift on each of its 3 runs, with any group overridden by a list. */
const kase = (shift = 0, over = {}) => ({
  ...Object.fromEntries(GROUPS.map((g) => [g, [BASE[g] + shift, BASE[g] + shift, BASE[g] + shift]])),
  ...over,
});
const pool = (n, extra = {}) => ({ ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, kase(i % 3 - 1)])), ...extra });
const judge = (table, opts = {}) => verdicts(table, GROUPS, { runs: RUNS, ...opts });

test('the normal quantile is the textbook one', () => {
  assert.equal(normalQuantile(0.975).toFixed(3), '1.960');
  assert.equal(normalQuantile(0.95).toFixed(3), '1.645');
});

test('the band and the gap come from the measured noise: 3 runs over 11 cases give 8.0 for a path, 11.3 for a persona and a 6.6 gap', () => {
  assert.equal(bandFor('best', 3, 11, 6).toFixed(1), '8.0');
  assert.equal(bandFor('weak', 3, 11, 6).toFixed(1), '11.3');
  assert.equal(gapFor(3, 3).toFixed(1), '6.6');
  // One play per path, the old design, has a noise band of 13.85: wider than the ±10 that was asked of it.
  assert.equal(bandFor('best', 1, 11, 6).toFixed(2), '13.85');
  assert.ok(Math.abs(bandFor('best', 12, 11, 6) * 2 - bandFor('best', 3, 11, 6)) < 1e-9, 'four times the runs halves the band');
  assert.ok(bandFor('best', 3, 3, 6) > bandFor('best', 3, 11, 6), 'a smaller pool has a less certain median');
  assert.equal(SIGMA.path, 4.91);
  assert.equal(SIGMA.persona, 6.92);
});

test('a pool of matched cases whose paths separate all pass', () => {
  const v = judge(pool(11));
  assert.ok(Object.values(v.cases).every((c) => c.pass));
  assert.equal(v.medians.best, 48);
  assert.equal(v.bands.best, 8);
  assert.equal(v.gap_min, 6.59);
});

test('a group mean exactly at its band passes and just beyond it fails, either side', () => {
  const at = (delta) => judge(pool(11, { x: kase(0, { strong: [47 + delta, 47 + delta, 47 + delta] }) })).cases.x.pass;
  const band = bandFor('strong', 3, 12, 6);
  assert.equal(at(Math.floor(band * 100) / 100), true);
  assert.equal(at(-Math.floor(band * 100) / 100), true);
  assert.equal(at(band + 0.01), false);
  assert.equal(at(-band - 0.01), false);
});

test('each group is held to its own median, and the reason names the band', () => {
  const v = judge(pool(11, { x: kase(0, { best: [62, 62, 62] }) }));
  assert.equal(v.cases.x.pass, false);
  assert.deepEqual(v.cases.x.reasons, ['best mean 62 is 14 from the pool median 48, beyond ±7.95']);
});

test('best must beat weakest by more than the noise: just under the gap fails, at it passes', () => {
  const gap = gapFor(3, 3);
  const withGap = (g) => judge(pool(11, { x: kase(0, { best: [46, 46, 46], weakest: [46 - g, 46 - g, 46 - g] }) })).cases.x;
  assert.equal(withGap(Math.ceil(gap * 100) / 100).pass, true);
  const flat = withGap(gap - 0.01);
  assert.equal(flat.pass, false);
  assert.match(flat.reasons.at(-1), /^best is only 6\.58 above weakest, under 6\.59$/);
});

test('an unscored play fails its own case only, and its group stays out of the pool', () => {
  const v = judge(pool(4, { x: kase(0, { strong: [47, 47] }) }));
  assert.equal(v.cases.x.pass, false);
  assert.deepEqual(v.cases.x.reasons, ['strong: 2 of 3 plays scored']);
  assert.deepEqual(Object.entries(v.cases).filter(([id]) => id !== 'x').map(([, c]) => c.pass), [true, true, true, true]);
  assert.equal(v.pool_n.strong, 4);
  assert.equal(v.pool_n.best, 5);
});

test('the pool counts only complete cases: a scored with b and c empty does not pass on its own median', () => {
  const empty = Object.fromEntries(GROUPS.map((g) => [g, []]));
  const v = judge({ a: kase(), b: empty, c: empty });
  assert.equal(v.cases.a.pass, false);
  assert.equal(v.pool_n.best, 1);
  assert.equal(v.bands.best, null);
  assert.match(v.cases.a.reasons[0], /^no pool: best pooled from 1 case/);
});

test('a run cut short by the cap passes no case, even a matched pool', () => {
  const v = judge(pool(11), { incomplete: '120 of 198 plays scored, stopped at the cap' });
  assert.ok(Object.values(v.cases).every((c) => !c.pass));
  assert.equal(v.cases.k0.reasons[0], 'incomplete run: 120 of 198 plays scored, stopped at the cap');
});

test('a rerun of a few cases is judged against an earlier pool and sized by that pool\'s case count', () => {
  const earlier = judge(pool(11));
  assert.equal(judge({ x: kase(2) }, { pool: earlier }).cases.x.pass, true);
  const far = judge({ x: kase(20) }, { pool: earlier });
  assert.equal(far.cases.x.pass, false);
  assert.equal(far.pool_from, 'earlier run');
  assert.equal(far.bands.best, earlier.bands.best);
  assert.equal(judge({ x: kase() }, { pool: judge({ x: kase() }) }).cases.x.pass, false);
});

test('a scripted-only run is judged on the scripted groups alone', () => {
  const scripted = ['best', 'mixed', 'weakest'];
  const only = (s) => ({ best: [48 + s, 48 + s, 48 + s], mixed: [45 + s, 45 + s, 45 + s], weakest: [35 + s, 35 + s, 35 + s] });
  const v = verdicts({ a: only(0), b: only(2), c: only(-2) }, scripted, { runs: { best: 3, mixed: 3, weakest: 3 } });
  assert.deepEqual(Object.values(v.cases).map((c) => c.pass), [true, true, true]);
});

test('one value per group judged as the mean of 3 plays is complete and gets the 3-play gap; left to runs, it gets the 1-play gap', () => {
  const scripted = ['best', 'mixed', 'weakest'];
  const each = (n) => ({ best: n, mixed: n, weakest: n });
  const one = (s) => ({ best: [45 + s], mixed: [42 + s], weakest: [35 + s] });
  const table = { a: one(0), b: one(2), c: one(-2) };
  const asThree = verdicts(table, scripted, { runs: each(1), averaged: each(3) });
  assert.deepEqual(Object.values(asThree.cases).map((c) => c.pass), [true, true, true]);
  assert.equal(asThree.gap_min, 6.59);
  // 1.645 × 4.91 × √2 = 11.42, over the 10 that best beats weakest by.
  const asOne = verdicts(table, scripted, { runs: each(1) });
  assert.equal(asOne.gap_min, 11.42);
  assert.deepEqual(asOne.cases.a.reasons, ['best is only 10 above weakest, under 11.42']);
});

test('the summary shows each case, the pool medians, the bands and why a failing case failed', () => {
  const table = pool(3, { x: kase(0, { best: [70, 70, 70] }) });
  const verdict = judge(table);
  const md = summaryMarkdown({
    run_id: 'sbx-1', date: '2026-11-03', scored: 72, planned: 72, spent_usd: 2.5, cap_usd: 30, stopped: false,
    providers: ['anthropic'], persona_model: 'claude-x', path_runs: 3, persona_runs: 3,
    cases: Object.fromEntries(Object.keys(table).map((id) => [id, { version: '1', unscored: 0, fallbacks: id === 'x' ? 2 : 0 }])),
    verdict,
  }, GROUPS);
  assert.match(md, /^# Booth physician sandbox, run sbx-1$/m);
  assert.match(md, /Each scripted path plays 3 times and each persona 3 times/);
  assert.match(md, /\| k1 \| 1 \| 48 ± 0 \| 45 ± 0 \| 35 ± 0 \| 47 ± 0 \| 47 ± 0 \| 44 ± 0 \| 13 \| 0 \| 0 \| pass \|/);
  assert.match(md, /\| x \| 1 \| 70 ± 0 \| .* \| 0 \| 2 \| FAIL \|/);
  assert.match(md, /\| pool median \(cases\) \| \| 48\.5 \(4\) \|/);
  assert.match(md, new RegExp(`\\| band \\(±\\) \\| \\| ${verdict.bands.best} \\| .* \\| ${verdict.gap_min} \\| \\| \\| \\|`));
  assert.match(md, /- x: best mean 70 is 21\.5 from the pool median 48\.5, beyond ±/);
});
