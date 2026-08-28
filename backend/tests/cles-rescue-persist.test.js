// The Socratic rescue is decided in RIMPL and becomes a FACT here. CREC082's Statistical Analysis
// Plan commits to reporting trigger rate, activation point, and exchanges before/after — none of
// which is recoverable after the fact from message text, so an unrecorded activation is a lost data
// point. This suite pins the write, the latches that make it idempotent, and the state RIMPL needs
// forwarded to it in order to skip a classifier call it cannot decide to skip on its own.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const mockChat = jest.fn();
jest.mock('../src/services/rimpl-client', () => ({ rimplChat: mockChat }));
jest.mock('../src/lib/usage', () => ({
  effectiveLimit: async () => 1,
  reserveUsage: async () => ({ ok: true, applied: true }),
  refundUsage: async () => {},
  settleUsage: async () => {},
  accrueUsage: async () => ({ cost: 0, error: null }),
  RESERVE_ESTIMATE_USD: 0.02,
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const clesRouter = require('../src/routes/cles');
const app = express();
app.use(express.json());
app.use('/cles', clesRouter);
const auth = r => r.set('Authorization', 'Bearer test');

let cleRow;
const reply = (rescue) => ({
  content: 'What would change your mind?', refs: [], socratic_question: null,
  token_count: 100, input_tokens: 50, output_tokens: 50, provider: 'anthropic', model: 'm',
  rescue,
});

beforeEach(() => {
  m.reset();
  mockChat.mockReset();
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_cost_usd: 0 };
  cleRow = { id: 'ple1', status: 'active', physician_id: 'doc1', turn_count: 4, token_count: 500 };
  m.state.resolve = (table, kind) =>
    (table === 'cles' && kind === 'single') ? cleRow : undefined;
});

const send = () => auth(request(app).post('/cles/ple1/message')).send({ message: 'hi', language: 'en' });
const cleUpdate = () => m.all('cles', 'update').at(-1).payload;

test('an activation is stamped with its reason, its exchange count, and the protocol reason code', async () => {
  mockChat.mockResolvedValue(reply({ activated: true, reason: 'not_qualifying', exchanges_before: 4, qualifying: false }));
  expect((await send()).status).toBe(200);
  expect(cleUpdate()).toMatchObject({
    rescue_reason: 'not_qualifying',
    rescue_exchanges_before: 4,
    socratic_active: true,
    // 'protocol_rescue' is the only Socratic reason CREC082 sanctions. It must match the value
    // db/migration-crec-phase0.sql adds to cles_socratic_reason_chk, or every write 23514s — which
    // is exactly how the previous 'randomised_examiner' path shipped broken and unnoticed.
    socratic_reason: 'protocol_rescue',
  });
  expect(cleUpdate().rescue_activated_at).toEqual(expect.any(String));
});

test('a second activation does NOT move the timestamp — the activation POINT is what the SAP reports', async () => {
  cleRow.rescue_activated_at = '2026-08-01T00:00:00Z';
  mockChat.mockResolvedValue(reply({ activated: true, reason: 'off_topic', exchanges_before: 9, qualifying: false }));
  await send();
  expect(cleUpdate()).not.toHaveProperty('rescue_activated_at');
  expect(cleUpdate()).not.toHaveProperty('rescue_reason');
});

test('qualifying latches once, so later turns cost no classifier call', async () => {
  mockChat.mockResolvedValue(reply({ activated: false, reason: null, qualifying: true }));
  await send();
  expect(cleUpdate().qualified_at).toEqual(expect.any(String));

  cleRow.qualified_at = '2026-08-01T00:00:00Z';
  await send();
  expect(cleUpdate()).not.toHaveProperty('qualified_at');
});

test('both latches are forwarded to RIMPL, which is stateless and cannot know them', async () => {
  cleRow.rescue_activated_at = '2026-08-01T00:00:00Z';
  cleRow.qualified_at = '2026-08-02T00:00:00Z';
  mockChat.mockResolvedValue(reply(null));
  await send();
  expect(mockChat.mock.calls[0][0]).toMatchObject({ rescue_active: true, already_qualified: true });

  cleRow.rescue_activated_at = null; cleRow.qualified_at = null;
  await send();
  expect(mockChat.mock.calls[1][0]).toMatchObject({ rescue_active: false, already_qualified: false });
});

test('a turn with no rescue block writes no rescue columns', async () => {
  mockChat.mockResolvedValue(reply(null));
  await send();
  const u = cleUpdate();
  expect(u).toMatchObject({ turn_count: 5 });
  for (const k of ['rescue_activated_at', 'rescue_reason', 'rescue_exchanges_before', 'qualified_at', 'socratic_reason']) {
    expect(u).not.toHaveProperty(k);
  }
});

test('a rescue reply that broke its constraints is RECORDED, but the physician still gets the turn', async () => {
  // This used to assert a console.error. That put a CREC082 §4 violation in the host's log retention
  // instead of the dataset, so "did any rescue turn give a diagnosis?" was unanswerable from the
  // study data. It is a flag row now; tests/integrity-autoscan.test.js owns the row's shape.
  mockChat.mockResolvedValue(reply({
    activated: true, reason: 'not_qualifying', exchanges_before: 4, qualifying: false,
    reply_check: { ok: false, diagnostic: true, noQuestion: true, questions: 0 },
  }));
  const res = await send();
  expect(res.status).toBe(200);                       // never cost the physician their turn
  expect(m.all('cle_integrity_flags', 'upsert').map(q => q.payload.signal)).toEqual(['R1_RESCUE_REPLY_BREACH']);
});
