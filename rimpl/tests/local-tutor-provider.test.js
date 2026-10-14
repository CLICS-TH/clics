// The on-prem TUTOR provider (providers/local-tutor.js) — a second instance of the local transport
// (providers/local-factory.js), so CCME's tutor model and the DeepSeek evaluator can be different
// endpoints with different keys (CCME R3: the evaluator must be a distinct model artifact).
//
// HERMETIC: global.fetch is mocked; `undici` is mocked so the proxy path never opens a socket.
//
// What is load-bearing here:
//   * env isolation — the tutor reads LOCAL_TUTOR_AI_* / LOCAL_TUTOR_*, never the evaluator's
//     LOCAL_AI_* / LOCAL_*, and the evaluator is unchanged by the tutor's existence;
//   * state isolation — its own queue, its own prompt-size calibration, its own /health/deep check key
//     (readiness() merges every provider's checks into one map, so a shared key would hide a box);
//   * unconfigured = a clear config error and a `down` check, with no request on the wire;
//   * the proxy: LOCAL_TUTOR_AI_HTTP_PROXY when SET (empty = direct), else LOCAL_AI_HTTP_PROXY.

const mockProxyFetch = jest.fn();
const mockProxyAgent = jest.fn(function ProxyAgent(opts) { this.opts = opts; });
jest.mock('undici', () => ({ fetch: (...a) => mockProxyFetch(...a), ProxyAgent: mockProxyAgent }));

const ENV = [
  'LOCAL_AI_BASE_URL', 'LOCAL_AI_MODEL', 'LOCAL_AI_API_KEY', 'LOCAL_AI_TIMEOUT_MS', 'LOCAL_AI_MIN_CONTEXT',
  'LOCAL_AI_HTTP_PROXY', 'LOCAL_AI_MAX_PROMPT_TOKENS', 'LOCAL_AI_NUM_CTX', 'LOCAL_AI_THINKING_STYLE',
  'LOCAL_MAX_CONCURRENCY', 'LOCAL_MAX_RETRIES', 'LOCAL_RETRY_BASE_MS', 'LOCAL_INTERACTIVE_RESERVE',
  'LOCAL_MAX_QUEUE_INTERACTIVE', 'LOCAL_MAX_QUEUE_BACKGROUND', 'LOCAL_QUEUE_RETRY_AFTER_S', 'LOCAL_LOG_PROMPT_RATIO',
  'LOCAL_TUTOR_AI_BASE_URL', 'LOCAL_TUTOR_AI_MODEL', 'LOCAL_TUTOR_AI_API_KEY', 'LOCAL_TUTOR_AI_TIMEOUT_MS',
  'LOCAL_TUTOR_AI_MIN_CONTEXT', 'LOCAL_TUTOR_AI_HTTP_PROXY', 'LOCAL_TUTOR_AI_MAX_PROMPT_TOKENS', 'LOCAL_TUTOR_AI_NUM_CTX',
  'LOCAL_TUTOR_AI_THINKING_STYLE', 'LOCAL_TUTOR_MAX_CONCURRENCY', 'LOCAL_TUTOR_MAX_RETRIES', 'LOCAL_TUTOR_RETRY_BASE_MS',
  'LOCAL_TUTOR_INTERACTIVE_RESERVE', 'LOCAL_TUTOR_MAX_QUEUE_INTERACTIVE', 'LOCAL_TUTOR_MAX_QUEUE_BACKGROUND',
  'LOCAL_TUTOR_QUEUE_RETRY_AFTER_S', 'LOCAL_TUTOR_LOG_PROMPT_RATIO', 'HEALTH_PROBE_TIMEOUT_MS',
];

