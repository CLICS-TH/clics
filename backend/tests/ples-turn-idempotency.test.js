// Idempotency of a physician chat turn: POST /ples/:id/message with `client_turn_id`.
//
// The failure this exists for: a dropped connection looked like a failed turn, the backend had often
// already stored it, and the client's Retry stored the physician message a second time in the SCORED
// transcript (CREC082). The fix is a key the client reuses on retry plus a unique (ple_id, client_turn_id)
// on the physician row. These tests pin the contract, with the messages table played by a small in-memory
// store that enforces the same partial unique index the migration creates — so "the DB is the arbiter" is
// exercised, not asserted.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const mockCalls = [];
const mockRimplChat = jest.fn();
jest.mock('../src/services/rimpl-client', () => ({ rimplChat: (...a) => mockRimplChat(...a) }));
const mockReserve = jest.fn();
const mockRefund = jest.fn();
const mockAccrue = jest.fn();
jest.mock('../src/lib/usage', () => ({
  effectiveTokenLimit: async () => null,
  effectiveLimit: async () => 1,
  budgetState: async () => ({ over: false, reason: null, limit: 1, tokenLimit: null, cost: 0, tokens: 0 }),
  reserveUsage: (...a) => mockReserve(...a),
  refundUsage: (...a) => mockRefund(...a),
  settleUsage: async () => {},
  accrueUsage: (...a) => mockAccrue(...a),
  RESERVE_ESTIMATE_USD: 0.02,
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const turnIdem = require('../src/lib/turn-idempotency');
const plesRouter = require('../src/routes/ples');

const app = express();
app.use(express.json());
app.use('/ples', plesRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

const KEY = '3f2b8c1e-6a4d-4e0b-9b7a-1c2d3e4f5a6b';
const OTHER_KEY = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REPLY = {
  content: 'assistant reply', refs: [{ source: 'X' }], socratic_question: null,
  token_count: 120, input_tokens: 100, output_tokens: 20,
  provider: 'local', model: 'secret-model', prompt_version: 'chat-prompt-deadbeef',
};

let rows;                 // the messages table
let pleRow;
let uniqueViolations;     // how many inserts the "index" refused
let columnMissing;        // simulate "migration not applied"
let columnMissingOn;      // 'lookup' | 'claim' | 'both'
let skipNextKeyedLookup;  // make the FIRST keyed lookup read stale (the overlap race)
let errSpy;

function installStore() {
  let seq = 0;
  m.state.resolve = (table, kind, ctx) => {
    const eq = (c) => (ctx.eqs.find((e) => e[0] === c) || [])[1];
    if (table === 'ples' && kind === 'single') return pleRow;
    if (table === 'app_settings') return { value: 0 };
    if (table !== 'messages') return undefined;

    if (ctx.op === 'insert') {
      const p = ctx.payload;
      mockCalls.push(`insert:${p.role}`);
      if (columnMissing && p.client_turn_id !== undefined && columnMissingOn !== 'lookup') {
        return { data: null, error: { code: 'PGRST204', message: "Could not find the 'client_turn_id' column of 'messages' in the schema cache" } };
      }
      if (p.role === 'physician' && p.client_turn_id &&
          rows.some((r) => r.role === 'physician' && r.ple_id === p.ple_id && r.client_turn_id === p.client_turn_id)) {
        uniqueViolations += 1;
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "messages_ple_client_turn_uidx"' } };
      }
      const row = { id: `msg-${++seq}`, created_at: new Date().toISOString(), refs: [], socratic_question: null, ...p };
      rows.push(row);
      return { data: { id: row.id }, error: null };
    }
    if (ctx.op === 'delete') {
      mockCalls.push('delete');
      const id = eq('id');
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return { data: null, error: null };
    }
    // select
    if (ctx.eqs.some((e) => e[0] === 'client_turn_id')) {
      if (columnMissing && columnMissingOn !== 'claim') {
        return { data: null, error: { code: '42703', message: 'column messages.client_turn_id does not exist' } };
      }
      if (skipNextKeyedLookup) { skipNextKeyedLookup = false; return []; }
      return rows.filter((r) => r.ple_id === eq('ple_id') && r.client_turn_id === eq('client_turn_id'));
    }
    return rows.filter((r) => r.ple_id === eq('ple_id')).map(({ role, content }) => ({ role, content }));
  };
}

beforeEach(() => {
  m.reset();
  rows = []; uniqueViolations = 0; columnMissing = false; columnMissingOn = 'both'; skipNextKeyedLookup = false;
  mockCalls.length = 0;
  mockRimplChat.mockReset(); mockReserve.mockReset(); mockRefund.mockReset(); mockAccrue.mockReset();
  mockRimplChat.mockImplementation(async () => { mockCalls.push('rimpl'); return REPLY; });
  mockReserve.mockImplementation(async () => { mockCalls.push('reserve'); return { ok: true, applied: true }; });
  mockRefund.mockResolvedValue(undefined);
  mockAccrue.mockResolvedValue(undefined);
  turnIdem._resetLogThrottle();
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_cost_usd: 0 };
  pleRow = { id: 'ple1', status: 'active', physician_id: 'doc1', turn_count: 0, token_count: 0, input_tokens: 0, output_tokens: 0, context_tokens: 0, chief_complaint: 'chest pain' };
  installStore();
});
afterEach(() => errSpy.mockRestore());

const send = (body = {}) =>
  auth(request(app).post('/ples/ple1/message')).send({ message: 'hello doctor', language: 'en', ...body });
const physicianRows = () => rows.filter((r) => r.role === 'physician');

describe('no key: behaves exactly as before', () => {
  test('physician row is written AFTER rimpl, with no key anywhere, and no key lookup happens', async () => {
    const r = await send();
    expect(r.status).toBe(200);
    expect(mockCalls).toEqual(['reserve', 'rimpl', 'insert:physician', 'insert:assistant']);
    expect(rows.every((x) => x.client_turn_id === undefined)).toBe(true);
    expect(m.state.queries.some((q) => q.eqs.some((e) => e[0] === 'client_turn_id'))).toBe(false);
    expect(r.body.deduplicated).toBeUndefined();
    expect(mockAccrue).toHaveBeenCalledTimes(1);
  });

  test('two identical unkeyed sends still store two turns (no accidental dedup on text)', async () => {
    await send(); await send();
    expect(physicianRows()).toHaveLength(2);
    expect(mockRimplChat).toHaveBeenCalledTimes(2);
  });

  test('a malformed key is a 400, not silently ignored', async () => {
    const r = await send({ client_turn_id: 'not-a-uuid' });
    expect(r.status).toBe(400);
    expect(mockRimplChat).not.toHaveBeenCalled();
  });
});

describe('first request with a key', () => {
  test('claims the physician row BEFORE reserving or calling rimpl, and stamps the reply with the key', async () => {
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    expect(mockCalls).toEqual(['insert:physician', 'reserve', 'rimpl', 'insert:assistant']);
    expect(physicianRows()).toHaveLength(1);
    expect(physicianRows()[0]).toMatchObject({ content: 'hello doctor', client_turn_id: KEY });
    expect(rows.find((x) => x.role === 'assistant')).toMatchObject({ client_turn_id: KEY, content: 'assistant reply' });
    expect(r.body.content).toBe('assistant reply');
    expect(r.body.deduplicated).toBeUndefined();
    expect(mockAccrue).toHaveBeenCalledTimes(1);
  });
});

describe('duplicate key after the turn is stored', () => {
  test('returns the stored turn with NO rimpl call, NO reservation, NO accrual, NO new row', async () => {
    await send({ client_turn_id: KEY });
    const before = rows.length;
    mockCalls.length = 0; mockRimplChat.mockClear(); mockReserve.mockClear(); mockAccrue.mockClear(); mockRefund.mockClear();

    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deduplicated: true, content: 'assistant reply', token_count: 120 });
    expect(r.body.message_id).toBe(rows.find((x) => x.role === 'assistant').id);
    expect(r.body.user_message_id).toBe(physicianRows()[0].id);
    expect(rows).toHaveLength(before);
    expect(mockRimplChat).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockAccrue).not.toHaveBeenCalled();
    expect(mockRefund).not.toHaveBeenCalled();
    expect(mockCalls).toEqual([]);
  });

  test('the deduplicated body is a whitelist: no provider, model or prompt version', async () => {
    await send({ client_turn_id: KEY });
    const r = await send({ client_turn_id: KEY });
    const flat = JSON.stringify(r.body);
    expect(flat).not.toMatch(/secret-model|chat-prompt|provider|prompt_version|local/);
  });

  test('still answered after the session has ended; a key with nothing stored on an ended session is refused', async () => {
    await send({ client_turn_id: KEY });
    pleRow.status = 'ended';
    const stored = await send({ client_turn_id: KEY });
    expect(stored.status).toBe(200);
    expect(stored.body.deduplicated).toBe(true);
    const fresh = await send({ client_turn_id: OTHER_KEY });
    expect(fresh.status).toBe(400);
    expect(mockRimplChat).toHaveBeenCalledTimes(1);
  });

  test('the same key with DIFFERENT text is a 409, never the old turn dressed as the new question', async () => {
    await send({ client_turn_id: KEY });
    mockRimplChat.mockClear(); mockReserve.mockClear();
    const r = await send({ client_turn_id: KEY, message: 'a different question' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('turn_id_reused');
    expect(mockRimplChat).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });
});

describe('the original is still in flight (physician row claimed, no reply yet)', () => {
  test('a retry gets 202 turn_pending: no insert, no rimpl, no reservation', async () => {
    rows.push({ id: 'p0', ple_id: 'ple1', role: 'physician', content: 'hello doctor', client_turn_id: KEY, created_at: new Date().toISOString() });
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ pending: true, code: 'turn_pending', user_message_id: 'p0' });
    expect(r.headers['retry-after']).toBeDefined();
    expect(rows).toHaveLength(1);
    expect(mockRimplChat).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });

  test('a claim older than the rimpl ceiling is abandoned: removed by id, and the retry takes the slot', async () => {
    const old = new Date(Date.now() - turnIdem.STALE_CLAIM_MS - 5_000).toISOString();
    rows.push({ id: 'p0', ple_id: 'ple1', role: 'physician', content: 'hello doctor', client_turn_id: KEY, created_at: old });
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    expect(rows.find((x) => x.id === 'p0')).toBeUndefined();
    expect(physicianRows()).toHaveLength(1);
    expect(mockRimplChat).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.some((c) => /reclaiming abandoned claim p0/.test(String(c[0])))).toBe(true);
  });

  test('an ended session is never edited: its abandoned claim stays and the answer is still pending', async () => {
    pleRow.status = 'ended';
    const old = new Date(Date.now() - turnIdem.STALE_CLAIM_MS - 5_000).toISOString();
    rows.push({ id: 'p0', ple_id: 'ple1', role: 'physician', content: 'hello doctor', client_turn_id: KEY, created_at: old });
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(202);
    expect(rows.find((x) => x.id === 'p0')).toBeDefined();
  });
});

