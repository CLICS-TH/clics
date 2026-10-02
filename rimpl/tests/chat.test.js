// The AI seam is services/ai.callAI — routes name a PURPOSE, never a vendor (services/ai.js
// resolves provider per call). Mocking here keeps the suite hermetic: no provider, no network.
jest.mock('../src/services/ai', () => ({
  callAI: jest.fn().mockResolvedValue({
    text: 'Metformin is first-line (ADA, 2024).\n❓ How does renal function affect this choice?',
    tokenCount: 120,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
  }),
}));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
// Hermetic: src/index mounts every route; the route require chain reaches src/lib/supabase,
// whose createClient() throws "supabaseUrl is required" with no env. Stub it so the suite needs
// no real Supabase URL/key and makes no network round-trip.
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const http = require('http');
const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { QueueFullError } = require('../src/services/providers/runtime');

// Poll until `cond()` holds (or 5s pass) — for the hang-up test, which has to act mid-request. The
// ceiling is generous on purpose: under --coverage in CI the instrumented process is several times
// slower, and this must stay a test of ordering, not of the machine's speed.
async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor: condition not met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('POST /chat', () => {
  beforeEach(() => callAI.mockClear());

  // Provider routing is keyed off `purpose` (AI_PROVIDER_CHAT → AI_PROVIDER → anthropic).
  // A wrong/absent purpose silently routes the turn to the wrong model, so pin it.
  test('declares purpose "chat" so provider routing can key off it', async () => {
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en' });
    expect(callAI.mock.calls[0][0].purpose).toBe('chat');
  });

  test('natural mode (CLE1/3, socratic:false default) uses the non-Socratic prompt', async () => {
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en' });
    const sys = callAI.mock.calls[0][0].systemPrompt;
    expect(sys).toMatch(/NATURAL, physician-led/);
    expect(sys).not.toMatch(/SOCRATIC LEARNING/);
  });

  test('examiner mode (CLE2, socratic:true) uses the Socratic clinical-examiner prompt', async () => {
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en', socratic: true });
    const sys = callAI.mock.calls[0][0].systemPrompt;
    expect(sys).toMatch(/Socratic clinical examiner/);
    expect(sys).toMatch(/SOCRATIC LEARNING/);
  });

  test('artifacts flag drives the system prompt: guidance appended only when true', async () => {
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en' });
    expect(callAI.mock.calls[0][0].systemPrompt).not.toMatch(/:::artifact/); // default off
    callAI.mockClear();
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en', artifacts: true });
    expect(callAI.mock.calls[0][0].systemPrompt).toMatch(/:::artifact/);     // on → guidance present
  });

  test('returns content, references, and socratic_question', async () => {
    const res = await request(app).post('/chat').send({
      ple_id: 'test-123',
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
    const res = await request(app).post('/chat').send({ ple_id: 'x', history: [] });
    expect(res.status).toBe(400);
  });

  test('patient_ref scrubs an unlabelled name from what reaches the model', async () => {
    await request(app).post('/chat').send({
      ple_id: 'x', history: [], message: 'สมชายปวดท้องมา 2 วัน', language: 'th',
      patient_ref: 'นายสมชาย ใจดี',
    });
    const sent = JSON.stringify(callAI.mock.calls[0][0].messages);
    expect(sent).not.toContain('สมชาย'); // the known patient name never reaches the cloud
    expect(sent).toContain('[NAME-1]');
  });

  test('patient_ref: null is accepted (regression — backend sends `?? null` when none recorded)', async () => {
    const res = await request(app).post('/chat').send({
      ple_id: 'x', history: [], message: 'q', language: 'en', patient_ref: null, socratic: false,
    });
    expect(res.status).toBe(200); // z.string().nullish() — not .optional(), which 400s on null
  });

  // The retry gate is the experiment's behavioral hinge: Socratic mode MUST end on ❓ (retry if not);
  // natural mode must NOT be forced to (the ❓ is the manipulation, not a quality bar).
  const reply = (text) => ({ text, tokenCount: 100, inputTokens: 50, outputTokens: 50 });

  test('examiner mode retries when the ❓ is missing; the retry budget is NOT lower than the first call', async () => {
    callAI
      .mockResolvedValueOnce(reply('Metformin is first-line (ADA, 2024).'))          // citation, NO ❓
      .mockResolvedValueOnce(reply('Metformin (ADA, 2024).\n❓ Why renal-adjust?'));  // corrected
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en', socratic: true });
    expect(callAI).toHaveBeenCalledTimes(2);
    // A corrected reply may itself carry an artifact, so the retry must not truncate worse than the original.
    expect(callAI.mock.calls[1][0].maxTokens).toBe(callAI.mock.calls[0][0].maxTokens);
    expect(callAI.mock.calls[0][0].maxTokens).toBeGreaterThanOrEqual(4000);
  });

  test('natural mode does NOT retry on a missing ❓ (only a missing citation matters)', async () => {
    callAI.mockResolvedValueOnce(reply('Metformin is first-line (ADA, 2024).')); // citation, NO ❓
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en', socratic: false });
    expect(callAI).toHaveBeenCalledTimes(1); // accepted as-is — no forced ❓
  });

  test('a missing citation retries in BOTH modes', async () => {
    callAI
      .mockResolvedValueOnce(reply('Metformin is first-line.\n❓ Why?'))             // ❓ but NO citation
      .mockResolvedValueOnce(reply('Metformin (ADA, 2024).\n❓ Why?'));
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en', socratic: false });
    expect(callAI).toHaveBeenCalledTimes(2);
  });

  // The prompt tells the model to write the no-source note INSTEAD of inventing a reference. If the
  // guard retried that, it would push the model straight back to inventing one.
  test('an explicit no-specific-source note satisfies the citation rule — no retry (English and Thai)', async () => {
    callAI.mockResolvedValueOnce(reply('Metformin is usually first-line (no specific source cited).'));
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en', socratic: false });
    expect(callAI).toHaveBeenCalledTimes(1);
    callAI.mockClear();
    callAI.mockResolvedValueOnce(reply('ยาเมทฟอร์มินมักเป็นยาตัวแรก (ไม่มีแหล่งอ้างอิงเฉพาะ)\n❓ ถ้าไตเสื่อมจะเปลี่ยนการเลือกยาอย่างไร'));
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'ยาตัวแรกคืออะไร', language: 'th', socratic: true });
    expect(callAI).toHaveBeenCalledTimes(1);
  });

  test('the note does not excuse a missing ❓ in examiner mode, and the retry offers the note instead of demanding a citation', async () => {
    callAI
      .mockResolvedValueOnce(reply('Metformin is usually first-line (no specific source cited).'))  // note, NO ❓
      .mockResolvedValueOnce(reply('Metformin is usually first-line (no specific source cited).\n❓ Why?'));
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en', socratic: true });
    expect(callAI).toHaveBeenCalledTimes(2);
    const asked = callAI.mock.calls[1][0].messages.at(-1).content;
    expect(asked).toMatch(/\(no specific source cited\) instead of inventing one/);
  });

  test('a clinical "no specific source of infection" is NOT a no-source note — still retried', async () => {
    callAI
      .mockResolvedValueOnce(reply('No specific source of infection was found, so treat empirically.'))
      .mockResolvedValueOnce(reply('Treat empirically (Surviving Sepsis Campaign International Guidelines, 2021).'));
    await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en', socratic: false });
    expect(callAI).toHaveBeenCalledTimes(2);
  });

  // CONTEXT vs BILLING. The backend stores "what the model last saw" as ples.context_tokens for its
  // transcript cap. input_tokens / output_tokens are billing figures and are SUMMED over every call in
  // the turn, so on a retry turn they run ~2x the real context and the 64k cap fired at ~32k.
  // context_tokens is the returned call's own in+out — a plain integer, or null when there was no usage.
  test('context_tokens: with no retry it equals input_tokens + output_tokens of the only call', async () => {
    callAI.mockResolvedValueOnce({ text: 'Metformin is first-line (ADA, 2024).', tokenCount: 130, inputTokens: 100, outputTokens: 30 });
    const res = await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en' });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body.input_tokens).toBe(100);
    expect(res.body.output_tokens).toBe(30);
    expect(res.body.context_tokens).toBe(130);
    expect(Number.isInteger(res.body.context_tokens)).toBe(true);
  });

  test('context_tokens: on a citation retry it is the RETRY call\'s own in+out, while input/output_tokens stay the two-call billing sums', async () => {
    // Distinct usages, so no coincidence can satisfy the assertions: first call 1000+300, retry 1400+70
    // (the retry prompt is the first prompt + the first reply + the correction, so it is the LARGER view).
    callAI
      .mockResolvedValueOnce({ text: 'Metformin is first-line.', tokenCount: 1300, inputTokens: 1000, outputTokens: 300 })   // no citation → retry
      .mockResolvedValueOnce({ text: 'Metformin (ADA, 2024).', tokenCount: 1470, inputTokens: 1400, outputTokens: 70 });
    const res = await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en' });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body.input_tokens).toBe(2400);      // 1000 + 1400 — billing, exactly as before
    expect(res.body.output_tokens).toBe(370);      // 300 + 70
    expect(res.body.token_count).toBe(2770);
    expect(res.body.context_tokens).toBe(1470);    // 1400 + 70: the returned call only — not 2770, not 1300
  });

  test('context_tokens: null (not 0) when the provider reported no usage — the backend then falls back to its own sum', async () => {
    callAI.mockResolvedValueOnce({ text: 'Metformin (ADA, 2024).', tokenCount: 0 });   // no inputTokens / outputTokens at all
    const res = await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('context_tokens');   // present, as null — not omitted
    expect(res.body.context_tokens).toBeNull();
  });

  // CLINICAL ARTIFACTS — a prior assistant turn's artifact fence must NOT replay into the cloud chat
  // context; the body stays as clinical context, but `:::artifact{...}` control syntax is stripped.
  test('a persisted artifact fence in history is stripped before reaching the model (body kept)', async () => {
    await request(app).post('/chat').send({
      ple_id: 'x', language: 'en', message: 'and the management?',
      history: [
        { role: 'physician', content: 'differential for chest pain?' },
        { role: 'assistant', content: 'Top causes:\n:::artifact{type="differential" title="DDx"}\n| ACS | high |\n:::\n(AHA, 2021)' },
      ],
    });
    const sent = JSON.stringify(callAI.mock.calls[0][0].messages);
    expect(sent).not.toContain(':::artifact');   // control syntax never re-enters the cloud context
    expect(sent).toContain('| ACS | high |');     // artifact body survives as context
    expect(sent).toContain('(AHA, 2021)');         // citation outside the fence survives
  });
});