let savedEnv, realFetch, fetchMock, warnSpy;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  // Two DIFFERENT boxes, two DIFFERENT keys — the configuration R3 asks for.
  process.env.LOCAL_AI_BASE_URL = 'http://evaluator.tailnet:8000/v1';
  process.env.LOCAL_AI_MODEL = 'deepseek-evaluator';
  process.env.LOCAL_AI_API_KEY = 'evaluator-key';
  process.env.LOCAL_TUTOR_AI_BASE_URL = 'http://tutor.tailnet:9000/v1';
  process.env.LOCAL_TUTOR_AI_MODEL = 'qwen-tutor';
  process.env.LOCAL_TUTOR_AI_API_KEY = 'tutor-key';
  process.env.LOCAL_RETRY_BASE_MS = '1';
  process.env.LOCAL_TUTOR_RETRY_BASE_MS = '1';
  realFetch = global.fetch;
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  mockProxyFetch.mockReset();
  mockProxyAgent.mockClear();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = realFetch;
  warnSpy.mockRestore();
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.resetModules();
});

// Both instances from ONE fresh module registry, so they share the factory module the way they do in
// production — the isolation being tested is between instances, not between module copies.
function load() {
  jest.resetModules();
  return {
    local: require('../src/services/providers/local'),
    tutor: require('../src/services/providers/local-tutor'),
    settings: require('../src/services/provider-settings'),
  };
}

function res(body, { status = 200, statusText = 'OK', headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300, status, statusText, headers: new Headers(headers),
    json: async () => JSON.parse(text), text: async () => text,
  };
}
const completion = (model, over = {}) => ({
  model,
  choices: [{ message: { role: 'assistant', content: `from ${model}` }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 5 },
  ...over,
});
const args = (over = {}) => ({ systemPrompt: 'tutor persona', messages: [{ role: 'user', content: 'de-identified turn' }], maxTokens: 300, ...over });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
describe('identity', () => {
  test('the tutor is its own provider: name, check key, no embeddings', () => {
    const { tutor, local } = load();
    expect(tutor.name).toBe('local-tutor');
    expect(tutor.embed).toBeUndefined();
    expect(tutor.embedModel).toBeUndefined();
    for (const fn of ['call', 'model', 'ready', 'stats', 'servedContext']) expect(typeof tutor[fn]).toBe('function');
    // The evaluator keeps every name the evaluator path, the history and the shadow rows key on.
    expect(local.name).toBe('local');
    expect(typeof local.embed).toBe('function');
    expect(typeof local.embedModel).toBe('function');
  });

  test('model() reads each instance from its own env', () => {
    const { tutor, local } = load();
    expect(tutor.model()).toBe('qwen-tutor');
    expect(local.model()).toBe('deepseek-evaluator');
    process.env.LOCAL_TUTOR_AI_MODEL = 'qwen-tutor-v2';
    expect(tutor.model()).toBe('qwen-tutor-v2');
    expect(local.model()).toBe('deepseek-evaluator');
  });
});

// ---------------------------------------------------------------------------
describe('env isolation — two boxes, two keys', () => {
  test('each instance posts to its OWN base URL with its OWN model and key', async () => {
    fetchMock.mockImplementation(async (url) => res(completion(String(url).includes('tutor') ? 'qwen-tutor' : 'deepseek-evaluator')));
    const { tutor, local } = load();

    const t = await tutor.call(args({ purpose: 'chat' }));
    const tutorCall = fetchMock.mock.calls.at(-1);
    expect(tutorCall[0]).toBe('http://tutor.tailnet:9000/v1/chat/completions');
    expect(tutorCall[1].headers.authorization).toBe('Bearer tutor-key');
    expect(JSON.parse(tutorCall[1].body).model).toBe('qwen-tutor');
    expect(t).toMatchObject({ text: 'from qwen-tutor', model: 'qwen-tutor' });

    const e = await local.call(args({ purpose: 'evaluate' }));
    const evalCall = fetchMock.mock.calls.at(-1);
    expect(evalCall[0]).toBe('http://evaluator.tailnet:8000/v1/chat/completions');
    expect(evalCall[1].headers.authorization).toBe('Bearer evaluator-key');
    expect(JSON.parse(evalCall[1].body).model).toBe('deepseek-evaluator');
    expect(e.model).toBe('deepseek-evaluator');
  });

  test('the tutor NEVER falls back to the evaluator box: unset LOCAL_TUTOR_AI_* is a config error, no fetch', async () => {
    delete process.env.LOCAL_TUTOR_AI_BASE_URL;
    const { tutor } = load();
    await expect(tutor.call(args({ purpose: 'chat' }))).rejects.toThrow('LOCAL_TUTOR_AI_BASE_URL is not set (AI_PROVIDER=local-tutor requires it)');
    process.env.LOCAL_TUTOR_AI_BASE_URL = 'http://tutor.tailnet:9000/v1';
    delete process.env.LOCAL_TUTOR_AI_MODEL;
    await expect(tutor.call(args({ purpose: 'chat' }))).rejects.toThrow('LOCAL_TUTOR_AI_MODEL is not set (AI_PROVIDER=local-tutor requires it)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the evaluator is unaffected by the tutor env being unset', async () => {
    for (const k of ENV.filter((n) => n.startsWith('LOCAL_TUTOR'))) delete process.env[k];
    fetchMock.mockResolvedValue(res(completion('deepseek-evaluator')));
    const { local } = load();
    expect((await local.call(args({ purpose: 'evaluate' }))).model).toBe('deepseek-evaluator');
  });

  test('error messages name the tutor endpoint, so a log line says WHICH box failed', async () => {
    process.env.LOCAL_TUTOR_MAX_RETRIES = '0';
    fetchMock.mockResolvedValue(res({ error: 'nope' }, { status: 503, statusText: 'Service Unavailable' }));
    const { tutor } = load();
    await expect(tutor.call(args({ purpose: 'chat' }))).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/^local tutor AI 503/) });
  });
});