describe('concurrent duplicate: the unique constraint decides', () => {
  test('a lookup that read stale loses at the INSERT, with no rimpl call and no reservation', async () => {
    // Request A already holds the claim (in flight). Request B's lookup raced ahead of A's insert and
    // saw nothing; only the database can tell B it lost.
    rows.push({ id: 'p0', ple_id: 'ple1', role: 'physician', content: 'hello doctor', client_turn_id: KEY, created_at: new Date().toISOString() });
    skipNextKeyedLookup = true;
    const r = await send({ client_turn_id: KEY });
    expect(uniqueViolations).toBe(1);
    expect(r.status).toBe(202);
    expect(r.body.code).toBe('turn_pending');
    expect(physicianRows()).toHaveLength(1);
    expect(mockRimplChat).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockAccrue).not.toHaveBeenCalled();
  });

  test('two overlapping requests: one turn is stored, rimpl is called once, budget is reserved once', async () => {
    // rimpl answers after a delay, so the overlapping request arrives while the first is in flight. A
    // timer rather than a manual release: a regression must FAIL this test, not hang the suite.
    mockRimplChat.mockImplementation(() => new Promise((res) => { mockCalls.push('rimpl'); setTimeout(() => res(REPLY), 60); }));
    const a = send({ client_turn_id: KEY });
    const b = send({ client_turn_id: KEY });
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status].sort()).toEqual([200, 202]);
    expect(physicianRows()).toHaveLength(1);
    expect(rows.filter((x) => x.role === 'assistant')).toHaveLength(1);
    expect(mockRimplChat).toHaveBeenCalledTimes(1);
    expect(mockReserve).toHaveBeenCalledTimes(1);
    expect(mockAccrue).toHaveBeenCalledTimes(1);
  });
});

