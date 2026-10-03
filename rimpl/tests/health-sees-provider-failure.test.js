// /health/deep used to report `ok` while the Anthropic key could not serve a single request:
// ready() checked only that the env var was set and the SDK constructed, "WITHOUT making a
// completion call (zero token spend)". So an exhausted balance, a revoked key and a hard rate limit
// all read as healthy — the same shape as the outage that left production broken for three days
// with both operator screens green.
//
// The fix records what the runner last OBSERVED (still zero extra spend) and interprets it. Every
// case below is a way that fix could go wrong, not a way the SDK works.
process.env.CLAUDE_MAX_CONCURRENCY = '3';
process.env.CLAUDE_MAX_RETRIES = '2';
process.env.CLAUDE_RETRY_BASE_MS = '1';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockCall = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: () => ({ withResponse: () => mockCall() }) },
})));

const provider = require('../src/services/providers/anthropic');
const MSG = { content: [{ text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' };
const okReply = { data: MSG, response: { headers: new Map() } };
const err = (status, message) => Object.assign(new Error(message), { status });
const serving = () => provider.ready().checks.anthropic_serving;
const say = async (msg = 'x') => provider.call({ system: 's', messages: [{ role: 'user', content: msg }], purpose: 'chat' });

beforeEach(() => { mockCall.mockReset(); });

test('a provider that has never been called is not reported as broken', () => {
  // Boot state. Reporting `down` here would make every fresh deploy look dead.
  expect(serving().status).toBe('up');
});

test('an exhausted balance is visible — this is the whole point', async () => {
  mockCall.mockRejectedValue(err(400, 'Your credit balance is too low to access the Anthropic API'));
  await expect(say()).rejects.toThrow(/credit balance/);
  const s = serving();
  expect(s.status).toBe('down');
  expect(s.error).toMatch(/cannot pay/);
  expect(s.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test('a revoked key (401) and a forbidden key (403) are visible', async () => {
  mockCall.mockRejectedValue(err(401, 'invalid x-api-key'));
  await expect(say()).rejects.toThrow();
  expect(serving().status).toBe('down');
  expect(serving().error).toMatch(/401/);

  mockCall.mockResolvedValue(okReply);
  await say();                                   // clear
  mockCall.mockRejectedValue(err(403, 'forbidden'));
  await expect(say()).rejects.toThrow();
  expect(serving().error).toMatch(/403/);
});

test('ONE malformed request does not declare the provider dead', async () => {
  // The trap in this fix: 400 is non-retryable, so "non-retryable" is the wrong predicate — a
  // prompt over the context limit would take the whole deployment down with it.
  mockCall.mockRejectedValue(err(400, 'prompt is too long: 300000 tokens > 200000 maximum'));
  await expect(say()).rejects.toThrow(/too long/);
  expect(serving().status).toBe('up');
});

test('a rate limit is not an outage — it is retried, and it never reaches the health verdict', async () => {
  mockCall.mockRejectedValueOnce(err(429, 'rate_limit_error')).mockResolvedValue(okReply);
  await say();
  expect(serving().status).toBe('up');
});

test('a rate limit that exhausts the retry budget still does not read as down', async () => {
  mockCall.mockRejectedValue(err(429, 'rate_limit_error'));
  await expect(say()).rejects.toThrow();
  expect(serving().status).toBe('up');   // capacity, not credentials
});

test('a success after a failure clears it — an operator who fixes the key sees green', async () => {
  mockCall.mockRejectedValue(err(400, 'Your credit balance is too low'));
  await expect(say()).rejects.toThrow();
  expect(serving().status).toBe('down');

  mockCall.mockResolvedValue(okReply);
  await say();
  expect(serving().status).toBe('up');
});

test('stats() carries lastOk and lastError so the check has something to read', async () => {
  mockCall.mockResolvedValue(okReply);
  await say();
  const s = provider.stats();
  expect(typeof s.lastOk).toBe('number');
  expect(s.maxConcurrency).toBeDefined();       // the pre-existing fields survive the merge
});

test('the key and client checks still work, and ready() never throws', () => {
  const r = provider.ready();
  expect(r.checks.anthropic_key.status).toBe('up');
  expect(r.checks.anthropic_client.status).toBe('up');
  expect(Object.keys(r.checks)).toContain('anthropic_serving');
});
