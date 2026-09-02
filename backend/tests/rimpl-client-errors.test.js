// rimpl-client error shape since the evaluation drain: a 503 queue_full carries the server's
// Retry-After (body or header) so the drain backs off by the server's estimate; 413 is deterministic.
const savedFetch = global.fetch;
afterAll(() => { global.fetch = savedFetch; });
const { rimplEvaluate, rimplEvaluateCriteria, isDeterministicRimplError } = require('../src/services/rimpl-client');

const respond = ({ status, body, headers = {} }) => ({
  ok: false, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

test('503 queue_full → transient, with retryAfterMs from the body', async () => {
  global.fetch = jest.fn(async () => respond({ status: 503, body: { error: 'busy', code: 'queue_full', retry_after_s: 30 } }));
  const err = await rimplEvaluate({ ple_id: 'p1', transcript: [] }).catch((e) => e);
  expect(err.status).toBe(503);
  expect(err.code).toBe('queue_full');
  expect(err.retryAfterMs).toBe(30_000);
  expect(isDeterministicRimplError(err)).toBe(false);
});

test('a Retry-After HEADER wins over the body value', async () => {
  global.fetch = jest.fn(async () => respond({ status: 503, body: { code: 'queue_full', retry_after_s: 30 }, headers: { 'retry-after': '45' } }));
  const err = await rimplEvaluateCriteria({ transcript: [] }).catch((e) => e);
  expect(err.retryAfterMs).toBe(45_000);
});

test('413 transcript_too_large → DETERMINISTIC (never retried), code preserved', async () => {
  global.fetch = jest.fn(async () => respond({ status: 413, body: { error: 'too large', code: 'transcript_too_large', est_tokens: 70000, limit: 64000 } }));
  const err = await rimplEvaluate({ ple_id: 'p1', transcript: [] }).catch((e) => e);
  expect(err.status).toBe(413);
  expect(err.code).toBe('transcript_too_large');
  expect(isDeterministicRimplError(err)).toBe(true);
});

test('a bare non-OK response (no json, no headers) still produces a status-bearing error', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
  const err = await rimplEvaluate({ ple_id: 'p1', transcript: [] }).catch((e) => e);
  expect(err.status).toBe(500);
  expect(err.retryAfterMs).toBeUndefined();
  expect(isDeterministicRimplError(err)).toBe(false);
});
