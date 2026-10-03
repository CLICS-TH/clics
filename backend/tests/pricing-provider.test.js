// Provider-aware cost accounting.
//
// The AI seam can route a call to the Anthropic cloud OR to the on-prem local model. With ONE global
// rate pair, every on-prem token was still invoiced at Claude rates: physicians got throttled against
// the $0.50 cap for tokens that cost nothing, and councils were billed for compute they own. These
// tests pin the four things that must hold:
//   1. anthropic pricing is byte-for-byte what it was before the refactor,
//   2. a local call costs exactly $0,
//   3. a hybrid session bills ONLY its anthropic portion,
//   4. the reserve→settle path NETS TO ZERO for a local turn — no stranded reservation.
// (4) is the subtle one: a per-turn estimate is added to the meter BEFORE the call, so a "free" turn
// that simply skips its settle leaves that estimate on the meter forever.

// ── A supabase mock that actually SIMULATES the meter, so the reserve/settle arithmetic is proved
// end-to-end through the real usage.js + pricing.js rather than asserted against a stub. ───────────
const mockMeter = { value: 0, limit: 0.5, increments: [] };
jest.mock('../src/lib/supabase', () => {
  const base = require('./helpers/supabase-mock').makeSupabaseMock();
  base.supabase.rpc = (name, args) => {
    if (name === 'reserve_usage' || name === 'reserve_auditor_usage') {
      // Mirrors db/migration-usage-reserve.sql: add the estimate ONLY while still under the limit.
      if (mockMeter.value < args.p_limit) { mockMeter.value += args.p_estimate; return Promise.resolve({ data: true, error: null }); }
      return Promise.resolve({ data: false, error: null });
    }
    if (name === 'increment_usage' || name === 'increment_auditor_usage') {
      mockMeter.value += args.p_cost;
      mockMeter.increments.push(args);
      return Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };
  return base;
});

const mockRimplChat = jest.fn();
jest.mock('../src/services/rimpl-client', () => ({ rimplChat: (...a) => mockRimplChat(...a) }));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { costUsd, settlementDelta, INPUT_PER_M, OUTPUT_PER_M } = require('../src/lib/pricing');
const { RESERVE_ESTIMATE_USD } = require('../src/lib/usage');

const plesRouter = require('../src/routes/ples');
const app = express();
app.use(express.json());
app.use('/ples', plesRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

const IN = 20_000, OUT = 4_000;          // one realistic turn
const turn = (provider) => ({
  content: 'assistant reply', refs: [], socratic_question: null,
  token_count: IN + OUT, input_tokens: IN, output_tokens: OUT, provider,
});

beforeEach(() => {
  m.reset();
  mockMeter.value = 0; mockMeter.limit = 0.5; mockMeter.increments = [];
  mockRimplChat.mockReset();
  m.state.caller = {
    id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z',
    usage_limit_usd: 0.5, usage_cost_usd: 0,
  };
  m.state.resolve = (table, kind) => {
    if (table === 'app_settings') return { value: 0 };                       // clinical-artifacts toggle off
    if (table === 'ples' && kind === 'single') {
      return { id: 'ple1', status: 'active', physician_id: 'doc1', turn_count: 0, token_count: 0, input_tokens: 0, output_tokens: 0, chief_complaint: 'chest pain' };
    }
    if (table === 'messages' && kind === 'list') return [];
    return undefined;
  };
});

const sendTurn = () => auth(request(app).post('/ples/ple1/message')).send({ message: 'hello', language: 'en' });

// ── 1. Pure rate table ────────────────────────────────────────────────────────────────────────────

test('anthropic pricing is the claude-sonnet-5-5 rate — the 2-arg legacy signature still means anthropic', () => {
  // $2 / $10 per MTok (platform.claude.com/docs/en/about-claude/pricing, verified 2026-10-03).
  expect(INPUT_PER_M).toBe(2);
  expect(OUTPUT_PER_M).toBe(10);
  expect(costUsd(1_000_000, 1_000_000)).toBeCloseTo(12, 9);
  // The old 2-arg call and the new explicit 3-arg call must agree exactly.
  expect(costUsd(IN, OUT)).toBe(costUsd(IN, OUT, 'anthropic'));
  expect(costUsd(IN, OUT)).toBeCloseTo((IN / 1e6) * 2 + (OUT / 1e6) * 10, 12);
});

test('the local provider costs exactly $0 — the DGX is a sunk cost, marginal tokens are free', () => {
  expect(costUsd(IN, OUT, 'local')).toBe(0);
  expect(costUsd(50_000_000, 50_000_000, 'local')).toBe(0);
});

test('an UNKNOWN provider bills at anthropic rates, never at $0 (fail toward over-billing)', () => {
  // A vendor added to rimpl before its rates land here must not silently stop metering real spend —
  // and it must SAY SO, so the gap is noticed before an invoice is.
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(costUsd(IN, OUT, 'some-new-vendor')).toBe(costUsd(IN, OUT, 'anthropic'));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown AI provider "some-new-vendor"'));
  expect(costUsd(IN, OUT, undefined)).toBe(costUsd(IN, OUT, 'anthropic'));
  warn.mockRestore();
});

// ── 2. settlementDelta arithmetic (the reserve→settle reconciliation) ─────────────────────────────

test('settlementDelta: anthropic reconciles to (actual − estimate); local releases the reservation', () => {
  const est = RESERVE_ESTIMATE_USD;
  expect(settlementDelta({ estimate: est, inputTokens: IN, outputTokens: OUT, applied: true, provider: 'anthropic' }))
    .toBeCloseTo(costUsd(IN, OUT) - est, 12);
  // The whole point: a free turn owes −estimate, i.e. it GIVES THE RESERVATION BACK.
  expect(settlementDelta({ estimate: est, inputTokens: IN, outputTokens: OUT, applied: true, provider: 'local' }))
    .toBeCloseTo(-est, 12);
});

test('settlementDelta: when reserve failed OPEN (applied:false) nothing is given back', () => {
  const est = RESERVE_ESTIMATE_USD;
  // Nothing was ever added, so subtracting the estimate would run the meter backwards every turn.
  expect(settlementDelta({ estimate: est, inputTokens: IN, outputTokens: OUT, applied: false, provider: 'anthropic' }))
    .toBeCloseTo(costUsd(IN, OUT), 12);
  expect(settlementDelta({ estimate: est, inputTokens: IN, outputTokens: OUT, applied: false, provider: 'local' })).toBe(0);
});

// ── 3. The route: reserve → paid call → settle, against a simulated meter ─────────────────────────

test('a LOCAL turn nets the meter to ZERO — the reservation is released, not stranded', async () => {
  mockRimplChat.mockResolvedValue(turn('local'));
  const res = await sendTurn();
  expect(res.status).toBe(200);

  // reserve added +estimate; settle must hand back exactly that.
  expect(mockMeter.increments).toHaveLength(1);
  expect(mockMeter.increments[0].p_cost).toBeCloseTo(-RESERVE_ESTIMATE_USD, 12);
  expect(mockMeter.value).toBeCloseTo(0, 12);
  // Tokens are still metered even at $0 — free is not the same as invisible.
  expect(mockMeter.increments[0].p_in).toBe(IN);
  expect(mockMeter.increments[0].p_out).toBe(OUT);
});

test('20 LOCAL turns do NOT creep toward the cap (the stranded-reservation regression)', async () => {
  mockRimplChat.mockResolvedValue(turn('local'));
  for (let i = 0; i < 20; i++) expect((await sendTurn()).status).toBe(200);
  // Pre-fix this would sit at 20 × $0.02 = $0.40 — 80% of a $0.50 budget consumed by free tokens.
  expect(mockMeter.value).toBeCloseTo(0, 9);
});

test('an ANTHROPIC turn still bills the full real cost (no behaviour change on the paid path)', async () => {
  mockRimplChat.mockResolvedValue(turn('anthropic'));
  expect((await sendTurn()).status).toBe(200);
  expect(mockMeter.value).toBeCloseTo(costUsd(IN, OUT), 12);
});

test('a turn from a rimpl that reports NO provider is billed as anthropic (safe default)', async () => {
  const { provider, ...noProvider } = turn('anthropic'); // eslint-disable-line no-unused-vars
  mockRimplChat.mockResolvedValue(noProvider);
  expect((await sendTurn()).status).toBe(200);
  expect(mockMeter.value).toBeCloseTo(costUsd(IN, OUT), 12);
});

test('a HYBRID session bills ONLY the anthropic portion', async () => {
  // 3 local turns interleaved with 2 cloud turns.
  const seq = ['local', 'anthropic', 'local', 'anthropic', 'local'];
  for (const p of seq) {
    mockRimplChat.mockResolvedValueOnce(turn(p));
    expect((await sendTurn()).status).toBe(200);
  }
  const anthropicTurns = seq.filter((p) => p === 'anthropic').length;
  expect(mockMeter.value).toBeCloseTo(anthropicTurns * costUsd(IN, OUT), 9);
  // Sanity: had every turn been priced as anthropic, the meter would read 5×, not 2×.
  expect(mockMeter.value).not.toBeCloseTo(seq.length * costUsd(IN, OUT), 9);
});

test('a local turn whose RIMPL call FAILS still refunds — no stranded reservation on the error path', async () => {
  mockRimplChat.mockRejectedValue(new Error('connect ECONNREFUSED'));
  const res = await sendTurn();
  expect(res.status).toBe(502);
  expect(mockMeter.value).toBeCloseTo(0, 12);
});
