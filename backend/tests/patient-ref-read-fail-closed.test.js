// A patient_ref READ ERROR must fail closed. Every reader used to destructure only `{ data: pref }`, so a
// PostgREST error became patient_ref = null: RIMPL then de-identified the transcript WITHOUT the scrub
// hints, and an untitled name — "วรินทรปวดท้องมา 2 วัน", hint from "นางวรินทร ใจงาม" — reached the cloud.
// A MISSING row (no patient_ref recorded) is not an error and must keep working.
// Here: the physician's /message, /end and /reflection. (The auditor /discuss and transcript view are in
// auditor-transcript-deid.test.js; the evaluation drain in eval-drain.test.js; reconcile in
// reconcile.test.js.)
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const mockChat = jest.fn();
const mockCriteria = jest.fn();
jest.mock('../src/services/rimpl-client', () => ({
  rimplChat: (...a) => mockChat(...a),
  rimplEvaluateCriteria: (...a) => mockCriteria(...a),
  isDeterministicRimplError: () => false,
}));
const mockReserve = jest.fn(async () => ({ ok: true, applied: true }));
const mockRefund = jest.fn(async () => {});
jest.mock('../src/lib/usage', () => ({
  effectiveTokenLimit: async () => null,
  budgetState: async () => ({ over: false, reason: null, limit: 1, tokenLimit: null, cost: 0, tokens: 0 }),
  effectiveLimit: async () => 1,
  reserveUsage: (...a) => mockReserve(...a),
  refundUsage: (...a) => mockRefund(...a),
  settleUsage: async () => {},
  accrueUsage: async () => {},
  RESERVE_ESTIMATE_USD: 0.02,
}));
jest.mock('../src/services/integrity-scan', () => ({
  scanPle: async () => ({ flags: [], scanned_turns: 0 }),
  flagRescueReplyBreach: async () => {},
  recordReportedReply: async () => ({}),
}));
jest.mock('../src/services/eval-drain', () => ({ kick: jest.fn() }));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const app = express();
app.use(express.json());
app.use('/ples', require('../src/routes/ples'));
const auth = (r) => r.set('Authorization', 'Bearer test');

const RAW_TURN = 'วรินทรปวดท้องมา 2 วัน';            // untitled: only the hint can scrub it
const PATIENT_REF = 'นางวรินทร ใจงาม';
const CHIEF = 'ปวดท้อง 2 วัน';
const KEY = '3f2b8c1e-6a4d-4e0b-9b7a-1c2d3e4f5a6b';
const READ_ERROR = { data: null, error: { message: 'connection reset' } };

let ple, prefResult, errSpy;
beforeEach(() => {
  m.reset();
  mockChat.mockReset().mockRejectedValue(new Error('connect ECONNREFUSED'));
  mockCriteria.mockReset().mockResolvedValue({ c4: true, c5: true, c6: true, c7: true, pii_map: [], input_tokens: 1, output_tokens: 1, provider: 'anthropic' });
  mockReserve.mockClear();
  mockRefund.mockClear();
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_cost_usd: 0 };
  ple = { id: 'ple1', status: 'active', physician_id: 'doc1', chief_complaint: CHIEF, started_at: new Date(Date.now() - 3600e3).toISOString(),
    c1_pass: true, c2_pass: true, c3_pass: true };
  prefResult = READ_ERROR;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'ples' && kind === 'single') return ple;
    if (table === 'ples' && kind === 'update') return [{ id: 'ple1' }];     // /end's atomic claim
    // The keyed-turn replay check looks for THIS key's rows: none stored yet.
    if (table === 'messages' && ctx.eqs.some(([c]) => c === 'client_turn_id')) return [];
    if (table === 'messages' && kind === 'list') return [
      { id: 'm1', role: 'physician', content: RAW_TURN, token_count: 20 },
      { id: 'm2', role: 'assistant', content: 'เล่าเพิ่มได้ไหม', token_count: 20 },
    ];
    if (table === 'ple_patient_refs') return prefResult;
    if (table === 'app_settings') return { value: 0 };                     // reflection not required, etc.
    return undefined;
  };
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

