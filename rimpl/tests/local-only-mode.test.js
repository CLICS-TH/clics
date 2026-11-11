// LOCAL-ONLY MODE (#428, ADR 0012): with CLICS_LOCAL_ONLY=1, RIMPL refuses every provider other than the
// on-prem evaluator (`local`) and the on-prem tutor (`local-tutor`), for every purpose, BEFORE a request is
// sent. Off by default.
//
// Every case is run twice. Mode OFF is the CONTROL: today's code sends the request (the stubbed client is
// called). Mode ON: the same configuration is refused and the stub is never called. A test that passed
// with the mode off would prove nothing about the guard.
//
// HERMETIC: every provider and the Supabase client are mocked at the module boundary (no key, no socket).
// Drives the REAL services/ai.js and, where a route exists, the REAL route through src/index.js.
const mockAnthropic = {
  name: 'anthropic',
  call: jest.fn(),
  model: jest.fn(() => 'claude-sonnet-4-6'),
  ready: jest.fn(() => ({ checks: { anthropic_key: { status: process.env.ANTHROPIC_API_KEY ? 'up' : 'down' } } })),
  stats: jest.fn(() => ({ provider: 'anthropic', active: 0, queued: 0 })),
};
const mockLocal = {
  name: 'local',
  call: jest.fn(),
  model: jest.fn(() => 'deepseek-eval'),
  embed: jest.fn(async () => Array(1536).fill(0.1)),
  embedModel: jest.fn(() => 'bge-m3'),
  ready: jest.fn(async () => ({ checks: { local_ai: { status: 'up' } } })),
  stats: jest.fn(() => ({ provider: 'local', active: 0, queued: 0 })),
};
const mockTutor = {
  name: 'local-tutor',
  call: jest.fn(),
  model: jest.fn(() => 'qwen-tutor'),
  ready: jest.fn(async () => ({ checks: { local_tutor_ai: { status: 'up' } } })),
  stats: jest.fn(() => ({ provider: 'local-tutor', active: 0, queued: 0 })),
};
const mockOpenaiEmbed = {
  name: 'openai',
  embed: jest.fn(async () => Array(1536).fill(0.2)),
  embedModel: jest.fn(() => 'text-embedding-3-small'),
  model: jest.fn(() => 'text-embedding-3-small'),
  ready: jest.fn(() => ({ checks: { openai_embeddings: { status: 'up' } } })),
};
jest.mock('../src/services/providers/anthropic', () => mockAnthropic);
jest.mock('../src/services/providers/local', () => mockLocal);
jest.mock('../src/services/providers/local-tutor', () => mockTutor);
jest.mock('../src/services/providers/openai-embed', () => mockOpenaiEmbed);
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));

// app_settings: rows, or an error (the store unreachable). professionals: the /health/deep probe.
// shadow_evaluations: the shadow's persist.
const mockDb = { rows: [], error: null, upserts: [] };
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn((table) => ({
      select: jest.fn(() => ({
        in: jest.fn(async () => (mockDb.error ? { data: null, error: { message: mockDb.error } } : { data: mockDb.rows, error: null })),
        limit: jest.fn(async () => ({ count: 1, error: null })),
      })),
      upsert: jest.fn(async (row) => { mockDb.upserts.push({ table, row }); return { error: null }; }),
    })),
    rpc: jest.fn().mockResolvedValue({ data: [], error: null }),
  },
}));

const ENV = ['CLICS_LOCAL_ONLY', 'AI_PROVIDER', 'AI_PROVIDER_CHAT', 'AI_PROVIDER_EVALUATE', 'AI_PROVIDER_CRITERIA',
  'AI_PROVIDER_DISCUSS', 'AI_PROVIDER_EMBED', 'EMBED_PROVIDER', 'CHAT_FAILOVER_PROVIDER', 'SHADOW_EVAL_PROVIDER',
  'PROVIDER_SETTINGS_SOURCE', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'RAG_EMBED_DIM'];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
