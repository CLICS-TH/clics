// Idempotency of a physician chat turn: POST /ples/:id/message with `client_turn_id`.
//
// The failure this exists for: a dropped connection looked like a failed turn, the backend had often
// already stored it, and the client's Retry stored the physician message a second time in the SCORED
// transcript (CREC082). The design (lib/turn-idempotency.js): a claim in chat_turn_claims, OUTSIDE the
// transcript, taken before any paid work; the physician + assistant rows still written after rimpl, as
// before; and a unique (ple_id, client_turn_id) on the physician row as the final arbiter.
//
// The two tables are played by a small in-memory store that enforces the same keys the migration creates
// (claims primary key, partial unique index on physician rows) and REFUSES an update/delete that lacks
// the filters the real code must send — so "the DB is the arbiter" and "it can only touch its own row"
// are exercised, not asserted.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const mockCalls = [];
const mockRimplChat = jest.fn();
jest.mock('../src/services/rimpl-client', () => ({ rimplChat: (...a) => mockRimplChat(...a) }));
const mockReserve = jest.fn();
const mockRefund = jest.fn();
const mockAccrue = jest.fn();
const mockBudgetState = jest.fn();
jest.mock('../src/lib/usage', () => ({
  effectiveTokenLimit: async () => null,
  effectiveLimit: async () => 1,
  budgetState: (...a) => mockBudgetState(...a),
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
const TEXT = 'hello doctor';
const reply = (content = 'assistant reply') => ({
  content, refs: [{ source: 'X' }], socratic_question: null,
  token_count: 120, input_tokens: 100, output_tokens: 20,
  provider: 'local', model: 'secret-model', prompt_version: 'chat-prompt-deadbeef',
});
const OLD = () => new Date(Date.now() - turnIdem.STALE_CLAIM_MS - 5_000).toISOString();
const NOW = () => new Date().toISOString();

let messages, claims, pleRow, uniqueViolations, missing, hooks, errSpy, warnSpy;

// Filters the real code must put on every write that can touch an existing row.
const REQUIRED = {
  'messages:delete': ['id', 'ple_id', 'role', 'client_turn_id'],
  'chat_turn_claims:delete': ['ple_id', 'client_turn_id', 'claim_token'],
  'chat_turn_claims:update': ['ple_id', 'client_turn_id', 'claim_token'],
};
const project = (row, selectArgs) => {
  const spec = (selectArgs && selectArgs[0]) || '*';
  if (spec === '*') return { ...row };
  const out = {};
  for (const c of spec.split(',').map((x) => x.trim())) if (c in row) out[c] = row[c];
  return out;
};
const matches = (row, eqs) => eqs.every(([c, v]) => row[c] === v);

function installStore() {
  let seq = 0;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'ples' && kind === 'single') return pleRow;
    if (table === 'app_settings') return { value: 0 };
    if (table !== 'messages' && table !== 'chat_turn_claims') return undefined;
    const need = REQUIRED[`${table}:${ctx.op}`];
    if (need) {
      const have = ctx.eqs.map((e) => e[0]);
      const lacking = need.filter((c) => !have.includes(c));
      if (lacking.length) throw new Error(`${table} ${ctx.op} without filter(s): ${lacking.join(', ')}`);
    }

    if (table === 'chat_turn_claims') {
      if (missing.table) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.chat_turn_claims' in the schema cache" } };
      if (hooks.claims) { const r = hooks.claims(ctx); if (r !== undefined) return r; }
      if (ctx.op === 'insert') {
        mockCalls.push('claim:insert');
        const p = ctx.payload;
        if (claims.some((c) => c.ple_id === p.ple_id && c.client_turn_id === p.client_turn_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "chat_turn_claims_pkey"' } };
        }
        claims.push({ claimed_at: NOW(), created_at: NOW(), status: 'in_flight', ...p });
        return { data: null, error: null };
      }
      if (ctx.op === 'update') {
        const hit = claims.filter((c) => matches(c, ctx.eqs));
        hit.forEach((c) => Object.assign(c, ctx.payload));
        mockCalls.push(ctx.payload.status === 'done' ? 'claim:done' : 'claim:takeover');
        return { data: ctx.selectArgs ? hit.map((c) => project(c, ctx.selectArgs)) : null, error: null };
      }
      if (ctx.op === 'delete') {
        mockCalls.push('claim:release');
        claims = claims.filter((c) => !matches(c, ctx.eqs));
        return { data: null, error: null };
      }
      const rows = claims.filter((c) => matches(c, ctx.eqs)).map((c) => project(c, ctx.selectArgs));
      return kind === 'maybeSingle' ? { data: rows[0] ?? null, error: null } : rows;
    }

    // messages
    if (hooks.messages) { const r = hooks.messages(ctx, kind); if (r !== undefined) return r; }
    if (ctx.op === 'insert') {
      const p = ctx.payload;
      mockCalls.push(`insert:${p.role}`);
      if (missing.column && 'client_turn_id' in p) {
        return { data: null, error: { code: 'PGRST204', message: "Could not find the 'client_turn_id' column of 'messages' in the schema cache" } };
      }
      if (p.role === 'physician' && p.client_turn_id &&
          messages.some((r) => r.role === 'physician' && r.ple_id === p.ple_id && r.client_turn_id === p.client_turn_id)) {
        uniqueViolations += 1;
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "messages_ple_client_turn_uidx"' } };
      }
      const row = { id: `msg-${++seq}`, created_at: NOW(), refs: [], socratic_question: null, client_turn_id: null, ...p };
      messages.push(row);
      return { data: { id: row.id }, error: null };
    }
    if (ctx.op === 'delete') {
      mockCalls.push('messages:delete');
      messages = messages.filter((r) => !matches(r, ctx.eqs));
      return { data: null, error: null };
    }
    const wantsKey = ctx.eqs.some((e) => e[0] === 'client_turn_id') || /client_turn_id/.test(String(ctx.selectArgs?.[0] ?? ''));
    if (missing.column && wantsKey) return { data: null, error: { code: '42703', message: 'column messages.client_turn_id does not exist' } };
    return messages.filter((r) => matches(r, ctx.eqs)).map((r) => project(r, ctx.selectArgs));
  };
}

beforeEach(() => {
  m.reset();
  messages = []; claims = []; uniqueViolations = 0; missing = { column: false, table: false }; hooks = {};
  mockCalls.length = 0;
  for (const f of [mockRimplChat, mockReserve, mockRefund, mockAccrue, mockBudgetState]) f.mockReset();
  mockRimplChat.mockImplementation(async () => { mockCalls.push('rimpl'); return reply(); });
  mockReserve.mockImplementation(async () => { mockCalls.push('reserve'); return { ok: true, applied: true }; });
  mockRefund.mockResolvedValue(undefined);
  mockAccrue.mockResolvedValue(undefined);
  mockBudgetState.mockResolvedValue({ over: false, reason: null, limit: 1, tokenLimit: null, cost: 0, tokens: 0 });
  turnIdem._resetLogThrottle();
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_cost_usd: 0 };
  pleRow = { id: 'ple1', status: 'active', physician_id: 'doc1', started_at: '2026-10-01T00:00:00Z', turn_count: 0, token_count: 0, input_tokens: 0, output_tokens: 0, context_tokens: 0, chief_complaint: 'chest pain' };
  installStore();
});
afterEach(() => { errSpy.mockRestore(); warnSpy.mockRestore(); });

const send = (body = {}) => auth(request(app).post('/ples/ple1/message')).send({ message: TEXT, language: 'en', ...body });
const physicianRows = () => messages.filter((r) => r.role === 'physician');
const assistantRows = () => messages.filter((r) => r.role === 'assistant');
const insertPayloads = () => m.all('messages', 'insert').map((q) => q.payload);
const storeTurn = (key = KEY, content = 'stored reply') => {
  messages.push({ id: 'p0', ple_id: 'ple1', role: 'physician', content: TEXT, client_turn_id: key, created_at: NOW(), refs: [], socratic_question: null, token_count: 3 });
  messages.push({ id: 'a0', ple_id: 'ple1', role: 'assistant', content, client_turn_id: key, created_at: NOW(), refs: [], socratic_question: null, token_count: 120 });
  claims.push({ ple_id: 'ple1', client_turn_id: key, claim_token: 'tok-0', status: 'done', claimed_at: NOW(), created_at: NOW() });
};
const claim = (claimed_at, token = 'tok-0') =>
  claims.push({ ple_id: 'ple1', client_turn_id: KEY, claim_token: token, status: 'in_flight', claimed_at, created_at: claimed_at });

describe('no key: behaves exactly as before', () => {
  test('rows written after rimpl, no key anywhere, no claim or keyed lookup', async () => {
    const r = await send();
    expect(r.status).toBe(200);
    expect(mockCalls).toEqual(['reserve', 'rimpl', 'insert:physician', 'insert:assistant']);
    expect(insertPayloads().every((p) => !('client_turn_id' in p))).toBe(true);
    expect(m.all('chat_turn_claims')).toHaveLength(0);
    expect(m.state.queries.some((q) => q.eqs.some((e) => e[0] === 'client_turn_id'))).toBe(false);
    expect(r.body.deduplicated).toBeUndefined();
  });

  test('two identical unkeyed sends still store two turns (no accidental dedup on text)', async () => {
    await send(); await send();
    expect(physicianRows()).toHaveLength(2);
    expect(mockRimplChat).toHaveBeenCalledTimes(2);
  });

  test('an exhausted budget still refuses an unkeyed send', async () => {
    mockBudgetState.mockResolvedValue({ over: true, reason: 'cost', limit: 1, tokenLimit: null });
    const r = await send();
    expect(r.status).toBe(403);
  });

  test('a malformed key is a 400, not silently ignored', async () => {
    const r = await send({ client_turn_id: 'not-a-uuid' });
    expect(r.status).toBe(400);
    expect(mockRimplChat).not.toHaveBeenCalled();
  });
});

describe('first request with a key', () => {
  test('claim first (outside messages), then the SAME write order as today, then the claim is marked done', async () => {
    mockRimplChat.mockImplementation(async () => {
      mockCalls.push('rimpl');
      // While the AI is answering, the scored transcript holds NOTHING for this turn.
      expect(messages).toHaveLength(0);
      expect(claims).toHaveLength(1);
      return reply();
    });
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    expect(mockCalls).toEqual(['claim:insert', 'reserve', 'rimpl', 'insert:physician', 'insert:assistant', 'claim:done']);
    expect(physicianRows()).toEqual([expect.objectContaining({ content: TEXT, client_turn_id: KEY })]);
    expect(assistantRows()).toEqual([expect.objectContaining({ client_turn_id: KEY, content: 'assistant reply' })]);
    expect(claims[0].status).toBe('done');
    expect(mockAccrue).toHaveBeenCalledTimes(1);
  });
});

describe('a retry of a stored turn', () => {
  test('is answered from the record: NO rimpl, NO reservation, NO accrual, NO refund, NO write', async () => {
    storeTurn();
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deduplicated: true, content: 'stored reply', message_id: 'a0', user_message_id: 'p0', token_count: 120 });
    for (const f of [mockRimplChat, mockReserve, mockAccrue, mockRefund]) expect(f).not.toHaveBeenCalled();
    expect(mockCalls).toEqual([]);
    expect(messages).toHaveLength(2);
  });

  test('is answered even when the budget is now exhausted (the lookup runs before requireBudget)', async () => {
    storeTurn();
    mockBudgetState.mockResolvedValue({ over: true, reason: 'cost', limit: 1, tokenLimit: null });
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    expect(r.body.deduplicated).toBe(true);
    expect(mockBudgetState).not.toHaveBeenCalled();
  });

  test('the deduplicated body is a whitelist: no provider, model or prompt version', async () => {
    await send({ client_turn_id: KEY });
    const r = await send({ client_turn_id: KEY });
    expect(r.body.deduplicated).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/secret-model|chat-prompt|provider|prompt_version|"local"/);
  });

  test('is answered after the session ended; a NEW key on an ended session is refused', async () => {
    storeTurn();
    pleRow.status = 'ended';
    expect((await send({ client_turn_id: KEY })).body.deduplicated).toBe(true);
    expect((await send({ client_turn_id: OTHER_KEY })).status).toBe(400);
    expect(mockRimplChat).not.toHaveBeenCalled();
  });

  test('the same key with DIFFERENT text is a 409, never the old turn dressed as the new question', async () => {
    storeTurn();
    const r = await send({ client_turn_id: KEY, message: 'a different question' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('turn_id_reused');
    expect(mockRimplChat).not.toHaveBeenCalled();
  });
});

