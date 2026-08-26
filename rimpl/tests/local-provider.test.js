// Local (on-premise) provider — OpenAI-compatible /chat/completions transport.
//
// HERMETIC: global.fetch is mocked for every test; nothing here touches the network, a real DGX,
// or a real key. The provider reads its config LAZILY (first call) but memoizes its concurrency
// runner, so each test sets process.env BEFORE jest.resetModules() + require().
//
// What is actually load-bearing here, and why each block exists:
//   * system prompt placement  — Anthropic takes `system` top-level, OpenAI-compatible servers take
//     it as the FIRST message. Getting this wrong silently drops the PIS-7 rubric / Socratic persona.
//   * finish_reason → stopReason — routes/evaluate.js branches on the Anthropic vocabulary
//     ('max_tokens' = truncated, needs a bigger ceiling; 'end_turn' = model never emitted JSON).
//   * non-string content       — a reasoning model returning {content:null, reasoning_content:...}
//     must degrade to '' and NEVER leak chain-of-thought into a clinical transcript.
//   * data.model over cfg.model — §10.2 provenance: a box whose model changed underneath us must
//     show up in the recorded data.

const LOCAL_ENV = [
  'LOCAL_AI_BASE_URL', 'LOCAL_AI_MODEL', 'LOCAL_AI_API_KEY', 'LOCAL_AI_TIMEOUT_MS',
  'LOCAL_MAX_CONCURRENCY', 'LOCAL_MAX_RETRIES', 'LOCAL_RETRY_BASE_MS', 'HEALTH_PROBE_TIMEOUT_MS',
  'LOCAL_AI_MIN_CONTEXT', 'LOCAL_AI_NUM_CTX', 'LOCAL_AI_EMBED_MODEL', 'LOCAL_AI_EMBED_TIMEOUT_MS',
];

let savedEnv;
let realFetch;
let fetchMock;
let warnSpy;

