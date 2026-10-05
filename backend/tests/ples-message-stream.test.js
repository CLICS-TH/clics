// STREAMED physician turn — POST /ples/:id/message with `stream: true` while the superadmin
// `chat_streaming` setting is on. rimpl's `delta` / `replace` events go straight to the physician; the
// turn is then stored, billed and answered EXACTLY as a non-streamed turn, with that answer (status +
// the same whitelisted body) as the stream's final `done` event (src/lib/sse.js).
//
// Pinned: the setting gates it; a turn rimpl answers in plain JSON (a rescue turn) stays plain JSON;
// a failure after the first word arrives as `done` with its usual status and code; a replaced draft
// is stored on the assistant row and never sent back to the physician.
jest.mock('../src/lib/supabase', () => {
  const base = require('./helpers/supabase-mock').makeSupabaseMock();
  base.supabase.rpc = (name) => Promise.resolve(name === 'store_chat_turn'
    ? require('./helpers/supabase-mock').STORE_FN_ABSENT : { data: true, error: null });
  return base;
});
const mockRimplChat = jest.fn();
jest.mock('../src/services/rimpl-client', () => ({ rimplChat: (...a) => mockRimplChat(...a) }));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const app = express();
app.use(express.json());
app.use('/ples', require('../src/routes/ples'));
const auth = (r) => r.set('Authorization', 'Bearer test');
const ASSISTANT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

const body = (extra = {}) => ({
  content: 'Amoxicillin 1 g tds (BTS, 2019).', refs: [], socratic_question: null,
  token_count: 120, input_tokens: 100, output_tokens: 20,
  provider: 'local', model: 'deepseek', prompt_version: 'chat-prompt-1', ...extra,
});
// A rimplChat double that emits events through onEvent (when streaming) and then resolves/rejects.
const streams = (events, result) => async ({ onEvent }) => {
  for (const [n, d] of events) onEvent?.(n, d);
  if (result instanceof Error) throw result;
  return result;
};
function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((b) => ({
    event: /^event: (.+)$/m.exec(b)?.[1],
    data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? 'null'),
  }));
}

let streamingSetting;
beforeEach(() => {
  m.reset();
  mockRimplChat.mockReset();
  streamingSetting = 1;
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_limit_usd: 0.5, usage_cost_usd: 0 };
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'app_settings') return { value: ctx?.id?.('key') === 'chat_streaming' ? streamingSetting : 0 };
    if (table === 'ples' && kind === 'single') {
      return { id: 'ple1', status: 'active', physician_id: 'doc1', turn_count: 0, token_count: 0, input_tokens: 0, output_tokens: 0, chief_complaint: 'cough' };
    }
    if (table === 'messages' && kind === 'list') return [];
    if (table === 'messages' && kind === 'single') return { id: ASSISTANT_ID };
    return undefined;
  };
});
const send = (extra = {}) => auth(request(app).post('/ples/ple1/message')).send({ message: 'first line for CAP?', language: 'en', stream: true, ...extra });

describe('streamed physician turn (ples.js + lib/sse.js)', () => {
  test('forwards deltas, stores the turn as usual, and ends with the whitelisted body as `done`', async () => {
    mockRimplChat.mockImplementation(streams([['delta', { text: 'Amoxicillin ' }], ['delta', { text: '1 g tds (BTS, 2019).' }]], body()));
    const r = await send();
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    const ev = parseSse(r.text);
    expect(ev.map((e) => e.event)).toEqual(['delta', 'delta', 'done']);
    expect(ev.slice(0, 2).map((e) => e.data.text).join('')).toBe('Amoxicillin 1 g tds (BTS, 2019).');
    const done = ev.at(-1).data;
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ message_id: ASSISTANT_ID, content: 'Amoxicillin 1 g tds (BTS, 2019).' });
    for (const k of ['provider', 'model', 'prompt_version', 'superseded_draft', 'superseded_reason']) expect(done.body).not.toHaveProperty(k);
    expect(mockRimplChat.mock.calls[0][0].stream).toBe(true);
    // Stored exactly as a non-streamed turn.
    const inserts = m.all('messages', 'insert').map((q) => q.payload);
    expect(inserts.map((p) => p.role)).toEqual(['physician', 'assistant']);
  });

  test('setting OFF: a stream request is answered in plain JSON and rimpl is not asked to stream', async () => {
    streamingSetting = 0;
    mockRimplChat.mockImplementation(streams([], body()));
    const r = await send();
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.body.content).toBe(body().content);
    expect(mockRimplChat.mock.calls[0][0].stream).toBe(false);
    expect(mockRimplChat.mock.calls[0][0].onEvent).toBeUndefined();
  });

  test('no `stream` in the request: plain JSON even with the setting on', async () => {
    mockRimplChat.mockImplementation(streams([], body()));
    const r = await send({ stream: undefined });
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(mockRimplChat.mock.calls[0][0].stream).toBe(false);
  });

  test('a turn rimpl answers whole (a rescue turn) stays plain JSON', async () => {
    mockRimplChat.mockImplementation(streams([], body({ rescue: { rescuing: true } })));
    const r = await send();
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.body).not.toHaveProperty('rescue');
  });

  test('a replaced draft is stored on the assistant row and never sent to the physician', async () => {
    mockRimplChat.mockImplementation(streams(
      [['delta', { text: 'no citation' }], ['replace', { reason: 'citation' }], ['delta', { text: 'Amoxicillin 1 g tds (BTS, 2019).' }]],
      body({ superseded_draft: 'no citation', superseded_reason: 'citation' })));
    const r = await send();
    const ev = parseSse(r.text);
    expect(ev.map((e) => e.event)).toEqual(['delta', 'replace', 'delta', 'done']);
    expect(ev[1].data).toEqual({ reason: 'citation' });
    expect(ev.at(-1).data.body).not.toHaveProperty('superseded_draft');
    const upd = m.all('messages', 'update').map((q) => q);
    const draft = upd.find((q) => q.payload && 'superseded_draft' in q.payload);
    expect(draft.payload).toEqual({ superseded_draft: 'no citation', superseded_reason: 'citation' });
    expect(draft.eqs).toEqual(expect.arrayContaining([['id', ASSISTANT_ID], ['role', 'assistant']]));
    // The scored transcript row holds the reply that stood.
    expect(m.all('messages', 'insert').map((q) => q.payload).find((p) => p.role === 'assistant').content)
      .toBe('Amoxicillin 1 g tds (BTS, 2019).');
  });

  test('a failure after the first word: `done` carries the usual status and code, nothing is stored', async () => {
    const busy = Object.assign(new Error('RIMPL /chat error: 503'), { status: 503, code: 'queue_full', retryAfterMs: 20000 });
    mockRimplChat.mockImplementation(streams([['delta', { text: 'Amox' }]], busy));
    const r = await send();
    const ev = parseSse(r.text);
    expect(ev.map((e) => e.event)).toEqual(['delta', 'done']);
    expect(ev[1].data.status).toBe(503);
    expect(ev[1].data.body).toMatchObject({ code: 'ai_busy', retry_after_s: 20 });
    expect(m.all('messages', 'insert')).toHaveLength(0);
  });
});