describe('claims', () => {
  test('a FRESH claim held by another request → 202 turn_pending, nothing written, nothing charged', async () => {
    claim(NOW());
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ pending: true, code: 'turn_pending' });
    expect(r.headers['retry-after']).toBeDefined();
    expect(messages).toHaveLength(0);
    expect(mockRimplChat).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });

  test('a STALE claim (killed request) is taken over atomically, by its old token, and the turn proceeds', async () => {
    claim(OLD(), 'tok-dead');
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    const takeover = m.all('chat_turn_claims', 'update').find((q) => q.payload.claim_token);
    expect(takeover.eqs).toEqual(expect.arrayContaining([['claim_token', 'tok-dead']]));
    expect(claims).toHaveLength(1);
    expect(claims[0].claim_token).not.toBe('tok-dead');
    expect(claims[0].status).toBe('done');
    expect(physicianRows()).toHaveLength(1);
    expect(mockRimplChat).toHaveBeenCalledTimes(1);
  });

  test('losing a takeover race (0 rows updated) → re-read → 202, never a second rimpl call', async () => {
    claim(OLD(), 'tok-dead');
    hooks.claims = (ctx) => {
      if (ctx.op === 'update' && ctx.payload.claim_token) {
        // Another retry took it over between our read and our update.
        Object.assign(claims[0], { claim_token: 'tok-other', claimed_at: NOW() });
        hooks.claims = null;
        return { data: [], error: null };
      }
      return undefined;
    };
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(202);
    expect(mockRimplChat).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
    expect(claims[0].claim_token).toBe('tok-other');
  });

  test('claimTurn second attempt: insert collides (23505), the slot is free again on re-read, the retry claims it', async () => {
    let collided = false;
    hooks.claims = (ctx) => {
      if (ctx.op === 'insert' && !collided) {
        collided = true;
        mockCalls.push('claim:insert');
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "chat_turn_claims_pkey"' } };
      }
      return undefined;
    };
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    expect(mockCalls.filter((c) => c === 'claim:insert')).toHaveLength(2);
    expect(physicianRows()).toHaveLength(1);
    expect(mockRimplChat).toHaveBeenCalledTimes(1);
  });

  test('two overlapping requests: one turn stored, rimpl once, budget reserved once', async () => {
    // A timer rather than a manual release: a regression must FAIL this test, not hang the suite.
    mockRimplChat.mockImplementation(() => new Promise((res) => { mockCalls.push('rimpl'); setTimeout(() => res(reply()), 60); }));
    const [ra, rb] = await Promise.all([send({ client_turn_id: KEY }), send({ client_turn_id: KEY })]);
    expect([ra.status, rb.status].sort()).toEqual([200, 202]);
    expect(physicianRows()).toHaveLength(1);
    expect(assistantRows()).toHaveLength(1);
    expect(mockRimplChat).toHaveBeenCalledTimes(1);
    expect(mockReserve).toHaveBeenCalledTimes(1);
    expect(mockAccrue).toHaveBeenCalledTimes(1);
  });
});

