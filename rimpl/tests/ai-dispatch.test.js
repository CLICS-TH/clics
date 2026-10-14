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

// The on-prem TUTOR (providers/local-tutor.js): a second instance of the local transport, on its own
// endpoint and its own check key. Dormant unless a purpose names it.
const mockTutor = {
  name: 'local-tutor',
  call: jest.fn(async () => ({ text: 'T', inputTokens: 5, outputTokens: 6, tokenCount: 11, stopReason: 'end_turn', model: 'qwen-tutor' })),
  model: jest.fn(() => 'qwen-tutor'),
  ready: jest.fn(async () => ({ checks: { local_tutor_ai: { status: 'up', model: 'qwen-tutor' } } })),
  stats: jest.fn(() => ({ provider: 'local-tutor', active: 0, queued: 0, maxConcurrency: 2 })),
};

jest.mock('../src/services/providers/anthropic', () => mockAnthropic);
jest.mock('../src/services/providers/local', () => mockLocal);
jest.mock('../src/services/providers/local-tutor', () => mockTutor);

const AI_ENV = ['AI_PROVIDER', 'AI_PROVIDER_CHAT', 'AI_PROVIDER_EVALUATE', 'AI_PROVIDER_CRITERIA', 'AI_PROVIDER_DISCUSS',
  // The embed lane leaked between tests until 2026-09-05 — harmless while nothing probed it,
  // and immediately confusing once readiness() did.
  'AI_PROVIDER_EMBED', 'EMBED_PROVIDER'];
let savedEnv;

// ONE module instance for the whole file: resolution is per call, so nothing here needs a reload.
const ai = require('../src/services/ai');
const settings = require('../src/services/provider-settings');

// app_settings.rag_enabled decides whether the embed vendor is part of the serving path at all, and
// therefore whether readiness() probes it. There is no database here, so numberFor() would answer
// undefined (= off) for every test; this states the answer where a test depends on it.
const withRag = (n) => jest.spyOn(settings, 'numberFor').mockImplementation((k) => (k === 'rag_enabled' ? n : undefined));

beforeEach(() => {
  savedEnv = Object.fromEntries(AI_ENV.map((k) => [k, process.env[k]]));
  for (const k of AI_ENV) delete process.env[k];
  jest.clearAllMocks();
});

