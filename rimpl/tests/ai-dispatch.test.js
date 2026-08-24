// services/ai.js — the single AI seam. Routes declare a PURPOSE; this module decides the vendor.
//
// HERMETIC: both provider modules are mocked at the module boundary, so nothing constructs an
// Anthropic client, reads a key, or opens a socket.
//
// Resolution order, per call:  AI_PROVIDER_<PURPOSE>  →  AI_PROVIDER  →  'anthropic'
//
// The three things that MUST NOT regress:
//   1. Default (env unset) is anthropic for every purpose — prod behaviour is unchanged until
//      someone deliberately flips AI_PROVIDER.
//   2. The hybrid (chat/criteria/discuss local, evaluate on Anthropic) is the shipping config.
//   3. An unknown provider name THROWS. A silent fallback to anthropic would mean paying cloud
//      rates while believing you were on-prem, and scoring PIS-7 under a model nobody intended.

const mockAnthropic = {
  name: 'anthropic',
  call: jest.fn(async () => ({ text: 'A', inputTokens: 1, outputTokens: 2, tokenCount: 3, stopReason: 'end_turn', model: 'claude-sonnet-4-6' })),
  model: jest.fn(() => 'claude-sonnet-4-6'),
  ready: jest.fn(() => ({ checks: { anthropic_key: { status: 'up' }, anthropic_client: { status: 'up' } } })),
  stats: jest.fn(() => ({ provider: 'anthropic', active: 0, queued: 0 })),
};

const mockLocal = {
  name: 'local',
  call: jest.fn(async () => ({ text: 'L', inputTokens: 10, outputTokens: 20, tokenCount: 30, stopReason: 'end_turn', model: 'qwen3-32b-medical' })),
  model: jest.fn(() => 'qwen3-32b-medical'),
  ready: jest.fn(async () => ({ checks: { local_ai: { status: 'up', model: 'qwen3-32b-medical' } } })),
  stats: jest.fn(() => ({ provider: 'local', active: 0, queued: 0, maxConcurrency: 24 })),
};

jest.mock('../src/services/providers/anthropic', () => mockAnthropic);
jest.mock('../src/services/providers/local', () => mockLocal);

const AI_ENV = ['AI_PROVIDER', 'AI_PROVIDER_CHAT', 'AI_PROVIDER_EVALUATE', 'AI_PROVIDER_CRITERIA', 'AI_PROVIDER_DISCUSS'];
let savedEnv;

// ONE module instance for the whole file: resolution is per call, so nothing here needs a reload.
const ai = require('../src/services/ai');

beforeEach(() => {
  savedEnv = Object.fromEntries(AI_ENV.map((k) => [k, process.env[k]]));
  for (const k of AI_ENV) delete process.env[k];
  jest.clearAllMocks();
});

