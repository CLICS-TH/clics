// Local-only mode (#428, ADR 0012): a tutor failure on POST /ples/:id/message fails CLOSED.
//
// rimpl answers 503 `ai_unavailable` when the on-prem tutor is down under the mode, and 503
// `local_only_refused` when it refused a non-local provider before sending anything. Either way the turn
// is not counted (nothing written to messages, the ples counters untouched), not charged (the reservation
// is refunded), and the physician gets one readable code the Portal shows as "AI temporarily unavailable,
// your session is saved" with the typed text kept. rimpl sends neither code while the mode is off, so the
// existing 503 queue_full -> ai_busy and generic -> 502 contracts are the control.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const mockChat = jest.fn();
jest.mock('../src/services/rimpl-client', () => ({ rimplChat: (...a) => mockChat(...a) }));
const mockRefund = jest.fn(async () => {});
const mockReserve = jest.fn(async () => ({ ok: true, applied: true }));
const mockSettle = jest.fn(async () => {});
jest.mock('../src/lib/usage', () => ({
  effectiveLimit: async () => 1,
  effectiveTokenLimit: async () => 300000,
  budgetState: async () => ({ over: false, reason: null, limit: 1, tokenLimit: 300000, cost: 0, tokens: 0 }),
  reserveUsage: (...a) => mockReserve(...a),
  refundUsage: mockRefund,
  settleUsage: mockSettle,
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
const auth = (r) => r.set('Authorization', 'Bearer test');

beforeEach(() => {
  m.reset(); mockRefund.mockClear(); mockReserve.mockClear(); mockSettle.mockClear(); mockChat.mockReset();
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_cost_usd: 0 };
  m.state.resolve = (table, kind) => {
    if (table === 'ples' && kind === 'single') return { id: 'ple1', status: 'active', physician_id: 'doc1', context_tokens: 100, turn_count: 2 };
    return undefined;
  };
});
const send = () => auth(request(app).post('/ples/ple1/message')).send({ message: 'chest pain for 2 hours', language: 'en' });
const rimpl503 = (code) => Object.assign(new Error('RIMPL /chat error: 503'), { status: 503, code });
const wrote = () => m.state.queries.filter((q) => (q.table === 'messages' && q.op === 'insert') || (q.table === 'ples' && q.op === 'update'));

test.each(['ai_unavailable', 'local_only_refused'])('rimpl 503 %s -> 503 ai_unavailable: refunded, nothing stored, turn not counted', async (code) => {
  mockChat.mockRejectedValue(rimpl503(code));
  const res = await send();
  expect(res.status).toBe(503);
  expect(res.body).toEqual({
    error: 'ระบบ AI ไม่พร้อมใช้งานชั่วคราว เซสชันของคุณบันทึกไว้แล้ว / AI temporarily unavailable, your session is saved.',
    code: 'ai_unavailable',
  });
  expect(mockRefund).toHaveBeenCalledTimes(1);
  expect(mockSettle).not.toHaveBeenCalled();
  expect(wrote()).toEqual([]);
  expect(mockChat).toHaveBeenCalledTimes(1);   // never a second call: no fail-over from the backend either
});

test('control: rimpl 503 queue_full keeps its ai_busy contract', async () => {
  mockChat.mockRejectedValue(Object.assign(rimpl503('queue_full'), { retryAfterMs: 45000 }));
  const res = await send();
  expect(res.status).toBe(503);
  expect(res.body).toMatchObject({ code: 'ai_busy', retry_after_s: 45 });
});

test('control: a 503 with no code keeps the ai_busy contract (mode off sends no new code)', async () => {
  mockChat.mockRejectedValue(rimpl503(undefined));
  const res = await send();
  expect(res.status).toBe(503);
  expect(res.body.code).toBe('ai_busy');
});
