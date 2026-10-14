// EVIDENCE MARKER (CCME R5) on the physician turn — POST /ples/:id/message.
//
// The backend's whole part: read the app setting `chat_evidence_marker` (default OFF) and forward it to
// RIMPL as `evidence_marker`, the way `artifacts` travels. It persists nothing new and does NOT forward
// rimpl's evidence_level / evidence_retry to the physician (the response is a whitelist; a replayed
// turn could not reproduce them, since nothing is stored). A streamed draft the marker retry replaced
// is still recorded — with a NULL reason, because the DB's CHECK constraint does not know 'evidence'.
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
const { KNOWN_REASONS } = require('../src/services/superseded-draft');

const app = express();
app.use(express.json());
app.use('/ples', require('../src/routes/ples'));
const auth = (r) => r.set('Authorization', 'Bearer test');
const ASSISTANT_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

const MARKED = 'Amoxicillin 1 g tds (BTS, 2019).\nระดับหลักฐาน: ปานกลาง (Evidence: moderate)';
const body = (extra = {}) => ({
  content: MARKED, refs: [], socratic_question: null,
  token_count: 120, input_tokens: 100, output_tokens: 20,
  provider: 'local', model: 'deepseek', prompt_version: 'chat-prompt-1',
  evidence_level: 'moderate', evidence_retry: false, ...extra,
});

let settings;
beforeEach(() => {
  m.reset();
  mockRimplChat.mockReset();
  settings = { chat_evidence_marker: 1, chat_streaming: 0 };
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_limit_usd: 0.5, usage_cost_usd: 0 };
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'app_settings') return { value: settings[ctx?.id?.('key')] ?? 0 };
    if (table === 'ples' && kind === 'single') {
      return { id: 'ple1', status: 'active', physician_id: 'doc1', turn_count: 0, token_count: 0, input_tokens: 0, output_tokens: 0, chief_complaint: 'cough' };
    }
    if (table === 'messages' && kind === 'list') return [];
    if (table === 'messages' && kind === 'single') return { id: ASSISTANT_ID };
    return undefined;
  };
});
const send = (extra = {}) => auth(request(app).post('/ples/ple1/message')).send({ message: 'first line for CAP?', language: 'en', ...extra });

describe('chat_evidence_marker → evidence_marker', () => {
  test('setting ON: rimpl is told evidence_marker: true', async () => {
    mockRimplChat.mockResolvedValue(body());
    const r = await send();
    expect(r.status).toBe(200);
    expect(mockRimplChat.mock.calls[0][0].evidence_marker).toBe(true);
  });

  test('setting OFF, and setting ABSENT (no row, the default): evidence_marker: false', async () => {
    mockRimplChat.mockResolvedValue(body({ evidence_level: null }));
    settings.chat_evidence_marker = 0;
    await send();
    delete settings.chat_evidence_marker;
    await send();
    expect(mockRimplChat.mock.calls.map((c) => c[0].evidence_marker)).toEqual([false, false]);
  });

  test('the physician response is the unchanged whitelist: no evidence_level / evidence_retry; the marker is in content', async () => {
    mockRimplChat.mockResolvedValue(body({ evidence_retry: true }));
    const r = await send();
    expect(Object.keys(r.body).sort()).toEqual(
      ['content', 'input_tokens', 'message_id', 'output_tokens', 'refs', 'socratic_question', 'token_count', 'transcript'].sort());
    expect(r.body.content).toBe(MARKED);
  });

  test('nothing new is persisted: the assistant row is the same columns as before', async () => {
    mockRimplChat.mockResolvedValue(body());
    await send();
    const assistant = m.all('messages', 'insert').map((q) => q.payload).find((p) => p.role === 'assistant');
    expect(Object.keys(assistant).sort()).toEqual(
      ['content', 'model', 'ple_id', 'prompt_version', 'provider', 'refs', 'role', 'socratic_question', 'token_count'].sort());
  });
});

describe('a streamed draft replaced by the marker retry', () => {
  const streams = (events, result) => async ({ onEvent }) => {
    for (const [n, d] of events) onEvent?.(n, d);
    return result;
  };

  test('is recorded, with reason NULL — the CHECK constraint knows only citation | language | rescue', async () => {
    expect([...KNOWN_REASONS].sort()).toEqual(['citation', 'language', 'rescue']);
    settings.chat_streaming = 1;
    mockRimplChat.mockImplementation(streams(
      [['delta', { text: 'Amoxicillin 1 g tds (BTS, 2019).' }], ['replace', { reason: 'evidence' }], ['delta', { text: MARKED }]],
      body({ evidence_retry: true, superseded_draft: 'Amoxicillin 1 g tds (BTS, 2019).', superseded_reason: 'evidence' })));
    const r = await send({ stream: true });
    expect(r.status).toBe(200);
    const draft = m.all('messages', 'update').find((q) => q.payload && 'superseded_draft' in q.payload);
    expect(draft.payload).toEqual({ superseded_draft: 'Amoxicillin 1 g tds (BTS, 2019).', superseded_reason: null });
  });

  test('a known reason is still stored as itself', async () => {
    settings.chat_streaming = 1;
    mockRimplChat.mockImplementation(streams(
      [['delta', { text: 'no cite' }], ['replace', { reason: 'citation' }], ['delta', { text: MARKED }]],
      body({ superseded_draft: 'no cite', superseded_reason: 'citation' })));
    await send({ stream: true });
    const draft = m.all('messages', 'update').find((q) => q.payload && 'superseded_draft' in q.payload);
    expect(draft.payload.superseded_reason).toBe('citation');
  });
});
