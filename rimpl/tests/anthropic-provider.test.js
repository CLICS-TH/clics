// The Anthropic provider's call() must (a) retry transient errors (429/5xx/overload) with backoff,
// (b) NOT retry non-retryable errors (e.g. 400), and (c) cap in-flight concurrency to a queue —
// the retry/queue policy the old services/claude.js owned, now behind the provider interface that
// services/ai.js dispatches to (shared machinery in providers/runtime.js). The code reads
// rate-limit headers via .withResponse(), so the mock returns { data, response } accordingly.
// Env is set BEFORE requiring the module (limits are read at module load).
process.env.CLAUDE_MAX_CONCURRENCY = '3';
process.env.CLAUDE_MAX_RETRIES = '5';
process.env.CLAUDE_RETRY_BASE_MS = '5'; // tiny backoff so tests run fast
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.CLAUDE_TIMEOUT_MS;   // the late-retry cutoff is derived from it

const mockCall = jest.fn(); // resolves/rejects the .withResponse() promise per attempt
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  // The request options are passed through to mockCall so the abort tests below can read `signal`.
  messages: { create: (body, opts) => ({ withResponse: () => mockCall(body, opts) }) },
})));

const provider = require('../src/services/providers/anthropic');
const call = provider.call;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MSG = { content: [{ text: 'hi' }], usage: { input_tokens: 5, output_tokens: 7 }, stop_reason: 'end_turn' };
const okResp = { data: MSG, response: { headers: new Map() } };
const args = () => ({ systemPrompt: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });

beforeEach(() => { mockCall.mockReset(); });

test('retries a 429 (rate-limit) then succeeds', async () => {
  mockCall.mockRejectedValueOnce({ status: 429 }).mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce(okResp);
  const r = await call(args());
  // The full result contract callers depend on: `model` is now part of it (services/ai.js stamps
  // §10.2 provenance from it) and `stopReason` distinguishes truncation from a finished non-JSON
  // reply. Exact-match so a dropped field fails here rather than downstream.
  expect(r).toEqual({
    text: 'hi', inputTokens: 5, outputTokens: 7, tokenCount: 12,
    stopReason: 'end_turn', model: 'claude-sonnet-4-6',
  });
  expect(mockCall).toHaveBeenCalledTimes(3);
});

test('retries a 529 (overloaded) then succeeds', async () => {
  mockCall.mockRejectedValueOnce({ status: 529 }).mockResolvedValueOnce(okResp);
  const r = await call(args());
  expect(r.text).toBe('hi');
  expect(mockCall).toHaveBeenCalledTimes(2);
});

test('does NOT retry a non-retryable 400', async () => {
  mockCall.mockRejectedValue({ status: 400, message: 'bad request' });
  await expect(call(args())).rejects.toMatchObject({ status: 400 });
  expect(mockCall).toHaveBeenCalledTimes(1);
});

test('gives up after exhausting retries on a persistent 429', async () => {
  mockCall.mockRejectedValue({ status: 429 });
  await expect(call(args())).rejects.toMatchObject({ status: 429 });
  expect(mockCall).toHaveBeenCalledTimes(6); // 1 + 5 retries
});

test('caps in-flight concurrency to CLAUDE_MAX_CONCURRENCY (queue)', async () => {
  let inFlight = 0, peak = 0;
  mockCall.mockImplementation(async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(25); inFlight--; return okResp; });
  await Promise.all(Array.from({ length: 12 }, () => call(args())));
  expect(peak).toBeLessThanOrEqual(3);
  expect(mockCall).toHaveBeenCalledTimes(12); // all 12 eventually run
});

// The provider interface services/ai.js dispatches on. ai.js reads `name` (stamped onto every
// result) and `model()` (reported by /health/deep), so a rename here breaks provenance + health
// silently — pin the shape.
test('exposes the provider interface ai.js dispatches on', () => {
  expect(provider.name).toBe('anthropic');
  expect(provider.model()).toBe('claude-sonnet-4-6');
  expect(typeof provider.call).toBe('function');
  expect(typeof provider.ready).toBe('function');
});

