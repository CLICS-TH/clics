import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLog, nearestRank, summarize } from './score-latency.mjs';

const SCRIPT = fileURLToPath(new URL('./score-latency.mjs', import.meta.url));
const scoredLine = (i, ms, provider = 'anthropic') =>
  `2026-11-02T10:0${i}:00Z [inf] [booth] score scored play=p${i} ms=${ms} provider=${provider}`;
const fiveFast = [12000, 18000, 21000, 25000, 30000].map((ms, i) => scoredLine(i, ms)).join('\n');

test('parseLog reads both lines through a Railway prefix and ignores other log lines', () => {
  const log = [
    scoredLine(1, 23456),
    '[booth] reply failed for p2: TimeoutError',
    'Wed [wrn] [booth] score unavailable play=p3 ms=60004 reason=TimeoutError',
  ].join('\r\n');
  assert.deepEqual(parseLog(log), {
    scored: [{ play: 'p1', ms: 23456, provider: 'anthropic' }],
    unavailable: [{ play: 'p3', ms: 60004, reason: 'TimeoutError' }],
  });
});

test('nearestRank picks the ceil(p * n)th value', () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(nearestRank(ten, 50), 5);
  assert.equal(nearestRank(ten, 95), 10);
  assert.equal(nearestRank([7], 95), 7);
  assert.equal(nearestRank([], 95), null);
  assert.equal(nearestRank([1, 2, 3, 4, 5], 50), 3);
  assert.equal(nearestRank([1, 2, 3, 4, 5], 95), 5);
});

test('five scored plays on anthropic under 60 s pass, with p50, p95 and max in seconds', () => {
  const s = summarize(parseLog(fiveFast));
  assert.deepEqual(s, { n: 5, unavailable: 0, p50_s: 21, p95_s: 30, max_s: 30, providers: { anthropic: 5 }, pass: true, failures: [] });
});

test('each PASS condition fails on its own', () => {
  assert.match(summarize(parseLog(fiveFast), { min: 6 }).failures.join(), /only 5 scored plays, need 6/);
  const withMiss = `${fiveFast}\n[booth] score unavailable play=px ms=900 reason=schema`;
  assert.match(summarize(parseLog(withMiss)).failures.join(), /1 unavailable/);
  const slow = `${fiveFast}\n${scoredLine(6, 60000)}`;
  assert.match(summarize(parseLog(slow)).failures.join(), /p95 60\.0 s is not under 60 s/);
  const local = `${fiveFast}\n${scoredLine(7, 1000, 'local')}`;
  const s = summarize(parseLog(local));
  assert.deepEqual(s.providers, { anthropic: 5, local: 1 });
  assert.match(s.failures.join(), /did not run on anthropic/);
  assert.equal(s.pass, false);
});

test('a play logged more than once counts once: five copies of one scored line fail on the play count', () => {
  const line = '2026-11-02T03:00:00Z [booth] score scored play=11111111-1111-4111-8111-111111111111 ms=25000 provider=anthropic';
  const s = summarize(parseLog(Array(5).fill(line).join('\n')), { min: 5 });
  assert.equal(s.pass, false);
  assert.equal(s.n, 1);
  assert.deepEqual(s.providers, { anthropic: 1 });
  assert.match(s.failures.join(), /only 1 scored plays, need 5/);
});

test('a replay keeps the first live line: its ms and provider=replay never enter the gate', () => {
  const replay = (i, ms) => `2026-11-02T10:0${i}:30Z [booth] score scored play=p${i} ms=${ms} provider=replay`;
  const s = summarize(parseLog(`${fiveFast}\n${replay(0, 90000)}\n${replay(9, 200)}`));
  assert.deepEqual(s, { n: 5, unavailable: 0, p50_s: 21, p95_s: 30, max_s: 30, providers: { anthropic: 5 }, pass: true, failures: [] });
});

test('a play with an unavailable line counts as unavailable, not scored, and counts once', () => {
  const miss = '[booth] score unavailable play=p0 ms=10 reason=settled';
  const s = summarize(parseLog(`${fiveFast}\n${miss}\n${miss}`));
  assert.deepEqual([s.n, s.unavailable, s.pass], [4, 1, false]);
});

test('an empty log fails on the play count and prints no percentiles', () => {
  const s = summarize(parseLog(''));
  assert.equal(s.pass, false);
  assert.deepEqual([s.n, s.p50_s, s.p95_s, s.max_s], [0, null, null, null]);
});

test('the CLI reads stdin and exits 0 on PASS, 1 on FAIL, 2 on a bad flag', () => {
  const run = (input, args = []) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  const pass = run(fiveFast);
  assert.equal(pass.code, 0);
  assert.match(pass.out, /p95 30\.0 s/);
  assert.match(pass.out, /providers anthropic=5/);
  assert.match(pass.out, /^PASS$/m);
  assert.equal(run(fiveFast, ['--min', '6']).code, 1);
  assert.equal(run(fiveFast, ['--min', 'x']).code, 2);
});
