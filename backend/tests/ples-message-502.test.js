// When RIMPL is unreachable mid-turn, POST /ples/:id/message refunds the reservation and returns a
// 502 carrying the stable machine code 'rimpl_unavailable' (matches the /health/deep readiness
// signal + the repo's code: convention). Verifies the catch path in the message route.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/services/rimpl-client', () => ({
  rimplChat: jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
}));
const mockRefund = jest.fn(async () => {});
jest.mock('../src/lib/usage', () => ({
  effectiveLimit: async () => 1,
  reserveUsage: async () => ({ ok: true, applied: true }),
  refundUsage: mockRefund,
  settleUsage: async () => {},
  accrueUsage: async () => {},
  RESERVE_ESTIMATE_USD: 0.02,
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const plesRouter = require('../src/routes/ples');
const app = express();
app.use(express.json());
app.use('/ples', plesRouter);
const auth = r => r.set('Authorization', 'Bearer test');

beforeEach(() => {
  m.reset();
  mockRefund.mockClear();
  // A consented physician under budget; an active session they own.
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_cost_usd: 0 };
  m.state.resolve = (table, kind) =>
    (table === 'ples' && kind === 'single')
      ? { id: 'ple1', status: 'active', physician_id: 'doc1' }
      : undefined; // messages history → []
});

test('RIMPL failure → 502 with code rimpl_unavailable, and the reservation is refunded', async () => {
  const res = await auth(request(app).post('/ples/ple1/message')).send({ message: 'hello', language: 'en' });
  expect(res.status).toBe(502);
  expect(res.body.code).toBe('rimpl_unavailable');
  expect(res.body.error).toMatch(/RIMPL unavailable/);
  expect(mockRefund).toHaveBeenCalledTimes(1); // no turn delivered — reservation released
});
