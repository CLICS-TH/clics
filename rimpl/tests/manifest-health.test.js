// The model manifest at runtime (services/manifest.js): its block on /health/deep, its check, and GET
// /manifest. Three properties matter more than the shape:
//   1. WARN-ONLY. Production runs every purpose on anthropic while the declared target is on-prem, so the
//      default env drifts — and that must never make /health/deep 503 (backend reads 503 as rimpl down).
//   2. NOTHING ADDRESS-LIKE LEAVES. /health/deep is unauthenticated. With every base URL, key and proxy
//      set to addresses, and a server fingerprint that itself carries one, the body holds none of them.
//   3. DRIFT IS REAL. An env override of a code default, and a served engine that differs from the
//      declared one, each show up as one entry — and an engine never observed is not invented as drift.
// HERMETIC: the Anthropic SDK and Supabase are mocked; the one local call uses a mocked fetch.
jest.mock('@anthropic-ai/sdk', () => function Anthropic() { return { messages: { create: jest.fn() } }; });
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ limit: () => Promise.resolve({ count: 1, error: null }) }) }) },
}));

process.env.HEALTH_PROBE_TIMEOUT_MS = '50';
const AI_ENV = ['AI_PROVIDER', 'AI_PROVIDER_CHAT', 'AI_PROVIDER_EVALUATE', 'AI_PROVIDER_CRITERIA', 'AI_PROVIDER_DISCUSS',
  'CHAT_FAILOVER_PROVIDER', 'SHADOW_EVAL_PROVIDER', 'INTERNAL_TOKEN', 'ANTHROPIC_API_KEY',
  'LOCAL_AI_BASE_URL', 'LOCAL_AI_MODEL', 'LOCAL_AI_API_KEY', 'LOCAL_AI_HTTP_PROXY', 'LOCAL_AI_NUM_CTX', 'LOCAL_AI_THINKING_STYLE',
  'LOCAL_TUTOR_AI_BASE_URL', 'LOCAL_TUTOR_AI_MODEL', 'LOCAL_TUTOR_AI_API_KEY', 'LOCAL_TUTOR_AI_THINKING_STYLE',
  'RIMPL_CHAT_MAX_TOKENS', 'SHADOW_EVAL_MAX_TOKENS', 'EVAL_CONSISTENCY', 'RIMPL_DISCUSS_MAX_TOKENS'];
const saved = Object.fromEntries(AI_ENV.map((k) => [k, process.env[k]]));
for (const k of AI_ENV) delete process.env[k];
afterAll(() => { for (const k of AI_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const request = require('supertest');
const app = require('../src/index');
const M = require('../src/lib/manifest');
const local = require('../src/services/providers/local');

const committed = M.readManifest();
const sha12 = (s) => require('crypto').createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);
const reset = () => {
  for (const k of AI_ENV) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = 'sk-test-key';
};
beforeEach(reset);

describe('/health/deep on a default env (every purpose on anthropic)', () => {
  test('the block, exactly: present, verified, this build\'s code, and the provider drift the declared target implies', async () => {
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);                       // drift never degrades the endpoint
    expect(res.body.status).toBe('ok');
    expect(res.body.manifest).toEqual({
      sha256: committed.sha256,
      claimed_sha256: committed.sha256,
      file: 'present',
      code_match: true,
      drift: [
        { key: 'declared.providers.chat', expected: 'local-tutor', live: 'anthropic' },
        { key: 'declared.providers.criteria', expected: 'local', live: 'anthropic' },
        { key: 'declared.providers.discuss', expected: 'local-tutor', live: 'anthropic' },
        { key: 'declared.providers.evaluate', expected: 'local', live: 'anthropic' },
        // A model id is free text: on this public endpoint only whether it is set, and its hash.
        { key: 'declared.local.model', expected: 'DeepSeek-V4.1-Flash-1017', live_present: false, live_sha256_12: null },
        { key: 'declared.local-tutor.model', expected: 'qwen3.8-flash-next', live_present: false, live_sha256_12: null },
      ],
    });
    expect(res.body.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.checks.manifest).toEqual({ status: 'warn',
      warning: 'model manifest: 6 live value(s) differ from the manifest (declared target or code defaults) — see manifest.drift' });
    expect(res.body.warnings).toEqual(['manifest']);
  });

  test('a warn never masks a real failure: with the Anthropic key gone it is 503, and the manifest is still warn, not down', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.manifest.status).toBe('warn');
  });

  test('configured as declared and no code default overridden: the check is up and there is no drift', async () => {
    process.env.AI_PROVIDER_EVALUATE = 'local';
    process.env.AI_PROVIDER_CRITERIA = 'local';
    process.env.AI_PROVIDER_CHAT = 'local-tutor';
    process.env.AI_PROVIDER_DISCUSS = 'local-tutor';
    process.env.LOCAL_AI_MODEL = 'DeepSeek-V4.1-Flash-1017';
    process.env.LOCAL_TUTOR_AI_MODEL = 'qwen3.8-flash-next';
    const res = await request(app).get('/health/deep');
    expect(res.body.manifest.drift).toEqual([]);
    expect(res.body.checks.manifest).toEqual({ status: 'up' });
  });
});

