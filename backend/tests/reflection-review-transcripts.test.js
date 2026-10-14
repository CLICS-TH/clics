// Human reviewers must receive the saved reflection that the evaluator reads. Exercise the real
// routers/helper and mock only the database/auth edge; no model calls or real patient data.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
// GET /auditor/ples/:id now de-identifies the transcript through RIMPL and fails closed without it.
// That is not this suite's subject: an identity stand-in keeps it hermetic and about what it tests;
// tests/auditor-transcript-deid.test.js covers the masking and the 503.
jest.mock('../src/services/rimpl-client', () => ({
  ...jest.requireActual('../src/services/rimpl-client'),
  rimplDeidentify: async ({ messages }) => ({ messages: messages.map((m) => ({ role: m.role, content: m.content })) }),
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { AUDITOR, ADMIN, SUPERADMIN, COUNCIL_A, COUNCIL_B } = require('./helpers/roles');

const app = express();
app.use('/auditor', require('../src/routes/auditor'));
app.use('/admin', require('../src/routes/admin'));
const auth = r => r.set('Authorization', 'Bearer test');
const CHAT = [
  { role: 'physician', content: 'How should I reassess this?', created_at: '2026-01-01T00:00:00Z' },
  { role: 'assistant', content: 'Review the evidence.', refs: [{ source: 'Test guideline' }], socratic_question: 'What changed?' },
];
const SAVED = {
  id: 'reflection-1', physician_id: 'phys-1', submitted_at: '2026-01-01T00:01:00Z', skipped: false,
  learned: 'eGFR affects the choice', uncertainty: 'Evidence below 30 is uncertain', application: 'I will check the guideline',
};
const TURN = {
  role: 'reflection',
  content: 'เรียนรู้อะไร / What I learned:\neGFR affects the choice\n\nความไม่แน่นอน / What remains uncertain:\nEvidence below 30 is uncertain\n\nจะตรวจสอบ/นำไปใช้อย่างไร / How I will verify or apply it:\nI will check the guideline',
};
let ple, saved, messageResult, reflectionError;

beforeEach(() => {
  m.reset();
  ple = { id: 'p1', auditor_id: AUDITOR.id, council_id: COUNCIL_A, specialty_id: 'spec-A', status: 'evaluated',
    privacy_review_status: 'passed', privacy_concern_open: false };
  saved = { ...SAVED };
  messageResult = { data: CHAT, error: null };
  reflectionError = null;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'ples') return ple;
    if (table === 'messages') return messageResult;
    if (table === 'ple_reflections' && ctx.id('ple_id') === 'p1') return { data: saved, error: reflectionError };
    if (table === 'ai_evaluations') return { composite_score: 80 };
    return undefined;
  };
});

describe.each([
  ['assigned auditor', AUDITOR, '/auditor/ples/p1'],
  ['council/specialty admin', { ...ADMIN, specialty_id: 'spec-A' }, '/admin/ples/p1/transcript'],
  ['superadmin', SUPERADMIN, '/admin/ples/p1/transcript'],
])('%s transcript', (_viewer, caller, url) => {
  beforeEach(() => { m.state.caller = caller; });

  test('appends all reflection prompts after the unchanged conversation without private row metadata', async () => {
    const r = await auth(request(app).get(url));
    expect(r.status).toBe(200);
    expect(r.body.messages).toEqual([...CHAT, TURN]);
  });

  test('keeps a partial reflection as evidence', async () => {
    saved = { skipped: false, learned: 'Only this answer' };
    const r = await auth(request(app).get(url));
    expect(r.status).toBe(200);
    expect(r.body.messages).toEqual([...CHAT, { role: 'reflection', content: 'เรียนรู้อะไร / What I learned:\nOnly this answer' }]);
  });

  test.each([['missing', null], ['skipped', { ...SAVED, skipped: true }], ['blank', { learned: '', uncertainty: '', application: '' }]])(
    '%s reflection adds no invented physician evidence', async (_status, row) => {
      saved = row;
      const r = await auth(request(app).get(url));
      expect(r.status).toBe(200);
      expect(r.body.messages).toEqual(CHAT);
    },
  );

  test('a reflection read failure returns an error instead of an incomplete transcript', async () => {
    saved = null;
    reflectionError = { message: 'reflection read failed', code: 'XX000' };
    const r = await auth(request(app).get(url));
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual(expect.any(String));
    expect(r.body).not.toHaveProperty('messages');
  });

  test('a conversation read failure cannot become a reflection-only transcript', async () => {
    messageResult = { data: null, error: { message: 'messages read failed' } };
    const r = await auth(request(app).get(url));
    expect(r.status).toBe(500);
    expect(r.body).not.toHaveProperty('messages');
  });
});

test('the reflection is visible before scoring while AI and peer scores remain blind', async () => {
  m.state.caller = AUDITOR;
  const r = await auth(request(app).get('/auditor/ples/p1'));
  expect(r.status).toBe(200);
  expect(r.body.messages.at(-1)).toEqual(TURN);
  expect(r.body.audit_score).toBeNull();
  expect(r.body.ai_evaluation).toBeNull();
  expect(r.body.peer_avg).toBeNull();
  expect(r.body.peer_n).toBe(0);
});

test('an unassigned auditor receives no conversation or reflection', async () => {
  m.state.caller = AUDITOR;
  ple.auditor_id = 'other-auditor';
  const r = await auth(request(app).get('/auditor/ples/p1'));
  expect(r.status).toBe(404);
  expect(r.body).not.toHaveProperty('messages');
});

test.each([
  ['revoked privacy clearance', { privacy_review_status: 'pending' }],
  ['new privacy concern', { privacy_concern_open: true }],
])('the direct auditor URL withholds evidence after %s', async (_reason, change) => {
  m.state.caller = AUDITOR;
  Object.assign(ple, change);
  const r = await auth(request(app).get('/auditor/ples/p1'));
  expect(r.status).toBe(404);
  expect(r.body).not.toHaveProperty('messages');
});

test.each([
  ['another council', { council_id: COUNCIL_B }],
  ['another specialty', { specialty_id: 'spec-B' }],
])('an admin in %s receives no conversation or reflection', async (_scope, changes) => {
  m.state.caller = { ...ADMIN, specialty_id: 'spec-A' };
  Object.assign(ple, changes);
  const r = await auth(request(app).get('/admin/ples/p1/transcript'));
  expect(r.status).toBe(404);
  expect(r.body).not.toHaveProperty('messages');
});
