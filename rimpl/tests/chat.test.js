jest.mock('../src/services/claude', () => ({
  callClaude: jest.fn().mockResolvedValue({
    text: 'Metformin is first-line (ADA, 2024).\n❓ How does renal function affect this choice?',
    tokenCount: 120,
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
const { callClaude } = require('../src/services/claude');

describe('POST /chat', () => {
  beforeEach(() => callClaude.mockClear());

  test('natural mode (CLE1/3, socratic:false default) uses the non-Socratic prompt', async () => {
    await request(app).post('/chat').send({ cle_id: 'x', history: [], message: 'q', language: 'en' });
    const sys = callClaude.mock.calls[0][0].systemPrompt;
    expect(sys).toMatch(/NATURAL, physician-led/);
    expect(sys).not.toMatch(/SOCRATIC LEARNING/);
  });

  test('examiner mode (CLE2, socratic:true) uses the Socratic clinical-examiner prompt', async () => {
    await request(app).post('/chat').send({ cle_id: 'x', history: [], message: 'q', language: 'en', socratic: true });
    const sys = callClaude.mock.calls[0][0].systemPrompt;
    expect(sys).toMatch(/Socratic clinical examiner/);
    expect(sys).toMatch(/SOCRATIC LEARNING/);
  });

  test('returns content, references, and socratic_question', async () => {
    const res = await request(app).post('/chat').send({
      cle_id: 'test-123',
      history: [],
      message: 'What is first-line for T2DM?',
      language: 'en',
    });
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('Metformin');
    expect(res.body.refs.length).toBeGreaterThan(0);
    expect(res.body.socratic_question).toContain('renal function');
    expect(res.body.token_count).toBe(120);
  });

  test('returns 400 when message is missing', async () => {
    const res = await request(app).post('/chat').send({ cle_id: 'x', history: [] });
    expect(res.status).toBe(400);
  });
});