describe('drift', () => {
  test('an env override of a code default is one entry against the code; garbage falls back and is not drift', async () => {
    process.env.SHADOW_EVAL_MAX_TOKENS = '6000';
    process.env.EVAL_CONSISTENCY = 'adaptive';
    process.env.LOCAL_AI_THINKING_STYLE = 'chat-template';      // a typo: reported as 'invalid', not hidden as none
    process.env.LOCAL_AI_NUM_CTX = '32768';
    process.env.RIMPL_DISCUSS_MAX_TOKENS = 'auto';               // unparseable: the default runs, so no drift
    const { drift } = (await request(app).get('/health/deep')).body.manifest;
    const code = drift.filter((d) => d.key.startsWith('code.'));
    expect(code).toEqual([
      { key: 'code.decoding.shadow.max_tokens', expected: 4096, live: 6000 },
      { key: 'code.consistency.evaluate_mode', expected: 'off', live: 'adaptive' },
      { key: 'code.decoding.num_ctx.local', expected: null, live: 32768 },
      { key: 'code.thinking_style.local', expected: 'none', live: 'invalid' },
    ]);
  });

  test('the Anthropic model is read from the PROVIDER, not from the constant the manifest was built from', async () => {
    const { PROVIDERS } = require('../src/services/ai');
    const spy = jest.spyOn(PROVIDERS.anthropic, 'model').mockReturnValue('claude-not-the-pinned-one');
    try {
      const pub = (await request(app).get('/health/deep')).body.manifest.drift;
      expect(pub).toEqual(expect.arrayContaining([
        { key: 'code.models.anthropic', expected: 'claude-sonnet-4-6', live_present: true, live_sha256_12: sha12('claude-not-the-pinned-one') },
      ]));
      process.env.INTERNAL_TOKEN = 'internal-test-token';
      const raw = (await request(app).get('/manifest').set('x-internal-token', 'internal-test-token')).body;
      expect(raw.live.models.anthropic).toBe('claude-not-the-pinned-one');
    } finally { spy.mockRestore(); }
    // Unspied, the provider sends the pinned id: no drift on this key.
    const back = (await request(app).get('/health/deep')).body.manifest.drift;
    expect(back.some((d) => d.key === 'code.models.anthropic')).toBe(false);
  });

  test('the served engine: unobserved is not drift; observed and different is', async () => {
    process.env.LOCAL_AI_BASE_URL = 'http://evalbox.internal:8000/v1';
    process.env.LOCAL_AI_MODEL = 'DeepSeek-V4.1-Flash-1017';
    const before = (await request(app).get('/health/deep')).body.manifest.drift;
    expect(before.some((d) => /engine|fingerprint|served_model/.test(d.key))).toBe(false);

    const realFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ model: 'DeepSeek-V4.1-Flash-1017', system_fingerprint: 'sglang-0.5.2-tp2-0badc0de',
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) }));
    try {
      await local.call({ systemPrompt: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10, purpose: 'evaluate' });
    } finally { globalThis.fetch = realFetch; }

    const after = (await request(app).get('/health/deep')).body.manifest.drift;
    expect(after).toEqual(expect.arrayContaining([
      { key: 'declared.local.engine', expected: 'vllm', live: 'sglang' },
    ]));
    // No fingerprint is declared yet (null is not compared), and the served model is the declared one.
    expect(after.some((d) => d.key === 'declared.local.system_fingerprint')).toBe(false);
    expect(after.some((d) => d.key === 'declared.local.served_model')).toBe(false);
    // Behind the token, the same entry is raw.
    process.env.INTERNAL_TOKEN = 'internal-test-token';
    const raw = (await request(app).get('/manifest').set('x-internal-token', 'internal-test-token')).body.drift;
    expect(raw).toEqual(expect.arrayContaining([
      { key: 'declared.local.engine', expected: 'vllm', live: 'sglang' },
    ]));
  });
});

