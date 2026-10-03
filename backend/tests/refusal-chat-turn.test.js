// A physician chat turn the model's safeguards declined (rimpl 422 'refused'): nothing is delivered,
// but the call was billed. The reservation must SETTLE to the real, provider-priced cost (not be
// refunded, which would let declined turns spend money the cap never sees), and the physician gets a
// stable code, 'ai_refused', with neutral wording. The copy is pending #136.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
let mockAssessment = null;
const mockRefusal = () => Object.assign(new Error('RIMPL /chat error: 422'), {
  status: 422, code: 'refused', category: 'general_harms',
  usage: { input_tokens: 2400, output_tokens: 302, provider: 'anthropic' },
  ...(mockAssessment ? { assessment: mockAssessment } : {}),
});
jest.mock('../src/services/rimpl-client', () => ({
  rimplChat: jest.fn(() => Promise.reject(mockRefusal())),
}));
const mockRefund = jest.fn(async () => {});
const mockAccrue = jest.fn(async () => ({ cost: 0, error: null }));
jest.mock('../src/lib/usage', () => ({
  effectiveTokenLimit: async () => null,
  budgetState: async () => ({ over: false, reason: null, limit: 1, tokenLimit: null, cost: 0, tokens: 0 }),
  effectiveLimit: async () => 1,
  reserveUsage: async () => ({ ok: true, applied: true }),
  refundUsage: mockRefund,
  settleUsage: async () => {},
  accrueUsage: (...a) => mockAccrue(...a),
  RESERVE_ESTIMATE_USD: 0.02,
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { settlementDelta, costUsd } = require('../src/lib/pricing');
const { AI_REFUSED_MESSAGE } = require('../src/lib/rimpl-refusal');
const plesRouter = require('../src/routes/ples');
const app = express();
app.use(express.json());
app.use('/ples', plesRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

let warn;
beforeEach(() => {
  m.reset();
  mockAssessment = null;
  mockRefund.mockClear();
  mockAccrue.mockClear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_cost_usd: 0 };
  m.state.resolve = (table, kind) =>
    (table === 'ples' && kind === 'single') ? { id: 'ple1', status: 'active', physician_id: 'doc1' } : undefined;
});
afterEach(() => warn.mockRestore());

test('a declined turn answers 422 ai_refused and SETTLES the reservation to the real cost (no refund)', async () => {
  const res = await auth(request(app).post('/ples/ple1/message')).send({ message: 'hello', language: 'en' });
  expect(res.status).toBe(422);
  expect(res.body.code).toBe('ai_refused');
  expect(res.body.error).not.toMatch(/general_harms|refus/i);   // neutral: no category, no policy word
  expect(res.body.error).toBe(AI_REFUSED_MESSAGE);
  expect(res.body.error.indexOf('AI ไม่สามารถ')).toBe(0);         // Thai first, then English
  expect(res.body.error).toMatch(/ \/ The AI could not respond/);
  expect(mockRefund).not.toHaveBeenCalled();
  expect(mockAccrue).toHaveBeenCalledTimes(1);
  expect(mockAccrue).toHaveBeenCalledWith('doc1', 2400, 302, settlementDelta({
    estimate: 0.02, inputTokens: 2400, outputTokens: 302, applied: true, provider: 'anthropic',
  }));
  // The physician's message is not stored as a turn: nothing was delivered.
  expect(m.all('messages', 'insert')).toHaveLength(0);
  // No classifier ran on this turn, so the episode's study-cost columns are untouched.
  expect(m.all('ples', 'update')).toHaveLength(0);
});

test('a declined turn that ran the rescue classifier charges THAT to the study, not the physician', async () => {
  mockAssessment = { input_tokens: 900, output_tokens: 40, provider: 'anthropic' };
  const res = await auth(request(app).post('/ples/ple1/message')).send({ message: 'hello', language: 'en' });
  expect(res.status).toBe(422);
  const upd = m.all('ples', 'update');
  expect(upd).toHaveLength(1);
  expect(upd[0].payload).toEqual({ rescue_assessment_tokens: 940, rescue_assessment_cost_usd: costUsd(900, 40, 'anthropic') });
  // The physician's meter got the TURN only (2400/302), never the classifier.
  expect(mockAccrue).toHaveBeenCalledTimes(1);
  expect(mockAccrue.mock.calls[0].slice(0, 3)).toEqual(['doc1', 2400, 302]);
});