for (const k of ENV) delete process.env[k];
afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

const request = require('supertest');
const app = require('../src/index');
const ai = require('../src/services/ai');
const settings = require('../src/services/provider-settings');
const { shadowTarget, runShadowEvaluation } = require('../src/services/shadow');
const { localOnly } = require('../src/lib/provider-policy');

// A reply WITH a (Source, Year) citation, so routes/chat.js's citation retry does not fire.
const REPLY = { text: 'ควรตรวจ troponin ซ้ำที่ 3 ชั่วโมง (ESC, 2023).', inputTokens: 100, outputTokens: 20, tokenCount: 120, stopReason: 'end_turn' };
const SCORES = JSON.stringify({ d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, rationale: { d1: 'r', d2: 'r', d3: 'r', d4: 'r', d5: 'r', d6: 'r', d7: 'r' } });
const chatBody = () => ({ ple_id: 'x', history: [], message: 'ผู้ป่วยเจ็บหน้าอก 2 ชั่วโมง', language: 'th' });
const args = (purpose) => ({ purpose, systemPrompt: 'sys', messages: [{ role: 'user', content: 'de-identified text' }], maxTokens: 900 });
const connRefused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
const sent = () => mockAnthropic.call.mock.calls.length + mockOpenaiEmbed.embed.mock.calls.length;

let warnSpy, errSpy;
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  mockDb.rows = []; mockDb.error = null; mockDb.upserts = [];
  settings.__resetForTests();
  jest.clearAllMocks();
  mockAnthropic.call.mockReset().mockResolvedValue({ ...REPLY, model: 'claude-sonnet-4-6' });
  mockLocal.call.mockReset().mockResolvedValue({ ...REPLY, model: 'deepseek-eval' });
  mockTutor.call.mockReset().mockResolvedValue({ ...REPLY, model: 'qwen-tutor' });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { warnSpy.mockRestore(); errSpy.mockRestore(); });

const MODES = [['off (control: today\'s code sends it)', undefined], ['on', '1']];
const setMode = (v) => { if (v === undefined) delete process.env.CLICS_LOCAL_ONLY; else process.env.CLICS_LOCAL_ONLY = v; };

describe('the switch itself', () => {
  test.each([[undefined, false], ['', false], ['0', false], ['false', false], ['OFF', false], ['no', false],
    ['1', true], ['true', true], ['yes', true], ['l', true]])('CLICS_LOCAL_ONLY=%p -> on=%p (any value that is not an off spelling is ON)', (v, on) => {
    setMode(v);
    expect(localOnly()).toBe(on);
  });

  test('with the mode on and nothing configured, every purpose defaults to the on-prem evaluator, never anthropic/openai', () => {
    setMode('1');
    for (const p of ai.PURPOSES) expect(ai.providerNameFor(p)).toBe('local');
    expect(ai.embedProviderName()).toBe('local');
    setMode(undefined);
    for (const p of ai.PURPOSES) expect(ai.providerNameFor(p)).toBe('anthropic');
    expect(ai.embedProviderName()).toBe('openai');
  });
});

