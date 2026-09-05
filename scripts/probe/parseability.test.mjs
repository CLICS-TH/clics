// Tests for the D18 parseability accounting.
//
// Every case below is a bug that actually shipped or was actually proposed on 2026-09-04. This file
// exists because the same accounting error was fixed once in repeat-consistency.mjs and then written
// again, independently, in two consumers — the third and fourth times it appeared, it produced a
// published conclusion that had to be retracted. Run with: node --test scripts/probe/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeParseability, isTransport } from './parseability.mjs';

const scores = { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3 };
const okRow = (calls = 2, retries = 0) => ({
  local: scores, cloud: scores, localCalls: calls, localJsonRetries: retries,
  localError: null, cloudError: null,
});

test('a clean run is 100% and excludes nothing', () => {
  const r = computeParseability([okRow(), okRow(), okRow()], null);
  assert.deepEqual([r.attempted, r.parsed, r.excluded, r.pass], [6, 6, 0, true]);
  assert.equal(r.legacy, false);
});

test('counts CALLS, not fixtures — an adaptive row is 2-3 calls plus re-asks', () => {
  // The bug: counting these two rows as 2 attempts reported 100% for a run that made 5 calls,
  // one of which came back unusable and was re-asked.
  const r = computeParseability([okRow(2, 0), okRow(2, 1)], null);
  assert.equal(r.attempted, 5, 'four calls plus one re-ask');
  assert.equal(r.parsed, 4);
  assert.equal(r.pass, false, '80% must not pass the 98% bar');
});

test('Pis7ScoreError COUNTS — it is the model breaking its contract, not the box', () => {
  // The worst bug of the day: excluding this turned "5 of 18 rows failed" into a clean pass.
  const failing = { local: null, cloud: scores, localCalls: 3, localJsonRetries: 2,
    localError: 'Pis7ScoreError', cloudError: null };
  const r = computeParseability([okRow(), failing], null);
  assert.equal(r.excluded, 0, 'nothing may be excused here');
  assert.equal(r.attempted, 7, '2 good calls + 3 calls + 2 re-asks');
  assert.equal(r.parsed, 4, '2 good + the 2 calls before the one that could not be made valid');
  assert.equal(r.pass, false);
});

test('a run that fails its contract on every call cannot report a passing rate', () => {
  // With everything excluded, pct went null and jsonPass could no longer pull a verdict down to fail.
  const failing = (i) => ({ local: null, cloud: scores, localCalls: 1, localJsonRetries: 0,
    localError: 'Pis7ScoreError', cloudError: null, id: `X${i}` });
  const r = computeParseability([failing(1), failing(2), failing(3)], null);
  assert.notEqual(r.pct, null, 'must produce a number, not n/m');
  assert.equal(r.pass, false);
});

test('transport IS excluded — the box failing says nothing about the model', () => {
  const dead = { local: null, cloud: scores, localCalls: 1, localJsonRetries: 0,
    localError: 'transport 502', cloudError: null };
  const r = computeParseability([okRow(), dead], null);
  assert.equal(r.excluded, 1);
  assert.deepEqual([r.attempted, r.parsed, r.pass], [2, 2, true]);
});

test('a cloud-arm failure is excluded — the local arm was never judged', () => {
  const cloudDied = { local: null, cloud: null, localCalls: 2, localJsonRetries: 0,
    localError: null, cloudError: 'unparseable' };
  const r = computeParseability([okRow(), cloudDied], null);
  assert.equal(r.excluded, 2, 'both of its local calls leave the denominator');
  assert.deepEqual([r.attempted, r.parsed], [2, 2]);
});

test('repeat rows: transport leaves the denominator, a bad reply stays in', () => {
  const repeat = { results: [
    { arm: 'local', runs: [scores, scores, scores], ms: [1, 1, 1, 1, 1],
      errors: [null, 'transport 500', null, 'transport', null] },   // 2 box failures
    { arm: 'local', runs: [scores, scores, scores, scores], ms: [1, 1, 1, 1, 1],
      errors: [null, null, null, null, 'empty reply'] },            // 1 model failure
    { arm: 'cloud', runs: [scores], ms: [1], errors: [null] },      // ignored entirely
  ] };
  const r = computeParseability([], repeat);
  assert.equal(r.excluded, 2);
  assert.deepEqual([r.attempted, r.parsed], [8, 7]);
});

test("'empty reply' is a MODEL failure — the model replied with nothing usable", () => {
  const repeat = { results: [{ arm: 'local', runs: [], ms: [1], errors: ['empty reply'] }] };
  const r = computeParseability([], repeat);
  assert.equal(r.excluded, 0);
  assert.deepEqual([r.attempted, r.parsed], [1, 0]);
});

test('legacy reports are flagged, never silently rescored', () => {
  const oldRow = { local: scores, cloud: scores };                       // no localCalls
  const oldRepeat = { results: [{ arm: 'local', runs: [scores], ms: [1, 1] }] };  // no errors
  assert.equal(computeParseability([oldRow], null).legacy, true);
  assert.equal(computeParseability([], oldRepeat).legacy, true);
  assert.equal(computeParseability([okRow()], null).legacy, false);
});

test('legacy rows count a lost fixture against the model (strict, not generous)', () => {
  const lost = { local: null, cloud: scores };   // pre-stamp: timeout and bad JSON are indistinguishable
  const r = computeParseability([{ local: scores, cloud: scores }, lost], null);
  assert.deepEqual([r.attempted, r.parsed, r.excluded], [2, 1, 0]);
  assert.equal(r.legacy, true);
});

test('parsed can never exceed attempted, and attempted never goes negative', () => {
  const repeat = { results: [{ arm: 'local', runs: [scores, scores], ms: [1, 1],
    errors: ['transport', 'transport'] }] };
  const r = computeParseability([], repeat);
  assert.ok(r.attempted >= 0, 'attempted must not go negative');
  assert.ok(r.parsed <= r.attempted || r.attempted === 0);
});

test('no rows and no repeat yields n/m rather than a fabricated 0%', () => {
  const r = computeParseability([], null);
  assert.deepEqual([r.pct, r.pass], [null, null]);
});

test('isTransport matches only the stamp, never an error class name', () => {
  assert.ok(isTransport('transport'));
  assert.ok(isTransport('transport 502'));
  assert.ok(!isTransport('Pis7ScoreError'), 'the contract-breach class must never be read as transport');
  assert.ok(!isTransport('empty reply'));
  assert.ok(!isTransport('unparseable'));
  assert.ok(!isTransport(null));
  assert.ok(!isTransport('transported'), 'word boundary, not a prefix match');
});
