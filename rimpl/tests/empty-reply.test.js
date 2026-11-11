// An empty or reasoning-only model reply (#425) is a retryable 503 `empty_reply` on every route, never a
// 200 built from nothing. Live repro 2026-11-10: DeepSeek-V4.1 spent the whole max_tokens reasoning and
// returned content "" with finish_reason length, which /evaluate-criteria turned into 200 all-false.
//
// HERMETIC: the real services/ai.js and the real `local` provider run; only global.fetch (the model
// server) is stubbed. RAG and Supabase are stubbed, credentials cleared so routing comes from env.
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const ENV = {
  AI_PROVIDER: 'local',
  LOCAL_AI_BASE_URL: 'http://dgx.tailnet:8000/v1',
  LOCAL_AI_MODEL: 'deepseek-test',
  LOCAL_AI_TIMEOUT_MS: '5000',
  LOCAL_MAX_RETRIES: '0',
  LOCAL_RETRY_BASE_MS: '1',
  SUPABASE_URL: undefined,
  SUPABASE_SERVICE_ROLE_KEY: undefined,
  CHAT_FAILOVER_PROVIDER: undefined,
  LOCAL_AI_THINK_PREOPENED: undefined,
  LOCAL_AI_MAX_TOKENS_FLOOR_CRITERIA: undefined,
};
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
for (const [k, v] of Object.entries(ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

const request = require('supertest');
const app = require('../src/index');

let realFetch, fetchMock, warnSpy, errorSpy;
beforeEach(() => {
  realFetch = global.fetch;
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = realFetch;
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  delete process.env.LOCAL_AI_THINK_PREOPENED;
  delete process.env.LOCAL_AI_MAX_TOKENS_FLOOR_CRITERIA;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const REASONING = 'The physician is Somchai; I should think about c4 first.';
const completion = (content, finish = 'length') => ({
  ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => ({ model: 'deepseek-test', choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 50, completion_tokens: 200 } }),
  text: async () => '',
});
const sseResponse = (chunks) => {
  const enc = new TextEncoder();
  return { ok: true, status: 200, headers: new Map(), body: { async *[Symbol.asyncIterator]() { for (const c of chunks) yield enc.encode(c); } } };
};
const line = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const sentBody = (n = 0) => JSON.parse(fetchMock.mock.calls[n][1].body);
const parseSse = (text) => text.split('\n\n').filter(Boolean).map((block) => ({
  event: /^event: (.+)$/m.exec(block)?.[1],
  data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null'),
}));

const criteria = () => request(app).post('/evaluate-criteria').send({ transcript: [{ role: 'physician', content: 'BP 120/80, asked about renal dosing' }] });
const chat = (body = {}) => request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'First-line antibiotic for CAP?', language: 'en', ...body });

const expectEmptyReply = (res) => {
  expect(res.status).toBe(503);
  expect(res.body.code).toBe('empty_reply');
  expect(res.headers).not.toHaveProperty('retry-after');
  expect(JSON.stringify(res.body)).not.toContain('Somchai');
};

describe('POST /evaluate-criteria — an empty classifier reply is a retryable 503, never 200 all-false', () => {
  test.each([
    ['empty content', ''],
    ['whitespace-only content', '  \n\t '],
    ['content that is nothing but a closed <think> block', `<think>${REASONING}</think>`],
    ['content: null (reasoning returned separately)', null],
  ])('%s → 503 empty_reply, no criteria in the body', async (_label, content) => {
    fetchMock.mockResolvedValue(completion(content));
    const res = await criteria();
    expectEmptyReply(res);
    for (const k of ['c4', 'c5', 'c6', 'c7', 'on_topic', 'pii_map']) expect(res.body).not.toHaveProperty(k);
  });

  test('THINK_PREOPENED and the reasoning never closed → 503 empty_reply, the reasoning never returned', async () => {
    process.env.LOCAL_AI_THINK_PREOPENED = '1';
    fetchMock.mockResolvedValue(completion(REASONING));
    expectEmptyReply(await criteria());
  });

  test.each([
    ['prose', 'Sure.'],
    ['JSON cut off mid-object', '{"c4": true, "c5": tr'],
    ['an empty object', '{}'],
    ['a criterion missing', '{"c4":true,"c5":true,"c6":true}'],
    ['a criterion that is not a boolean', '{"c4":"false","c5":true,"c6":true,"c7":true}'],
  ])('%s → an error, never 200 with criteria', async (_label, content) => {
    fetchMock.mockResolvedValue(completion(content, 'stop'));
    const res = await criteria();
    expect(res.status).not.toBe(200);
    for (const k of ['c4', 'c5', 'c6', 'c7']) expect(res.body).not.toHaveProperty(k);
  });

  test('a real classifier reply still answers 200', async () => {
    fetchMock.mockResolvedValue(completion('{"c4":true,"c5":false,"c6":true,"c7":false}', 'stop'));
    const res = await criteria();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ c4: true, c5: false, c6: true, c7: false });
  });
});

