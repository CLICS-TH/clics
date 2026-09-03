// The transcript-size cap on POST /ples/:id/message, and the two rimpl outcomes it maps:
//   * projected context ≥ ple_max_transcript_tokens → 403 transcript_limit_reached BEFORE any reservation;
//   * a successful turn reports transcript { used, limit, pct, warn } (warn at ≥ warn_pct);
//   * rimpl 413 transcript_too_large → 403 transcript_limit_reached + the reservation refunded;
//   * rimpl 503 queue_full → 503 ai_busy with Retry-After, refunded — never a fail-over.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const mockChat = jest.fn();
jest.mock('../src/services/rimpl-client', () => ({ rimplChat: (...a) => mockChat(...a) }));
const mockRefund = jest.fn(async () => {});
const mockReserve = jest.fn(async () => ({ ok: true, applied: true }));
jest.mock('../src/lib/usage', () => ({
  effectiveLimit: async () => 1,
  effectiveTokenLimit: async () => 300000,
  budgetState: async () => ({ over: false, reason: null, limit: 1, tokenLimit: 300000, cost: 0, tokens: 0 }),
  reserveUsage: (...a) => mockReserve(...a),
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
const SETTINGS = { ple_max_transcript_tokens: 10000, ple_transcript_warn_pct: 80 };

function wire({ contextTokens }) {
  m.reset(); mockRefund.mockClear(); mockReserve.mockClear(); mockChat.mockReset();
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_cost_usd: 0 };
  m.state.resolve = (table, kind) => {
    if (table === 'ples' && kind === 'single') return { id: 'ple1', status: 'active', physician_id: 'doc1', context_tokens: contextTokens, turn_count: 2 };
    if (table === 'app_settings' && kind === 'list') return { data: Object.entries(SETTINGS).map(([key, value]) => ({ key, value })) };
    return undefined;
  };
}
const send = (msg = 'hello') => auth(request(app).post('/ples/ple1/message')).send({ message: msg, language: 'en' });

test('projected context at the cap → 403 transcript_limit_reached, and NO reservation was taken', async () => {
  wire({ contextTokens: 9990 });
  const res = await send('x'.repeat(100)); // +25 tokens → 10015 ≥ 10000
  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ code: 'transcript_limit_reached', used: 9990, limit: 10000 });
  expect(mockReserve).not.toHaveBeenCalled();
  expect(mockChat).not.toHaveBeenCalled();
});

test('under the cap the turn goes through and reports transcript size; warn flips at 80%', async () => {
  wire({ contextTokens: 5000 });
  mockChat.mockResolvedValue({ content: 'ok', refs: [], input_tokens: 8100, output_tokens: 300, token_count: 8400, provider: 'local' });
  const res = await send();
  expect(res.status).toBe(200);
  expect(res.body.transcript).toEqual({ used: 8400, limit: 10000, pct: 84, warn: true, warn_pct: 80 });
  // the counters write carries the size the model just saw
  const counters = m.all('ples', 'update').find((q) => q.payload && 'context_tokens' in q.payload);
  expect(counters.payload.context_tokens).toBe(8400);
  // and the reservation carried the token ceiling
  expect(mockReserve).toHaveBeenCalledWith('doc1', 1, 0.02, 'physician', 300000);
});

test('below the warn threshold → warn false', async () => {
  wire({ contextTokens: 1000 });
  mockChat.mockResolvedValue({ content: 'ok', refs: [], input_tokens: 2000, output_tokens: 200, token_count: 2200, provider: 'local' });
  const res = await send();
  expect(res.body.transcript).toMatchObject({ used: 2200, pct: 22, warn: false });
});

test('rimpl 413 (its own size backstop) → 403 transcript_limit_reached, reservation refunded', async () => {
  wire({ contextTokens: 8000 });
  mockChat.mockRejectedValue(Object.assign(new Error('RIMPL /chat error: 413'), { status: 413, code: 'transcript_too_large' }));
  const res = await send();
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('transcript_limit_reached');
  expect(mockRefund).toHaveBeenCalledTimes(1);
});

test('rimpl 503 queue_full → 503 ai_busy with the server\'s Retry-After, refunded — not a fail-over', async () => {
  wire({ contextTokens: 100 });
  mockChat.mockRejectedValue(Object.assign(new Error('RIMPL /chat error: 503'), { status: 503, code: 'queue_full', retryAfterMs: 45000 }));
  const res = await send();
  expect(res.status).toBe(503);
  expect(res.body).toEqual({ error: expect.any(String), code: 'ai_busy', retry_after_s: 45 });
  expect(res.headers['retry-after']).toBe('45');
  expect(mockRefund).toHaveBeenCalledTimes(1);
  expect(mockChat).toHaveBeenCalledTimes(1);
});

test('any other rimpl failure keeps the existing 502 rimpl_unavailable contract', async () => {
  wire({ contextTokens: 100 });
  mockChat.mockRejectedValue(new Error('connect ECONNREFUSED'));
  const res = await send();
  expect(res.status).toBe(502);
  expect(res.body.code).toBe('rimpl_unavailable');
});
