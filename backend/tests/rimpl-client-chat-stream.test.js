// rimplChat({ stream: true }) — reading rimpl's server-sent events (rimpl/src/lib/sse.js).
// `delta` / `replace` reach onEvent in order; the final `done` event resolves with the same body a
// non-streamed call returns (provider stamped), or throws the same error rimplError would; a stream
// that ends without `done` is a 502; a plain-JSON answer (rescue turn) is read as before.
const savedFetch = global.fetch;
afterAll(() => { global.fetch = savedFetch; });
const { rimplChat } = require('../src/services/rimpl-client');

const CALL = { ple_id: 'p1', history: [], message: 'hello', language: 'en', socratic: false, artifacts: false };
const enc = new TextEncoder();
const sseRes = (chunks) => ({
  ok: true, status: 200,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
  body: { async *[Symbol.asyncIterator]() { for (const c of chunks) yield enc.encode(c); } },
});
const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

test('forwards events in order and resolves with the done body (provider stamped when absent)', async () => {
  const whole = ev('delta', { text: 'Hel' }) + ev('delta', { text: 'lo' }) + ev('done', { status: 200, body: { content: 'Hello', refs: [] } });
  // split mid-event, as a socket may
  global.fetch = jest.fn().mockResolvedValue(sseRes([whole.slice(0, 17), whole.slice(17)]));
  const seen = [];
  const out = await rimplChat({ ...CALL, stream: true, onEvent: (n, d) => seen.push([n, d]) });
  expect(seen).toEqual([['delta', { text: 'Hel' }], ['delta', { text: 'lo' }]]);
  expect(out).toEqual({ content: 'Hello', refs: [], provider: 'anthropic' });
  const sent = global.fetch.mock.calls[0][1];
  expect(JSON.parse(sent.body).stream).toBe(true);
  expect(sent.headers.accept).toBe('text/event-stream');
});

test('a done event with an error status throws the usual error (status, code, retryAfterMs)', async () => {
  global.fetch = jest.fn().mockResolvedValue(sseRes([ev('delta', { text: 'x' }), ev('done', { status: 503, body: { error: 'busy', code: 'queue_full', retry_after_s: 30 } })]));
  await expect(rimplChat({ ...CALL, stream: true, onEvent: () => {} }))
    .rejects.toMatchObject({ status: 503, code: 'queue_full', retryAfterMs: 30000 });
});

test('a stream that ends without done is a 502', async () => {
  global.fetch = jest.fn().mockResolvedValue(sseRes([ev('delta', { text: 'half' })]));
  await expect(rimplChat({ ...CALL, stream: true, onEvent: () => {} })).rejects.toMatchObject({ status: 502 });
});

test('a plain JSON answer to a stream request (a rescue turn) is read as before', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ content: 'Q?', provider: 'local' }) });
  const onEvent = jest.fn();
  expect(await rimplChat({ ...CALL, stream: true, onEvent })).toEqual({ content: 'Q?', provider: 'local' });
  expect(onEvent).not.toHaveBeenCalled();
});

test('without stream the request carries no stream flag and no accept header', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ content: 'hi' }) });
  await rimplChat(CALL);
  const sent = global.fetch.mock.calls[0][1];
  expect(JSON.parse(sent.body)).not.toHaveProperty('stream');
  expect(sent.headers).not.toHaveProperty('accept');
});
