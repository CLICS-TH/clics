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

const mockCall = jest.fn(); // resolves/rejects the .withResponse() promise per attempt
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: () => ({ withResponse: () => mockCall() }) },
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

// services/ai.js now forwards `purpose` and `signal` to EVERY provider (the local one picks a queue
// lane from the purpose and cancels on the signal). The relay has neither concept and must simply
// ignore both keys — same request, same result, no lane, no cancellation.
test('ignores the purpose and signal keys callAI forwards (extra keys change nothing)', async () => {
  mockCall.mockResolvedValueOnce(okResp);
  const ac = new AbortController();
  const r = await call({ ...args(), purpose: 'chat', signal: ac.signal });
  expect(r).toEqual({ text: 'hi', inputTokens: 5, outputTokens: 7, tokenCount: 12, stopReason: 'end_turn', model: 'claude-sonnet-4-6' });
  expect(mockCall).toHaveBeenCalledTimes(1);
  expect(provider.stats()).toEqual({ provider: 'anthropic', active: 0, queued: 0, maxConcurrency: 3,
    lastOk: expect.any(Number), lastError: null }); // no `lanes`: still the FIFO
});

test('ready() reports up when ANTHROPIC_API_KEY is present (no completion call, no spend)', () => {
  const { checks } = provider.ready();
  expect(checks.anthropic_key.status).toBe('up');
  expect(checks.anthropic_client.status).toBe('up');
  expect(mockCall).not.toHaveBeenCalled(); // readiness must never burn a token
});