afterEach(() => {
  // jest.clearAllMocks() in beforeEach resets call history but NOT a spyOn implementation, so a
  // withRag() from one test would silently decide the next one.
  settings.numberFor.mockRestore?.();
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
  test('forwards systemPrompt/messages/maxTokens/temperature verbatim, plus purpose and signal', async () => {
    process.env.AI_PROVIDER = 'local';
    const ac = new AbortController();
    await ai.callAI({ ...args('chat'), signal: ac.signal });

    expect(mockLocal.call).toHaveBeenCalledWith({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'de-identified text' }],
      maxTokens: 900,
      temperature: 0.3,
      // The provider is still a dumb transport — it never branches on what a purpose MEANS — but it
      // needs the purpose to pick its queue lane (a chat turn must not wait behind an evaluation)
      // and the signal to cancel at the socket when the caller hangs up. Anthropic ignores both.
      purpose: 'chat',
      signal: ac.signal,
    });
  });

  test('callProvider forwards purpose + signal too (the shadow evaluator names itself "shadow")', async () => {
    const ac = new AbortController();
    await ai.callProvider({ provider: 'local', purpose: 'shadow', systemPrompt: 'sys', messages: [], maxTokens: 10, signal: ac.signal });
    expect(mockLocal.call).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'shadow', signal: ac.signal }));
  });

  test('a callAI without a signal forwards signal: undefined (no synthetic controller)', async () => {
    process.env.AI_PROVIDER = 'local';
    await ai.callAI(args('chat'));
    expect(mockLocal.call.mock.calls[0][0].signal).toBeUndefined();
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

  test('retrieval OFF: the embed vendor is not probed, because no request touches it', async () => {
    // rag_enabled=0 means ragLookup returns before reaching the embed provider. Reporting an unset
    // OPENAI_API_KEY as `down` would then take /health/deep to 503 over a vendor nothing calls —
    // a false alarm, and this codebase already has one warning nobody reads for exactly that reason.
    process.env.AI_PROVIDER = 'local';
    withRag(0);
    expect((await ai.readiness()).openai_embeddings).toBeUndefined();
  });

  test('retrieval ON: AI_PROVIDER=local is NOT all-local — embeddings stay on OpenAI, and now say so', async () => {
    // The reason the embed provider had to become visible at all. embedProviderName() falls back to
    // 'openai', not to AI_PROVIDER (ai.js:50), so an operator who sets AI_PROVIDER=local believes the
    // deployment is on-prem while every turn still reaches a commercial third party — which the
    // revised CREC082 submission set says will not happen. The default is left alone deliberately:
    // moving it needs LOCAL_AI_EMBED_MODEL and would hard-fail on a dimension mismatch against an
    // existing corpus. It must not be INVISIBLE, which it was.
    process.env.AI_PROVIDER = 'local';
    withRag(1);
    expect(Object.keys(await ai.readiness()).sort()).toEqual(['local_ai', 'openai_embeddings']);

    process.env.AI_PROVIDER_EMBED = 'local';
    mockLocal.ready.mockClear();
    const checks = await ai.readiness();
    expect(Object.keys(checks)).toEqual(['local_ai']);   // now it really is all-local
    expect(mockLocal.ready).toHaveBeenCalledTimes(1);    // and local, serving both lanes, is probed ONCE
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

  test('an unknown EMBED provider is a down check named after it, not `unknown provider` silence', async () => {
    // Embed providers live in their OWN registry, so probing one by name against PROVIDERS reported
    // `unknown provider "openai"` — which is why the embed lane had to be resolved separately.
    process.env.AI_PROVIDER = 'local';
    process.env.AI_PROVIDER_EMBED = 'cohere';
    withRag(1);
    const checks = await ai.readiness();
    expect(checks.cohere_provider).toEqual({ status: 'down', error: 'unknown provider "cohere"' });
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
  test('exposes exactly the three providers, keyed by the name each reports', () => {
    expect(Object.keys(ai.PROVIDERS).sort()).toEqual(['anthropic', 'local', 'local-tutor']);
    for (const [key, p] of Object.entries(ai.PROVIDERS)) expect(p.name).toBe(key);
  });

  test('every provider implements the full interface the seam depends on', () => {
    for (const p of Object.values(ai.PROVIDERS)) {
      for (const fn of ['call', 'model', 'ready', 'stats']) expect(typeof p[fn]).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// The on-prem TUTOR provider (CCME R3: the evaluator must be a distinct model artifact from the
// tutor). It serves chat and discuss ONLY; evaluate / criteria routed to it must fail loudly, the same
// way an unknown provider name does — the alternative is scoring a PLE with the tutor's own model.
describe('local-tutor: routing, the purpose guard, and dormancy', () => {
  test('dormant: nothing routes to it, nothing probes it, nothing reports its queue', async () => {
    for (const p of PURPOSES) expect(ai.providerNameFor(p)).not.toBe('local-tutor');
    expect(ai.activeProviders()).toEqual(['anthropic']);
    const checks = await ai.readiness();
    expect(checks).not.toHaveProperty('local_tutor_ai');
    expect(mockTutor.ready).not.toHaveBeenCalled();
  });

  test('chat and discuss route to it independently of the evaluator', async () => {
    process.env.AI_PROVIDER_CHAT = 'local-tutor';
    process.env.AI_PROVIDER_DISCUSS = 'local-tutor';
    process.env.AI_PROVIDER_EVALUATE = 'local';
    process.env.AI_PROVIDER_CRITERIA = 'local';
    expect(await ai.callAI(args('chat'))).toMatchObject({ provider: 'local-tutor', model: 'qwen-tutor', text: 'T' });
    expect(await ai.callAI(args('discuss'))).toMatchObject({ provider: 'local-tutor' });
    expect(await ai.callAI(args('evaluate'))).toMatchObject({ provider: 'local', model: 'qwen3-32b-medical' });
    expect(await ai.callAI(args('criteria'))).toMatchObject({ provider: 'local' });
    expect(mockTutor.call).toHaveBeenCalledTimes(2);
    expect(mockLocal.call).toHaveBeenCalledTimes(2);
    expect(ai.activeProviders().sort()).toEqual(['local', 'local-tutor']);
    expect(ai.modelsByPurpose()).toMatchObject({
      chat: { provider: 'local-tutor', model: 'qwen-tutor' }, discuss: { provider: 'local-tutor', model: 'qwen-tutor' },
      evaluate: { provider: 'local', model: 'qwen3-32b-medical' }, criteria: { provider: 'local', model: 'qwen3-32b-medical' },
    });
    // Two boxes, two checks: distinct keys, so readiness() merging them loses neither.
    expect(Object.keys(await ai.readiness()).sort()).toEqual(['local_ai', 'local_tutor_ai']);
  });

  test.each(['evaluate', 'criteria'])('%s routed to local-tutor THROWS — via env, the global default, or a pin — and never calls it', async (purpose) => {
    process.env[`AI_PROVIDER_${purpose.toUpperCase()}`] = 'local-tutor';
    await expect(ai.callAI(args(purpose))).rejects.toThrow(new RegExp(`"local-tutor".*cannot serve "${purpose}".*chat, discuss`));
    await expect(ai.resolveProviderName(purpose)).rejects.toThrow(/cannot serve/);
    delete process.env[`AI_PROVIDER_${purpose.toUpperCase()}`];

    process.env.AI_PROVIDER = 'local-tutor';   // the easy way to mean "all on-prem" and get it wrong
    await expect(ai.callAI(args(purpose))).rejects.toThrow(/cannot serve/);
    delete process.env.AI_PROVIDER;

    await expect(ai.callAI({ ...args(purpose), provider: 'local-tutor' })).rejects.toThrow(/a pinned provider.*cannot serve/);
    expect(mockTutor.call).not.toHaveBeenCalled();
    expect(mockAnthropic.call).not.toHaveBeenCalled();   // and it does not quietly fall back either
  });

  test('a misrouted purpose is reported DOWN by readiness(), even though the tutor box itself is up', async () => {
    process.env.AI_PROVIDER_EVALUATE = 'local-tutor';
    const checks = await ai.readiness();
    expect(checks.evaluate_routing).toEqual({ status: 'down', error: '"local-tutor" cannot serve "evaluate" — it serves only chat, discuss' });
    expect(checks.local_tutor_ai.status).toBe('up');
    expect(Object.values(checks).every((c) => c.status === 'up')).toBe(false);
  });

  test('probeProvider refuses it for evaluate / criteria without probing, and probes it for chat', async () => {
    for (const purpose of ['evaluate', 'criteria']) {
      expect(await ai.probeProvider('local-tutor', purpose)).toMatchObject({ fit: false, code: 'purpose_not_served' });
    }
    expect(mockTutor.ready).not.toHaveBeenCalled();
    expect(await ai.probeProvider('local-tutor', 'chat')).toMatchObject({ fit: true, provider: 'local-tutor' });
    expect(mockTutor.ready).toHaveBeenCalledTimes(1);
  });

  test('it is NOT an embedding provider', async () => {
    expect(Object.keys(ai.EMBED_PROVIDERS).sort()).toEqual(['local', 'openai']);
    expect(await ai.probeProvider('local-tutor', 'embed')).toMatchObject({ fit: false, code: 'unknown_provider' });
    process.env.AI_PROVIDER_EMBED = 'local-tutor';
    await expect(ai.embedText('x')).rejects.toThrow(/Unknown AI provider "local-tutor"/);
  });

  test('the guard leaves every other provider and purpose alone', () => {
    for (const p of [...PURPOSES, 'shadow']) {
      expect(ai.servesPurpose('anthropic', p)).toBe(true);
      expect(ai.servesPurpose('local', p)).toBe(true);
    }
    expect(ai.PROVIDER_PURPOSES).toEqual({ 'local-tutor': ['chat', 'discuss'] });
  });

  // `shadow` is an evaluation (a second PIS-7 score of the same transcript), so it follows the
  // evaluate rule from the SAME list rather than a second one.
  test('shadow is evaluate-class: local-tutor may not shadow either', () => {
    expect(ai.servesPurpose('local-tutor', 'shadow')).toBe(false);
    expect(ai.servesPurpose('local-tutor', 'chat')).toBe(true);
  });

  test('callProvider (routing bypassed by name) still refuses local-tutor for shadow / evaluate — the backstop behind services/shadow.js', async () => {
    for (const purpose of ['shadow', 'evaluate', 'criteria']) {
      await expect(ai.callProvider({ provider: 'local-tutor', purpose, systemPrompt: 's', messages: [] }))
        .rejects.toThrow(new RegExp(`an explicit provider name.*cannot serve "${purpose}"`));
    }
    expect(mockTutor.call).not.toHaveBeenCalled();
    await ai.callProvider({ provider: 'local-tutor', purpose: 'chat', systemPrompt: 's', messages: [] });
    expect(mockTutor.call).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// `thinking` / `onReasoning` — plumbing for a later router; nobody passes them yet, so a call without
// them must reach the provider with EXACTLY the arguments it always had.
describe('thinking + onReasoning pass-through', () => {
  test('absent: not a key on the provider call (the pre-existing exact-args contract holds)', async () => {
    process.env.AI_PROVIDER = 'local';
    await ai.callAI(args('chat'));
    const sent = mockLocal.call.mock.calls[0][0];
    expect(sent).not.toHaveProperty('thinking');
    expect(sent).not.toHaveProperty('onReasoning');
    expect(sent).not.toHaveProperty('onDelta');
  });

  test('given: forwarded verbatim through callAI and callProvider', async () => {
    process.env.AI_PROVIDER_CHAT = 'local-tutor';
    const onReasoning = jest.fn();
    await ai.callAI({ ...args('chat'), thinking: { enabled: false, budget: 0 }, onReasoning });
    expect(mockTutor.call).toHaveBeenCalledWith(expect.objectContaining({ thinking: { enabled: false, budget: 0 }, onReasoning }));

    await ai.callProvider({ provider: 'local', purpose: 'shadow', systemPrompt: 's', messages: [], thinking: true });
    expect(mockLocal.call).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'shadow', thinking: true }));
    expect(mockLocal.call.mock.calls[0][0]).not.toHaveProperty('onReasoning');
  });

  test('a reasoning notification does not commit the turn: chat fail-over still applies', async () => {
    process.env.AI_PROVIDER_CHAT = 'local-tutor';
    const savedFailover = process.env.CHAT_FAILOVER_PROVIDER;
    process.env.CHAT_FAILOVER_PROVIDER = 'local';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockTutor.call.mockImplementationOnce(async ({ onReasoning }) => {
        onReasoning();
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      });
      const r = await ai.callAI({ ...args('chat'), onReasoning: jest.fn(), onDelta: jest.fn() });
      expect(r).toMatchObject({ provider: 'local', failed_over_from: 'local-tutor' });
    } finally {
      warn.mockRestore();
      if (savedFailover === undefined) delete process.env.CHAT_FAILOVER_PROVIDER; else process.env.CHAT_FAILOVER_PROVIDER = savedFailover;
    }
  });
});

// ---------------------------------------------------------------------------
describe('r3_distinct_models (readiness)', () => {
  afterEach(() => { delete mockLocal.endpointKey; delete mockTutor.endpointKey; });

  test('equal keys: one warn check; providers without endpointKey (or unconfigured) add nothing', async () => {
    expect(await ai.readiness()).not.toHaveProperty('r3_distinct_models');   // mocks without endpointKey
    mockLocal.endpointKey = () => 'http://box/v1 m';
    mockTutor.endpointKey = () => null;                                       // tutor unconfigured
    expect(await ai.readiness()).not.toHaveProperty('r3_distinct_models');
    mockTutor.endpointKey = () => 'http://box/v1 m';
    expect((await ai.readiness()).r3_distinct_models).toMatchObject({ status: 'warn' });
  });

  test('it does not make the provider probe unfit: probeProvider reads only the provider\'s own checks', async () => {
    mockLocal.endpointKey = () => 'k';
    mockTutor.endpointKey = () => 'k';
    expect(await ai.probeProvider('local-tutor', 'chat')).toMatchObject({ fit: true });
  });
});
