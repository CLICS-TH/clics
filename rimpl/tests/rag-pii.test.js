// Regression: the on-prem data boundary. The /chat route must PII-strip the physician message
// BEFORE the RAG embedding lookup — ragLookup forwards its query to the OpenAI embeddings API, a
// SECOND cloud vendor outside the documented Claude-only pipeline, so raw PII reaching it is a
// direct breach of "PII never leaves the on-premise RIMPL layer". (Previously chat.js embedded the
// raw message.)
jest.mock('../src/services/claude', () => ({
  callClaude: jest.fn().mockResolvedValue({
    text: 'First-line therapy (ADA, 2024).\n❓ Why?', tokenCount: 80, inputTokens: 40, outputTokens: 40,
  }),
}));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
// Hermetic: src/index mounts every route; the route require chain reaches src/lib/supabase,
// whose createClient() throws "supabaseUrl is required" with no env. Stub it so the suite needs
// no real Supabase URL/key and makes no network round-trip.
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { ragLookup } = require('../src/services/rag');

describe('RAG never receives raw PII', () => {
  beforeEach(() => ragLookup.mockClear());

  test('the message is PII-stripped before the embedding lookup', async () => {
    const raw = 'ผู้ป่วยเบอร์ 081-234-5678 มาด้วยอาการเจ็บหน้าอก';
    const res = await request(app).post('/chat').send({
      ple_id: 'pii-1', history: [], message: raw, language: 'th',
    });
    expect(res.status).toBe(200);
    expect(ragLookup).toHaveBeenCalledTimes(1);

    const embeddedQuery = ragLookup.mock.calls[0][0];
    expect(embeddedQuery).not.toBe(raw);                 // not the verbatim message
    expect(embeddedQuery).not.toContain('081-234-5678'); // the raw phone never leaves on-prem
    expect(embeddedQuery).toContain('[PHONE-1]');        // the masked token does
  });
});
