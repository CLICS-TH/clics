// Session creation (POST /ples) must be blocked until the physician has recorded informed consent.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const plesRouter = require('../src/routes/ples');
const app = express();
app.use(express.json());
app.use('/ples', plesRouter);
const auth = r => r.set('Authorization', 'Bearer test');

// The physician (id 'doc1') verifyJwt sees for the Bearer token; consented_at toggled per test.
const physician = (consented_at) => ({ id: 'doc1', role: 'physician', status: 'active', consented_at });

beforeEach(() => {
  m.reset();
  m.state.caller = physician(null);
  m.state.resolve = (table, kind) => {
    if (table === 'ples' && kind === 'single') return { id: 'ple1', status: 'active' }; // insert().select().single() echo
    return undefined;
  };
});

test('POST /ples is blocked (403 consent_required) before consent', async () => {
  const res = await auth(request(app).post('/ples')).send({ chief_complaint: 'chest pain in a 58yo' });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('consent_required');
});

// Defense-in-depth: the gate must also cover the session-writing routes, not just creation.
test('POST /ples/:id/message and /end are also gated before consent', async () => {
  const msg = await auth(request(app).post('/ples/ple1/message')).send({ message: 'hello', language: 'en' });
  expect(msg.status).toBe(403);
  expect(msg.body.code).toBe('consent_required');

  const end = await auth(request(app).post('/ples/ple1/end')).send({ active_seconds: 1000 });
  expect(end.status).toBe(403);
  expect(end.body.code).toBe('consent_required');
});

test('POST /ples passes the consent gate once consented', async () => {
  m.state.caller = physician('2026-06-07T00:00:00Z');
  const res = await auth(request(app).post('/ples')).send({ chief_complaint: 'chest pain in a 58yo' });
  expect(res.status).not.toBe(403); // gate cleared (proceeds to create)
  expect(res.body.code).not.toBe('consent_required');
});
