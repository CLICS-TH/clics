// The AI-usage budget gate: a consented physician at/over their effective limit is blocked from
// starting a session and from sending turns (403 budget_exceeded), but finalizing (/end) is allowed.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const plesRouter = require('../src/routes/ples');
const app = express();
app.use(express.json());
app.use('/ples', plesRouter);
const auth = r => r.set('Authorization', 'Bearer test');

// A consented physician with a $0.50 override who has already spent $0.50 (at the cap).
beforeEach(() => {
  m.reset();
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_limit_usd: 0.5, usage_cost_usd: 0.5 };
  // ples -> an active session (fetchOwnedPle .single() and the create insert().select().single() echo).
  m.state.resolve = (table, kind) =>
    (table === 'ples' && kind === 'single')
      ? { id: 'ple1', status: 'active', physician_id: 'doc1', turn_count: 0, token_count: 0 }
      : undefined;
});

test('POST /ples is blocked (403 budget_exceeded) when at/over the limit', async () => {
  const res = await auth(request(app).post('/ples')).send({ chief_complaint: 'chest pain in a 58yo' });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('budget_exceeded');
});

test('POST /ples/:id/message is also blocked when over the limit', async () => {
  const res = await auth(request(app).post('/ples/ple1/message')).send({ message: 'hello', language: 'en' });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('budget_exceeded');
});

test('POST /ples/:id/end is NOT budget-gated (a session can always be finalized)', async () => {
  const res = await auth(request(app).post('/ples/ple1/end')).send({ active_seconds: 100 });
  expect(res.body.code).not.toBe('budget_exceeded');
});

test('under the limit, POST /ples passes the budget gate', async () => {
  m.state.caller.usage_cost_usd = 0.1; // well under $0.50
  const res = await auth(request(app).post('/ples')).send({ chief_complaint: 'chest pain in a 58yo' });
  expect(res.status).not.toBe(403);
  expect(res.body.code).not.toBe('budget_exceeded');
});
