// The readiness rows over a fake ctx (src/lib/readiness.js, #431): each control fails its row when it
// does not behave, a short sample or a weakened override fails, owner-gated rows print but never decide
// the exit code, and the report is withheld when it carries a secret, a host, an address or a sentence.
const R = require('../src/lib/readiness');

const check = (id) => R.CHECKS.find((c) => c.id === id);
const run = (id, ctx) => check(id).run.call(check(id), ctx);

const localReply = (path) => {
  if (path === '/evaluate') return { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, provider: 'local' };
  if (path === '/evaluate-criteria') return { c4: true, c5: true, c6: true, c7: true, provider: 'local' };
  return { content: 'fictional reply', provider: path === '/chat' || path === '/audit-discuss' ? 'local-tutor' : 'local', middleware_flags: { thinking: true } };
};

// Each fake request yields to the event loop, as real I/O does: the drain's loop would otherwise spin
// on resolved promises and starve the timers the rows wait on.
const yieldThen = (fn) => async (...a) => { await new Promise((r) => setImmediate(r)); return fn(...a); };

function fakeCtx(over = {}) {
  let clock = 0;
  const { post = async (path) => ({ status: 200, body: localReply(path), ms: 1 }), ...rest } = over;
  return {
    opts: R.resolveOptions({}),
    post: yieldThen(post),
    instances: Object.fromEntries(R.INSTANCES.map((n) => [n, {
      configured: () => ({ thinking_style: 'none' }),
      ready: async () => ({ status: 'up', model: `${n}-model`, error: null }),
      chatOnce: async () => ({ ok: true, reason: 'ok', ms: 1 }),
      window: async () => ({ tokens: 32768, source: 'models_max_model_len' }),
      promptTokens: async () => ({ tokens: 1000 }),
    }])),
    supportsThinking: () => false,
    withEndpoint: async (kind, fn) => fn(),
    childApp: async () => ({ status: 503, body: { code: 'local_only_refused' } }),
    sandboxTranscript: async () => ({ ples: 1, transcript: { turns: [{ role: 'physician', content: 'fictional sandbox turn text' }], chiefComplaint: null } }),
    sensitive: () => {},
    anthropicRequests: () => 0,
    sleep: async () => {},
    now: () => (clock += 1),
    ...rest,
  };
}

describe('inference-shape control', () => {
  test('a forced empty reply classified as an error passes the control', async () => {
    const ctx = fakeCtx({
      withEndpoint: async (kind, fn) => {
        expect(kind).toBe('empty');
        const saved = ctx.post;
        ctx.post = async () => ({ status: 503, body: { code: 'empty_reply' }, ms: 1 });
        try { return await fn(); } finally { ctx.post = saved; }
      },
    });
    const row = await run('inference-shape', ctx);
    expect(row.status).toBe('pass');
    expect(row.evidence.control).toMatchObject({ classified_as: 'empty_reply', behaved: true });
  });

  test('a control that comes back with content fails the row as control_broken', async () => {
    const row = await run('inference-shape', fakeCtx());
    expect(row).toMatchObject({ status: 'fail', notes: 'control_broken' });
  });

  test('deep chat on a thinking-capable provider must report thinking on', async () => {
    const ctx = fakeCtx({ supportsThinking: () => true });
    const post = ctx.post;
    ctx.post = async (path, body, o) => {
      const res = await post(path, body, o);
      if (path === '/chat' && body.deep_mode) res.body.middleware_flags = { thinking: false };
      return res;
    };
    ctx.withEndpoint = async () => ({ status: 503, body: { code: 'empty_reply' } });
    const row = await run('inference-shape', ctx);
    expect(row.status).toBe('fail');
    expect(row.evidence['chat-deep']).toMatchObject({ thinking_supported: true, thinking: false });
  });
});

