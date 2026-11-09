import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLog, nearestRank, summarize, summarizeReplies } from './score-latency.mjs';

const SCRIPT = fileURLToPath(new URL('./score-latency.mjs', import.meta.url));
const scoredLine = (i, ms, provider = 'table') =>
  `2026-11-02T10:0${i}:00Z [inf] [booth] score scored play=p${i} ms=${ms} provider=${provider}`;
const fiveFast = [12000, 18000, 21000, 25000, 30000].map((ms, i) => scoredLine(i, ms)).join('\n');
const replyLine = (i, ms, kind = 'replied', provider = 'anthropic') => `2026-11-02T10:00:00Z [inf] [booth] reply ${kind} `
  + `play=r${Math.floor(i / 3)} step=${(i % 3) + 1} ms=${ms} provider=${provider}${kind === 'empty' ? ' reason=TimeoutError' : ''}`;
/** n replies, 3 to a play, all at `ms` but the last, at `slowest`. */
const replies = (n, slowest, ms = 4000) => Array.from({ length: n }, (_, i) => replyLine(i, i === n - 1 ? slowest : ms)).join('\n');
// 30 replies: nearest rank 95 is the 29th of 30, so two slow replies set the p95.
const twoSlow = (ms) => `${replies(28, 4000)}\n${replyLine(28, ms)}\n${replyLine(29, ms)}`;

