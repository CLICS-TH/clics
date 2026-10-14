// GET /health/deep readiness probe. Hermetic: the Anthropic SDK and Supabase are mocked so no key,
// network, or token is needed. The SDK mock constructs fine at module-load (claude.js line 9) and is
// only made to throw on demand (constructor-down case) — and we assert messages.create is NEVER
// called, proving the deep check spends zero Anthropic tokens.
let mockConstructorShouldThrow = false;
const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => function Anthropic() {
  if (mockConstructorShouldThrow) throw new Error('SDK init failed');
  return { messages: { create: mockMessagesCreate } };
});

let mockSupabaseResult = { count: 1, error: null };
let mockSupabaseHang = false;
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        limit: () => (mockSupabaseHang ? new Promise(() => {}) : Promise.resolve(mockSupabaseResult)),
      }),
    }),
  },
}));

// Tiny timeout so the "supabase hangs" case resolves fast. Set BEFORE requiring the app (health.js
// reads it at module load).
process.env.HEALTH_PROBE_TIMEOUT_MS = '50';
process.env.ANTHROPIC_API_KEY = 'sk-test-key';
// src/index.js runs dotenv.config(), so a developer rimpl/.env that sets AI_PROVIDER=local would
// make this suite resolve the local provider and issue a REAL outbound fetch to the DGX — failing
// the run and breaking the hermetic-test rule. Pin the anthropic default regardless of .env.
const AI_ENV_KEYS = ['AI_PROVIDER', 'AI_PROVIDER_CHAT', 'AI_PROVIDER_EVALUATE', 'AI_PROVIDER_CRITERIA', 'AI_PROVIDER_DISCUSS', 'CHAT_FAILOVER_PROVIDER'];
const savedAiEnv = {};
for (const k of AI_ENV_KEYS) { savedAiEnv[k] = process.env[k]; delete process.env[k]; }
afterAll(() => {
  for (const k of AI_ENV_KEYS) {
    if (savedAiEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedAiEnv[k];
  }
});

const request = require('supertest');
const app = require('../src/index');

describe('GET /health/deep (rimpl)', () => {
  beforeEach(() => {
    mockConstructorShouldThrow = false;
    mockSupabaseHang = false;
    for (const k of AI_ENV_KEYS) delete process.env[k]; // no test may leak a provider override
    mockSupabaseResult = { count: 1, error: null };
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    mockMessagesCreate.mockClear();
  });

  test('all dependencies up → 200 ok with the pinned model', async () => {
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('rimpl');
    expect(res.body.model).toBe('claude-sonnet-4-6');
    expect(res.body.checks.anthropic_key.status).toBe('up');
    expect(res.body.checks.anthropic_client.status).toBe('up');
    expect(res.body.checks.supabase.status).toBe('up');
  });

  test('missing ANTHROPIC_API_KEY → 503 degraded', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.anthropic_key.status).toBe('down');
  });

  test('Anthropic client not constructible → 503, and zero token spend', async () => {
    mockConstructorShouldThrow = true;
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.anthropic_client.status).toBe('down');
    expect(mockMessagesCreate).toHaveBeenCalledTimes(0); // never calls the completion API
  });

  test('Supabase error → 503 degraded', async () => {
    mockSupabaseResult = { count: null, error: { message: 'connection refused' } };
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.supabase.status).toBe('down');
    expect(res.body.checks.supabase.error).toMatch(/connection refused/);
  });

  test('Supabase timeout → down (no hang) + 503', async () => {
    mockSupabaseHang = true;
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.supabase.status).toBe('down');
    expect(res.body.checks.supabase.error).toMatch(/timeout/);
  });

  test('reachable without the x-internal-token (mounted before the auth gate)', async () => {
    const res = await request(app).get('/health/deep'); // no x-internal-token header
    expect(res.status).not.toBe(401);
    expect(res.body.service).toBe('rimpl');
  });

  // Live queue depth per provider — but only for the providers this deployment actually routes to.
  test('queues: reports the active provider only (anthropic here), with the runner stats shape', async () => {
    const res = await request(app).get('/health/deep');
    expect(res.body.queues).toEqual({
      anthropic: { provider: 'anthropic', active: 0, queued: 0, maxConcurrency: expect.any(Number),
        lastOk: null, lastError: null },
    });
    expect(res.body.queues.local).toBeUndefined();   // not active → not reported, not even probed
  });

  test('queues: a hybrid reports both providers, and the local one exposes its two lanes — with no network call', async () => {
    const LOCAL_KEYS = ['LOCAL_AI_BASE_URL', 'LOCAL_AI_MODEL'];
    const saved = Object.fromEntries(LOCAL_KEYS.map((k) => [k, process.env[k]]));
    for (const k of LOCAL_KEYS) delete process.env[k];   // unconfigured local: its probe fails on config, never on the wire
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no network in tests'));
    try {
      process.env.AI_PROVIDER_CHAT = 'local';
      const res = await request(app).get('/health/deep');
      expect(Object.keys(res.body.queues).sort()).toEqual(['anthropic', 'local']);
      expect(res.body.queues.local).toEqual({
        provider: 'local', active: 0, queued: 0, maxConcurrency: expect.any(Number),
        lanes: {
          interactive: { active: 0, queued: 0, maxQueue: expect.any(Number) },
          background: { active: 0, queued: 0, maxQueue: expect.any(Number), maxActive: expect.any(Number) },
        },
        // The self-calibrating 413 backstop's learnt estimate/served ratio — null/0 until a call is served.
        prompt_calibration: { ratio: null, n: 0 },
        // Added 2026-09-05: the last outcome the runner observed, so readiness can distinguish
        // "cannot serve" from "idle" with no extra call. Null here — nothing has run.
        lastOk: null, lastError: null,
      });
      expect(res.status).toBe(503);                          // unconfigured local is (correctly) down…
      expect(res.body.checks.local_ai.status).toBe('down');
      expect(fetchSpy).not.toHaveBeenCalled();               // …without a single outbound request
    } finally {
      fetchSpy.mockRestore();
      for (const k of LOCAL_KEYS) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });

  // The on-prem TUTOR provider (providers/local-tutor.js) ships dormant. A deployment that never
  // routes to it must not be probed for it, reported degraded for it, or show its queue — whatever its
  // env says. Routed to and unconfigured, it is (correctly) down, under its OWN check key.
  test('local-tutor dormant: no local_tutor_ai check, no queue, still 200 — even with its env unset', async () => {
    const TUTOR_KEYS = ['LOCAL_TUTOR_AI_BASE_URL', 'LOCAL_TUTOR_AI_MODEL'];
    const saved = Object.fromEntries(TUTOR_KEYS.map((k) => [k, process.env[k]]));
    for (const k of TUTOR_KEYS) delete process.env[k];
    try {
      const res = await request(app).get('/health/deep');
      expect(res.status).toBe(200);
      expect(res.body.checks).not.toHaveProperty('local_tutor_ai');
      expect(res.body.queues).not.toHaveProperty('local-tutor');
      expect(res.body.providers).toEqual(['anthropic']);
    } finally {
      for (const k of TUTOR_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });

  test('local-tutor routed for chat but unconfigured: 503, local_tutor_ai down, its own queue reported — no outbound request', async () => {
    const TUTOR_KEYS = ['LOCAL_TUTOR_AI_BASE_URL', 'LOCAL_TUTOR_AI_MODEL'];
    const saved = Object.fromEntries(TUTOR_KEYS.map((k) => [k, process.env[k]]));
    for (const k of TUTOR_KEYS) delete process.env[k];
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no network in tests'));
    try {
      process.env.AI_PROVIDER_CHAT = 'local-tutor';
      const res = await request(app).get('/health/deep');
      expect(res.status).toBe(503);
      expect(res.body.checks.local_tutor_ai).toEqual({ status: 'down', error: 'LOCAL_TUTOR_AI_BASE_URL not set' });
      expect(res.body.checks.anthropic_key.status).toBe('up');      // the other side of the hybrid is unaffected
      expect(res.body.checks).not.toHaveProperty('local_ai');      // the evaluator box is not active here
      expect(res.body.models.chat).toEqual({ provider: 'local-tutor', model: '' });
      expect(Object.keys(res.body.queues).sort()).toEqual(['anthropic', 'local-tutor']);
      expect(res.body.queues['local-tutor']).toMatchObject({ provider: 'local-tutor', active: 0, queued: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      for (const k of TUTOR_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });

  test('evaluate routed to local-tutor is reported down as a ROUTING fault, not hidden behind a healthy box', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no network in tests'));
    try {
      process.env.AI_PROVIDER_EVALUATE = 'local-tutor';
      const res = await request(app).get('/health/deep');
      expect(res.status).toBe(503);
      expect(res.body.checks.evaluate_routing).toMatchObject({ status: 'down', error: expect.stringMatching(/"local-tutor" cannot serve "evaluate"/) });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // The chat fail-over target (CHAT_FAILOVER_PROVIDER) is probed too, so a fail-over that could not
  // work — no ANTHROPIC_API_KEY on an all-local box — is visible here, before the outage it is meant
  // to cover. It is probed, not made active: `providers` and `queues` still name only what routes.
  test('a configured chat fail-over target is probed: missing ANTHROPIC_API_KEY on an all-local box → anthropic_key down', async () => {
    const LOCAL_KEYS = ['LOCAL_AI_BASE_URL', 'LOCAL_AI_MODEL'];
    const saved = Object.fromEntries(LOCAL_KEYS.map((k) => [k, process.env[k]]));
    for (const k of LOCAL_KEYS) delete process.env[k];
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no network in tests'));
    try {
      process.env.AI_PROVIDER = 'local';
      process.env.CHAT_FAILOVER_PROVIDER = 'anthropic';
      delete process.env.ANTHROPIC_API_KEY;
      const res = await request(app).get('/health/deep');
      expect(res.status).toBe(503);
      expect(res.body.checks.anthropic_key).toEqual({ status: 'down', error: 'ANTHROPIC_API_KEY not set' });
      expect(res.body.providers).toEqual(['local']);          // not active — routing unchanged
      expect(Object.keys(res.body.queues)).toEqual(['local']);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      for (const k of LOCAL_KEYS) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });
});

// `routing` — WHERE the per-purpose routing came from (services/provider-settings.js). The sandbox smoke
// runs a laptop stack against the shared production database with PROVIDER_SETTINGS_SOURCE=env and
// refuses to run unless this endpoint PROVES the override is active, so `routing.override` is contract.
describe('GET /health/deep — routing.override (PROVIDER_SETTINGS_SOURCE)', () => {
  // Same hygiene as the describe above: a test that set AI_PROVIDER_CHAT must not leak into these.
  beforeEach(() => { for (const k of AI_ENV_KEYS) delete process.env[k]; });

  test('default configuration → override:false (env-sourced or database-sourced, but never overridden)', async () => {
    const res = await request(app).get('/health/deep');
    expect(res.body.routing).toMatchObject({ override: false });
    expect(['env', 'database']).toContain(res.body.routing.source);
  });

  test('PROVIDER_SETTINGS_SOURCE=env → override:true, source env, reason named — and routing follows env', async () => {
    // The source is read at module load, so boot a second app instance in an isolated registry (the
    // jest.mock factories above still apply to it). This asserts the CONTRACT the smoke reads; the
    // structural proof that no app_settings read happens lives in tests/provider-settings-source.test.js.
    process.env.PROVIDER_SETTINGS_SOURCE = 'env';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let envApp;
    try {
      jest.isolateModules(() => { envApp = require('../src/index'); });
      const res = await request(envApp).get('/health/deep');
      expect(res.body.routing).toEqual({
        source: 'env', override: true, reason: 'PROVIDER_SETTINGS_SOURCE=env', evaluator_locked_at: null,
      });
      expect(res.body.models.chat).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' }); // env chain, unset → default
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/PROVIDER_SETTINGS_SOURCE=env/));
    } finally {
      warnSpy.mockRestore();
      delete process.env.PROVIDER_SETTINGS_SOURCE;
    }
  });
});