// ---------------------------------------------------------------------------
describe('readiness — its own check key, and unconfigured is DOWN without a request', () => {
  test('unconfigured: { local_tutor_ai: down } and nothing on the wire', async () => {
    delete process.env.LOCAL_TUTOR_AI_BASE_URL;
    const { tutor } = load();
    expect(await tutor.ready()).toEqual({ checks: { local_tutor_ai: { status: 'down', error: 'LOCAL_TUTOR_AI_BASE_URL not set' } } });
    process.env.LOCAL_TUTOR_AI_BASE_URL = 'http://tutor.tailnet:9000/v1';
    delete process.env.LOCAL_TUTOR_AI_MODEL;
    expect(await tutor.ready()).toEqual({ checks: { local_tutor_ai: { status: 'down', error: 'LOCAL_TUTOR_AI_MODEL not set' } } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('configured: probes ITS box with ITS key, and reports under local_tutor_ai only', async () => {
    fetchMock.mockImplementation(async (url) => (String(url).endsWith('/models') ? res({ data: [{ id: 'qwen-tutor' }] }) : res({}, { status: 404, statusText: 'Not Found' })));
    const { tutor } = load();
    const r = await tutor.ready();
    expect(r).toEqual({ checks: { local_tutor_ai: { status: 'up', model: 'qwen-tutor', context_length: 'unknown', min_context: 16384 } } });
    const probe = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/models'));
    expect(probe[0]).toBe('http://tutor.tailnet:9000/v1/models');
    expect(probe[1].headers.authorization).toBe('Bearer tutor-key');
  });

  test('min context: app_settings.local_tutor_ai_min_context → LOCAL_TUTOR_AI_MIN_CONTEXT → 16384, independent of the evaluator floor', async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) return res({ data: [{ id: u.includes('tutor') ? 'qwen-tutor' : 'deepseek-evaluator' }] });
      if (u.endsWith('/api/show')) return res({ model_info: { 'qwen3.context_length': 32768 } });
      return res({}, { status: 404, statusText: 'Not Found' });
    });
    process.env.LOCAL_TUTOR_AI_MIN_CONTEXT = '65536';
    const { tutor, local, settings } = load();
    expect((await tutor.ready()).checks.local_tutor_ai).toMatchObject({ status: 'down', context_length: 32768, min_context: 65536 });
    expect((await local.ready()).checks.local_ai).toMatchObject({ status: 'up', min_context: 16384 });   // the evaluator's floor did not move

    const spy = jest.spyOn(settings, 'numberFor').mockImplementation((k) => ({ local_tutor_ai_min_context: 8192, local_ai_min_context: 131072 })[k]);
    try {
      expect((await tutor.ready()).checks.local_tutor_ai).toMatchObject({ status: 'up', min_context: 8192 });
      expect((await local.ready()).checks.local_ai).toMatchObject({ status: 'down', min_context: 131072 });
    } finally {
      spy.mockRestore();
    }
  });

  test('provider-settings reads the tutor floor in the same round trip as everything else', () => {
    const { settings } = load();
    expect(settings.NUMBER_KEYS).toEqual(expect.arrayContaining(['local_ai_min_context', 'local_tutor_ai_min_context', 'rag_enabled']));
  });
});