beforeEach(() => {
  savedEnv = Object.fromEntries(LOCAL_ENV.map((k) => [k, process.env[k]]));
  for (const k of LOCAL_ENV) delete process.env[k];

  // Sane defaults; individual tests override BEFORE calling load().
  process.env.LOCAL_AI_BASE_URL = 'http://dgx.tailnet:8000/v1';
  process.env.LOCAL_AI_MODEL = 'qwen3-32b-medical';
  process.env.LOCAL_AI_TIMEOUT_MS = '5000';
  process.env.LOCAL_MAX_RETRIES = '3';
  process.env.LOCAL_RETRY_BASE_MS = '1'; // keep backoff ~instant

  realFetch = global.fetch;
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = realFetch;
  warnSpy.mockRestore();
  for (const k of LOCAL_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.resetModules();
});

// Fresh module instance so the memoized runner picks up the current env.
function load() {
  jest.resetModules();
  return require('../src/services/providers/local');
}

function res(body, { status = 200, statusText = 'OK', headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Headers(headers),
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

// ready() probes twice — GET /models, then Ollama's native /api/show for the served context — so
// tests must name the call they mean rather than assuming which one landed last.
const callTo = (fragment) => {
  const hit = fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment)).pop();
  return hit ? { url: String(hit[0]), opts: hit[1] || {} } : null;
};

const completion = (over = {}) => ({
  id: 'chatcmpl-1',
  model: 'qwen3-32b-medical',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
  ...over,
});

const args = (over = {}) => ({
  systemPrompt: 'You are a Socratic tutor.',
  messages: [{ role: 'user', content: 'A 54-year-old with chest pain.' }],
  maxTokens: 1200,
  ...over,
});

const lastBody = () => JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
const lastOpts = () => fetchMock.mock.calls.at(-1)[1];
const lastUrl = () => fetchMock.mock.calls.at(-1)[0];

// ---------------------------------------------------------------------------
describe('request shape', () => {
  test('systemPrompt becomes the FIRST message with role "system" (not a top-level param)', async () => {
    fetchMock.mockResolvedValue(res(completion()));
    await load().call(args());

    const body = lastBody();
    expect(body.system).toBeUndefined();          // Anthropic-ism must NOT leak through
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a Socratic tutor.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'A 54-year-old with chest pain.' });
    expect(body.messages).toHaveLength(2);
  });

  test('omits the system message entirely when there is no systemPrompt', async () => {
    fetchMock.mockResolvedValue(res(completion()));
    await load().call(args({ systemPrompt: undefined }));

    const body = lastBody();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
  });

  test('sends model, max_tokens and stream:false; posts to <baseUrl>/chat/completions', async () => {
    fetchMock.mockResolvedValue(res(completion()));
    await load().call(args());

    expect(lastUrl()).toBe('http://dgx.tailnet:8000/v1/chat/completions');
    expect(lastOpts().method).toBe('POST');
    const body = lastBody();
    expect(body.model).toBe('qwen3-32b-medical');
    expect(body.max_tokens).toBe(1200);
    expect(body.stream).toBe(false);              // never stream: routes await a whole reply
  });

  test('strips trailing slashes from LOCAL_AI_BASE_URL (no double slash)', async () => {
    process.env.LOCAL_AI_BASE_URL = 'http://dgx.tailnet:8000/v1///';
    fetchMock.mockResolvedValue(res(completion()));
    await load().call(args());
    expect(lastUrl()).toBe('http://dgx.tailnet:8000/v1/chat/completions');
  });

  test('temperature is sent only when supplied', async () => {
    fetchMock.mockResolvedValue(res(completion()));
    const local = load();

    await local.call(args());
    expect(lastBody()).not.toHaveProperty('temperature');

    await local.call(args({ temperature: 0 }));   // 0 must survive (falsy but meaningful)
    expect(lastBody().temperature).toBe(0);
  });

  test('defaults max_tokens to 1500 when the caller omits it', async () => {
    fetchMock.mockResolvedValue(res(completion()));
    await load().call({ systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(lastBody().max_tokens).toBe(1500);
  });

  test('NO Authorization header when LOCAL_AI_API_KEY is unset', async () => {
    delete process.env.LOCAL_AI_API_KEY;
    fetchMock.mockResolvedValue(res(completion()));
    await load().call(args());

    const headers = lastOpts().headers;
    expect(headers.authorization).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('application/json');
  });

  test('Authorization: Bearer <key> when LOCAL_AI_API_KEY is set', async () => {
    process.env.LOCAL_AI_API_KEY = 'dgx-token';
    fetchMock.mockResolvedValue(res(completion()));
    await load().call(args());
    expect(lastOpts().headers.authorization).toBe('Bearer dgx-token');
  });

  test('passes an abort signal so a hung DGX cannot outlive the backend timeout', async () => {
    fetchMock.mockResolvedValue(res(completion()));
    await load().call(args());
    expect(lastOpts().signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
describe('response mapping', () => {
  test('maps usage + content into the Anthropic-shaped result', async () => {
    fetchMock.mockResolvedValue(res(completion()));
    const r = await load().call(args());

    expect(r.text).toBe('hello');
    expect(r.inputTokens).toBe(11);               // usage.prompt_tokens
    expect(r.outputTokens).toBe(4);               // usage.completion_tokens
    expect(r.tokenCount).toBe(15);                // sum, NOT usage.total_tokens
    expect(r.stopReason).toBe('end_turn');
    expect(r.model).toBe('qwen3-32b-medical');
  });

  test('tokenCount is the SUM of the two, independent of total_tokens', async () => {
    fetchMock.mockResolvedValue(res(completion({
      usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 99999 },
    })));
    const r = await load().call(args());
    expect(r.tokenCount).toBe(107);
  });

  test('missing usage degrades to 0/0/0 rather than NaN (the C3 gate sums tokenCount)', async () => {
    fetchMock.mockResolvedValue(res(completion({ usage: undefined })));
    const r = await load().call(args());
    expect(r).toMatchObject({ inputTokens: 0, outputTokens: 0, tokenCount: 0 });
    expect(Number.isNaN(r.tokenCount)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('finish_reason → stopReason (routes/evaluate.js branches on these exact strings)', () => {
  test.each([
    ['length', 'max_tokens'],        // genuinely truncated → needs a bigger ceiling
    ['stop', 'end_turn'],            // finished on its own → a compliance problem, not a length one
    ['tool_calls', 'tool_use'],
    ['function_call', 'tool_use'],
    ['content_filter', 'content_filter'],
  ])('%s -> %s', async (finish, expected) => {
    fetchMock.mockResolvedValue(res(completion({
      choices: [{ message: { content: 'x' }, finish_reason: finish }],
    })));
    const r = await load().call(args());
    expect(r.stopReason).toBe(expected);
  });

  test('an unmapped finish_reason passes through verbatim (never silently becomes end_turn)', async () => {
    fetchMock.mockResolvedValue(res(completion({
      choices: [{ message: { content: 'x' }, finish_reason: 'abort' }],
    })));
    expect((await load().call(args())).stopReason).toBe('abort');
  });

  test('absent finish_reason -> null', async () => {
    fetchMock.mockResolvedValue(res(completion({
      choices: [{ message: { content: 'x' } }],
    })));
    expect((await load().call(args())).stopReason).toBeNull();
  });

  test('no choices at all -> text "" and stopReason null (no crash)', async () => {
    fetchMock.mockResolvedValue(res(completion({ choices: [] })));
    const r = await load().call(args());
    expect(r.text).toBe('');
    expect(r.stopReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('non-string content must NOT leak reasoning / chain-of-thought', () => {
  const SECRET = 'The user is probably a physician named Somchai; I should hedge.';

  test('content:null + reasoning_content degrades to "" and drops the reasoning entirely', async () => {
    fetchMock.mockResolvedValue(res(completion({
      choices: [{ message: { role: 'assistant', content: null, reasoning_content: SECRET }, finish_reason: 'stop' }],
    })));
    const r = await load().call(args());

    expect(r.text).toBe('');
    expect(JSON.stringify(r)).not.toContain('Somchai');
    expect(JSON.stringify(r)).not.toContain('reasoning');
    // The failure is still visible to the caller via stopReason + a zero-length text.
    expect(r.stopReason).toBe('end_turn');
  });

  test('structured (array) content — the OpenAI "parts" shape — degrades to "" too', async () => {
    fetchMock.mockResolvedValue(res(completion({
      choices: [{ message: { content: [{ type: 'text', text: 'hi' }, { type: 'thinking', text: SECRET }] }, finish_reason: 'stop' }],
    })));
    const r = await load().call(args());
    expect(r.text).toBe('');
    expect(JSON.stringify(r)).not.toContain('Somchai');
  });

  test('message absent entirely -> ""', async () => {
    fetchMock.mockResolvedValue(res(completion({
      choices: [{ finish_reason: 'stop' }],
    })));
    expect((await load().call(args())).text).toBe('');
  });
});

// ---------------------------------------------------------------------------
describe('model provenance (§10.2)', () => {
  test('prefers the model the SERVER reports over the configured one', async () => {
    fetchMock.mockResolvedValue(res(completion({ model: 'qwen3-32b-medical-v2-hotfix' })));
    const r = await load().call(args());
    // A box silently reloaded with a different checkpoint must show up in the recorded data.
    expect(r.model).toBe('qwen3-32b-medical-v2-hotfix');
    expect(r.model).not.toBe(process.env.LOCAL_AI_MODEL);
  });

  test('falls back to the configured model when the server reports none', async () => {
    fetchMock.mockResolvedValue(res(completion({ model: undefined })));
    expect((await load().call(args())).model).toBe('qwen3-32b-medical');
  });

  test('model() reflects the CURRENT env (config is read lazily, not captured at load)', () => {
    const local = load();
    expect(local.model()).toBe('qwen3-32b-medical');
    process.env.LOCAL_AI_MODEL = 'llama-4-70b';
    expect(local.model()).toBe('llama-4-70b'); // no reload required
  });
});

// ---------------------------------------------------------------------------
describe('configuration errors', () => {
  test('missing LOCAL_AI_BASE_URL throws a clear error and never calls fetch', async () => {
    delete process.env.LOCAL_AI_BASE_URL;
    await expect(load().call(args())).rejects.toThrow(/LOCAL_AI_BASE_URL is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('missing LOCAL_AI_MODEL throws a clear error and never calls fetch', async () => {
    delete process.env.LOCAL_AI_MODEL;
    await expect(load().call(args())).rejects.toThrow(/LOCAL_AI_MODEL is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the config error is NOT retried (it is not a transport failure)', async () => {
    delete process.env.LOCAL_AI_BASE_URL;
    const local = load();
    await expect(local.call(args())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
describe('HTTP errors + retry classification', () => {
  test('a non-2xx response throws an Error carrying .status (so retry logic can classify it)', async () => {
    process.env.LOCAL_MAX_RETRIES = '0';
    fetchMock.mockResolvedValue(res({ error: 'nope' }, { status: 418, statusText: "I'm a teapot" }));

    const err = await load().call(args()).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(418);
    expect(err.message).toMatch(/local AI 418/);
    expect(err.headers).toBeDefined(); // needed by retryAfterMs
  });

  test('429 retries then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ error: 'rate limited' }, { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(res({ error: 'rate limited' }, { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(res(completion()));

    const r = await load().call(args());
    expect(r.text).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('503 (model still loading / server restarting) retries then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ error: 'loading' }, { status: 503, statusText: 'Service Unavailable' }))
      .mockResolvedValueOnce(res(completion()));

    expect((await load().call(args())).text).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('400 does NOT retry — a malformed request is not transient', async () => {
    fetchMock.mockResolvedValue(res({ error: 'bad request' }, { status: 400, statusText: 'Bad Request' }));

    await expect(load().call(args())).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('401 (wrong LOCAL_AI_API_KEY) does NOT retry', async () => {
    fetchMock.mockResolvedValue(res({ error: 'unauthorized' }, { status: 401, statusText: 'Unauthorized' }));
    await expect(load().call(args())).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('404 (wrong base URL / model route) does NOT retry', async () => {
    fetchMock.mockResolvedValue(res({ error: 'not found' }, { status: 404, statusText: 'Not Found' }));
    await expect(load().call(args())).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('gives up after LOCAL_MAX_RETRIES on a persistent 429', async () => {
    process.env.LOCAL_MAX_RETRIES = '2';
    fetchMock.mockResolvedValue(res({ error: 'rate limited' }, { status: 429, statusText: 'Too Many Requests' }));

    await expect(load().call(args())).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  test('a network-level failure (DGX unreachable / tailnet down) retries then succeeds', async () => {
    const netErr = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    fetchMock.mockRejectedValueOnce(netErr).mockResolvedValueOnce(res(completion()));

    expect((await load().call(args())).text).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('honours a Retry-After header instead of the exponential backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ error: 'slow down' }, { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '0.01' } }))
      .mockResolvedValueOnce(res(completion()));

    const started = Date.now();
    await load().call(args());
    expect(Date.now() - started).toBeLessThan(3000); // 0.01s * 1000 = 10ms, capped at 30s
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  // REGRESSION (confirmed HIGH, review 2026-08-24): our OWN client-side deadline must be terminal.
  // AbortSignal.timeout rejects with a TimeoutError carrying no .status and a NUMERIC .code, so it
  // used to fall through to the retryable regex, match /timeout|aborted/, and re-run the FULL
  // generation — 4 x 85s = 340s against a backend that aborts at RIMPL_EVAL_TIMEOUT_MS = 100s.
  test('our own request timeout is NOT retried (would blow past the backend deadline)', async () => {
    const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    fetchMock.mockRejectedValue(timeoutErr);
    const local = load();
    await expect(local.call({ systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/aborted due to timeout/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // exactly one attempt, no retry storm
  });

  // A transient network blip is a DIFFERENT thing and MUST still retry — the fix must not over-apply.
  test('a transient network error still retries', async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(res({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }));
    const local = load();
    const r = await local.call({ systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(r.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // REGRESSION (confirmed LOW, review 2026-08-24): Math.max(1, parseInt('auto',10)) is NaN, not 1 —
  // Math.max PROPAGATES NaN. runtime.js's `active < maxConcurrency` was then permanently false, so
  // every call queued and nothing ever ran or released: a silent, permanent hang, no error, no log.
  test('a non-numeric LOCAL_MAX_CONCURRENCY falls back to the default instead of hanging', async () => {
    process.env.LOCAL_MAX_CONCURRENCY = 'auto';
    fetchMock.mockResolvedValue(res({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: {} }));
    const local = load();
    const r = await local.call({ systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(r.text).toBe('hi');
    expect(local.stats().maxConcurrency).toBe(24);
  });

  test('LOCAL_MAX_CONCURRENCY caps in-flight calls; the excess queues and still completes', async () => {
    process.env.LOCAL_MAX_CONCURRENCY = '3';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let inFlight = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await sleep(20);
      inFlight--;
      return res(completion());
    });

    const local = load();
    const results = await Promise.all(Array.from({ length: 12 }, () => local.call(args())));

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);              // it really does run in parallel, not serially
    expect(fetchMock).toHaveBeenCalledTimes(12);  // all 12 eventually run
    expect(results.every((r) => r.text === 'hello')).toBe(true);
  });

  test('stats() reports the queue depth (the local replacement for rate-limit headers)', async () => {
    process.env.LOCAL_MAX_CONCURRENCY = '2';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    fetchMock.mockImplementation(async () => { await sleep(20); return res(completion()); });

    const local = load();
    expect(local.stats()).toMatchObject({ provider: 'local', active: 0, queued: 0, maxConcurrency: 2 });

    const inflight = Promise.all(Array.from({ length: 5 }, () => local.call(args())));
    await Promise.resolve(); // let the synchronous acquire()s run
    const busy = local.stats();
    expect(busy.active).toBe(2);
    expect(busy.queued).toBe(3);

    await inflight;
    expect(local.stats()).toMatchObject({ active: 0, queued: 0 });
  });
});

// ---------------------------------------------------------------------------
describe('ready() — /health/deep probe', () => {
  test('up when GET /models lists the configured model (and it uses GET, no generation)', async () => {
    fetchMock.mockResolvedValue(res({ data: [{ id: 'qwen3-32b-medical' }, { id: 'other' }] }));
    const r = await load().ready();

    // context_length 'unknown' — the mocked /api/show reply carries no model_info, which is exactly
    // what a non-Ollama server (vLLM, SGLang) looks like. Unknown must not read as unhealthy.
    expect(r.checks.local_ai).toEqual({ status: 'up', model: 'qwen3-32b-medical', context_length: 'unknown' });
    const models = callTo('/v1/models');
    expect(models.url).toBe('http://dgx.tailnet:8000/v1/models');
    expect(models.opts.method).toBe('GET');
    expect(models.opts.body).toBeUndefined(); // zero token spend
  });

  test('sends the Bearer key on the probe too when one is configured', async () => {
    process.env.LOCAL_AI_API_KEY = 'dgx-token';
    fetchMock.mockResolvedValue(res({ data: [{ id: 'qwen3-32b-medical' }] }));
    await load().ready();
    expect(callTo('/v1/models').opts.headers.authorization).toBe('Bearer dgx-token');
  });

  test('DOWN when reachable but the configured model is NOT served', async () => {
    fetchMock.mockResolvedValue(res({ data: [{ id: 'llama-4-70b' }, { id: 'qwen3-8b' }] }));
    const r = await load().ready();

    expect(r.checks.local_ai.status).toBe('down');
    expect(r.checks.local_ai.error).toMatch(/qwen3-32b-medical/);
    expect(r.checks.local_ai.error).toMatch(/not served/);
    expect(r.checks.local_ai.error).toMatch(/llama-4-70b/); // names what IS served, for triage
  });

  test('down on a network error (DGX off / tailnet down) — and does not throw', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const r = await load().ready();
    expect(r.checks.local_ai.status).toBe('down');
    expect(r.checks.local_ai.error).toMatch(/fetch failed/);
  });

  test('down on a non-2xx probe response', async () => {
    fetchMock.mockResolvedValue(res({ error: 'nope' }, { status: 500, statusText: 'Internal Server Error' }));
    const r = await load().ready();
    expect(r.checks.local_ai.status).toBe('down');
    expect(r.checks.local_ai.error).toMatch(/local AI 500/);
  });

  test('down on a malformed (non-JSON) probe body — never throws', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
      text: async () => '<html>proxy</html>',
    });
    await expect(load().ready()).resolves.toMatchObject({ checks: { local_ai: { status: 'down' } } });
  });

  test('down (without probing) when LOCAL_AI_BASE_URL is unset', async () => {
    delete process.env.LOCAL_AI_BASE_URL;
    const r = await load().ready();
    expect(r.checks.local_ai).toEqual({ status: 'down', error: 'LOCAL_AI_BASE_URL not set' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('down (without probing) when LOCAL_AI_MODEL is unset', async () => {
    delete process.env.LOCAL_AI_MODEL;
    const r = await load().ready();
    expect(r.checks.local_ai).toEqual({ status: 'down', error: 'LOCAL_AI_MODEL not set' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the probe is NOT retried — /health/deep must answer fast, not back off', async () => {
    fetchMock.mockResolvedValue(res({ error: 'busy' }, { status: 503, statusText: 'Service Unavailable' }));
    await load().ready();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Documented lenience, NOT an endorsement: a server that enumerates nothing is treated as up.
  // See the finding reported alongside this suite — an empty /models list is a false green.
  // A 200 from /models that enumerates nothing proves nothing: a reverse proxy, a Tailscale-fronted
  // shim, or a vLLM instance still registering all answer that way, and every /chat/completions call
  // would then 404. Reporting `up` would green-light exactly the failure this probe exists to catch.
  test.each([
    ['an empty list', { data: [] }],
    ['a null list', { data: null }],
    ['a non-OpenAI body', {}],
  ])('a server that enumerates NO models (%s) is reported DOWN', async (_label, body) => {
    fetchMock.mockResolvedValue(res(body));
    const r = await load().ready();
    expect(r.checks.local_ai.status).toBe('down');
    expect(r.checks.local_ai.error).toMatch(/enumerated no models/);
  });
});

// ---------------------------------------------------------------------------
// Context length — the measured blocker for running a real CLE on the DGX.
//
// On 2026-08-24 a 9,144-token evaluation against the box returned
// 400 "... exceeds the available context size (4096)". A creditable CLE is >= 10,000 tokens (C3), so
// at Ollama's default EVERY evaluation fails. These tests pin the two things that make that
// survivable: it is visible in /health/deep beforehand, and when it does happen the error says how
// to fix it instead of just restating the number.
describe('served context length', () => {
  const probeRoutes = (showBody, showStatus = 200) => {
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) return res({ data: [{ id: 'qwen3-32b-medical' }] });
      if (u.endsWith('/api/show')) return res(showBody, { status: showStatus, statusText: 'x' });
      return res({}, { status: 404, statusText: 'Not Found' });
    });
  };

  test('DOWN when the box serves less context than a CLE transcript needs', async () => {
    probeRoutes({ model_info: { 'qwen3.context_length': 4096 } });
    const r = await load().ready();

    expect(r.checks.local_ai.status).toBe('down');
    expect(r.checks.local_ai.context_length).toBe(4096);
    expect(r.checks.local_ai.error).toMatch(/4096/);
    expect(r.checks.local_ai.error).toMatch(/LOCAL_AI_MIN_CONTEXT/);
  });

  test('UP, and reports the number, when the context is adequate', async () => {
    probeRoutes({ model_info: { 'llama.context_length': 32768 } });
    const r = await load().ready();
    expect(r.checks.local_ai).toEqual({ status: 'up', model: 'qwen3-32b-medical', context_length: 32768 });
  });

  test('the probe reads the architecture-namespaced key, whatever the family is called', async () => {
    probeRoutes({ model_info: { 'general.parameter_count': 32e9, 'deepseek2.context_length': 65536 } });
    const r = await load().ready();
    expect(r.checks.local_ai.context_length).toBe(65536);
  });

  test('a server with no native /api/show is UNKNOWN, not unhealthy (vLLM, SGLang)', async () => {
    probeRoutes({ error: 'not found' }, 404);
    const r = await load().ready();
    expect(r.checks.local_ai.status).toBe('up');
    expect(r.checks.local_ai.context_length).toBe('unknown');
  });

  test('LOCAL_AI_MIN_CONTEXT is what the probe compares against', async () => {
    process.env.LOCAL_AI_MIN_CONTEXT = '65536';
    probeRoutes({ model_info: { 'qwen3.context_length': 32768 } });
    const r = await load().ready();
    expect(r.checks.local_ai.status).toBe('down'); // adequate for a CLE, below THIS deployment's bar
  });

  test('a context-overflow 400 explains the fix, and is NOT retried', async () => {
    fetchMock.mockResolvedValue(res(
      { error: 'input length 9144 tokens exceeds the available context size (4096)' },
      { status: 400, statusText: 'Bad Request' },
    ));

    const err = await load().call(args()).then(() => null, (e) => e);

    expect(err).toBeTruthy();
    expect(err.contextTooSmall).toBe(true);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/OLLAMA_CONTEXT_LENGTH|num_ctx/);   // names the server-side fix
    expect(err.message).toMatch(/max-model-len/);                    // …for vLLM too
    // Re-sending the same oversized transcript cannot make it fit. One attempt, not four.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('LOCAL_AI_NUM_CTX is sent only when explicitly set', async () => {
    fetchMock.mockResolvedValue(res(completion()));
    await load().call(args());
    expect(JSON.parse(lastOpts().body).options).toBeUndefined();

    process.env.LOCAL_AI_NUM_CTX = '32768';
    fetchMock.mockResolvedValue(res(completion()));
    await load().call(args());
    expect(JSON.parse(lastOpts().body).options).toEqual({ num_ctx: 32768 });
  });
});

// ---------------------------------------------------------------------------
// Embeddings. RAG retrieval used to call api.openai.com directly, which no configuration could
// move; behind the provider seam it can run on the same box as everything else.
describe('embed()', () => {
  test('POSTs to /embeddings with the EMBEDDING model, not the chat model', async () => {
    process.env.LOCAL_AI_EMBED_MODEL = 'bge-m3';
    fetchMock.mockResolvedValue(res({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));

    const v = await load().embed('chest pain in a 58yo');

    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(lastUrl()).toBe('http://dgx.tailnet:8000/v1/embeddings');
    const body = JSON.parse(lastOpts().body);
    expect(body.model).toBe('bge-m3');            // NOT qwen3-32b-medical
    expect(body.input).toBe('chest pain in a 58yo');
  });

  test('refuses without LOCAL_AI_EMBED_MODEL rather than silently embedding with the chat model', async () => {
    fetchMock.mockResolvedValue(res({ data: [{ embedding: [1] }] }));
    await expect(load().embed('x')).rejects.toThrow(/LOCAL_AI_EMBED_MODEL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a response carrying no vector is an error, not an empty embedding', async () => {
    process.env.LOCAL_AI_EMBED_MODEL = 'bge-m3';
    fetchMock.mockResolvedValue(res({ data: [] }));
    await expect(load().embed('x')).rejects.toThrow(/no vector/);
  });
});