describe('POST /chat — an empty reply is a failed turn, never an empty reply delivered', () => {
  test('non-streamed: 503 empty_reply, no content', async () => {
    fetchMock.mockResolvedValue(completion(''));
    const res = await chat();
    expectEmptyReply(res);
    expect(res.body).not.toHaveProperty('content');
  });

  test('streamed, reasoning arrived then nothing: the done event carries 503 empty_reply and no delta was sent', async () => {
    fetchMock.mockResolvedValue(sseResponse([
      line({ choices: [{ delta: { reasoning_content: REASONING } }] }),
      line({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 50, completion_tokens: 900 } }),
      'data: [DONE]\n\n',
    ]));
    const res = await chat({ stream: true, router_enabled: true });
    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual(['status', 'done']);
    expect(events[1].data.status).toBe(503);
    expect(events[1].data.body.code).toBe('empty_reply');
    expect(res.text).not.toContain('Somchai');
  });
});

describe('per-purpose max_tokens floor for a reasoning model (<prefix>MAX_TOKENS_FLOOR_<PURPOSE>)', () => {
  const ok = () => fetchMock.mockResolvedValue(completion('{"c4":true,"c5":true,"c6":true,"c7":true}', 'stop'));

  test('unset: the route\'s own 200', async () => {
    ok();
    await criteria();
    expect(sentBody().max_tokens).toBe(200);
  });

  test('above the requested ceiling: the floor is sent', async () => {
    process.env.LOCAL_AI_MAX_TOKENS_FLOOR_CRITERIA = '4096';
    ok();
    await criteria();
    expect(sentBody().max_tokens).toBe(4096);
  });

  test.each([['below the requested ceiling', '100'], ['not a number', 'auto'], ['empty', '']])('%s: the route\'s own 200', async (_label, v) => {
    process.env.LOCAL_AI_MAX_TOKENS_FLOOR_CRITERIA = v;
    ok();
    await criteria();
    expect(sentBody().max_tokens).toBe(200);
  });
});

describe('the floor is what provenance, the fingerprint and the manifest record (§10.2)', () => {
  const SCORES = JSON.stringify({ d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7: 4, rationale: { d1: 'x' } });
  const evaluate = () => request(app).post('/evaluate').send({ ple_id: 'p', transcript: [{ role: 'physician', content: 'hello' }], shadow: false });
  const { liveSnapshot } = require('../src/services/manifest');

  test('no floor: max_tokens 4096 and no floor in the manifest; a floor: the sent value, a new fingerprint, and the floor listed', async () => {
    fetchMock.mockResolvedValue(completion(SCORES, 'stop'));
    const plain = await evaluate();
    expect(plain.status).toBe(200);
    expect(plain.body.provenance.decoding.max_tokens).toBe(4096);
    expect(liveSnapshot().decoding).not.toHaveProperty('max_tokens_floor');

    process.env.LOCAL_AI_MAX_TOKENS_FLOOR_EVALUATE = '16000';
    try {
      const floored = await evaluate();
      expect(floored.status).toBe(200);
      expect(sentBody(fetchMock.mock.calls.length - 1).max_tokens).toBe(16000);
      expect(floored.body.provenance.decoding.max_tokens).toBe(16000);
      expect(floored.body.provenance.config_fingerprint).not.toBe(plain.body.provenance.config_fingerprint);
      expect(liveSnapshot().decoding.max_tokens_floor).toMatchObject({ local: { evaluate: 16000 } });
    } finally { delete process.env.LOCAL_AI_MAX_TOKENS_FLOOR_EVALUATE; }
  });
});