describe('a purpose resolved to anthropic is refused before a request is sent', () => {
  describe.each(MODES)('mode %s', (_label, mode) => {
    const on = mode === '1';

    test.each(['chat', 'evaluate', 'criteria', 'discuss'])('callAI(%s) routed to anthropic by env', async (purpose) => {
      setMode(mode);
      process.env.AI_PROVIDER = 'anthropic';
      const p = ai.callAI(args(purpose));
      if (on) {
        await expect(p).rejects.toMatchObject({ code: 'local_only_refused', status: 503, provider: 'anthropic', purpose });
        expect(mockAnthropic.call).not.toHaveBeenCalled();
      } else {
        await expect(p).resolves.toMatchObject({ provider: 'anthropic' });
        expect(mockAnthropic.call).toHaveBeenCalledTimes(1);
      }
    });

    test('routed to anthropic by an app_settings row (the superadmin switch)', async () => {
      setMode(mode);
      process.env.SUPABASE_URL = 'http://db.invalid';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
      process.env.AI_PROVIDER = 'local';
      mockDb.rows = [{ key: 'ai_provider_chat', value_text: 'anthropic' }];
      const p = ai.callAI(args('chat'));
      if (on) {
        await expect(p).rejects.toMatchObject({ code: 'local_only_refused' });
        await expect(p).rejects.toThrow(/app_settings\.ai_provider_chat/);
      } else {
        await expect(p).resolves.toMatchObject({ provider: 'anthropic' });
      }
      expect(mockAnthropic.call).toHaveBeenCalledTimes(on ? 0 : 1);
    });

    test('a call PINNED to anthropic', async () => {
      setMode(mode);
      process.env.AI_PROVIDER = 'local';
      const p = ai.callAI({ ...args('chat'), provider: 'anthropic' });
      if (on) await expect(p).rejects.toMatchObject({ code: 'local_only_refused' });
      else await expect(p).resolves.toMatchObject({ provider: 'anthropic' });
      expect(mockAnthropic.call).toHaveBeenCalledTimes(on ? 0 : 1);
    });

    test('POST /chat routed to anthropic: 503 local_only_refused, and nothing reaches the provider', async () => {
      setMode(mode);
      process.env.AI_PROVIDER = 'anthropic';
      const res = await request(app).post('/chat').send(chatBody());
      if (on) {
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ code: 'local_only_refused', provider: 'anthropic', purpose: 'chat' });
        expect(res.body.error).toMatch(/Local-only mode/);
      } else {
        expect(res.status).toBe(200);
      }
      expect(mockAnthropic.call).toHaveBeenCalledTimes(on ? 0 : 1);
    });

    test('POST /evaluate routed to anthropic: 503 local_only_refused (the backend requeues a 503), nothing sent', async () => {
      setMode(mode);
      process.env.AI_PROVIDER = 'anthropic';
      mockAnthropic.call.mockResolvedValue({ ...REPLY, text: SCORES, model: 'claude-sonnet-4-6' });
      const res = await request(app).post('/evaluate').send({ ple_id: 'x', transcript: [{ role: 'physician', content: 'chest pain' }] });
      if (on) {
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('local_only_refused');
      } else {
        expect(res.status).toBe(200);
      }
      expect(mockAnthropic.call).toHaveBeenCalledTimes(on ? 0 : 1);
    });

    test('embed routed to openai', async () => {
      setMode(mode);
      process.env.EMBED_PROVIDER = 'openai';
      const p = ai.embedText('de-identified query');
      if (on) await expect(p).rejects.toMatchObject({ code: 'local_only_refused', provider: 'openai', purpose: 'embed' });
      else await expect(p).resolves.toHaveLength(1536);
      expect(mockOpenaiEmbed.embed).toHaveBeenCalledTimes(on ? 0 : 1);
    });

    test('the local providers still serve: local for evaluate, local-tutor for chat, local for embed', async () => {
      setMode(mode);
      process.env.AI_PROVIDER_EVALUATE = 'local';
      process.env.AI_PROVIDER_CHAT = 'local-tutor';
      process.env.EMBED_PROVIDER = 'local';
      await expect(ai.callAI(args('evaluate'))).resolves.toMatchObject({ provider: 'local' });
      await expect(ai.callAI(args('chat'))).resolves.toMatchObject({ provider: 'local-tutor' });
      await expect(ai.embedText('q')).resolves.toHaveLength(1536);
      expect(sent()).toBe(0);
    });
  });
});

