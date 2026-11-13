// The readiness command's statistics and verdict rules (src/lib/readiness.js, #431): nearest-rank p95
// reported with its n, the 95% Wilson upper bound, and the rule that a short sample fails.
const fs = require('fs');
const path = require('path');
const R = require('../src/lib/readiness');

describe('percentile (nearest rank)', () => {
  test('p95 of 1..100 is 95, of 1..30 is the 29th value, and of nothing is null', () => {
    const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
    expect(R.percentile(range(100), 95)).toBe(95);
    expect(R.percentile(range(30), 95)).toBe(29);
    expect(R.percentile([7], 95)).toBe(7);
    expect(R.percentile([], 95)).toBeNull();
  });

  test('order of the input does not matter', () => {
    expect(R.percentile([30, 10, 20], 50)).toBe(20);
  });
});

describe('Wilson upper bound, 95% two-sided', () => {
  test('zero misses passes 5% from n = 73 and not at n = 72', () => {
    expect(R.wilsonUpper(0, 72)).toBeGreaterThan(0.05);
    expect(R.wilsonUpper(0, 73)).toBeLessThanOrEqual(0.05);
    expect(R.minTurnsForZeroMissPass()).toBe(73);
  });

  test('matches the closed form for k > 0', () => {
    // k = 2, n = 100: p = 0.02, z = 1.96 -> upper 0.0700 (standard Wilson table value)
    expect(R.wilsonUpper(2, 100)).toBeCloseTo(0.0700, 3);
    expect(R.wilsonUpper(0, 0)).toBe(1);
  });
});

describe('judgeP95', () => {
  const samples = Array.from({ length: 30 }, () => 1000);

  test('fewer samples than the minimum fails even when every sample is fast', () => {
    const v = R.judgeP95(samples.slice(0, 29), { minN: 30, limitMs: 15000, inclusive: false });
    expect(v).toMatchObject({ pass: false, reason: 'too_few_samples', n: 29, min_n: 30 });
  });

  test('chat is strict (< limit), evaluate inclusive (<= limit)', () => {
    const atLimit = Array.from({ length: 30 }, () => 15000);
    expect(R.judgeP95(atLimit, { minN: 30, limitMs: 15000, inclusive: false }).reason).toBe('p95_over_limit');
    expect(R.judgeP95(atLimit, { minN: 30, limitMs: 15000, inclusive: true }).pass).toBe(true);
  });

  test('reports p95 with its n', () => {
    expect(R.judgeP95(samples, { minN: 30, limitMs: 15000, inclusive: false })).toMatchObject({ pass: true, n: 30, p95_ms: 1000 });
  });
});

describe('judgeConcurrency', () => {
  const turns = (n, f) => Array.from({ length: n }, (_, i) => f(i));

  test('80 on-time turns pass; 72 cannot, whatever their latency', () => {
    expect(R.judgeConcurrency(turns(80, () => ({ ms: 10, ok: true })), { deadlineMs: 15000 }).pass).toBe(true);
    expect(R.judgeConcurrency(turns(72, () => ({ ms: 10, ok: true })), { deadlineMs: 15000 }).reason).toBe('too_few_turns');
  });

  test('one lost turn fails even with the bound met', () => {
    const v = R.judgeConcurrency(turns(400, (i) => ({ ms: 10, ok: i !== 0 })), { deadlineMs: 15000 });
    expect(v).toMatchObject({ pass: false, reason: 'turns_lost', lost: 1 });
    expect(v.miss_upper_95).toBeLessThan(0.05);
  });

  test('late turns count as misses and are judged on the upper bound, not the point rate', () => {
    // 3 late of 80 is 3.75% observed, but the upper bound is about 10.5%
    const v = R.judgeConcurrency(turns(80, (i) => ({ ms: i < 3 ? 20000 : 10, ok: true })), { deadlineMs: 15000 });
    expect(v).toMatchObject({ pass: false, reason: 'misses_over_bound', misses: 3, lost: 0 });
  });
});

describe('options', () => {
  test('an override weaker than the ticket is named; a stricter one is not', () => {
    const opts = R.resolveOptions({ chatSamples: 5, chatP95Ms: 10000, deadlineMs: 20000 });
    expect(R.weakerOverrides(opts, ['chatSamples', 'chatP95Ms', 'deadlineMs', 'sessions'])).toEqual(['chatSamples', 'deadlineMs']);
  });

  test('ticket defaults', () => {
    expect(R.resolveOptions({})).toMatchObject({ chatSamples: 30, evalSamples: 10, chatP95Ms: 15000, evalP95Ms: 240000, sessions: 10, deadlineMs: 15000 });
  });
});

describe('classifyReply', () => {
  const ok = (body) => ({ status: 200, body, ms: 5 });

  test('a local reply with content is ok; a cloud provider is not', () => {
    expect(R.classifyReply('chat', ok({ content: 'x', provider: 'local-tutor' }))).toEqual({ ok: true, reason: 'ok' });
    expect(R.classifyReply('chat', ok({ content: 'x', provider: 'anthropic' })).reason).toBe('not_on_prem');
  });

  test('the forced empty reply the AI seam raises is a failure, not a pass', () => {
    expect(R.classifyReply('chat', { status: 503, body: { code: 'empty_reply' } })).toEqual({ ok: false, reason: 'empty_reply' });
    expect(R.classifyReply('chat', ok({ content: '   ', provider: 'local-tutor' })).reason).toBe('no_content');
  });

  test('each shape needs its own fields', () => {
    expect(R.classifyReply('criteria', ok({ c4: true, c5: false, c6: true, c7: true, provider: 'local' })).ok).toBe(true);
    expect(R.classifyReply('criteria', ok({ c4: true, provider: 'local' })).ok).toBe(false);
    expect(R.classifyReply('evaluate', ok({ d1: 1, d2: 2, d3: 3, d4: 4, d5: 5, d6: 0, d7: 1, provider: 'local' })).ok).toBe(true);
    expect(R.classifyReply('evaluate', ok({ d1: 1, provider: 'local' })).ok).toBe(false);
  });

  test('transport errors and other statuses name themselves', () => {
    expect(R.classifyReply('chat', { error: 'timeout' }).reason).toBe('timeout');
    expect(R.classifyReply('chat', { status: 503, body: { code: 'queue_full' } }).reason).toBe('queue_full');
    expect(R.classifyReply('chat', { status: 500, body: {} }).reason).toBe('http_500');
  });
});

test('DETERMINISTIC_STATUSES matches the backend set that sends an evaluation to manual QA', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'src', 'services', 'rimpl-client.js'), 'utf8');
  const m = src.match(/const DETERMINISTIC_STATUSES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  expect(m).not.toBeNull();
  const backend = m[1].split(',').map((s) => Number(s.trim())).filter(Number.isFinite).sort((a, b) => a - b);
  expect([...R.DETERMINISTIC_STATUSES].sort((a, b) => a - b)).toEqual(backend);
});
