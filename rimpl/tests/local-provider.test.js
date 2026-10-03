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
  'LOCAL_INTERACTIVE_RESERVE', 'LOCAL_MAX_QUEUE_INTERACTIVE', 'LOCAL_MAX_QUEUE_BACKGROUND',
  'LOCAL_QUEUE_RETRY_AFTER_S', 'LOCAL_AI_MAX_PROMPT_TOKENS', 'LOCAL_LOG_PROMPT_RATIO',
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

  // §10.2: routes/evaluate.js records the decoding the provider reports it SENT, in the same shape
  // as the anthropic provider. Here that is what went over the wire; there is no thinking switch.
  test('reports the decoding it actually sent', async () => {
    fetchMock.mockResolvedValue(res(completion()));
    const local = load();
    expect((await local.call(args({ temperature: 0 }))).decoding).toEqual({ temperature: 0, thinking: null });
    expect((await local.call(args())).decoding).toEqual({ temperature: null, thinking: null });
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

  test('records the engine and its version from the server system_fingerprint', async () => {
    fetchMock.mockResolvedValue(res(completion({ system_fingerprint: 'vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2-48c629c0' })));
    const r = await load().call(args());
    // Verbatim: the version lives inside the string, and it is what an auditor can check.
    expect(r.runtime).toBe('vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2-48c629c0');
    expect(r.engine).toBe('vllm');
  });

  test('an UNRECOGNISED fingerprint records the raw runtime but no engine', async () => {
    // OpenAI's shape. Writing `fp_44709d6fcb` into a field an auditor reads as "inference engine"
    // would be worse than leaving it empty, so the guess is refused and the raw string still lands.
    fetchMock.mockResolvedValue(res(completion({ system_fingerprint: 'fp_44709d6fcb' })));
    const r = await load().call(args());
    expect(r.runtime).toBe('fp_44709d6fcb');
    expect(r.engine).toBeNull();
  });

  test('a server that reports no fingerprint records null, not a guess from the model name', async () => {
    fetchMock.mockResolvedValue(res(completion({})));
    const r = await load().call(args());
    expect(r.runtime).toBeNull();
    expect(r.engine).toBeNull();
  });

  test('engine matching is case-insensitive and tolerates surrounding space', async () => {
    fetchMock.mockResolvedValue(res(completion({ system_fingerprint: '  Ollama-0.33.3  ' })));
    expect((await load().call(args())).engine).toBe('ollama');
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
    // 2, not 24: measured on the DGX, two concurrent PIS-7 evaluations already push p95 to 114s.
    expect(local.stats().maxConcurrency).toBe(2);
  });

  test('LOCAL_MAX_CONCURRENCY caps in-flight calls; the excess queues and still completes', async () => {
    process.env.LOCAL_MAX_CONCURRENCY = '3';
    // Purposeless calls ride the background lane; open it fully (no reserve, deep queue) so this
    // stays a test of the concurrency cap alone. The lane rules have their own block below.
    process.env.LOCAL_INTERACTIVE_RESERVE = '0';
    process.env.LOCAL_MAX_QUEUE_BACKGROUND = '100';
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
    process.env.LOCAL_INTERACTIVE_RESERVE = '0';   // background may use both slots here
    process.env.LOCAL_MAX_QUEUE_BACKGROUND = '10';
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
// The two-lane bounded queue (providers/runtime.js `lanes`), as wired by THIS provider: purpose →
// lane, the interactive reserve, bounded depth → queue_full, the caller's signal → cancellation, and
// the proactive 413 size backstop. The scheduler's own invariants live in runtime-lanes.test.js.
describe('two-lane queue — purpose → lane, reserve, bounded depth, cancellation', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A fetch that holds its slot until finish() — or rejects the way undici does when its signal
  // aborts. After finish(), later fetches resolve at once so queued calls can drain.
  function hangingFetch() {
    const pending = [];
    let released = false;
    fetchMock.mockImplementation((_url, opts) => new Promise((resolve, reject) => {
      if (released) return resolve(res(completion()));
      pending.push(() => resolve(res(completion())));
      opts.signal?.addEventListener('abort', () => reject(opts.signal.reason ?? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    }));
    return { finish: () => { released = true; pending.splice(0).forEach((done) => done()); } };
  }

  test('chat / criteria / discuss ride the interactive lane; evaluate / shadow / unknown ride background', async () => {
    process.env.LOCAL_MAX_CONCURRENCY = '8';
    process.env.LOCAL_INTERACTIVE_RESERVE = '1';
    const { finish } = hangingFetch();
    const local = load();
    expect(local.LANE_FOR).toEqual({ chat: 'interactive', criteria: 'interactive', discuss: 'interactive', evaluate: 'background', shadow: 'background' });
    expect(local.laneFor('some-new-purpose')).toBe('background');
    expect(local.laneFor(undefined)).toBe('background');

    const calls = ['chat', 'criteria', 'discuss', 'evaluate', 'shadow', undefined].map((purpose) => local.call(args({ purpose })));
    await sleep(5);
    const s = local.stats();
    expect(s.lanes.interactive.active).toBe(3);
    expect(s.lanes.background.active).toBe(3);   // maxActive = 8 − 1 = 7, so all three start
    expect(s.active).toBe(6);
    finish();
    await Promise.all(calls);
    expect(local.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('the reserve admits a chat turn while the background lane is saturated', async () => {
    process.env.LOCAL_MAX_CONCURRENCY = '2';
    process.env.LOCAL_INTERACTIVE_RESERVE = '1';
    process.env.LOCAL_MAX_QUEUE_BACKGROUND = '5';
    const { finish } = hangingFetch();
    const local = load();
    const e1 = local.call(args({ purpose: 'evaluate' }));   // starts: nothing in flight
    const e2 = local.call(args({ purpose: 'evaluate' }));   // waits: background may hold only 2 − 1 slots
    await sleep(5);
    expect(local.stats().lanes.background).toMatchObject({ active: 1, queued: 1, maxActive: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const c1 = local.call(args({ purpose: 'chat' }));        // the reserved slot: starts at once
    await sleep(5);
    expect(local.stats().lanes.interactive).toMatchObject({ active: 1, queued: 0 });
    expect(local.stats().lanes.background.queued).toBe(1);   // the evaluation is still waiting
    expect(fetchMock).toHaveBeenCalledTimes(2);

    finish();
    await Promise.all([e1, e2, c1]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('a full lane is refused at once with queue_full (503, Retry-After from LOCAL_QUEUE_RETRY_AFTER_S) — nothing queued, nothing counted', async () => {
    process.env.LOCAL_MAX_CONCURRENCY = '1';
    process.env.LOCAL_INTERACTIVE_RESERVE = '0';
    process.env.LOCAL_MAX_QUEUE_BACKGROUND = '1';
    process.env.LOCAL_QUEUE_RETRY_AFTER_S = '7';
    const { finish } = hangingFetch();
    const local = load();
    const running = local.call(args({ purpose: 'evaluate' }));
    const queued = local.call(args({ purpose: 'evaluate' }));
    await sleep(5);
    expect(local.stats()).toMatchObject({ active: 1, queued: 1 });

    await expect(local.call(args({ purpose: 'evaluate' }))).rejects.toMatchObject({
      code: 'queue_full', status: 503, lane: 'background', retryAfterMs: 7000,
    });
    expect(local.stats()).toMatchObject({ active: 1, queued: 1 });   // the refusal touched nothing
    expect(fetchMock).toHaveBeenCalledTimes(1);                       // and never reached the box

    finish();
    await Promise.all([running, queued]);
  });

  test('LOCAL_INTERACTIVE_RESERVE at or above LOCAL_MAX_CONCURRENCY is clamped (with a warning) so background work still runs', async () => {
    process.env.LOCAL_MAX_CONCURRENCY = '1';
    process.env.LOCAL_INTERACTIVE_RESERVE = '1';
    fetchMock.mockResolvedValue(res(completion()));
    const local = load();
    expect((await local.call(args({ purpose: 'evaluate' }))).text).toBe('hello');
    expect(local.stats().lanes.background.maxActive).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/LOCAL_INTERACTIVE_RESERVE=1.*clamping/));
  });

  test('the caller signal reaches fetch (combined with our deadline); aborting it cancels the request, releases the slot, and is NOT retried', async () => {
    process.env.LOCAL_MAX_RETRIES = '3';
    const { finish } = hangingFetch();
    const ac = new AbortController();
    const local = load();
    const p = local.call(args({ purpose: 'chat', signal: ac.signal }));
    await sleep(5);
    const sent = lastOpts().signal;
    expect(typeof sent.aborted).toBe('boolean');
    expect(sent.aborted).toBe(false);

    ac.abort();
    expect(sent.aborted).toBe(true);        // the composite signal follows the caller's
    // undici rejects with a message matching the retryable regex (/aborted/); the `aborted` tag must win.
    await expect(p).rejects.toMatchObject({ aborted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);                 // no retry storm for a caller that left
    expect(local.stats()).toMatchObject({ active: 0, queued: 0 }); // the slot is free again
    finish();
  });

  test('a caller that aborts while still QUEUED leaves the queue without ever reaching the box', async () => {
    process.env.LOCAL_MAX_CONCURRENCY = '1';
    process.env.LOCAL_INTERACTIVE_RESERVE = '0';
    const { finish } = hangingFetch();
    const ac = new AbortController();
    const local = load();
    const running = local.call(args({ purpose: 'chat' }));
    const waiting = local.call(args({ purpose: 'chat', signal: ac.signal }));
    await sleep(5);
    expect(local.stats()).toMatchObject({ active: 1, queued: 1 });

    ac.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'aborted', aborted: true });
    expect(local.stats()).toMatchObject({ active: 1, queued: 0 });
    finish();
    await running;
    expect(fetchMock).toHaveBeenCalledTimes(1);   // the aborted waiter never produced a request
    expect(local.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('our own TimeoutError is still tagged localTimeout (not aborted) when the caller signal is present but idle', async () => {
    const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    fetchMock.mockRejectedValue(timeoutErr);
    const ac = new AbortController();
    await expect(load().call(args({ purpose: 'chat', signal: ac.signal }))).rejects.toMatchObject({ localTimeout: true });
    expect(timeoutErr.aborted).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ----- proactive size backstop: SELF-CALIBRATING, in the server's prompt-token unit -----
  // LOCAL_AI_MAX_PROMPT_TOKENS is compared against the bytes/3 estimate CONVERTED through a ratio learnt
  // from served responses (ratio = est / usage.prompt_tokens, EWMA alpha 0.2). Before 3 served calls it
  // never pre-rejects: a wrong ratio rejects work the box can do, and with the raw estimate a Thai PLE
  // (3 bytes a character) was refused at ~30% of real capacity.
  const PII_TRANSCRIPT = 'ผู้ป่วยชื่อ สมชาย ใจดี HN 12345678 โทร 081-234-5678 ' + 'เจ็บหน้าอก '.repeat(40);
  const withSystem = (content) => [{ role: 'system', content: 'You are a Socratic tutor.' }, { role: 'user', content }];
  const sentEstimate = (local) => local.estimatePromptTokens(JSON.parse(fetchMock.mock.calls.at(-1)[1].body).messages);

  // A server that reports prompt_tokens = est / ratio for the exact body it was sent, so the learnt
  // ratio converges on `ratio` (up to the rounding of prompt_tokens to an integer).
  const serveAtRatio = (local, ratio) => async (_url, opts) => {
    const est = local.estimatePromptTokens(JSON.parse(opts.body).messages);
    return res(completion({ usage: { prompt_tokens: Math.round(est / ratio), completion_tokens: 4, total_tokens: 0 } }));
  };
  async function calibrate(local, ratio, n = 3) {
    for (let i = 0; i < n; i++) {
      fetchMock.mockImplementationOnce(serveAtRatio(local, ratio));
      await local.call(args({ purpose: 'chat', messages: [{ role: 'user', content: `calibration sample ${i} ` + 'x'.repeat(300 + i) }] }));
    }
  }

  test('(a) before 3 served calls the backstop never pre-rejects: a huge payload with the limit set still reaches fetch', async () => {
    process.env.LOCAL_AI_MAX_PROMPT_TOKENS = '50';
    const local = load();
    expect(local.stats().prompt_calibration).toEqual({ ratio: null, n: 0 });
    // The box serves this payload at a Thai-like ratio of 3 — i.e. at ~170 server tokens, well OVER the
    // limit of 50 — on every call. Inside the window it is sent anyway; the window is the point.
    fetchMock.mockImplementation(serveAtRatio(local, 3));
    const big = args({ purpose: 'evaluate', messages: [{ role: 'user', content: PII_TRANSCRIPT }] });

    for (const n of [0, 1, 2]) {
      expect(local.stats().prompt_calibration.n).toBe(n);
      const r = await local.call(big);
      expect(r.text).toBe('hello');                       // SENT, not refused…
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentEstimate(local)).toBeGreaterThan(50);     // …though the raw bytes/3 estimate was far above the limit throughout
    expect(local.stats().prompt_calibration.n).toBe(3);  // the window has just closed…

    await expect(local.call(big)).rejects.toMatchObject({ status: 413, code: 'transcript_too_large', limit: 50 });
    expect(fetchMock).toHaveBeenCalledTimes(3);          // …and the SAME payload is now refused before any fetch
  });

  test('(b) after 3 served calls a prompt whose PREDICTED server size exceeds the limit is 413 BEFORE any fetch, numbers only', async () => {
    process.env.LOCAL_AI_MAX_PROMPT_TOKENS = '50';
    const local = load();
    await calibrate(local, 3);                            // the box reports ~1 token per 3 estimate units (Thai-like)
    expect(local.stats().prompt_calibration.n).toBe(3);
    expect(local.stats().prompt_calibration.ratio).toBeCloseTo(3, 1);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(res(completion()));

    const p = local.call(args({ purpose: 'evaluate', messages: [{ role: 'user', content: PII_TRANSCRIPT }] }));
    await expect(p).rejects.toMatchObject({
      status: 413, code: 'transcript_too_large', contextTooSmall: true, limit: 50,
      est_tokens: expect.any(Number), calibration: { ratio: expect.any(Number), n: 3 },
    });
    const err = await p.catch((e) => e);
    const est = local.estimatePromptTokens(withSystem(PII_TRANSCRIPT));
    expect(err.est_tokens).toBeGreaterThan(50);
    expect(err.est_tokens).toBeLessThan(est);                                        // CONVERTED to server tokens, not the raw bytes/3
    expect(Math.abs(err.est_tokens - est / err.calibration.ratio)).toBeLessThan(2); // est / ratio, rounded
    expect(Number.isInteger(err.est_tokens)).toBe(true);
    expect(Object.values(err.calibration).every((v) => typeof v === 'number')).toBe(true);
    for (const frag of ['สมชาย', 'ใจดี', '12345678', '081-234-5678', 'เจ็บหน้าอก']) expect(err.message).not.toContain(frag);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(local.stats()).toMatchObject({ active: 0, queued: 0 });   // never took a slot
  });

  test('(c) the bug this fixes: a Thai-heavy prompt whose raw estimate is OVER the limit but whose predicted server size is UNDER it is sent', async () => {
    const local = load();
    await calibrate(local, 3);                            // learnt from the box: Thai runs ~3 estimate units per served token
    const thai = 'เจ็บหน้าอก '.repeat(40);                // 3 bytes a character
    const rawEst = local.estimatePromptTokens(withSystem(thai));
    const predicted = rawEst / local.stats().prompt_calibration.ratio;
    process.env.LOCAL_AI_MAX_PROMPT_TOKENS = String(Math.round(predicted) + 40);   // between predicted and raw
    expect(rawEst).toBeGreaterThan(Number(process.env.LOCAL_AI_MAX_PROMPT_TOKENS)); // the OLD rule would have refused this
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(res(completion()));

    const r = await local.call(args({ purpose: 'evaluate', messages: [{ role: 'user', content: thai }] }));
    expect(r.text).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(1);          // the calibrated rule sends it
  });

  test('(d) stats() exposes prompt_calibration for /health/deep: null/0 before any served call, then the EWMA ratio (3dp) and n', async () => {
    const local = load();
    expect(local.stats().prompt_calibration).toEqual({ ratio: null, n: 0 });

    fetchMock.mockResolvedValueOnce(res(completion({ usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 } })));
    await local.call(args({ purpose: 'chat' }));
    const est = sentEstimate(local);
    const r1 = est / 100;
    expect(local.stats().prompt_calibration).toEqual({ ratio: Number(r1.toFixed(3)), n: 1 });

    // A second sample at a different ratio (same body) moves the EWMA by alpha = 0.2.
    fetchMock.mockResolvedValueOnce(res(completion({ usage: { prompt_tokens: 50, completion_tokens: 4, total_tokens: 54 } })));
    await local.call(args({ purpose: 'chat' }));
    const r2 = est / 50;
    expect(local.stats().prompt_calibration).toEqual({ ratio: Number((r1 + 0.2 * (r2 - r1)).toFixed(3)), n: 2 });
  });

  test('a response without usage.prompt_tokens (or a non-positive one) leaves the calibration untouched', async () => {
    const local = load();
    fetchMock.mockResolvedValueOnce(res(completion({ usage: undefined })));
    await local.call(args({ purpose: 'chat' }));
    fetchMock.mockResolvedValueOnce(res(completion({ usage: { prompt_tokens: 0, completion_tokens: 4 } })));
    await local.call(args({ purpose: 'chat' }));
    expect(local.stats().prompt_calibration).toEqual({ ratio: null, n: 0 });
  });

  test('LOCAL_LOG_PROMPT_RATIO=1 prints one console.debug line per served call, numbers only; unset prints nothing', async () => {
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      fetchMock.mockResolvedValue(res(completion({ usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 } })));
      await load().call(args({ purpose: 'chat', messages: [{ role: 'user', content: PII_TRANSCRIPT }] }));
      expect(debugSpy).not.toHaveBeenCalled();

      process.env.LOCAL_LOG_PROMPT_RATIO = '1';
      await load().call(args({ purpose: 'chat', messages: [{ role: 'user', content: PII_TRANSCRIPT }] }));
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const line = debugSpy.mock.calls[0][0];
      expect(line).toMatch(/^\[local\] prompt est=\d+ served=100 ratio=\d+\.\d{3} n=1$/);
      for (const frag of ['สมชาย', 'ใจดี', '12345678', '081-234-5678', 'เจ็บหน้าอก']) expect(line).not.toContain(frag);
    } finally {
      debugSpy.mockRestore();
    }
  });

  test('LOCAL_AI_MAX_PROMPT_TOKENS unset / 0 disables the backstop even when calibrated', async () => {
    const local = load();
    await calibrate(local, 3);
    fetchMock.mockResolvedValue(res(completion()));
    const r = await local.call(args({ purpose: 'evaluate', messages: [{ role: 'user', content: 'x'.repeat(50000) }] }));
    expect(r.text).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(4);          // 3 calibration calls + this one
  });

  test('estimatePromptTokens is UTF-8 bytes / 3 (Thai counts three bytes a character)', () => {
    const local = load();
    const msgs = [{ role: 'user', content: 'เจ็บหน้าอก' }];
    expect(local.estimatePromptTokens(msgs)).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(msgs), 'utf8') / 3));
  });

  test("the server's own context-length 400 carries the same code, transcript_too_large, and is not retried", async () => {
    fetchMock.mockResolvedValue(res({ error: { message: 'the prompt exceeds the available context size (4096)' } }, { status: 400, statusText: 'Bad Request' }));
    await expect(load().call(args({ purpose: 'evaluate' }))).rejects.toMatchObject({
      status: 400, contextTooSmall: true, code: 'transcript_too_large', est_tokens: expect.any(Number), limit: null,
      calibration: { ratio: null, n: 0 },   // uncalibrated: est_tokens is the raw bytes/3 estimate, and the body says so
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a retry log line reports both lanes', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ error: 'busy' }, { status: 503, statusText: 'Service Unavailable' }))
      .mockResolvedValueOnce(res(completion()));
    await load().call(args({ purpose: 'chat' }));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/interactive 1 running\/0 waiting, background 0 running\/0 waiting/));
  });
});

// ---------------------------------------------------------------------------
describe('ready() — /health/deep probe', () => {
  test('up when GET /models lists the configured model (and it uses GET, no generation)', async () => {
    fetchMock.mockResolvedValue(res({ data: [{ id: 'qwen3-32b-medical' }, { id: 'other' }] }));
    const r = await load().ready();

    // context_length 'unknown' — the mocked /api/show reply carries no model_info, which is exactly
    // what a non-Ollama server (vLLM, SGLang) looks like. Unknown must not read as unhealthy.
    expect(r.checks.local_ai).toEqual({ status: 'up', model: 'qwen3-32b-medical', context_length: 'unknown', min_context: 16384 });
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
// Context length — the measured blocker for running a real PLE on the DGX.
//
// On 2026-08-24 a 9,144-token evaluation against the box returned
// 400 "... exceeds the available context size (4096)". A creditable PLE is >= 10,000 tokens (C3), so
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

  test('DOWN when the box serves less context than a PLE transcript needs', async () => {
    probeRoutes({ model_info: { 'qwen3.context_length': 4096 } });
    const r = await load().ready();

    expect(r.checks.local_ai.status).toBe('down');
    expect(r.checks.local_ai.context_length).toBe(4096);
    expect(r.checks.local_ai.error).toMatch(/4096/);
    expect(r.checks.local_ai.error).toMatch(/16384/);
    // Both numbers as FIELDS, not only in the prose. The gate that consumes this renders
    // "measured X, needs Y" from them; parsing the sentence is what left the production refusal
    // reporting measured: null while the message said 4096.
    expect(r.checks.local_ai.min_context).toBe(16384);
  });

  test('UP, and reports the number, when the context is adequate', async () => {
    probeRoutes({ model_info: { 'llama.context_length': 32768 } });
    const r = await load().ready();
    expect(r.checks.local_ai).toEqual({ status: 'up', model: 'qwen3-32b-medical', context_length: 32768, min_context: 16384 });
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
    expect(r.checks.local_ai.status).toBe('down'); // adequate for a PLE, below THIS deployment's bar
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