describe('no URL, host, IP or key ever reaches the unauthenticated body', () => {
  const SECRETS = ['sk-local-evaluator-key-123456', 'tutor-key-abcdef-7890'];
  const UNSAFE = [/https?:\/\//i, /\b\d{1,3}(?:\.\d{1,3}){3}\b/, /tailnet|ts\.net|localhost|evalbox|tutorbox|proxybox/i, ...SECRETS.map((s) => new RegExp(s))];

  test('every address configured, AND a server fingerprint that carries one: none of it in /health/deep', async () => {
    process.env.LOCAL_AI_BASE_URL = 'http://100.64.12.34:8888/v1';
    process.env.LOCAL_AI_MODEL = 'deepseek-v4-flash-dspark';
    process.env.LOCAL_AI_API_KEY = SECRETS[0];
    process.env.LOCAL_AI_HTTP_PROXY = 'http://proxybox.tailnet.ts.net:1055';
    process.env.LOCAL_TUTOR_AI_BASE_URL = 'https://tutorbox.tailnet.ts.net/v1';
    process.env.LOCAL_TUTOR_AI_MODEL = 'qwen-tutor';
    process.env.LOCAL_TUTOR_AI_API_KEY = SECRETS[1];

    // A gateway that echoes its own address into system_fingerprint — the live view must not repeat it.
    const realFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ model: 'deepseek-v4-flash-dspark', system_fingerprint: 'vllm-0.21 via http://192.168.10.20:18300',
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) }));
    try {
      // The proxy env routes through undici's ProxyAgent; go direct for this one call.
      delete process.env.LOCAL_AI_HTTP_PROXY;
      await local.call({ systemPrompt: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10, purpose: 'evaluate' });
      process.env.LOCAL_AI_HTTP_PROXY = 'http://proxybox.tailnet.ts.net:1055';
    } finally { globalThis.fetch = realFetch; }

    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    for (const re of UNSAFE) expect(body).not.toMatch(re);
    // The served model was observed and differs — and only its presence and a hash are public.
    expect(res.body.manifest.drift).toEqual(expect.arrayContaining([
      { key: 'declared.local.served_model', expected: 'DeepSeek-V4.1-Flash-1017',
        live_present: true, live_sha256_12: expect.stringMatching(/^[0-9a-f]{12}$/) },
    ]));

    // GET /manifest is behind the token, but carries no address either.
    process.env.INTERNAL_TOKEN = 'internal-test-token';
    const m = await request(app).get('/manifest').set('x-internal-token', 'internal-test-token');
    expect(m.status).toBe(200);
    const mb = JSON.stringify(m.body);
    for (const re of UNSAFE) expect(mb).not.toMatch(re);
    expect(m.body.live.base_url).toEqual({ local: 'present', 'local-tutor': 'present' });
  });
});

