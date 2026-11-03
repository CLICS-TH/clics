import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdicts, summaryMarkdown } from './sandbox-verdict.mjs';

const GROUPS = ['best', 'mixed', 'weakest', 'strong', 'average', 'weak'];
/** A case whose every group scores as given; one number per group is one play. */
const scored = (best, mixed, weakest, strong, average, weak) =>
  ({ best: [best], mixed: [mixed], weakest: [weakest], strong: [strong], average: [average], weak: [weak] });
const matched = (shift = 0) => scored(80 + shift, 65 + shift, 50 + shift, 75 + shift, 62 + shift, 50 + shift);

test('a pool of matched cases that separate good from bad all pass', () => {
  const v = verdicts({ a: matched(), b: matched(4), c: matched(-4) }, GROUPS);
  assert.deepEqual(Object.values(v.cases).map((c) => c.pass), [true, true, true]);
  assert.equal(v.medians.best, 80);
  assert.equal(v.cases.b.separation, 30);
});

test('each group is held to its own pool median, so a case easy on one group fails on that group alone', () => {
  const easy = { ...matched(), weak: [61] };
  const v = verdicts({ a: matched(), b: matched(), c: easy }, GROUPS);
  assert.equal(v.cases.c.pass, false);
  assert.deepEqual(v.cases.c.reasons, ['weak mean 61 is 11 from the pool median 50']);
  assert.equal(v.cases.a.pass, true);
});

test('a mean exactly 10 from the median passes and 10.01 fails, either side', () => {
  const at = (best) => verdicts({ a: matched(), b: matched(), c: { ...matched(), best: [best] } }, GROUPS).cases.c.pass;
  assert.equal(at(90), true);
  assert.equal(at(70), true);
  assert.equal(at(90.01), false);
  assert.equal(at(69.99), false);
});

test('best must beat weakest by at least 15: 15 passes, 14.99 fails even inside the band', () => {
  const pool = (best, weakest) => verdicts({
    a: matched(), b: matched(), c: { ...matched(), best: [best], weakest: [weakest] },
  }, GROUPS).cases.c;
  assert.equal(pool(72, 57).pass, true);
  const flat = pool(71.99, 57);
  assert.equal(flat.pass, false);
  assert.deepEqual(flat.reasons, ['best is only 14.99 above weakest']);
});

test('a group mean is the mean of its runs and its spread is their sample SD', () => {
  const v = verdicts({ a: { ...matched(), strong: [70, 75, 80] } }, GROUPS);
  assert.equal(v.cases.a.means.strong, 75);
  assert.equal(v.cases.a.sd.strong, 5);
  assert.equal(v.cases.a.sd.best, null);
});

test('a group with no scored play fails the case and stays out of the pool median', () => {
  const v = verdicts({ a: matched(), b: matched(2), c: { ...matched(), mixed: [] } }, GROUPS);
  assert.equal(v.cases.c.pass, false);
  assert.deepEqual(v.cases.c.reasons, ['mixed: no scored play']);
  assert.equal(v.medians.mixed, 66);
});

test('the summary has one row per case, the pool medians, and why a failing case failed', () => {
  const table = { a: matched(), b: matched(), c: { ...matched(), weak: [80] } };
  const md = summaryMarkdown({
    run_id: 'sbx-1', date: '2026-11-03', scored: 18, planned: 18, spent_usd: 2.5, cap_usd: 30, stopped: false,
    providers: ['anthropic'], persona_model: 'claude-x', persona_runs: 1,
    cases: { a: { version: '1' }, b: { version: '1' }, c: { version: '2' } }, verdict: verdicts(table, GROUPS),
  }, GROUPS);
  assert.match(md, /^# Booth physician sandbox, run sbx-1$/m);
  assert.match(md, /\| a \| 1 \| 80 \| 65 \| 50 \| 75 \| 62 \| 50 \| 30 \| pass \|/);
  assert.match(md, /\| c \| 2 \| .* \| FAIL \|/);
  assert.match(md, /\| pool median \| \| 80 \| 65 \| 50 \| 75 \| 62 \| 50 \| \| \|/);
  assert.match(md, /- c: weak mean 80 is 30 from the pool median 50/);
  assert.match(md, /2 of 3 cases pass/);
});
