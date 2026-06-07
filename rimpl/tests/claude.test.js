// callClaude must (a) retry transient errors (429/5xx/overload) with backoff, (b) NOT retry
// non-retryable errors (e.g. 400), and (c) cap in-flight concurrency to a queue. The code reads
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

const { callClaude } = require('../src/services/claude');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MSG = { content: [{ text: 'hi' }], usage: { input_tokens: 5, output_tokens: 7 } };
const okResp = { data: MSG, response: { headers: new Map() } };
const args = () => ({ systemPrompt: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });

beforeEach(() => { mockCall.mockReset(); });

test('retries a 429 (rate-limit) then succeeds', async () => {
  mockCall.mockRejectedValueOnce({ status: 429 }).mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce(okResp);
  const r = await callClaude(args());
  expect(r).toEqual({ text: 'hi', tokenCount: 12 });
  expect(mockCall).toHaveBeenCalledTimes(3);
});

test('retries a 529 (overloaded) then succeeds', async () => {
  mockCall.mockRejectedValueOnce({ status: 529 }).mockResolvedValueOnce(okResp);
  const r = await callClaude(args());
  expect(r.text).toBe('hi');
  expect(mockCall).toHaveBeenCalledTimes(2);
});

test('does NOT retry a non-retryable 400', async () => {
  mockCall.mockRejectedValue({ status: 400, message: 'bad request' });
  await expect(callClaude(args())).rejects.toMatchObject({ status: 400 });
  expect(mockCall).toHaveBeenCalledTimes(1);
});

test('gives up after exhausting retries on a persistent 429', async () => {
  mockCall.mockRejectedValue({ status: 429 });
  await expect(callClaude(args())).rejects.toMatchObject({ status: 429 });
  expect(mockCall).toHaveBeenCalledTimes(6); // 1 + 5 retries
});

test('caps in-flight concurrency to CLAUDE_MAX_CONCURRENCY (queue)', async () => {
  let inFlight = 0, peak = 0;
  mockCall.mockImplementation(async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(25); inFlight--; return okResp; });
  await Promise.all(Array.from({ length: 12 }, () => callClaude(args())));
  expect(peak).toBeLessThanOrEqual(3);
  expect(mockCall).toHaveBeenCalledTimes(12); // all 12 eventually run
});
