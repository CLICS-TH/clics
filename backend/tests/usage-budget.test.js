// The AI-usage budget gate: a consented physician at/over their effective limit is blocked from
// starting a session and from sending turns (403 budget_exceeded), but finalizing (/end) is allowed.
let mockProf, mockUser;
const mockPle = { data: { id: 'ple1', status: 'active', physician_id: 'doc1', turn_count: 0, token_count: 0 }, error: null };

// Table-aware chainable mock: professionals -> the auth'd user row; ples -> an active session.
jest.mock('../src/lib/supabase', () => {
  const chain = (val) => {
    const c = {
      select: () => c, eq: () => c, insert: () => c, update: () => c,
      order: () => Promise.resolve({ data: [], error: null }),
      single: () => Promise.resolve(val),
      then: (res) => res({ error: null }), // awaiting update().eq() resolves cleanly
    };
    return c;
  };
  return {
    supabase: {
      from: (table) => table === 'ples' ? chain(mockPle) : chain(mockProf),
      rpc: () => Promise.resolve({ error: null }),
    },
    authSupabase: { auth: { getUser: () => Promise.resolve(mockUser) } },
  };
});

const request = require('supertest');
const express = require('express');
const plesRouter = require('../src/routes/ples');
const app = express();
app.use(express.json());
app.use('/ples', plesRouter);
const auth = r => r.set('Authorization', 'Bearer test');

// A consented physician with a $0.50 override who has already spent $0.50 (at the cap).
beforeEach(() => {
  mockProf = { data: { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_limit_usd: 0.5, usage_cost_usd: 0.5 }, error: null };
  mockUser = { data: { user: { id: 'doc1', email: 'doc@clics.th' } }, error: null };
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
  mockProf.data.usage_cost_usd = 0.1; // well under $0.50
  const res = await auth(request(app).post('/ples')).send({ chief_complaint: 'chest pain in a 58yo' });
  expect(res.status).not.toBe(403);
  expect(res.body.code).not.toBe('budget_exceeded');
});