describe('the final arbiter: a late original vs the retry that took over its stale claim', () => {
  test('both get an answer from rimpl; one physician row, one reply, the loser is refunded and stores nothing', async () => {
    let releaseOriginal;
    mockRimplChat
      .mockImplementationOnce(() => new Promise((res) => { mockCalls.push('rimpl:original'); releaseOriginal = () => res(reply('ORIGINAL reply')); }))
      .mockImplementationOnce(async () => { mockCalls.push('rimpl:reclaimer'); return reply('RECLAIMER reply'); });

    const original = send({ client_turn_id: KEY }).then((r) => r); // .then() starts the request (supertest is lazy)
    for (let i = 0; i < 100 && !releaseOriginal; i++) await new Promise((r) => setTimeout(r, 5));
    expect(releaseOriginal).toBeDefined();
    // The original is still waiting on rimpl, but its claim now LOOKS dead (e.g. a slow DB, a clock).
    claims[0].claimed_at = OLD();
    const reclaimer = await send({ client_turn_id: KEY });
    expect(reclaimer.status).toBe(200);
    expect(reclaimer.body.content).toBe('RECLAIMER reply');

    releaseOriginal();
    const late = await original;
    // The late original hit the unique index on its physician insert: it must NOT insert its reply.
    expect(uniqueViolations).toBe(1);
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ deduplicated: true, content: 'RECLAIMER reply' });
    expect(physicianRows()).toHaveLength(1);
    expect(assistantRows()).toEqual([expect.objectContaining({ content: 'RECLAIMER reply' })]);
    expect(mockReserve).toHaveBeenCalledTimes(2);
    expect(mockRefund).toHaveBeenCalledTimes(1);   // the loser's reservation
    expect(mockAccrue).toHaveBeenCalledTimes(1);   // only the winner settles
    // The loser's release is conditional on ITS token, so the winner's claim survives as 'done'.
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe('done');
  });
});