describe('operator- and server-supplied strings: hashed in public, raw behind the token', () => {
  // Recognisable sentinels, deliberately NOT address-shaped, so redaction cannot be what hides them.
  const MODEL = 'SENTINEL-CONFIGURED-MODEL-7f3a9c';
  const SERVED = 'SENTINEL-SERVED-MODEL-41b2';
  const FINGERPRINT = 'vllm-sentinelfingerprint-9e8d7c';
  const TUTOR = 'SENTINEL-TUTOR-MODEL-0c1d';

  test('none of them in /health/deep; all of them in GET /manifest', async () => {
    process.env.LOCAL_AI_BASE_URL = 'http://evalbox.internal:8000/v1';
    process.env.LOCAL_AI_MODEL = MODEL;
    process.env.LOCAL_TUTOR_AI_MODEL = TUTOR;
    const realFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ model: SERVED, system_fingerprint: FINGERPRINT,
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) }));
    try {
      await local.call({ systemPrompt: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10, purpose: 'evaluate' });
    } finally { globalThis.fetch = realFetch; }

    const pub = await request(app).get('/health/deep');
    expect(pub.status).toBe(200);
    const body = JSON.stringify(pub.body);
    for (const s of [MODEL, SERVED, FINGERPRINT, TUTOR]) expect(body).not.toContain(s);
    // …but the drift still says which values differ, and the hashes let a holder of the value confirm it.
    expect(pub.body.manifest.drift).toEqual(expect.arrayContaining([
      { key: 'declared.local.model', expected: 'DeepSeek-V4.1-Flash-1017', live_present: true, live_sha256_12: sha12(MODEL) },
      { key: 'declared.local.served_model', expected: 'DeepSeek-V4.1-Flash-1017', live_present: true, live_sha256_12: sha12(SERVED) },
      { key: 'declared.local-tutor.model', expected: 'qwen3.8-flash-next', live_present: true, live_sha256_12: sha12(TUTOR) },
    ]));

    process.env.INTERNAL_TOKEN = 'internal-test-token';
    const priv = await request(app).get('/manifest').set('x-internal-token', 'internal-test-token');
    expect(priv.status).toBe(200);
    expect(priv.body.live.models).toMatchObject({ local: MODEL, 'local-tutor': TUTOR });
    expect(priv.body.live.last_seen.local).toMatchObject({ model: SERVED, runtime: FINGERPRINT, engine: 'vllm' });
    expect(priv.body.drift).toEqual(expect.arrayContaining([
      { key: 'declared.local.model', expected: 'DeepSeek-V4.1-Flash-1017', live: MODEL },
      { key: 'declared.local-tutor.model', expected: 'qwen3.8-flash-next', live: TUTOR },
    ]));
  });
});

describe('GET /manifest (internal token)', () => {
  test('401 without the token when one is configured — the route sits behind internalAuth', async () => {
    process.env.INTERNAL_TOKEN = 'internal-test-token';
    expect((await request(app).get('/manifest')).status).toBe(401);
    expect((await request(app).get('/manifest').set('x-internal-token', 'wrong')).status).toBe(401);
  });

  test('200 with it: the committed manifest, its verified sha256, code_match, the live view and the drift', async () => {
    process.env.INTERNAL_TOKEN = 'internal-test-token';
    const res = await request(app).get('/manifest').set('x-internal-token', 'internal-test-token');
    expect(res.status).toBe(200);
    expect(res.body.manifest).toEqual(committed.manifest);
    expect(res.body.sha256).toBe(M.manifestSha256(res.body.manifest));
    expect(res.body).toMatchObject({ file: 'present', code_match: true });
    expect(res.body.live).toMatchObject({
      providers: { chat: 'anthropic', evaluate: 'anthropic', criteria: 'anthropic', discuss: 'anthropic', embed: 'openai', shadow: null },
      models: { anthropic: 'claude-sonnet-4-6', local: null, 'local-tutor': null },
      base_url: { local: 'absent', 'local-tutor': 'absent' },
      decoding: { evaluate: { temperature: 0, max_tokens: 4096 }, shadow: { temperature: 0, max_tokens: 4096 } },
    });
    // The five the default env always drifts by (an engine observed by an earlier test may add one more).
    expect(res.body.drift.map((d) => d.key)).toEqual(expect.arrayContaining([
      'declared.providers.chat', 'declared.providers.criteria', 'declared.providers.discuss',
      'declared.providers.evaluate', 'declared.local.model',
    ]));
  });
});
