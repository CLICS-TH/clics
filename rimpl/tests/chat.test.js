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

  test('artifacts flag drives the system prompt: guidance appended only when true', async () => {
    await request(app).post('/chat').send({ cle_id: 'x', history: [], message: 'q', language: 'en' });
    expect(callClaude.mock.calls[0][0].systemPrompt).not.toMatch(/:::artifact/); // default off
    callClaude.mockClear();
    await request(app).post('/chat').send({ cle_id: 'x', history: [], message: 'q', language: 'en', artifacts: true });
    expect(callClaude.mock.calls[0][0].systemPrompt).toMatch(/:::artifact/);     // on → guidance present
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

  test('patient_ref scrubs an unlabelled name from what reaches the model', async () => {
    await request(app).post('/chat').send({
      cle_id: 'x', history: [], message: 'สมชายปวดท้องมา 2 วัน', language: 'th',
      patient_ref: 'นายสมชาย ใจดี',
    });
    const sent = JSON.stringify(callClaude.mock.calls[0][0].messages);
    expect(sent).not.toContain('สมชาย'); // the known patient name never reaches the cloud
    expect(sent).toContain('[NAME-1]');
  });

  test('patient_ref: null is accepted (regression — backend sends `?? null` when none recorded)', async () => {
    const res = await request(app).post('/chat').send({
      cle_id: 'x', history: [], message: 'q', language: 'en', patient_ref: null, socratic: false,
    });
    expect(res.status).toBe(200); // z.string().nullish() — not .optional(), which 400s on null
  });

  // The retry gate is the experiment's behavioral hinge: Socratic mode MUST end on ❓ (retry if not);
  // natural mode must NOT be forced to (the ❓ is the manipulation, not a quality bar).
  const reply = (text) => ({ text, tokenCount: 100, inputTokens: 50, outputTokens: 50 });

  test('examiner mode retries when the ❓ is missing; the retry budget is NOT lower than the first call', async () => {
    callClaude
      .mockResolvedValueOnce(reply('Metformin is first-line (ADA, 2024).'))          // citation, NO ❓
      .mockResolvedValueOnce(reply('Metformin (ADA, 2024).\n❓ Why renal-adjust?'));  // corrected
    await request(app).post('/chat').send({ cle_id: 'x', history: [], message: 'q', language: 'en', socratic: true });
    expect(callClaude).toHaveBeenCalledTimes(2);
    // A corrected reply may itself carry an artifact, so the retry must not truncate worse than the original.
    expect(callClaude.mock.calls[1][0].maxTokens).toBe(callClaude.mock.calls[0][0].maxTokens);
    expect(callClaude.mock.calls[0][0].maxTokens).toBeGreaterThanOrEqual(4000);
  });

  test('natural mode does NOT retry on a missing ❓ (only a missing citation matters)', async () => {
    callClaude.mockResolvedValueOnce(reply('Metformin is first-line (ADA, 2024).')); // citation, NO ❓
    await request(app).post('/chat').send({ cle_id: 'x', history: [], message: 'q', language: 'en', socratic: false });
    expect(callClaude).toHaveBeenCalledTimes(1); // accepted as-is — no forced ❓
  });

  test('a missing citation retries in BOTH modes', async () => {
    callClaude
      .mockResolvedValueOnce(reply('Metformin is first-line.\n❓ Why?'))             // ❓ but NO citation
      .mockResolvedValueOnce(reply('Metformin (ADA, 2024).\n❓ Why?'));
    await request(app).post('/chat').send({ cle_id: 'x', history: [], message: 'q', language: 'en', socratic: false });
    expect(callClaude).toHaveBeenCalledTimes(2);
  });

  // CLINICAL ARTIFACTS — a prior assistant turn's artifact fence must NOT replay into the cloud chat
  // context; the body stays as clinical context, but `:::artifact{...}` control syntax is stripped.
  test('a persisted artifact fence in history is stripped before reaching the model (body kept)', async () => {
    await request(app).post('/chat').send({
      cle_id: 'x', language: 'en', message: 'and the management?',
      history: [
        { role: 'physician', content: 'differential for chest pain?' },
        { role: 'assistant', content: 'Top causes:\n:::artifact{type="differential" title="DDx"}\n| ACS | high |\n:::\n(AHA, 2021)' },
      ],
    });
    const sent = JSON.stringify(callClaude.mock.calls[0][0].messages);
    expect(sent).not.toContain(':::artifact');   // control syntax never re-enters the cloud context
    expect(sent).toContain('| ACS | high |');     // artifact body survives as context
    expect(sent).toContain('(AHA, 2021)');         // citation outside the fence survives
  });
});