afterEach(() => {
  for (const k of AI_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const PURPOSES = ['chat', 'evaluate', 'criteria', 'discuss'];
const args = (purpose) => ({
  purpose,
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'de-identified text' }],
  maxTokens: 900,
  temperature: 0.3,
});

// ---------------------------------------------------------------------------
describe('default: no env at all', () => {
  test('every purpose resolves to anthropic', () => {
    expect(ai.PURPOSES).toEqual(PURPOSES);
    for (const p of PURPOSES) expect(ai.providerNameFor(p)).toBe('anthropic');
    expect(ai.providerNameFor(null)).toBe('anthropic');
    expect(ai.defaultProvider()).toBe(mockAnthropic);
  });

  test('every purpose actually CALLS anthropic and never local', async () => {
    for (const p of PURPOSES) await ai.callAI(args(p));
    expect(mockAnthropic.call).toHaveBeenCalledTimes(4);
    expect(mockLocal.call).not.toHaveBeenCalled();
  });

  test('activeProviders() is exactly ["anthropic"]', () => {
    expect(ai.activeProviders()).toEqual(['anthropic']);
  });
});

// ---------------------------------------------------------------------------
describe('AI_PROVIDER=local', () => {
  beforeEach(() => { process.env.AI_PROVIDER = 'local'; });

  test('routes every purpose to local', async () => {
    for (const p of PURPOSES) {
      expect(ai.providerNameFor(p)).toBe('local');
      await ai.callAI(args(p));
    }
    expect(mockLocal.call).toHaveBeenCalledTimes(4);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
    expect(ai.activeProviders()).toEqual(['local']);
  });

  test('is case- and whitespace-tolerant ("  LOCAL  " is still local)', () => {
    process.env.AI_PROVIDER = '  LOCAL  ';
    expect(ai.providerNameFor('chat')).toBe('local');
    expect(ai.defaultProvider()).toBe(mockLocal);
  });

  test('an empty AI_PROVIDER falls through to the anthropic default', () => {
    process.env.AI_PROVIDER = '';
    expect(ai.providerNameFor('chat')).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
describe('the HYBRID the roadmap ships: evaluate on Anthropic, everything else local', () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = 'local';
    process.env.AI_PROVIDER_EVALUATE = 'anthropic';
  });

  test('per-purpose override beats AI_PROVIDER', () => {
    expect(ai.providerNameFor('evaluate')).toBe('anthropic');
    expect(ai.providerNameFor('chat')).toBe('local');
    expect(ai.providerNameFor('criteria')).toBe('local');
    expect(ai.providerNameFor('discuss')).toBe('local');
  });

  test('PIS-7 scoring goes to Anthropic; chat/criteria/discuss go to the DGX', async () => {
    const evaluated = await ai.callAI(args('evaluate'));
    expect(evaluated.provider).toBe('anthropic');
    expect(evaluated.model).toBe('claude-sonnet-4-6');

    for (const p of ['chat', 'criteria', 'discuss']) {
      const r = await ai.callAI(args(p));
      expect(r.provider).toBe('local');
      expect(r.model).toBe('qwen3-32b-medical');
    }

    expect(mockAnthropic.call).toHaveBeenCalledTimes(1);
    expect(mockLocal.call).toHaveBeenCalledTimes(3);
  });

  test('activeProviders() is the UNION of both, deduped', () => {
    expect(ai.activeProviders().sort()).toEqual(['anthropic', 'local']);
  });

  test('readiness() probes BOTH sides and merges their checks', async () => {
    const checks = await ai.readiness();
    expect(mockAnthropic.ready).toHaveBeenCalledTimes(1);
    expect(mockLocal.ready).toHaveBeenCalledTimes(1);
    expect(checks).toMatchObject({
      anthropic_key: { status: 'up' },
      local_ai: { status: 'up', model: 'qwen3-32b-medical' },
    });
  });

  test('the inverse hybrid also works (chat pinned to anthropic under AI_PROVIDER=local)', async () => {
    delete process.env.AI_PROVIDER_EVALUATE;
    process.env.AI_PROVIDER_CHAT = 'anthropic';
    expect(ai.providerNameFor('chat')).toBe('anthropic');
    expect(ai.providerNameFor('evaluate')).toBe('local');
  });
});

// ---------------------------------------------------------------------------
describe('unknown provider must FAIL LOUDLY, never fall back', () => {
  test('AI_PROVIDER typo throws and calls nobody', async () => {
    process.env.AI_PROVIDER = 'antropic'; // typo
    await expect(ai.callAI(args('chat'))).rejects.toThrow(/Unknown AI provider "antropic"/);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
    expect(mockLocal.call).not.toHaveBeenCalled();
  });

  test('the error names the valid providers so ops can fix it from the log alone', async () => {
    process.env.AI_PROVIDER = 'ollama';
    const err = await ai.callAI(args('chat')).then(() => null, (e) => e);
    expect(err.message).toMatch(/Valid: anthropic, local/);
  });

  test('a per-purpose typo throws for THAT purpose only', async () => {
    process.env.AI_PROVIDER = 'local';
    process.env.AI_PROVIDER_EVALUATE = 'clause';
    await expect(ai.callAI(args('evaluate'))).rejects.toThrow(/Unknown AI provider "clause"/);
    // …and names the per-purpose var, not just AI_PROVIDER.
    await expect(ai.callAI(args('evaluate'))).rejects.toThrow(/AI_PROVIDER_EVALUATE/);
    await expect(ai.callAI(args('chat'))).resolves.toMatchObject({ provider: 'local' });
  });

  test('defaultProvider() throws on an unknown name (health.js guards it with try/catch)', () => {
    process.env.AI_PROVIDER = 'nope';
    expect(() => ai.defaultProvider()).toThrow(/Unknown AI provider/);
  });

  test('an unknown PURPOSE throws before any provider is chosen', async () => {
    await expect(ai.callAI(args('summarise'))).rejects.toThrow(/Unknown AI purpose "summarise"/);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('resolution is PER CALL (a rollback is an env change + the next request)', () => {
  test('flipping process.env between two awaits flips the provider — no reload', async () => {
    const first = await ai.callAI(args('chat'));
    expect(first.provider).toBe('anthropic');

    process.env.AI_PROVIDER = 'local';
    const second = await ai.callAI(args('chat'));
    expect(second.provider).toBe('local');

    delete process.env.AI_PROVIDER;               // rolled back
    const third = await ai.callAI(args('chat'));
    expect(third.provider).toBe('anthropic');

    expect(mockAnthropic.call).toHaveBeenCalledTimes(2);
    expect(mockLocal.call).toHaveBeenCalledTimes(1);
  });

  test('activeProviders() re-reads the env too', () => {
    expect(ai.activeProviders()).toEqual(['anthropic']);
    process.env.AI_PROVIDER_CHAT = 'local';
    expect(ai.activeProviders().sort()).toEqual(['anthropic', 'local']);
  });
});

// ---------------------------------------------------------------------------
describe('callAI passes the request through and tags the result', () => {
  test('forwards systemPrompt/messages/maxTokens/temperature verbatim, and NOT the purpose', async () => {
    process.env.AI_PROVIDER = 'local';
    await ai.callAI(args('chat'));

    expect(mockLocal.call).toHaveBeenCalledWith({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'de-identified text' }],
      maxTokens: 900,
      temperature: 0.3,
    });
    // The provider is a dumb transport: it must not learn the purpose (nothing to branch on).
    expect(Object.keys(mockLocal.call.mock.calls[0][0])).not.toContain('purpose');
  });

  test('returns provider + model alongside the text and token counts', async () => {
    process.env.AI_PROVIDER = 'local';
    const r = await ai.callAI(args('chat'));
    expect(r).toEqual({
      text: 'L', inputTokens: 10, outputTokens: 20, tokenCount: 30, stopReason: 'end_turn',
      provider: 'local', model: 'qwen3-32b-medical',
    });
  });

  test('the model the PROVIDER RESULT reports wins (§10.2 provenance)', async () => {
    process.env.AI_PROVIDER = 'local';
    mockLocal.call.mockResolvedValueOnce({ text: 'L', inputTokens: 0, outputTokens: 0, tokenCount: 0, stopReason: 'end_turn', model: 'qwen3-32b-medical-v2' });
    const r = await ai.callAI(args('evaluate'));
    expect(r.model).toBe('qwen3-32b-medical-v2');
    expect(mockLocal.model).not.toHaveBeenCalled(); // no need to ask; the result already said
  });

  test('falls back to provider.model() when the result omits a model', async () => {
    process.env.AI_PROVIDER = 'local';
    mockLocal.call.mockResolvedValueOnce({ text: 'L', inputTokens: 0, outputTokens: 0, tokenCount: 0, stopReason: 'end_turn' });
    expect((await ai.callAI(args('evaluate'))).model).toBe('qwen3-32b-medical');
  });

  test('a provider error propagates unchanged (routes map it to a 502)', async () => {
    process.env.AI_PROVIDER = 'local';
    mockLocal.call.mockRejectedValueOnce(Object.assign(new Error('local AI 500'), { status: 500 }));
    await expect(ai.callAI(args('chat'))).rejects.toMatchObject({ status: 500, message: 'local AI 500' });
  });

  test('a purposeless call is allowed and uses the default provider', async () => {
    process.env.AI_PROVIDER = 'local';
    const r = await ai.callAI({ systemPrompt: 's', messages: [] });
    expect(r.provider).toBe('local');
  });
});

// ---------------------------------------------------------------------------
describe('readiness() aggregates and NEVER throws', () => {
  test('probes only the providers this deployment actually uses', async () => {
    const checks = await ai.readiness();               // default: anthropic only
    expect(mockAnthropic.ready).toHaveBeenCalledTimes(1);
    expect(mockLocal.ready).not.toHaveBeenCalled();    // an all-cloud box must not probe a DGX
    expect(checks).toHaveProperty('anthropic_key');
    expect(checks).not.toHaveProperty('local_ai');
  });

  test('an all-local deployment does not probe (or report degraded for) Anthropic', async () => {
    process.env.AI_PROVIDER = 'local';
    const checks = await ai.readiness();
    expect(mockLocal.ready).toHaveBeenCalledTimes(1);
    expect(mockAnthropic.ready).not.toHaveBeenCalled();
    expect(Object.keys(checks)).toEqual(['local_ai']);
  });

  test('each active provider is probed exactly once even though it serves 3 purposes', async () => {
    process.env.AI_PROVIDER = 'local';
    process.env.AI_PROVIDER_EVALUATE = 'anthropic';
    await ai.readiness();
    expect(mockLocal.ready).toHaveBeenCalledTimes(1);
    expect(mockAnthropic.ready).toHaveBeenCalledTimes(1);
  });

  test('a THROWING ready() becomes a down check, not a 500', async () => {
    process.env.AI_PROVIDER = 'local';
    mockLocal.ready.mockImplementationOnce(() => { throw new Error('probe exploded'); });
    const checks = await ai.readiness();
    expect(checks.local_provider).toEqual({ status: 'down', error: 'probe exploded' });
  });

  test('a REJECTING ready() becomes a down check too', async () => {
    process.env.AI_PROVIDER = 'local';
    mockLocal.ready.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const checks = await ai.readiness();
    expect(checks.local_provider).toEqual({ status: 'down', error: 'ECONNREFUSED' });
  });

  test('an unknown AI_PROVIDER is a down check — readiness() does not throw the way callAI does', async () => {
    process.env.AI_PROVIDER = 'dgx';
    await expect(ai.readiness()).resolves.toEqual({
      dgx_provider: { status: 'down', error: 'unknown provider "dgx"' },
    });
  });

  test('a hybrid is degraded when EITHER side is down', async () => {
    process.env.AI_PROVIDER = 'local';
    process.env.AI_PROVIDER_EVALUATE = 'anthropic';
    mockLocal.ready.mockResolvedValueOnce({ checks: { local_ai: { status: 'down', error: 'model not served' } } });

    const checks = await ai.readiness();
    expect(Object.values(checks).every((c) => c.status === 'up')).toBe(false);
    expect(checks.local_ai.status).toBe('down');
    expect(checks.anthropic_key.status).toBe('up');
  });
});

// ---------------------------------------------------------------------------
describe('the exported provider registry', () => {
  test('exposes exactly the two providers, keyed by the name each reports', () => {
    expect(Object.keys(ai.PROVIDERS).sort()).toEqual(['anthropic', 'local']);
    for (const [key, p] of Object.entries(ai.PROVIDERS)) expect(p.name).toBe(key);
  });

  test('every provider implements the full interface the seam depends on', () => {
    for (const p of Object.values(ai.PROVIDERS)) {
      for (const fn of ['call', 'model', 'ready', 'stats']) expect(typeof p[fn]).toBe('function');
    }
  });
});