describe('CHAT_FAILOVER_PROVIDER and SHADOW_EVAL_PROVIDER naming a commercial provider are refused', () => {
  describe.each(MODES)('mode %s', (_label, mode) => {
    const on = mode === '1';

    test('the tutor is down and the fail-over names anthropic', async () => {
      setMode(mode);
      process.env.AI_PROVIDER_CHAT = 'local-tutor';
      process.env.CHAT_FAILOVER_PROVIDER = 'anthropic';
      mockTutor.call.mockRejectedValue(connRefused());
      const p = ai.callAI(args('chat'));
      if (on) await expect(p).rejects.toMatchObject({ name: 'TypeError' });   // the primary's own error: fails closed
      else await expect(p).resolves.toMatchObject({ provider: 'anthropic', failed_over_from: 'local-tutor' });
      expect(mockAnthropic.call).toHaveBeenCalledTimes(on ? 0 : 1);
    });

    test('POST /chat with the tutor down: mode on answers 503 ai_unavailable (no fail-over); mode off fails over as today', async () => {
      setMode(mode);
      process.env.AI_PROVIDER_CHAT = 'local-tutor';
      process.env.CHAT_FAILOVER_PROVIDER = 'anthropic';
      mockTutor.call.mockRejectedValue(connRefused());
      const res = await request(app).post('/chat').send(chatBody());
      if (on) {
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'AI temporarily unavailable. Your session is saved.', code: 'ai_unavailable' });
      } else {
        expect(res.status).toBe(200);
        expect(res.body.provider).toBe('anthropic');
      }
      expect(mockAnthropic.call).toHaveBeenCalledTimes(on ? 0 : 1);
    });

    test('the shadow evaluator names anthropic', async () => {
      setMode(mode);
      process.env.AI_PROVIDER_EVALUATE = 'local';
      process.env.SHADOW_EVAL_PROVIDER = 'anthropic';
      mockAnthropic.call.mockResolvedValue({ ...REPLY, text: SCORES, model: 'claude-sonnet-4-6' });
      expect(shadowTarget('local')).toBe(on ? null : 'anthropic');
      const r = await runShadowEvaluation({ pleId: 'x', transcriptText: 'de-identified', servedProvider: 'local' });
      if (on) expect(r).toEqual({ skipped: true });
      else expect(r).toMatchObject({ persisted: true, provider: 'anthropic' });
      expect(mockAnthropic.call).toHaveBeenCalledTimes(on ? 0 : 1);
    });

    test('callProvider (the shadow\'s transport) refuses anthropic as the backstop', async () => {
      setMode(mode);
      const p = ai.callProvider({ provider: 'anthropic', purpose: 'shadow', systemPrompt: 's', messages: [{ role: 'user', content: 't' }] });
      if (on) await expect(p).rejects.toMatchObject({ code: 'local_only_refused' });
      else await expect(p).resolves.toMatchObject({ provider: 'anthropic' });
      expect(mockAnthropic.call).toHaveBeenCalledTimes(on ? 0 : 1);
    });
  });
});

describe('a cold settings cache (store unreachable since boot) refuses every purpose instead of defaulting', () => {
  describe.each(MODES)('mode %s', (_label, mode) => {
    const on = mode === '1';
    beforeEach(() => {
      setMode(mode);
      process.env.SUPABASE_URL = 'http://db.invalid';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
      mockDb.error = 'connect ECONNREFUSED';
    });

    test.each(['chat', 'evaluate', 'criteria', 'discuss'])('callAI(%s)', async (purpose) => {
      const p = ai.callAI(args(purpose));
      if (on) {
        await expect(p).rejects.toMatchObject({ code: 'local_only_refused', purpose });
        await expect(p).rejects.toThrow(/app_settings has not been readable/);
      } else {
        await expect(p).resolves.toMatchObject({ provider: 'anthropic' });   // today: env, then the default
      }
      expect(mockAnthropic.call).toHaveBeenCalledTimes(on ? 0 : 1);
      expect(mockLocal.call).not.toHaveBeenCalled();
    });

    test('embed', async () => {
      const p = ai.embedText('q');
      if (on) await expect(p).rejects.toMatchObject({ code: 'local_only_refused', purpose: 'embed' });
      else await expect(p).resolves.toHaveLength(1536);
      expect(mockOpenaiEmbed.embed).toHaveBeenCalledTimes(on ? 0 : 1);
      expect(mockLocal.embed).not.toHaveBeenCalled();
    });

    test('even when env names the on-prem model: the database row it cannot read might say otherwise', async () => {
      process.env.AI_PROVIDER = 'local';
      const p = ai.callAI(args('evaluate'));
      if (on) await expect(p).rejects.toMatchObject({ code: 'local_only_refused' });
      else await expect(p).resolves.toMatchObject({ provider: 'local' });
      expect(mockLocal.call).toHaveBeenCalledTimes(on ? 0 : 1);
    });

    test('once the store answers, the cache is warm and local routing serves again', async () => {
      process.env.AI_PROVIDER = 'local';
      await ai.callAI(args('chat')).catch(() => {});
      mockDb.error = null;
      await expect(ai.callAI(args('chat'))).resolves.toMatchObject({ provider: 'local' });
    });
  });
});