describe('concurrency', () => {
  // A transport whose every turn takes `ms` on the fake clock.
  const timed = (ms) => {
    let t = 0;
    return {
      now: () => t,
      post: async (path) => { t += path === '/chat' ? ms : 0; return { status: 200, body: localReply(path), ms }; },
    };
  };

  test('on-time turns pass and the delay control behaves', async () => {
    const ctx = fakeCtx({ sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() });
    const row = await run('concurrency', ctx);
    expect(row.evidence).toMatchObject({ sessions: 10, turns_per_session: 8, turns: 80, lost: 0 });
    expect(row.evidence.control).toMatchObject({ clean_pass: true, delayed_reason: 'misses_over_bound', behaved: true });
    expect(row.status).toBe('pass');
  });

  test('an injected delay past the deadline on the measured turns fails the row', async () => {
    const { now, post } = timed(20000);
    const ctx = fakeCtx({ post, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    ctx.now = () => now() + Date.now();
    const row = await run('concurrency', ctx);
    expect(row.status).toBe('fail');
    expect(row.evidence.reason).toBe('misses_over_bound');
  });

  test('a lost turn fails the row', async () => {
    let n = 0;
    const ctx = fakeCtx({
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
      post: async (path) => (path === '/chat' && ++n === 5 ? { status: 503, body: { code: 'queue_full' }, ms: 1 } : { status: 200, body: localReply(path), ms: 1 }),
    });
    const row = await run('concurrency', ctx);
    expect(row.evidence).toMatchObject({ reason: 'turns_lost', lost: 1, lost_reasons: { queue_full: 1 } });
  });

  test('a weaker override fails the row and is named', async () => {
    const ctx = fakeCtx({ opts: R.resolveOptions({ sessions: 2 }), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() });
    const row = await run('concurrency', ctx);
    expect(row.status).toBe('fail');
    expect(row.evidence.weaker_than_ticket).toEqual(['sessions']);
  });
});

describe('latency', () => {
  test('passes at the ticket sizes with the drain running', async () => {
    const row = await run('latency', fakeCtx({ sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) }));
    expect(row.status).toBe('pass');
    expect(row.evidence.chat).toMatchObject({ n: 30, min_n: 30 });
    expect(row.evidence.evaluate.n).toBeGreaterThanOrEqual(10);
  });

  test('failed chat turns leave too few samples, which is a fail', async () => {
    let n = 0;
    const ctx = fakeCtx({
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      post: async (path) => (path === '/chat' && ++n % 2 ? { error: 'timeout', ms: 1 } : { status: 200, body: localReply(path), ms: 1 }),
    });
    const row = await run('latency', ctx);
    expect(row.status).toBe('fail');
    expect(row.evidence.chat).toMatchObject({ n: 15, reason: 'too_few_samples', errors: 15 });
  });

  test('an override below the ticket is reported and fails the row', async () => {
    const ctx = fakeCtx({ opts: R.resolveOptions({ chatSamples: 3, evalSamples: 1 }), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
    const row = await run('latency', ctx);
    expect(row.status).toBe('fail');
    expect(row.evidence.weaker_than_ticket).toEqual(['chatSamples', 'evalSamples']);
  });
});

describe('context', () => {
  test('passes under 80% of the served window and registers the transcript as sensitive', async () => {
    const seen = [];
    const row = await run('context', fakeCtx({ sensitive: (s) => seen.push(s) }));
    expect(row.status).toBe('pass');
    expect(row.evidence.local).toMatchObject({ prompt_tokens: 1000, window_tokens: 32768, reason: 'ok' });
    expect(seen).toContain('fictional sandbox turn text');
  });

  test('nothing in the sandbox is a fail, not a pass', async () => {
    const row = await run('context', fakeCtx({ sandboxTranscript: async () => ({ ples: 0, transcript: null }) }));
    expect(row).toMatchObject({ status: 'fail', evidence: { reason: 'nothing_to_measure' } });
  });

  test('an unreported window, an over-share prompt and a missing count each fail', async () => {
    const ctx = fakeCtx();
    ctx.instances.local.window = async () => ({ tokens: null, source: null });
    ctx.instances['local-tutor'].promptTokens = async () => ({ tokens: 30000 });
    let row = await run('context', ctx);
    expect(row.evidence.local.reason).toBe('window_not_reported');
    expect(row.evidence['local-tutor'].reason).toBe('over_share');
    ctx.instances.local.window = async () => ({ tokens: 32768, source: 'ollama_show' });
    ctx.instances.local.promptTokens = async () => ({ tokens: null, reason: 'refused_too_large' });
    row = await run('context', ctx);
    expect(row.evidence.local.reason).toBe('refused_too_large');
  });
});

describe('failure-down', () => {
  test('a deterministic evaluate status (manual QA) fails the row', async () => {
    const ctx = fakeCtx({ post: async (path) => (path === '/chat' ? { status: 503, body: { code: 'ai_unavailable' }, ms: 1 } : { status: 502, body: {}, ms: 1 }) });
    const row = await run('failure-down', ctx);
    expect(row.status).toBe('fail');
    expect(row.evidence.refused).toMatchObject({ chat_failed_closed: true, evaluate_requeued: false });
  });

  test('chat answering with text while the endpoints are down fails the row', async () => {
    const ctx = fakeCtx({ post: async (path) => (path === '/chat' ? { status: 200, body: { content: 'x', provider: 'anthropic' }, ms: 1 } : { status: 500, body: {}, ms: 1 }) });
    const row = await run('failure-down', ctx);
    expect(row.evidence.error).toMatchObject({ chat_failed_closed: false, evaluate_requeued: true });
  });
});

test('local-only fails when anything reaches the Anthropic stand-in', async () => {
  let count = 0;
  const ctx = fakeCtx({ anthropicRequests: () => count, childApp: async () => { count += 1; return { status: 503, body: { code: 'local_only_refused' } }; } });
  const row = await run('local-only', ctx);
  expect(row.status).toBe('fail');
  expect(row.evidence.routed_to_anthropic.anthropic_requests).toBe(1);
});

describe('runReadiness and the report', () => {
  test('owner-gated rows print and do not change the verdict', async () => {
    const report = await R.runReadiness(fakeCtx(), { only: ['reachability', 'decisive-icc', 'clinician-thai-read'] });
    expect(report.verdict).toBe('GO');
    expect(R.exitCodeFor(report)).toBe(0);
    const text = R.formatText(report);
    expect(text).toContain('[OWNER-GATED] decisive-icc');
    expect(text).toContain('[OWNER-GATED] clinician-thai-read');
    expect(text.match(/owner-gated, not measured here/g)).toHaveLength(2);
  });

  test('only owner-gated rows is not a GO: nothing was measured', async () => {
    const report = await R.runReadiness(fakeCtx(), { only: ['decisive-icc'] });
    expect(report.verdict).toBe('NO-GO');
  });

  test('a crashing check is a failed row, not a crashed run', async () => {
    const ctx = fakeCtx();
    ctx.instances.local.ready = async () => { throw Object.assign(new Error('boom http://10.0.0.1'), { code: 'ECONNRESET' }); };
    const report = await R.runReadiness(ctx, { only: ['reachability'] });
    expect(report.rows[0]).toMatchObject({ status: 'fail', evidence: { reason: 'check_crashed', error: 'ECONNRESET' } });
    expect(R.findUnsafe(R.formatText(report), [])).toBeNull();
  });

  test('every request body is synthetic: shadow off for /evaluate and readiness- ple ids', async () => {
    const bodies = [];
    const ctx = fakeCtx({ post: async (path, body) => { bodies.push([path, body]); return { status: 200, body: localReply(path), ms: 1 }; } });
    await run('inference-shape', ctx);
    const evals = bodies.filter(([p]) => p === '/evaluate');
    expect(evals.length).toBeGreaterThan(0);
    for (const [, b] of evals) expect(b.shadow).toBe(false);
    for (const [p, b] of bodies) if (p === '/chat' || p === '/evaluate') expect(b.ple_id).toMatch(/^readiness-/);
  });
});

describe('sanitizer', () => {
  const env = {
    LOCAL_AI_API_KEY: 'sk-live-0123456789abcdef', INTERNAL_TOKEN: 'internal-token-value-42',
    LOCAL_AI_BASE_URL: 'http://gpu-node.example.internal:8000/v1', SUPABASE_URL: 'https://projref.supabase.co',
    SHORT_KEY: 'abc', PLAIN: 'hello world',
  };
  const sensitive = [...R.sensitiveFromEnv(env), ...R.fixtureLiterals(), ...R.textLiteral('a sandbox transcript sentence')];

  test.each([
    ['secret', 'model=sk-live-0123456789abcdef'],
    ['secret', 'token internal-token-value-42'],
    ['host', 'reached gpu-node.example.internal'],
    ['host', 'projref.supabase.co'],
    ['address', 'see https://elsewhere.test/x'],
    ['address', 'peer 10.20.30.40'],
    ['address', 'peer [fe80::1]'],
    ['fixture', `echo ${R.FIXTURE_TEXT[1]}`],
    ['transcript', 'quoted: a sandbox transcript sentence'],
  ])('a report containing a %s is withheld', (cls, text) => {
    expect(R.findUnsafe(text, sensitive)).toBe(cls);
    expect(() => R.assertSafe(text, sensitive)).toThrow(`report withheld: contained ${cls}`);
  });

  test('a clean report passes, and short or non-secret values are not literals', () => {
    const text = 'verdict: GO\nlocal.model=Qwen/Qwen3-32B\nchat.p95_ms=900 hello world abc';
    expect(R.assertSafe(text, sensitive)).toBe(text);
  });
});