// The local provider's two-lane bounded queue surfaces here as two error classes (lib/ai-errors.js),
// and the request's client-gone signal (lib/request-signal.js) travels into every model call.
describe('POST /chat — lane full, client hang-up', () => {
  let warnSpy;
  beforeEach(() => { callAI.mockClear(); warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warnSpy.mockRestore());

  test('a full provider lane → 503 { code: queue_full, retry_after_s } with a Retry-After header', async () => {
    callAI.mockRejectedValueOnce(new QueueFullError({ provider: 'local', lane: 'interactive', maxQueue: 4, retryAfterMs: 30000 }));
    const res = await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en' });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body).toEqual({ error: expect.any(String), code: 'queue_full', retry_after_s: 30 });
    expect(callAI).toHaveBeenCalledTimes(1);   // a refused turn is not re-issued by the route
  });

  test('a too-large prompt → 413 { code: transcript_too_large, est_tokens, limit }', async () => {
    callAI.mockRejectedValueOnce(Object.assign(new Error('refused before send'), {
      status: 413, code: 'transcript_too_large', contextTooSmall: true, est_tokens: 70000, limit: 64000,
    }));
    const res = await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en' });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: expect.any(String), code: 'transcript_too_large', est_tokens: 70000, limit: 64000 });
  });

  test('every model call carries the request signal, un-aborted while the client is connected', async () => {
    callAI
      .mockResolvedValueOnce({ text: 'Metformin is first-line.', tokenCount: 10, inputTokens: 5, outputTokens: 5 })   // no citation → retry
      .mockResolvedValueOnce({ text: 'Metformin (ADA, 2024).', tokenCount: 10, inputTokens: 5, outputTokens: 5 });
    const res = await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'q', language: 'en' });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(2);
    for (const [call] of callAI.mock.calls) {
      expect(typeof call.signal.aborted).toBe('boolean');
      expect(call.signal.aborted).toBe(false);
    }
    expect(callAI.mock.calls[0][0].signal).toBe(callAI.mock.calls[1][0].signal);   // one signal per request
  });

  // Driven with a raw http.request against a server this test owns: superagent's abort() rejects
  // through its 'abort' event and suppresses the end-callback in which supertest closes its
  // ephemeral server, so a supertest-driven hang-up would leak the listener and hang jest.
  test('the client hangs up mid-call → the signal aborts, the turn is dropped, no second model call is made', async () => {
    const seen = {};
    callAI.mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => {
      seen.signal = signal;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'aborted', aborted: true })));
    }));

    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const body = JSON.stringify({ ple_id: 'x', history: [], message: 'q', language: 'en' });
      const clientReq = http.request({
        host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/chat',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      });
      clientReq.on('error', () => {});                         // our own destroy() surfaces here
      clientReq.end(body);
      await waitFor(() => callAI.mock.calls.length === 1);     // the body was parsed and the call is in flight…
      expect(seen.signal.aborted).toBe(false);                 // …and body completion did NOT abort it (res, not req, 'close')

      clientReq.destroy();                                     // the physician closes the tab
      await waitFor(() => seen.signal.aborted);                // res 'close' with nothing written → abort
      await waitFor(() => warnSpy.mock.calls.some(([m]) => /client went away/.test(String(m)))); // the route's catch ran
      await new Promise((r) => setTimeout(r, 50));             // anything else the route might still do…
      expect(callAI).toHaveBeenCalledTimes(1);                 // …is not a second model call
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });
});