describe('a keyed turn that ends without a stored reply frees its slot', () => {
  test('rimpl failure: claim released, nothing in messages, refund, 502 — and the retry starts clean', async () => {
    mockRimplChat.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(502);
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(0);
    expect(claims).toHaveLength(0);
    expect((await send({ client_turn_id: KEY })).status).toBe(200);
    expect(physicianRows()).toHaveLength(1);
  });

  test('budget refused at reservation: claim released, nothing stored', async () => {
    mockReserve.mockImplementationOnce(async () => ({ ok: false }));
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(403);
    expect(claims).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  test('reply row fails to save: the unanswered physician row is removed (by id+ple+role+key), claim released, refund, 500', async () => {
    hooks.messages = (ctx) => (ctx.op === 'insert' && ctx.payload.role === 'assistant')
      ? (mockCalls.push('insert:assistant'), { data: null, error: { message: 'boom' } }) : undefined;
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(500);
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(0);
    expect(claims).toHaveLength(0);
    const del = m.find('messages', 'delete');
    expect(del.eqs).toEqual(expect.arrayContaining([['ple_id', 'ple1'], ['role', 'physician'], ['client_turn_id', KEY]]));
  });

  test('a physician row with no reply and NO live claim is reported, not promised (409 turn_incomplete)', async () => {
    messages.push({ id: 'p9', ple_id: 'ple1', role: 'physician', content: TEXT, client_turn_id: KEY, created_at: NOW() });
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('turn_incomplete');
    expect(mockRimplChat).not.toHaveBeenCalled();
  });
});

describe('/end while a turn is being answered', () => {
  const end = () => auth(request(app).post('/ples/ple1/end')).send({ active_seconds: 30 });

  test('a FRESH claim → 409 turn_in_flight, and the session is not touched', async () => {
    claim(NOW());
    const r = await end();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('turn_in_flight');
    expect(m.all('ples', 'update')).toHaveLength(0);
  });

  test('a STALE claim never blocks /end', async () => {
    claim(OLD());
    const r = await end();
    expect(r.body.code).not.toBe('turn_in_flight');
    expect(m.all('ples', 'update').length).toBeGreaterThan(0);
  });

  test('a done claim never blocks /end', async () => {
    storeTurn();
    const r = await end();
    expect(r.body.code).not.toBe('turn_in_flight');
  });
});

describe('GET /ples/:id', () => {
  test('returns client_turn_id on PHYSICIAN rows only', async () => {
    storeTurn();
    const r = await auth(request(app).get('/ples/ple1'));
    expect(r.status).toBe(200);
    const [p, a] = r.body.messages;
    expect(p.client_turn_id).toBe(KEY);
    expect('client_turn_id' in a).toBe(false);
  });

  test('column missing → the transcript is still served, without the key, and it is logged', async () => {
    storeTurn();
    missing.column = true;
    const r = await auth(request(app).get('/ples/ple1'));
    expect(r.status).toBe(200);
    expect(r.body.messages).toHaveLength(2);
    expect(r.body.messages.every((x) => !('client_turn_id' in x))).toBe(true);
    expect(errSpy.mock.calls.some((c) => /missing \(transcript read\)/.test(String(c[0])))).toBe(true);
  });
});

describe('code deployed before the migration', () => {
  test('messages column missing: the unkeyed flow, logged', async () => {
    missing.column = true;
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    expect(mockCalls).toEqual(['reserve', 'rimpl', 'insert:physician', 'insert:assistant']);
    expect(insertPayloads().every((p) => !('client_turn_id' in p))).toBe(true);
    expect(errSpy.mock.calls.some((c) => /missing \(messages lookup\).*DISABLED/.test(String(c[0])))).toBe(true);
  });

  test('claims table missing: the unkeyed flow, logged', async () => {
    missing.table = true;
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(200);
    expect(physicianRows()).toHaveLength(1);
    expect(insertPayloads().every((p) => !('client_turn_id' in p))).toBe(true);
    expect(errSpy.mock.calls.some((c) => /missing \(claim lookup\)/.test(String(c[0])))).toBe(true);
  });

  test('claims table missing never blocks /end', async () => {
    missing.table = true;
    const r = await auth(request(app).post('/ples/ple1/end')).send({ active_seconds: 30 });
    expect(r.body.code).not.toBe('turn_in_flight');
  });

  test('a lookup failure that is NOT a missing table/column is a 500, not a silent fallback', async () => {
    hooks.messages = (ctx) => (ctx.op === 'select' && ctx.eqs.some((e) => e[0] === 'client_turn_id'))
      ? { data: null, error: { code: '57014', message: 'statement timeout' } } : undefined;
    const r = await send({ client_turn_id: KEY });
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('turn_lookup_failed');
    expect(mockRimplChat).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });
});
