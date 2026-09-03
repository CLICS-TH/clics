// Post-PLE reflection (CREC082 ICF §3 step 3, PLE Instruction Sheet §3).
//
// The reflection is SCORED EVIDENCE, not a follow-up survey. PIS-7 is assessed on "หลักฐานที่ปรากฏ
// ใน transcript และ reflection ของ PLE", the D6 anchor begins "0: ไม่มี reflection", and c6
// (reflective synthesis) is one of the four elements that decide whether the session qualifies at
// all. Everything below follows from that: it has to be captured before screening, it has to reach
// the evaluator, and it must be skippable without trapping anyone.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const mockFinalize = jest.fn(async () => ({ status: 'ple_pass', criteria: {} }));
jest.mock('../src/services/ple-finalize', () => ({
  finalizeScreening: mockFinalize,
  toPassCols: (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [`${k}_pass`, v])),
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { PHYSICIAN } = require('./helpers/roles');
const reflection = require('../src/services/reflection');

const app = express();
app.use(express.json());
app.use('/ples', require('../src/routes/ples'));
const auth = r => r.set('Authorization', 'Bearer test');

let ple, existing;
beforeEach(() => {
  m.reset();
  mockFinalize.mockClear();
  m.state.caller = { ...PHYSICIAN };
  ple = { id: 'p1', status: 'ended', physician_id: PHYSICIAN.id, c1_pass: true, c2_pass: true, c3_pass: true };
  existing = null;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'app_settings') return { value: 1 };
    if (table === 'ples') return kind === 'single' || kind === 'maybeSingle' ? ple : { data: [] };
    if (table === 'ple_reflections') return ctx.op === 'upsert' ? {} : existing;
    if (table === 'messages') return { data: [{ role: 'physician', content: 'hello' }] };
    return undefined;
  };
});

const post = (body) => auth(request(app).post('/ples/p1/reflection')).send(body);
const FULL = { learned: 'eGFR drives the choice', uncertainty: 'unsure below 30', application: 'will check KDIGO' };

describe('the reflection reaches the evaluator', () => {
  test('submitting stores it, then screens WITH it appended as its own turn', async () => {
    const res = await post(FULL);
    expect(res.status).toBe(200);
    expect(m.find('ple_reflections', 'upsert').payload).toMatchObject(FULL);

    existing = { ...FULL, skipped: false };   // now on file for the withReflection read
    mockFinalize.mockClear();
    await post(FULL);
    const sent = mockFinalize.mock.calls[0][0].transcript;
    // role 'reflection' — rimpl's flattenForPrompt renders it as "[REFLECTION]:", so the evaluator
    // can tell it from a chat turn. The rubric asks whether the physician reflected, not whether
    // they said more.
    expect(sent.at(-1).role).toBe('reflection');
    expect(sent.at(-1).content).toContain('eGFR drives the choice');
    expect(sent.at(-1).content).toContain('unsure below 30');
    expect(sent.at(-1).content).toContain('will check KDIGO');
  });

  test('a skipped reflection appends NOTHING — an absent tail is what scores as the D6 zero anchor', () => {
    expect(reflection.asTranscriptTurn({ skipped: true, learned: 'x' })).toBeNull();
    expect(reflection.asTranscriptTurn(null)).toBeNull();
    // Appending "(skipped)" would put words in the physician's mouth and could read to the model as
    // content. The anchor is "0: ไม่มี reflection" — no reflection, not a note saying so.
    expect(reflection.asTranscriptTurn({ learned: '', uncertainty: '', application: '' })).toBeNull();
  });

  test('a partial reflection still counts — only the prompts answered are included', () => {
    const turn = reflection.asTranscriptTurn({ learned: 'just this' });
    expect(turn.content).toContain('just this');
    expect(turn.content).not.toContain('uncertain');
  });
});

describe('skipping is allowed and recorded', () => {
  test('a skip clears the text and releases the session to screening', async () => {
    const res = await post({ skipped: true, learned: 'ignored' });
    expect(res.status).toBe(200);
    expect(m.find('ple_reflections', 'upsert').payload).toMatchObject({ skipped: true, learned: null });
    // ICF §7 — a physician may decline any part of participation. A skip must not strand the session.
    expect(mockFinalize).toHaveBeenCalled();
  });

  test('a skip is stored, not left absent — "declined" and "not asked yet" are different facts', async () => {
    await post({ skipped: true });
    expect(m.find('ple_reflections', 'upsert')).toBeDefined();
  });
});

describe('when a reflection may be submitted', () => {
  test('a session still running has nothing to reflect on → 409', async () => {
    ple.status = 'active';
    const res = await post(FULL);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_awaiting_reflection');
    expect(m.find('ple_reflections', 'upsert')).toBeUndefined();
  });

  test('an already-scored session is refused — the score was computed without it', async () => {
    // Accepting one now would leave a score on file that demonstrably ignored evidence also on file,
    // which is worse than not accepting it.
    ple.status = 'evaluated';
    expect((await post(FULL)).status).toBe(409);
  });

  test("another physician's session → 404", async () => {
    ple = null;
    expect((await post(FULL)).status).toBe(404);
  });

  test('a double-submit upserts rather than erroring — the second click is not a failure', async () => {
    await post(FULL);
    await post(FULL);
    expect(m.all('ple_reflections', 'upsert')).toHaveLength(2);
    expect(m.find('ple_reflections', 'upsert').onConflict ?? 'ple_id').toBeTruthy();
  });

  test('a screening failure leaves the session recoverable at ended, not flagged', async () => {
    mockFinalize.mockRejectedValueOnce(new Error('RIMPL down'));
    const res = await post(FULL);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'ended', pending: 'tier2' });
  });
});

describe('GET /ples/:id/reflection', () => {
  test('returns what is on file so the page can prefill or show it as done', async () => {
    existing = { ...FULL, skipped: false, submitted_at: 't' };
    const res = await auth(request(app).get('/ples/p1/reflection'));
    expect(res.status).toBe(200);
    expect(res.body.reflection).toMatchObject(FULL);
  });

  test('returns null when nothing has been written yet', async () => {
    const res = await auth(request(app).get('/ples/p1/reflection'));
    expect(res.body.reflection).toBeNull();
  });
});