test('parseLog reads both lines through a Railway prefix and ignores other log lines', () => {
  const log = [
    scoredLine(1, 23456),
    '[booth] settle failed for p2: down',
    'Wed [wrn] [booth] score unavailable play=p3 ms=60004 reason=TimeoutError',
    'Wed [inf] [booth] reply replied play=p4 step=1 ms=4200 provider=anthropic',
    'Wed [wrn] [booth] reply empty play=p4 step=2 ms=30001 provider=none reason=TimeoutError',
    'Wed [wrn] [booth] reply empty play=p4 step=3 ms=900 provider=local reason=',
    'Wed [wrn] [booth] reply unavailable play=p5 step=- ms=12 reason=error',
  ].join('\r\n');
  assert.deepEqual(parseLog(log), {
    scored: [{ play: 'p1', ms: 23456, provider: 'table' }],
    unavailable: [{ play: 'p3', ms: 60004, reason: 'TimeoutError' }],
    replies: [
      { kind: 'replied', play: 'p4', step: '1', ms: 4200, provider: 'anthropic' },
      { kind: 'empty', play: 'p4', step: '2', ms: 30001, provider: 'none' },
      { kind: 'empty', play: 'p4', step: '3', ms: 900, provider: 'local' },
      { kind: 'unavailable', play: 'p5', step: '-', ms: 12 },
    ],
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

test('five scored plays from the table under 60 s pass, with p50, p95 and max in seconds', () => {
  const s = summarize(parseLog(fiveFast));
  assert.deepEqual(s, { n: 5, unavailable: 0, p50_s: 21, p95_s: 30, max_s: 30, providers: { table: 5 }, pass: true, failures: [] });
});

test('each PASS condition fails on its own', () => {
  assert.match(summarize(parseLog(fiveFast), { min: 6 }).failures.join(), /only 5 scored plays, need 6/);
  const withMiss = `${fiveFast}\n[booth] score unavailable play=px ms=900 reason=schema`;
  assert.match(summarize(parseLog(withMiss)).failures.join(), /1 unavailable/);
  const slow = `${fiveFast}\n${scoredLine(6, 60000)}`;
  assert.match(summarize(parseLog(slow)).failures.join(), /p95 60\.0 s is not under 60 s/);
  const live = `${fiveFast}\n${scoredLine(7, 1000, 'anthropic')}`;
  const s = summarize(parseLog(live));
  assert.deepEqual(s.providers, { table: 5, anthropic: 1 });
  assert.match(s.failures.join(), /not read from a path score table/);
  assert.equal(s.pass, false);
});

test('a play logged more than once counts once: five copies of one scored line fail on the play count', () => {
  const line = '2026-11-02T03:00:00Z [booth] score scored play=11111111-1111-4111-8111-111111111111 ms=25000 provider=table';
  const s = summarize(parseLog(Array(5).fill(line).join('\n')), { min: 5 });
  assert.equal(s.pass, false);
  assert.equal(s.n, 1);
  assert.deepEqual(s.providers, { table: 1 });
  assert.match(s.failures.join(), /only 1 scored plays, need 5/);
});

test('a replay keeps the first live line: its ms and provider=replay never enter the gate', () => {
  const replay = (i, ms) => `2026-11-02T10:0${i}:30Z [booth] score scored play=p${i} ms=${ms} provider=replay`;
  const s = summarize(parseLog(`${fiveFast}\n${replay(0, 90000)}\n${replay(9, 200)}`));
  assert.deepEqual(s, { n: 5, unavailable: 0, p50_s: 21, p95_s: 30, max_s: 30, providers: { table: 5 }, pass: true, failures: [] });
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
  const both = `${fiveFast}\n${replies(30, 9000)}`;
  const pass = run(both);
  assert.equal(pass.code, 0);
  assert.equal(pass.out, [
    'scored n=5  unavailable=0', 'p50 21.0 s  p95 30.0 s  max 30.0 s', 'providers table=5', 'score PASS',
    'replies n=30  empty=0  unavailable=0', 'reply p50 4.0 s  p95 4.0 s  max 9.0 s', 'reply providers anthropic=30', 'reply PASS',
    'PASS', '',
  ].join('\n'));
  assert.equal(run(both, ['--min', '6']).code, 1);
  assert.equal(run(both, ['--min', 'x']).code, 2);
  assert.equal(run(both, ['--min-replies', '0']).code, 2);
  const tooFew = run(both, ['--min-replies', '31']);
  assert.equal(tooFew.code, 1);
  assert.match(tooFew.out, /^score PASS$/m);
  assert.match(tooFew.out, /^reply TOO FEW: only 30 replies, need 31$/m);
  assert.match(tooFew.out, /\nFAIL\n$/);
  const slowReplies = run(`${fiveFast}\n${twoSlow(16000)}`);
  assert.equal(slowReplies.code, 1);
  assert.match(slowReplies.out, /^reply FAIL: p95 16\.0 s is not under 15 s$/m);
  assert.equal(run(fiveFast).code, 1, 'no reply lines: the reply gate is TOO FEW');
});

test('the reply gate: p95 at 16 s fails, at 14 s passes, and 29 replies are too few', () => {
  const at = (n, slow) => summarizeReplies(parseLog(replies(n, slow)));
  const slow = (ms) => summarizeReplies(parseLog(twoSlow(ms)));
  assert.deepEqual([slow(16000).verdict, slow(16000).failure, slow(16000).p95_s], ['FAIL', 'p95 16.0 s is not under 15 s', 16]);
  assert.deepEqual([slow(14000).verdict, slow(14000).failure, slow(14000).p95_s], ['PASS', null, 14]);
  assert.equal(slow(15000).verdict, 'FAIL');
  const few = at(29, 4000);
  assert.deepEqual([few.verdict, few.failure, few.n, few.p95_s], ['TOO FEW', 'only 29 replies, need 30', 29, 4]);
  assert.equal(summarizeReplies(parseLog(replies(29, 16000))).verdict, 'TOO FEW', 'too few wins over a slow p95');
  assert.equal(summarizeReplies(parseLog(replies(29, 4000)), { min: 29 }).verdict, 'PASS');
});

test('a reply line logged twice counts once, the first line kept', () => {
  const log = `${replies(29, 4000)}\n${replyLine(28, 4000)}\n${replyLine(28, 90000)}`;
  const s = summarizeReplies(parseLog(log));
  assert.deepEqual([s.n, s.verdict, s.max_s], [29, 'TOO FEW', 4]);
});

test('empty replies count in n and the p95; unavailable replies count in neither', () => {
  const empties = [28, 29].map((i) => replyLine(i, 30000, 'empty', 'none')).join('\n');
  const unavailable = [30, 31, 32].map((i) => `[booth] reply unavailable play=r${Math.floor(i / 3)} step=${(i % 3) + 1} ms=99000 reason=ceiling`);
  const s = summarizeReplies(parseLog(`${replies(28, 4000)}\n${empties}\n${unavailable.join('\n')}\n${unavailable[0]}`));
  assert.deepEqual(s, {
    n: 30, empty: 2, unavailable: 3, p50_s: 4, p95_s: 30, max_s: 30, providers: { anthropic: 28, none: 2 },
    verdict: 'FAIL', failure: 'p95 30.0 s is not under 15 s',
  });
});
