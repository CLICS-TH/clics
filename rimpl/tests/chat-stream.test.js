// STREAMED CHAT — POST /chat with `stream: true` answers as server-sent events (src/lib/sse.js):
// `delta` pieces, a `replace` when a corrective retry takes over, and ONE final `done` event carrying
// the status and the exact JSON body the non-streamed route would have sent.
//
// Load-bearing rules pinned here:
//   * a RESCUE turn is never streamed (the physician must not watch an answer the rescue withholds);
//   * a draft that was streamed and then replaced is reported back (superseded_draft) for the record;
//   * a failure before any text keeps its plain status (503 + Retry-After), after text it becomes `done`;
//   * a non-streamed request's body is unchanged (no superseded_* keys).
//
// HERMETIC: callAI is mocked at the seam; RAG and Supabase are stubbed.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn() }));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { MAX_RESCUE_ROUNDS } = require('../src/services/rescue');
const { QueueFullError } = require('../src/services/providers/runtime');

const GOOD = 'Start amoxicillin 1 g three times daily for 5 days (BTS, 2019).';
const NO_CITE = 'Start amoxicillin 1 g three times daily for 5 days.';

// A callAI double that streams `pieces` through onDelta (when given) and then resolves.
const streamed = (pieces, i = 10, o = 10) => async ({ onDelta }) => {
  for (const p of pieces) onDelta?.(p);
  return { text: pieces.join(''), tokenCount: i + o, inputTokens: i, outputTokens: o, provider: 'local', model: 'm' };
};

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const ev = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
}

const turn = (body = {}) => request(app).post('/chat')
  .send({ ple_id: 'x', history: [], message: 'First-line for CAP?', language: 'en', stream: true, ...body });

let warn;
beforeEach(() => { callAI.mockReset(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

describe('streamed chat (chat.js + lib/sse.js)', () => {
  test('streams deltas in order, then one done event with the usual body', async () => {
    callAI.mockImplementationOnce(streamed(['Start amoxicillin ', '1 g three times daily ', 'for 5 days (BTS, 2019).']));
    const res = await turn();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['x-accel-buffering']).toBe('no');
    const events = parseSse(res.text);
    const deltas = events.filter((e) => e.event === 'delta').map((e) => e.data.text);
    expect(deltas.join('')).toBe(GOOD);
    const done = events.at(-1);
    expect(done.event).toBe('done');
    expect(done.data.status).toBe(200);
    expect(done.data.body).toMatchObject({ content: GOOD, provider: 'local', model: 'm', superseded_draft: null, superseded_reason: null });
    expect(done.data.body.refs).toEqual(expect.any(Array));
    expect(typeof callAI.mock.calls[0][0].onDelta).toBe('function');
  });

  test('a streamed draft replaced by the citation retry: replace, the retry sent whole, draft reported', async () => {
    callAI.mockImplementationOnce(streamed([NO_CITE], 100, 40)).mockImplementationOnce(streamed([GOOD], 160, 30));
    const res = await turn();
    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual(['delta', 'replace', 'delta', 'done']);
    expect(events[1].data).toEqual({ reason: 'citation' });
    expect(events[2].data.text).toBe(GOOD);
    const body = events.at(-1).data.body;
    expect(body.content).toBe(GOOD);
    expect(body.superseded_draft).toBe(NO_CITE);
    expect(body.superseded_reason).toBe('citation');
    expect(body.token_count).toBe(140 + 190);   // both calls still billed
    // The retry is NOT streamed (a retry failing half-way would leave unrecorded words on screen).
    expect(callAI.mock.calls[1][0].onDelta).toBeUndefined();
  });

  test('a failed language-only retry keeps the first reply and reports no superseded draft', async () => {
    const english = 'Amoxicillin is first line for mild CAP (BTS, 2019).';
    callAI.mockImplementationOnce(streamed([english]))
      .mockRejectedValueOnce(new QueueFullError({ provider: 'local', lane: 'interactive', maxQueue: 4, retryAfterMs: 30000 }));
    const res = await turn({ language: 'th', message: 'ยาตัวแรกสำหรับปอดอักเสบชุมชนคืออะไรครับ' });
    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual(['delta', 'replace', 'done']);
    expect(events[1].data.reason).toBe('language');
    const done = events.at(-1).data;
    expect(done.status).toBe(200);
    expect(done.body.content).toBe(english);
    expect(done.body.superseded_draft).toBeNull();
  });

  test('a RESCUE turn is never streamed: plain JSON, no onDelta, even when stream is asked for', async () => {
    callAI.mockImplementationOnce(streamed(['What would you check before choosing a dose?']));
    const res = await turn({ socratic: true, rescue_active: true, rescue_rounds: MAX_RESCUE_ROUNDS });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(callAI.mock.calls[0][0].onDelta).toBeUndefined();
    expect(res.body).not.toHaveProperty('superseded_draft');
    expect(res.body.rescue).toBeTruthy();
  });

  test('a non-streamed request is unchanged: JSON, no onDelta, no superseded_* keys', async () => {
    callAI.mockImplementationOnce(streamed([GOOD]));
    const res = await turn({ stream: false });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(callAI.mock.calls[0][0].onDelta).toBeUndefined();
    expect(res.body.content).toBe(GOOD);
    expect(res.body).not.toHaveProperty('superseded_draft');
    expect(res.body).not.toHaveProperty('superseded_reason');
  });

  test('a failure BEFORE any text keeps its plain status: 503 queue_full + Retry-After', async () => {
    callAI.mockRejectedValueOnce(new QueueFullError({ provider: 'local', lane: 'interactive', maxQueue: 4, retryAfterMs: 30000 }));
    const res = await turn();
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body.code).toBe('queue_full');
  });

  test('a failure AFTER text arrives becomes the done event, with the status it would have had', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    callAI.mockImplementationOnce(async ({ onDelta }) => { onDelta('Start amox'); throw new Error('socket hang up'); });
    const res = await turn();
    expect(res.status).toBe(200);   // the stream was already open
    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual(['delta', 'done']);
    expect(events[1].data.status).toBe(500);
    expect(events[1].data.body.error).toMatch(/temporarily unavailable/);
    console.error.mockRestore();
  });
});