const logged = () => errSpy.mock.calls.flat().map(String).join(' ');

describe('POST /ples/:id/message', () => {
  test('read error → 503 retryable, NOTHING sent to RIMPL, no claim, no reservation to refund', async () => {
    const r = await auth(request(app).post('/ples/ple1/message')).send({ message: RAW_TURN, language: 'th', client_turn_id: KEY });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'deidentify_unavailable', retry_after_s: 5 });
    expect(r.headers['retry-after']).toBe('5');
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();                 // refused before the reservation
    expect(mockRefund).not.toHaveBeenCalled();
    expect(m.all('chat_turn_claims').filter((q) => q.op !== 'select')).toEqual([]); // no claim taken
    expect(m.find('messages', 'insert')).toBeUndefined();
    expect(JSON.stringify(r.body) + logged()).not.toContain('วรินทร');
  });

  test('a retry with the same client_turn_id, once the read works, goes through as a fresh turn', async () => {
    await auth(request(app).post('/ples/ple1/message')).send({ message: RAW_TURN, language: 'th', client_turn_id: KEY });
    prefResult = { data: { patient_ref: PATIENT_REF }, error: null };
    await auth(request(app).post('/ples/ple1/message')).send({ message: RAW_TURN, language: 'th', client_turn_id: KEY });
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][0]).toMatchObject({ patient_ref: PATIENT_REF, chief_complaint: CHIEF });
  });

  test('NO row is not an error: the turn is sent with patient_ref null', async () => {
    prefResult = { data: null, error: null };
    const r = await auth(request(app).post('/ples/ple1/message')).send({ message: 'hello', language: 'en' });
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][0].patient_ref).toBeNull();
    expect(r.status).toBe(502);                                 // the mocked RIMPL is down — that path refunds as before
    expect(mockRefund).toHaveBeenCalledTimes(1);
  });
});

describe('POST /ples/:id/end', () => {
  test("read error → 202 pending tier2, left 'ended' for reconcile, classifier NEVER called", async () => {
    const r = await auth(request(app).post('/ples/ple1/end')).send({ active_seconds: 600 });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'ended', pending: 'tier2' });
    expect(mockCriteria).not.toHaveBeenCalled();
    const statuses = m.all('ples', 'update').map((q) => q.payload?.status).filter(Boolean);
    expect(statuses).toEqual(['ended']);                        // the claim only — no ple_pass / ple_flag_t2
    expect(logged()).not.toContain('วรินทร');
  });

  test('NO row is not an error: screened with patient_ref null and the chief complaint as numbering seed', async () => {
    prefResult = { data: null, error: null };
    const r = await auth(request(app).post('/ples/ple1/end')).send({ active_seconds: 600 });
    expect(r.status).toBe(200);
    expect(mockCriteria).toHaveBeenCalledTimes(1);
    expect(mockCriteria.mock.calls[0][0]).toMatchObject({ patient_ref: null, chief_complaint: CHIEF });
  });
});

describe('POST /ples/:id/reflection', () => {
  beforeEach(() => { ple.status = 'ended'; });

  test("read error → 202 pending tier2; the reflection is saved, the classifier NEVER called", async () => {
    const r = await auth(request(app).post('/ples/ple1/reflection')).send({ learned: 'x', uncertainty: 'y', application: 'z' });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ status: 'ended', pending: 'tier2' });
    expect(m.find('ple_reflections', 'upsert')).toBeTruthy();
    expect(mockCriteria).not.toHaveBeenCalled();
  });

  test('NO row is not an error: screened with patient_ref null', async () => {
    prefResult = { data: null, error: null };
    const r = await auth(request(app).post('/ples/ple1/reflection')).send({ learned: 'x' });
    expect(r.status).toBe(200);
    expect(mockCriteria.mock.calls[0][0]).toMatchObject({ patient_ref: null, chief_complaint: CHIEF });
  });
});