describe('a keyed turn that ends without a stored reply releases its slot', () => {
  test('rimpl failure: claim deleted, reservation refunded, 502 — and the retry starts clean', async () => {
    mockRimplChat.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('rimpl_unavailable');
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0);
    const retry = await send({ client_turn_id: KEY });
    expect(retry.status).toBe(200);
    expect(physicianRows()).toHaveLength(1);
  });

  test('budget refused after the claim: nothing of the turn stays stored', async () => {
    mockReserve.mockImplementationOnce(async () => ({ ok: false }));
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('budget_exceeded');
    expect(rows).toHaveLength(0);
  });

  test('reply row fails to save: 500, reservation refunded, claim released so a retry is not "pending" forever', async () => {
    const orig = m.state.resolve;
    m.state.resolve = (table, kind, ctx) =>
      (table === 'messages' && ctx.op === 'insert' && ctx.payload.role === 'assistant')
        ? { data: null, error: { message: 'boom' } } : orig(table, kind, ctx);
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(500);
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0);
  });
});

describe('column missing (code deployed before the migration)', () => {
  test('lookup finds no column: falls back to the unkeyed flow, and says so in the log', async () => {
    columnMissing = true; columnMissingOn = 'lookup';
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    // Exactly the unkeyed order and shape: physician written after rimpl, no key on any row.
    expect(mockCalls).toEqual(['reserve', 'rimpl', 'insert:physician', 'insert:assistant']);
    expect(rows.every((x) => x.client_turn_id === undefined)).toBe(true);
    expect(errSpy.mock.calls.some((c) => /client_turn_id column missing \(lookup\).*DISABLED/.test(String(c[0])))).toBe(true);
  });

  test('schema cache rejects the claim insert (PGRST204): same fallback, no turn is lost, logged', async () => {
    columnMissing = true; columnMissingOn = 'claim';
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    expect(physicianRows()).toHaveLength(1);
    expect(physicianRows()[0].client_turn_id).toBeUndefined();
    expect(mockRimplChat).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.some((c) => /client_turn_id column missing \(claim\)/.test(String(c[0])))).toBe(true);
  });

  test('a lookup failure that is NOT a missing column is a 500, not a silent fallback', async () => {
    const orig = m.state.resolve;
    m.state.resolve = (table, kind, ctx) =>
      (table === 'messages' && ctx.eqs.some((e) => e[0] === 'client_turn_id'))
        ? { data: null, error: { code: '57014', message: 'statement timeout' } } : orig(table, kind, ctx);
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('turn_lookup_failed');
    expect(mockRimplChat).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });
});