// services/ai.js forwards `purpose` and `signal` to EVERY provider. Anthropic has no lanes, but the
// signal reaches the SDK (an in-flight call is cancelled at the socket) and the runner (a queued call
// never starts), and the purpose marks an evaluation for the late-retry cutoff. Without the signal a
// hung-up call ran to completion, billed and unmetered, and the drain then paid for it again.
describe('the caller\'s abort signal', () => {
  // What SDK 0.30.1 does with `signal`: rejects the in-flight request with APIUserAbortError.
  const abortable = (_body, opts) => new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }));
    if (opts?.signal?.aborted) return fail();
    opts?.signal?.addEventListener('abort', fail, { once: true });
  });

  test('reaches the SDK, and an abort in flight rejects as aborted with NO retry', async () => {
    mockCall.mockImplementation(abortable);
    const ac = new AbortController();
    const p = call({ ...args(), purpose: 'evaluate', signal: ac.signal });
    await sleep(5);
    expect(mockCall.mock.calls[0][1].signal).toBeDefined();   // passed through to messages.create
    ac.abort();
    await expect(p).rejects.toMatchObject({ aborted: true, code: 'aborted' });
    await sleep(20);
    expect(mockCall).toHaveBeenCalledTimes(1);                 // "Request was aborted." matches /aborted/, but is never retried
  });

  test('a call still QUEUED when its caller hangs up never starts', async () => {
    const hold = [];
    mockCall.mockImplementation(() => new Promise((resolve) => hold.push(() => resolve(okResp))));
    const busy = [call(args()), call(args()), call(args())];          // fill all 3 slots
    await sleep(5);
    expect(mockCall).toHaveBeenCalledTimes(3);
    const ac = new AbortController();
    const queued = call({ ...args(), signal: ac.signal });
    ac.abort();                                                         // hung up while waiting
    hold.forEach((release) => release());
    await Promise.all(busy);
    await expect(queued).rejects.toMatchObject({ aborted: true });
    expect(mockCall).toHaveBeenCalledTimes(3);                         // the 4th never reached the SDK
  });

  test('a normal call is unaffected by the purpose and signal keys', async () => {
    mockCall.mockResolvedValueOnce(okResp);
    const ac = new AbortController();
    const r = await call({ ...args(), purpose: 'chat', signal: ac.signal });
    expect(r).toEqual({ text: 'hi', inputTokens: 5, outputTokens: 7, tokenCount: 12, stopReason: 'end_turn', model: 'claude-sonnet-4-6' });
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(provider.stats()).toEqual({ provider: 'anthropic', active: 0, queued: 0, maxConcurrency: 3,
      lastOk: expect.any(Number), lastError: null }); // no `lanes`: still the FIFO
  });
});

// A retry that STARTS after 480 − 150 − 30 = 300s cannot finish before the backend's 480s deadline.
describe('late-retry cutoff for evaluations', () => {
  let now, spy, warn;
  beforeEach(() => {
    now = 1_000_000;
    spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { spy.mockRestore(); warn.mockRestore(); });
  // The 529 "arrives" after the given number of seconds.
  const lateFailure = (seconds) => async () => { now += seconds * 1000; throw { status: 529 }; };

  test('the cutoff is derived from the timeouts: 480 − 150 − 30 = 300s by default', () => {
    expect(provider.EVAL_LATE_RETRY_MS).toBe(300000);
  });

  test.each(['evaluate', 'shadow'])('a %s error arriving after the cutoff is NOT retried', async (purpose) => {
    mockCall.mockImplementationOnce(lateFailure(301)).mockResolvedValue(okResp);
    await expect(call({ ...args(), purpose })).rejects.toMatchObject({ status: 529 });
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/not retrying a late evaluation error/);
  });

  test('an evaluation error inside the cutoff is still retried', async () => {
    mockCall.mockImplementationOnce(lateFailure(200)).mockResolvedValue(okResp);
    expect((await call({ ...args(), purpose: 'evaluate' })).text).toBe('hi');
    expect(mockCall).toHaveBeenCalledTimes(2);
  });

  test('chat is not subject to it (its own 100s caller deadline aborts it instead)', async () => {
    mockCall.mockImplementationOnce(lateFailure(301)).mockResolvedValue(okResp);
    expect((await call({ ...args(), purpose: 'chat' })).text).toBe('hi');
    expect(mockCall).toHaveBeenCalledTimes(2);
  });
});

// A timeout is APIConnectionTimeoutError ("Request timed out."): not retryable, one attempt.
test('a client timeout is ONE attempt, not retried', async () => {
  mockCall.mockRejectedValue(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }));
  await expect(call({ ...args(), purpose: 'evaluate' })).rejects.toThrow(/timed out/);
  expect(mockCall).toHaveBeenCalledTimes(1);
});

// §10.2: provenance must name the model that ANSWERED. The API reports it in the response body;
// the requested id is only the fallback for a response that omits it (as the mocks above do).
test('stamps the model the API reports, not the one requested', async () => {
  mockCall.mockResolvedValueOnce({ data: { ...MSG, model: 'claude-sonnet-4-6-served' }, response: { headers: new Map() } });
  expect((await call(args())).model).toBe('claude-sonnet-4-6-served');
});

test('ready() reports up when ANTHROPIC_API_KEY is present (no completion call, no spend)', () => {
  const { checks } = provider.ready();
  expect(checks.anthropic_key.status).toBe('up');
  expect(checks.anthropic_client.status).toBe('up');
  expect(mockCall).not.toHaveBeenCalled(); // readiness must never burn a token
});