// ---------------------------------------------------------------------------
describe('state isolation — queue and calibration', () => {
  test('each instance sizes its OWN runner from its OWN env; stats say whose they are', () => {
    process.env.LOCAL_MAX_CONCURRENCY = '3';
    process.env.LOCAL_TUTOR_MAX_CONCURRENCY = '5';
    process.env.LOCAL_TUTOR_INTERACTIVE_RESERVE = '2';
    process.env.LOCAL_TUTOR_MAX_QUEUE_INTERACTIVE = '9';
    const { tutor, local } = load();
    expect(tutor.stats()).toMatchObject({ provider: 'local-tutor', maxConcurrency: 5,
      lanes: { interactive: { maxQueue: 9 }, background: { maxActive: 3 } } });
    expect(local.stats()).toMatchObject({ provider: 'local', maxConcurrency: 3,
      lanes: { interactive: { maxQueue: 4 }, background: { maxActive: 2 } } });
  });

  test('a saturated tutor queue does not touch the evaluator: tutor queue_full while the evaluator still serves', async () => {
    process.env.LOCAL_TUTOR_MAX_CONCURRENCY = '1';
    process.env.LOCAL_TUTOR_INTERACTIVE_RESERVE = '0';
    process.env.LOCAL_TUTOR_MAX_QUEUE_INTERACTIVE = '0';
    process.env.LOCAL_TUTOR_QUEUE_RETRY_AFTER_S = '9';
    let releaseTutor;
    fetchMock.mockImplementation((url) => (String(url).includes('tutor')
      ? new Promise((resolve) => { releaseTutor = () => resolve(res(completion('qwen-tutor'))); })
      : Promise.resolve(res(completion('deepseek-evaluator')))));
    const { tutor, local } = load();

    const running = tutor.call(args({ purpose: 'chat' }));
    await sleep(5);
    await expect(tutor.call(args({ purpose: 'chat' }))).rejects.toMatchObject({
      code: 'queue_full', status: 503, lane: 'interactive', retryAfterMs: 9000,
      message: expect.stringMatching(/^local-tutor AI queue is full/),
    });
    // The evaluator box has its own slots: a busy tutor never answers for it.
    expect((await local.call(args({ purpose: 'chat' }))).model).toBe('deepseek-evaluator');
    expect(local.stats()).toMatchObject({ active: 0, queued: 0 });
    expect(tutor.stats()).toMatchObject({ active: 1, queued: 0 });
    releaseTutor();
    await running;
  });

  test('prompt-size calibration is learnt per box: serving the tutor teaches the evaluator nothing', async () => {
    fetchMock.mockResolvedValue(res(completion('qwen-tutor', { usage: { prompt_tokens: 7, completion_tokens: 1 } })));
    const { tutor, local } = load();
    for (let i = 0; i < 3; i++) await tutor.call(args({ purpose: 'chat' }));
    expect(tutor.stats().prompt_calibration.n).toBe(3);
    expect(local.stats().prompt_calibration).toEqual({ ratio: null, n: 0 });
  });

  test('LOCAL_TUTOR_AI_MAX_PROMPT_TOKENS is the tutor backstop; LOCAL_AI_MAX_PROMPT_TOKENS does not apply to it', async () => {
    process.env.LOCAL_AI_MAX_PROMPT_TOKENS = '1';   // would refuse everything — if the tutor read it
    fetchMock.mockResolvedValue(res(completion('qwen-tutor', { usage: { prompt_tokens: 7, completion_tokens: 1 } })));
    const { tutor } = load();
    for (let i = 0; i < 4; i++) await tutor.call(args({ purpose: 'chat' }));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    process.env.LOCAL_TUTOR_AI_MAX_PROMPT_TOKENS = '1';
    await expect(tutor.call(args({ purpose: 'chat' }))).rejects.toMatchObject({
      status: 413, code: 'transcript_too_large', limit: 1, message: expect.stringMatching(/above LOCAL_TUTOR_AI_MAX_PROMPT_TOKENS=1/),
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test('LOCAL_TUTOR_LOG_PROMPT_RATIO, not LOCAL_LOG_PROMPT_RATIO, turns on the tutor ratio line', async () => {
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      fetchMock.mockResolvedValue(res(completion('qwen-tutor')));
      process.env.LOCAL_LOG_PROMPT_RATIO = '1';
      const { tutor } = load();
      await tutor.call(args({ purpose: 'chat' }));
      expect(debugSpy).not.toHaveBeenCalled();
      process.env.LOCAL_TUTOR_LOG_PROMPT_RATIO = '1';
      await tutor.call(args({ purpose: 'chat' }));
      expect(debugSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[local-tutor\] prompt est=\d+ served=20 ratio=\d+\.\d{3} n=2$/));
    } finally {
      debugSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
describe('HTTP proxy — inherited unless the tutor names its own', () => {
  const proxied = () => mockProxyFetch.mock.calls.at(-1);

  test('neither proxy set: direct (native fetch), no agent built', async () => {
    fetchMock.mockResolvedValue(res(completion('qwen-tutor')));
    const { tutor } = load();
    await tutor.call(args({ purpose: 'chat' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockProxyFetch).not.toHaveBeenCalled();
    expect(mockProxyAgent).not.toHaveBeenCalled();
  });

  test('only LOCAL_AI_HTTP_PROXY set: the tutor goes through it too (one tailnet proxy per deployment)', async () => {
    process.env.LOCAL_AI_HTTP_PROXY = 'http://127.0.0.1:1055';
    mockProxyFetch.mockResolvedValue(res(completion('qwen-tutor')));
    const { tutor, local } = load();
    await tutor.call(args({ purpose: 'chat' }));
    expect(proxied()[0]).toBe('http://tutor.tailnet:9000/v1/chat/completions');
    expect(proxied()[1].dispatcher.opts.uri).toBe('http://127.0.0.1:1055');
    await local.call(args({ purpose: 'evaluate' }));
    expect(mockProxyAgent).toHaveBeenCalledTimes(1);   // one agent per proxy URL, shared
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('LOCAL_TUTOR_AI_HTTP_PROXY set: the tutor uses it, the evaluator keeps its own', async () => {
    process.env.LOCAL_AI_HTTP_PROXY = 'http://127.0.0.1:1055';
    process.env.LOCAL_TUTOR_AI_HTTP_PROXY = 'http://127.0.0.1:2066';
    mockProxyFetch.mockResolvedValue(res(completion('x')));
    const { tutor, local } = load();
    await tutor.call(args({ purpose: 'chat' }));
    expect(proxied()[1].dispatcher.opts.uri).toBe('http://127.0.0.1:2066');
    await local.call(args({ purpose: 'evaluate' }));
    expect(proxied()[1].dispatcher.opts.uri).toBe('http://127.0.0.1:1055');
  });

  test('LOCAL_TUTOR_AI_HTTP_PROXY set to the EMPTY string: the tutor goes direct while the evaluator stays proxied', async () => {
    process.env.LOCAL_AI_HTTP_PROXY = 'http://127.0.0.1:1055';
    process.env.LOCAL_TUTOR_AI_HTTP_PROXY = '';
    fetchMock.mockResolvedValue(res(completion('qwen-tutor')));
    mockProxyFetch.mockResolvedValue(res(completion('deepseek-evaluator')));
    const { tutor, local } = load();
    await tutor.call(args({ purpose: 'chat' }));
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('http://tutor.tailnet:9000/v1/chat/completions');
    await local.call(args({ purpose: 'evaluate' }));
    expect(proxied()[0]).toBe('http://evaluator.tailnet:8000/v1/chat/completions');
  });
});
