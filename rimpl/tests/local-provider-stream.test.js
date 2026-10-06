// Local provider, STREAMED (`onDelta`): the OpenAI-style SSE body of /chat/completions.
//
// HERMETIC: global.fetch is mocked; nothing touches the network.
//   * content deltas reach onDelta in order, and the resolved result has the non-streamed shape
//     (text, tokens from the final usage chunk, finish_reason → stopReason, served model);
//   * reasoning_content (chain-of-thought) is NEVER passed on or kept;
//   * the request asks for usage (stream_options.include_usage) — without it a turn bills 0 tokens;
//   * an error before any text is retried as usual; after text has gone out it is terminal.

const LOCAL_ENV = ['LOCAL_AI_BASE_URL', 'LOCAL_AI_MODEL', 'LOCAL_AI_TIMEOUT_MS', 'LOCAL_MAX_RETRIES', 'LOCAL_RETRY_BASE_MS', 'LOCAL_AI_HTTP_PROXY'];
let savedEnv, realFetch, fetchMock, warnSpy;

beforeEach(() => {
  savedEnv = Object.fromEntries(LOCAL_ENV.map((k) => [k, process.env[k]]));
  for (const k of LOCAL_ENV) delete process.env[k];
  process.env.LOCAL_AI_BASE_URL = 'http://dgx.tailnet:8000/v1';
  process.env.LOCAL_AI_MODEL = 'deepseek-test';
  process.env.LOCAL_AI_TIMEOUT_MS = '5000';
  process.env.LOCAL_MAX_RETRIES = '2';
  process.env.LOCAL_RETRY_BASE_MS = '1';
  realFetch = global.fetch;
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = realFetch;
  warnSpy.mockRestore();
  for (const k of LOCAL_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  jest.resetModules();
});
const load = () => { jest.resetModules(); return require('../src/services/providers/local'); };

// A Response whose body yields the given strings as byte chunks (split anywhere, like a real socket),
// optionally failing after them.
function sseResponse(chunks, { failAfter = false } = {}) {
  const enc = new TextEncoder();
  const body = {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield enc.encode(c);
      if (failAfter) throw Object.assign(new Error('terminated'), { name: 'TypeError' });
    },
  };
  return { ok: true, status: 200, headers: new Map(), body };
}
const line = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test('streams content deltas, drops reasoning, returns the non-streamed result shape', async () => {
  const sse = [
    line({ model: 'deepseek-served', choices: [{ delta: { reasoning_content: 'secret thoughts' } }] }),
    line({ choices: [{ delta: { content: 'สวัส' } }] }),
    // a chunk boundary in the middle of a line, as TCP is free to do
    `data: {"choices":[{"delta":{"content":"ดีครับ"}}]}\n\ndata: {"choices":[{"delta":{},"fin`,
    `ish_reason":"stop"}],"system_fingerprint":"vllm-0.21-tp2"}\n\n`,
    line({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } }),
    'data: [DONE]\n\n',
  ];
  fetchMock.mockResolvedValueOnce(sseResponse(sse));
  const pieces = [];
  const out = await load().call({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }], purpose: 'chat', onDelta: (t) => pieces.push(t) });
  expect(pieces).toEqual(['สวัส', 'ดีครับ']);
  expect(out).toMatchObject({ text: 'สวัสดีครับ', inputTokens: 120, outputTokens: 7, tokenCount: 127, stopReason: 'end_turn', model: 'deepseek-served', runtime: 'vllm-0.21-tp2' });
  expect(JSON.stringify(out)).not.toContain('secret thoughts');
  const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(sent.stream).toBe(true);
  expect(sent.stream_options).toEqual({ include_usage: true });
  expect(fetchMock.mock.calls[0][1].headers.accept).toBe('text/event-stream');
});

test('without onDelta the request is the usual non-streamed one', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) });
  await load().call({ systemPrompt: 's', messages: [{ role: 'user', content: 'q' }], purpose: 'chat' });
  const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(sent.stream).toBe(false);
  expect(sent).not.toHaveProperty('stream_options');
});

test('a failure before any text is retried as usual', async () => {
  fetchMock
    .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'busy', headers: new Map(), text: async () => '' })
    .mockResolvedValueOnce(sseResponse([line({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']));
  const pieces = [];
  const out = await load().call({ systemPrompt: 's', messages: [{ role: 'user', content: 'q' }], purpose: 'chat', onDelta: (t) => pieces.push(t) });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(out.text).toBe('ok');
  expect(pieces).toEqual(['ok']);
});

test('a failure after text has gone out is terminal: no second attempt, noRetry set', async () => {
  fetchMock.mockResolvedValue(sseResponse([line({ choices: [{ delta: { content: 'half an ans' } }] })], { failAfter: true }));
  const pieces = [];
  await expect(load().call({ systemPrompt: 's', messages: [{ role: 'user', content: 'q' }], purpose: 'chat', onDelta: (t) => pieces.push(t) }))
    .rejects.toMatchObject({ noRetry: true });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(pieces).toEqual(['half an ans']);
});

test('a body that just stops (no [DONE], no finish_reason) is an error, not a finished reply', async () => {
  fetchMock.mockResolvedValue(sseResponse([line({ choices: [{ delta: { content: 'partial' } }] })]));
  await expect(load().call({ systemPrompt: 's', messages: [{ role: 'user', content: 'q' }], purpose: 'chat', onDelta: () => {} }))
    .rejects.toMatchObject({ code: 'stream_incomplete', noRetry: true });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('an error object inside the stream (HTTP 200) is an error', async () => {
  fetchMock.mockResolvedValue(sseResponse([line({ error: { message: 'CUDA out of memory' } })]));
  await expect(load().call({ systemPrompt: 's', messages: [{ role: 'user', content: 'q' }], purpose: 'chat', onDelta: () => {} }))
    .rejects.toMatchObject({ code: 'stream_incomplete' });
});

test('a server that ignores stream and answers JSON: the text goes out in one piece', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Map([['content-type', 'application/json']]),
    json: async () => ({ choices: [{ message: { content: 'whole reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) });
  const pieces = [];
  const out = await load().call({ systemPrompt: 's', messages: [{ role: 'user', content: 'q' }], purpose: 'chat', onDelta: (t) => pieces.push(t) });
  expect(pieces).toEqual(['whole reply']);
  expect(out).toMatchObject({ text: 'whole reply', inputTokens: 3, outputTokens: 2 });
});

test('a streamed reply with no usage chunk is estimated, never billed as zero', async () => {
  fetchMock.mockResolvedValueOnce(sseResponse([line({ choices: [{ delta: { content: 'abcdef' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']));
  const out = await load().call({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'hello there' }], purpose: 'chat', onDelta: () => {} });
  expect(out.outputTokens).toBe(2);          // 6 bytes / 3
  expect(out.inputTokens).toBeGreaterThan(0);
});