describe('GET /health/deep', () => {
  test('reports local_only: off by default, and the mode changes nothing about a cloud-routed box', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);
    expect(res.body.local_only).toBe('off');
    expect(res.body.checks.anthropic_key.status).toBe('up');
  });

  test('mode off with the Anthropic key absent is degraded, as today (control)', async () => {
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.anthropic_key.status).toBe('down');
  });

  test('mode on with the Anthropic key absent: local_only on, not degraded, anthropic never probed', async () => {
    setMode('1');
    process.env.AI_PROVIDER_CHAT = 'local-tutor';
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.local_only).toBe('on');
    expect(res.body.checks.anthropic_key).toBeUndefined();
    expect(mockAnthropic.ready).not.toHaveBeenCalled();
    expect(res.body.checks.local_ai.status).toBe('up');
    expect(res.body.checks.local_tutor_ai.status).toBe('up');
  });

  test('mode on with a purpose still routed to anthropic: degraded by that ROUTING, not by the key', async () => {
    setMode('1');
    process.env.AI_PROVIDER_EVALUATE = 'anthropic';
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.evaluate_routing).toMatchObject({ status: 'down' });
    expect(res.body.checks.evaluate_routing.error).toMatch(/local-only mode refuses "anthropic"/);
    expect(res.body.checks.anthropic_key).toBeUndefined();
  });

  test('mode on with a commercial fail-over configured: a warning, not an outage, and it is not probed', async () => {
    setMode('1');
    process.env.CHAT_FAILOVER_PROVIDER = 'anthropic';
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);
    expect(res.body.checks.chat_failover).toMatchObject({ status: 'warn' });
    expect(res.body.warnings).toContain('chat_failover');
    expect(mockAnthropic.ready).not.toHaveBeenCalled();
  });

  test('mode on with the settings store unreachable since boot: degraded, every purpose refuses', async () => {
    setMode('1');
    process.env.SUPABASE_URL = 'http://db.invalid';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
    mockDb.error = 'connect ECONNREFUSED';
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.local_only_settings).toMatchObject({ status: 'down' });
  });
});

describe('the readiness probe behind the superadmin switch', () => {
  test.each(MODES)('mode %s: probing anthropic', async (_label, mode) => {
    setMode(mode);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const v = await ai.probeProvider('anthropic', 'chat');
    if (mode === '1') {
      expect(v).toMatchObject({ fit: false, code: 'local_only_refused' });
      expect(mockAnthropic.ready).not.toHaveBeenCalled();
    } else {
      expect(v).toMatchObject({ fit: true });
    }
  });

  test('mode on: probing the openai embedder never embeds a string at the vendor', async () => {
    setMode('1');
    const v = await ai.probeProvider('openai', 'embed');
    expect(v).toMatchObject({ fit: false, code: 'local_only_refused' });
    expect(mockOpenaiEmbed.embed).not.toHaveBeenCalled();
  });
});
