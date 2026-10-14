// The auditor reads the DE-IDENTIFIED transcript (docs/CONSENT-TEMPLATE.md §3: "Auditors see only the
// de-identified transcript"). The stored `messages` stay raw — they are the record — so GET
// /auditor/ples/:id masks them on the way out through RIMPL's POST /deidentify, and fails CLOSED: a
// RIMPL failure is a 503 with no transcript, never the raw text. RIMPL itself is mocked here (its
// masking is tested in rimpl/tests/deidentify-route.test.js); what is pinned is that EVERY free-text
// field reaches it, comes back masked, and that nothing raw can reach the auditor on any failure.
jest.mock('../src/lib/supabase', () => {
  const base = require('./helpers/supabase-mock').makeSupabaseMock();
  base.supabase.rpc = () => Promise.resolve({ data: true, error: null }); // usage reservations succeed
  return base;
});
const mockDeidentify = jest.fn();
const mockDiscuss = jest.fn();
const mockRefund = jest.fn(async () => ({ cost: 0, error: null }));
jest.mock('../src/lib/usage', () => ({
  ...jest.requireActual('../src/lib/usage'),
  refundUsage: (...a) => mockRefund(...a),
}));
jest.mock('../src/services/rimpl-client', () => ({
  ...jest.requireActual('../src/services/rimpl-client'),
  rimplDeidentify: (...a) => mockDeidentify(...a),
  rimplAuditDiscuss: (...a) => mockDiscuss(...a),
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { AUDITOR, COUNCIL_A } = require('./helpers/roles');

const app = express();
app.use(express.json());
app.use('/auditor', require('../src/routes/auditor'));
const auth = (r) => r.set('Authorization', 'Bearer test');

// Synthetic identifiers. LEAKS lists every raw fragment that must never reach the auditor.
const NAME = 'กฤตภาส';
const HN = 'HN 12345678';
const PATIENT_REF = `นาย${NAME} ใจงาม`;
const CHIEF = `นาย${NAME} เจ็บหน้าอก ${HN}`;
const STORED = [
  { role: 'physician', content: `ผู้ป่วยนาย${NAME} ${HN} เจ็บหน้าอก`, refs: [], socratic_question: null, created_at: '2026-01-01T00:00:00Z' },
  { role: 'assistant', content: `ตรวจ ECG (${NAME}, 2023)\n❓ ${NAME}มีอาการร่วมไหม`,
    refs: [{ source: `${NAME}, 2023`, title: NAME }], socratic_question: `${NAME}มีอาการร่วมไหม`, created_at: '2026-01-01T00:00:01Z' },
];
const REFLECTION = { learned: `${NAME} ต้องได้ serial troponin`, skipped: false };
const LEAKS = [NAME, '12345678', 'ใจงาม'];

// A stand-in for RIMPL: masks the synthetic identifiers and keeps everything else, like the filter.
const fakeMask = (s) => s.split(NAME).join('[NAME-1]').replace(/HN \d+/g, '[HN-1]');
const fakeRimpl = async ({ messages, chief_complaint }) => ({
  messages: messages.map((x) => ({ role: x.role, content: fakeMask(x.content) })),
  ...(chief_complaint != null ? { chief_complaint: fakeMask(chief_complaint) } : {}),
});

let prefResult, errSpy;
beforeEach(() => {
  m.reset();
  mockDeidentify.mockReset().mockImplementation(fakeRimpl);
  mockDiscuss.mockReset();
  mockRefund.mockClear();
  m.state.caller = AUDITOR;
  prefResult = { data: { patient_ref: PATIENT_REF }, error: null };
  m.state.resolve = (table, kind) => {
    if (table === 'ples') return { id: 'p1', status: 'evaluated', auditor_id: AUDITOR.id, council_id: COUNCIL_A, physician_id: 'phys-1',
      privacy_review_status: 'passed', privacy_concern_open: false, chief_complaint: CHIEF };
    if (table === 'messages') return STORED;
    if (table === 'ple_reflections') return REFLECTION;
    if (table === 'ple_patient_refs') return prefResult;
    if (table === 'app_settings') return { value: 0 };
    if (table === 'audit_scores') return kind === 'insert' ? undefined : { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, composite_score: 60 };
    if (table === 'ai_evaluations') return { d1: 4, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, composite_score: 64, domain_rationale: {} };
    if (table === 'audit_discussions') return kind === 'insert' ? undefined : [];
    return undefined;
  };
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

const wire = (r) => JSON.stringify(r.body) + (r.text || '');
// The fixed, bilingual 503 body (repo convention: a human-readable `error` plus a machine `code`).
const UNAVAILABLE = { error: 'การแสดงบทสนทนาขัดข้องชั่วคราว / The transcript is temporarily unavailable.', code: 'deidentify_unavailable' };
const logged = () => errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

describe('GET /auditor/ples/:id — the transcript is de-identified', () => {
  test('every turn, every role, and the copied fields come back masked; nothing raw is returned', async () => {
    const r = await auth(request(app).get('/auditor/ples/p1'));
    expect(r.status).toBe(200);
    for (const frag of LEAKS) expect(wire(r)).not.toContain(frag);
    expect(r.body.messages).toEqual([
      { role: 'physician', content: 'ผู้ป่วยนาย[NAME-1] [HN-1] เจ็บหน้าอก', refs: [], socratic_question: null, created_at: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'ตรวจ ECG ([NAME-1], 2023)\n❓ [NAME-1]มีอาการร่วมไหม',
        refs: [{ source: '[NAME-1], 2023', title: '[NAME-1]' }], socratic_question: '[NAME-1]มีอาการร่วมไหม', created_at: '2026-01-01T00:00:01Z' },
      { role: 'reflection', content: 'เรียนรู้อะไร / What I learned:\n[NAME-1] ต้องได้ serial troponin' },
    ]);
    // The chief complaint seeds the masking and is never handed to the auditor.
    expect(r.body.ple).not.toHaveProperty('chief_complaint');
  });

  test('ONE call to RIMPL: turns first in transcript order, copied fields after, with the scrub hints', async () => {
    await auth(request(app).get('/auditor/ples/p1'));
    expect(mockDeidentify).toHaveBeenCalledTimes(1);
    const { messages, patient_ref, chief_complaint } = mockDeidentify.mock.calls[0][0];
    expect(patient_ref).toBe(PATIENT_REF);           // the hints the chat route uses
    expect(chief_complaint).toBe(CHIEF);             // seeds the numbering /chat used
    expect(messages.slice(0, 3).map((x) => x.role)).toEqual(['physician', 'assistant', 'reflection']);
    expect(messages.slice(0, 3).map((x) => x.content)).toEqual([STORED[0].content, STORED[1].content, expect.stringContaining('serial troponin')]);
    // socratic_question, then refs[0].source and .title — after every turn, so they cannot renumber it.
    expect(messages.slice(3).map((x) => x.content)).toEqual([STORED[1].socratic_question, `${NAME}, 2023`, NAME]);
  });

  test.each([
    ['RIMPL answers 500', () => Object.assign(new Error('RIMPL /deidentify error: 500'), { status: 500 })],
    ['RIMPL times out', () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['RIMPL is unreachable', () => new TypeError('fetch failed')],
    ['RIMPL answers with a malformed body', () => new Error('RIMPL /deidentify returned a malformed transcript')],
  ])('FAIL CLOSED — %s: 503 deidentify_unavailable and no transcript, raw or otherwise', async (_label, makeErr) => {
    mockDeidentify.mockRejectedValue(makeErr());
    const r = await auth(request(app).get('/auditor/ples/p1'));
    expect(r.status).toBe(503);
    expect(r.body).toEqual(UNAVAILABLE);
    expect(wire(r)).not.toContain('เจ็บหน้าอก');     // not even the clinical text
    for (const frag of LEAKS) expect(wire(r)).not.toContain(frag);
    for (const frag of LEAKS) expect(logged()).not.toContain(frag);
  });

  test('FAIL CLOSED — the patient_ref (scrub hints) cannot be read: 503, RIMPL is not even asked', async () => {
    prefResult = { data: null, error: { message: 'ple_patient_refs read failed' } };
    const r = await auth(request(app).get('/auditor/ples/p1'));
    expect(r.status).toBe(503);
    expect(r.body).toEqual(UNAVAILABLE);
    expect(mockDeidentify).not.toHaveBeenCalled();
  });

  test('a session with no recorded patient_ref is still masked (no hints, null forwarded)', async () => {
    prefResult = { data: null, error: null };
    const r = await auth(request(app).get('/auditor/ples/p1'));
    expect(r.status).toBe(200);
    expect(mockDeidentify.mock.calls[0][0].patient_ref).toBeNull();
    for (const frag of LEAKS) expect(wire(r)).not.toContain(frag);
  });

  test('a field the route does not know how to mask is dropped, not passed through raw', async () => {
    const { deidentifyTranscript } = require('../src/services/deidentified-transcript');
    const out = await deidentifyTranscript([{ role: 'physician', content: NAME, superseded_draft: NAME, created_at: 't' }]);
    expect(out).toEqual([{ role: 'physician', content: '[NAME-1]', created_at: 't' }]);
  });
});

describe('POST /auditor/ples/:id/discuss — numbered like the auditor view, closed without its hints', () => {
  test('the chief complaint is forwarded to RIMPL as the numbering seed, never returned', async () => {
    mockDiscuss.mockResolvedValue({ content: 'ok', input_tokens: 1, output_tokens: 1, provider: 'anthropic' });
    const r = await auth(request(app).post('/auditor/ples/p1/discuss').send({ message: 'why d4?' }));
    expect(r.status).toBe(200);
    expect(mockDiscuss.mock.calls[0][0]).toMatchObject({ chief_complaint: CHIEF, patient_ref: PATIENT_REF });
    expect(wire(r)).not.toContain(NAME);
  });

  test('FAIL CLOSED — a patient_ref READ ERROR refunds the reservation and sends nothing to RIMPL', async () => {
    // Before: `{ data: pref }` turned this into patient_ref=null and the transcript went out without
    // its scrub hints, so an untitled patient name reached the model.
    prefResult = { data: null, error: { message: 'connection reset' } };
    const r = await auth(request(app).post('/auditor/ples/p1/discuss').send({ message: 'why d4?' }));
    expect(r.status).toBe(503);
    expect(r.body).toEqual(UNAVAILABLE);
    expect(mockDiscuss).not.toHaveBeenCalled();
    expect(m.find('audit_discussions', 'insert')).toBeUndefined();
    // The reservation taken before the read is released against the AUDITOR pool, as on rimpl failure.
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(mockRefund).toHaveBeenCalledWith(AUDITOR.id, expect.any(Number), true, 'auditor');
  });

  test('no recorded patient_ref (no row) is NOT an error: the discussion goes ahead with no hints', async () => {
    prefResult = { data: null, error: null };
    mockDiscuss.mockResolvedValue({ content: 'ok', input_tokens: 1, output_tokens: 1, provider: 'anthropic' });
    const r = await auth(request(app).post('/auditor/ples/p1/discuss').send({ message: 'why d4?' }));
    expect(r.status).toBe(200);
    expect(mockDiscuss.mock.calls[0][0].patient_ref).toBeNull();
  });
});

describe('rimplDeidentify (the client)', () => {
  const { rimplDeidentify } = jest.requireActual('../src/services/rimpl-client');
  let realFetch;
  beforeEach(() => { realFetch = global.fetch; process.env.INTERNAL_TOKEN = 'tok'; });
  afterEach(() => { global.fetch = realFetch; delete process.env.INTERNAL_TOKEN; });
  const respond = (status, body) => { global.fetch = jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body, headers: { get: () => null } }); };
  const turns = [{ role: 'physician', content: NAME }];

  test('posts to /deidentify with the internal token, patient_ref and chief complaint', async () => {
    respond(200, { messages: [{ role: 'physician', content: '[NAME-1]' }] });
    const out = await rimplDeidentify({ messages: turns, patient_ref: PATIENT_REF, chief_complaint: CHIEF });
    expect(out.messages[0].content).toBe('[NAME-1]');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/deidentify$/);
    expect(init.headers['x-internal-token']).toBe('tok');
    expect(JSON.parse(init.body)).toEqual({ messages: turns, patient_ref: PATIENT_REF, chief_complaint: CHIEF });
    expect(init.signal).toBeDefined();               // bounded by a timeout
  });

  test.each([
    ['a non-2xx', 500, { error: 'deidentify_failed' }],
    ['a body with fewer turns than sent', 200, { messages: [] }],
    ['a turn without string content', 200, { messages: [{ role: 'physician', content: null }] }],
    ['no messages array at all', 200, {}],
  ])('throws on %s (the caller then fails closed)', async (_label, status, body) => {
    respond(status, body);
    await expect(rimplDeidentify({ messages: turns })).rejects.toThrow();
  });
});
