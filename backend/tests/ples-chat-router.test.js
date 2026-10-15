// CHAT ROUTER on the physician turn — POST /ples/:id/message (backend half).
//
// The backend's part:
//   - forward the app setting `chat_router_enabled` (default OFF) as `router_enabled`, and the sticky
//     deep-mode latch as `deep_mode` (ples.deep_mode_at, read from the `*` row);
//   - latch ples.deep_mode_at ONCE, on the first turn rimpl serves as tier 'deep' with thinking applied;
//   - store rimpl's `middleware_flags` on the ASSISTANT row, whitelisted to exactly seven primitive keys;
//   - write flags + a streamed superseded draft in the turn's own transaction (store_chat_turn's three
//     trailing params, db/migration-chat-turn-flags.sql) — and, while that migration is not applied,
//     retry with the old signature and write them the old, separate way;
//   - relay rimpl's SSE `status` event reduced to its known `phase`.
// The code ships BEFORE the migration, so every "unmigrated" shape is pinned here too: no deep_mode_at
// column, no middleware_flags column, the old 12-param store_chat_turn, no store_chat_turn at all.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const mockRimplChat = jest.fn();
jest.mock('../src/services/rimpl-client', () => ({ rimplChat: (...a) => mockRimplChat(...a) }));

const request = require('supertest');
const express = require('express');
const { __mock: m, supabase: sb } = require('../src/lib/supabase');
const { sanitizeMiddlewareFlags, FLAG_KEYS, _resetLogThrottle: resetFlagLog } = require('../src/services/middleware-flags');
const { _resetLogThrottle: resetDraftLog } = require('../src/services/superseded-draft');
const turnIdem = require('../src/lib/turn-idempotency');

const app = express();
app.use(express.json());
app.use('/ples', require('../src/routes/ples'));
const auth = (r) => r.set('Authorization', 'Bearer test');
const ASSISTANT_ID = 'a1b2c3d4-0000-4000-8000-0000000000aa';

const OLD_PARAMS = ['p_ple_id', 'p_client_turn_id', 'p_physician_content', 'p_physician_tokens', 'p_assistant_content',
  'p_refs', 'p_socratic_question', 'p_assistant_tokens', 'p_provider', 'p_model', 'p_prompt_version', 'p_replace_physician_id'];
const NEW_PARAMS = ['p_middleware_flags', 'p_superseded_draft', 'p_superseded_reason'];
const PGRST202 = { code: 'PGRST202', message: 'Could not find the function public.store_chat_turn(p_assistant_content, ..., p_middleware_flags, ...) in the schema cache' };

// Real values, as rimpl emits them (the whitelist enumerates every string field).
const ROUTER_V = 'router-v1+abcdef012345';
const FLAGS = {
  router_version: ROUTER_V, tier: 'fast', reason: 'default', thinking: false,
  thinking_budget: null, evidence_level: null, failed_over_from: null,
};
const body = (extra = {}) => ({
  content: 'Amoxicillin 1 g tds (BTS, 2019).', refs: [], socratic_question: null,
  token_count: 120, input_tokens: 100, output_tokens: 20,
  provider: 'local', model: 'deepseek', prompt_version: 'chat-prompt-1',
  middleware_flags: FLAGS, ...extra,
});
const deep = (extra = {}) => body({ middleware_flags: { ...FLAGS, tier: 'deep', reason: 'dosing', thinking: true, thinking_budget: 4096 }, ...extra });
const streams = (events, result) => async ({ onEvent }) => {
  for (const [n, d] of events) onEvent?.(n, d);
  if (result instanceof Error) throw result;
  return result;
};
function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((b) => ({
    event: /^event: (.+)$/m.exec(b)?.[1],
    data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? 'null'),
  }));
}

// dbShape: 'v2' (migration applied) | 'v1' (only the 12-param store_chat_turn) | 'none' (no function).
// migrated: whether ples.deep_mode_at and messages.middleware_flags exist.
let settings, pleRow, dbShape, migrated, rpcCalls, rpcHook, errSpy, warnSpy;
beforeEach(() => {
  m.reset();
  mockRimplChat.mockReset();
  resetFlagLog(); resetDraftLog(); turnIdem._resetLogThrottle();
  settings = { chat_router_enabled: 1, chat_streaming: 0 };
  pleRow = { id: 'ple1', status: 'active', physician_id: 'doc1', turn_count: 0, token_count: 0, input_tokens: 0, output_tokens: 0, chief_complaint: 'cough', deep_mode_at: null };
  dbShape = 'v2'; migrated = true; rpcCalls = []; rpcHook = null;
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z', usage_limit_usd: 0.5, usage_cost_usd: 0 };
  sb.rpc = async (name, a) => {
    if (name !== 'store_chat_turn') return { data: true, error: null };
    rpcCalls.push(a);
    if (rpcHook) { const r = rpcHook(a, rpcCalls.length); if (r) return r; }
    if (dbShape === 'none' || (dbShape === 'v1' && NEW_PARAMS.some((k) => k in a))) return { data: null, error: PGRST202 };
    return { data: [{ physician_id: 'p-1', assistant_id: ASSISTANT_ID }], error: null };
  };
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'app_settings') return { value: settings[ctx?.id?.('key')] ?? 0 };
    if (table === 'ples' && kind === 'single') {
      // A select that NAMES the column fails on an unmigrated DB — the whole query, as PostgREST does.
      if (!migrated && /deep_mode_at/.test(String(ctx.selectArgs?.[0] ?? '*'))) {
        return { data: null, error: { code: '42703', message: 'column ples.deep_mode_at does not exist' } };
      }
      const row = { ...pleRow };
      if (!migrated) delete row.deep_mode_at;
      return row;
    }
    if (table === 'ples' && kind === 'update' && ctx.payload && 'deep_mode_at' in ctx.payload && !migrated) {
      return { data: null, error: { code: 'PGRST204', message: "Could not find the 'deep_mode_at' column of 'ples' in the schema cache" } };
    }
    if (table === 'messages' && kind === 'update' && ctx.payload && 'middleware_flags' in ctx.payload && !migrated) {
      return { data: null, error: { code: 'PGRST204', message: "Could not find the 'middleware_flags' column of 'messages' in the schema cache" } };
    }
    if (table === 'messages' && kind === 'list') return [];
    if (table === 'messages' && kind === 'single') return { id: ASSISTANT_ID };
    return undefined;
  };
});
afterEach(() => { errSpy.mockRestore(); warnSpy.mockRestore(); });

const send = (extra = {}) => auth(request(app).post('/ples/ple1/message')).send({ message: 'first line for CAP?', language: 'en', ...extra });
const latches = () => m.all('ples', 'update').filter((q) => q.payload && 'deep_mode_at' in q.payload);
const msgUpdates = (col) => m.all('messages', 'update').filter((q) => q.payload && col in q.payload);
const sentToRimpl = (i = 0) => mockRimplChat.mock.calls[i][0];

describe('chat_router_enabled → router_enabled', () => {
  test('setting ON: rimpl is told router_enabled: true', async () => {
    mockRimplChat.mockResolvedValue(body());
    expect((await send()).status).toBe(200);
    expect(sentToRimpl().router_enabled).toBe(true);
  });

  test('setting OFF, and setting ABSENT (no row, the default): router_enabled: false', async () => {
    mockRimplChat.mockResolvedValue(body({ middleware_flags: { ...FLAGS, tier: null } }));
    settings.chat_router_enabled = 0;
    await send();
    delete settings.chat_router_enabled;
    await send();
    expect(mockRimplChat.mock.calls.map((c) => c[0].router_enabled)).toEqual([false, false]);
  });
});

describe('sticky deep mode (ples.deep_mode_at)', () => {
  test('deep_mode is forwarded from the latch: null → false, a timestamp → true', async () => {
    mockRimplChat.mockResolvedValue(body());
    await send();
    pleRow.deep_mode_at = '2026-10-15T01:02:03Z';
    await send();
    expect(mockRimplChat.mock.calls.map((c) => c[0].deep_mode)).toEqual([false, true]);
  });

  test('the first deep turn latches it ONCE: set-once write (eq id + is deep_mode_at null)', async () => {
    mockRimplChat.mockResolvedValue(deep());
    expect((await send()).status).toBe(200);
    const l = latches();
    expect(l).toHaveLength(1);
    expect(Object.keys(l[0].payload)).toEqual(['deep_mode_at']);
    expect(Number.isNaN(Date.parse(l[0].payload.deep_mode_at))).toBe(false);
    expect(l[0].eqs).toEqual([['id', 'ple1']]);
    expect(l[0].iss).toEqual([['deep_mode_at', null]]);
  });

  test('a fast turn, and a turn with no tier (router off / older rimpl), never latch', async () => {
    mockRimplChat.mockResolvedValueOnce(body());
    await send();
    mockRimplChat.mockResolvedValueOnce(body({ middleware_flags: { ...FLAGS, tier: null } }));
    await send();
    mockRimplChat.mockResolvedValueOnce(body({ middleware_flags: undefined }));
    await send();
    expect(latches()).toHaveLength(0);
  });

  test('routed deep but NOT applied (thinking null: the provider cannot think) never latches', async () => {
    mockRimplChat.mockResolvedValue(body({ middleware_flags: { ...FLAGS, tier: 'deep', reason: 'dosing', thinking: null, thinking_budget: null } }));
    expect((await send()).status).toBe(200);
    expect(latches()).toHaveLength(0);
  });

  test('already latched: a later deep turn is sent deep_mode: true and never re-sets the stamp', async () => {
    pleRow.deep_mode_at = '2026-10-15T01:02:03Z';
    mockRimplChat.mockResolvedValue(deep());
    expect((await send()).status).toBe(200);
    expect(sentToRimpl().deep_mode).toBe(true);
    expect(latches()).toHaveLength(0);
  });

  test('the latch rides on its own write, never on the counters update (a missing column must not cost the counters)', async () => {
    mockRimplChat.mockResolvedValue(deep());
    await send();
    const counters = m.all('ples', 'update').find((q) => q.payload && 'turn_count' in q.payload);
    expect(counters.payload).not.toHaveProperty('deep_mode_at');
  });

  test('UNMIGRATED (no deep_mode_at column): the turn works, deep_mode is false, the failed latch is logged once (throttled)', async () => {
    migrated = false;
    mockRimplChat.mockResolvedValue(deep());
    const r1 = await send();
    const r2 = await send();
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(mockRimplChat.mock.calls.map((c) => c[0].deep_mode)).toEqual([false, false]);
    // Nothing selected the column by name (that select would have failed the whole PLE read).
    expect(m.all('ples').filter((q) => /deep_mode_at/.test(String(q.selectArgs?.[0] ?? '')))).toHaveLength(0);
    expect(latches()).toHaveLength(2);   // tried on each deep turn…
    const logged = errSpy.mock.calls.filter((c) => /ples\.deep_mode_at missing.*migration-chat-turn-flags\.sql/.test(String(c[0])));
    expect(logged).toHaveLength(1);      // …said once
  });

  test('a latch write that fails for another reason is logged and the turn still answers 200', async () => {
    const resolve = m.state.resolve;
    m.state.resolve = (table, kind, ctx) => (table === 'ples' && kind === 'update' && 'deep_mode_at' in (ctx.payload || {}))
      ? { data: null, error: { code: '57014', message: 'statement timeout' } } : resolve(table, kind, ctx);
    mockRimplChat.mockResolvedValue(deep());
    const r = await send();
    expect(r.status).toBe(200);
    expect(errSpy.mock.calls.some((c) => /could not latch deep mode on PLE ple1: statement timeout/.test(String(c[0])))).toBe(true);
  });
});

describe('middleware_flags: whitelisted, stored on the assistant row', () => {
  const ALL_NULL = { router_version: null, tier: null, reason: null, thinking: null, thinking_budget: null, evidence_level: null, failed_over_from: null };

  test('sanitize keeps exactly the seven keys and drops anything shaped wrong', () => {
    expect(FLAG_KEYS).toEqual(['router_version', 'tier', 'reason', 'thinking', 'thinking_budget', 'evidence_level', 'failed_over_from']);
    const out = sanitizeMiddlewareFlags({
      router_version: ROUTER_V, tier: 'deep', reason: 'dosing', thinking: true, thinking_budget: 4096,
      evidence_level: 'moderate', failed_over_from: 'local-tutor',
      provider: 'anthropic', transcript: 'the whole conversation', __proto__: { tier: 'x' },
    });
    expect(out).toEqual({ router_version: ROUTER_V, tier: 'deep', reason: 'dosing', thinking: true, thinking_budget: 4096, evidence_level: 'moderate', failed_over_from: 'local-tutor' });
    expect(sanitizeMiddlewareFlags({
      router_version: { v: 1 }, tier: 'ultra', reason: ['a'], thinking: 'yes', thinking_budget: 1.5,
      evidence_level: 'x'.repeat(201), failed_over_from: 7,
    })).toEqual(ALL_NULL);
    expect(sanitizeMiddlewareFlags({ router_version: 2, thinking_budget: -1 })).toMatchObject({ router_version: null, thinking_budget: null });
    for (const v of [null, undefined, 'flags', 42, ['tier', 'deep']]) expect(sanitizeMiddlewareFlags(v)).toBeNull();
  });

  test('every string field is ENUMERATED: the real values pass, anything else is NULL', () => {
    const one = (k, v) => sanitizeMiddlewareFlags({ [k]: v })[k];
    // router_version: version + 12-hex rules sha, or the bare version of an older rimpl (mid-deploy)
    for (const v of ['router-v1+abcdef012345', 'router-v12+0123456789ab', 'router-v1', 'router-v2']) expect(one('router_version', v)).toBe(v);
    for (const v of ['router-1', 'router-v1+ABCDEF012345', 'router-v1+abcdef01234', 'router-v1+abcdef0123456', 'router-v1+', 'router-v',
      ' router-v1', 'router-v1\n', 'router-v1+abcdef012345 ', 'router-vX', 'v1']) expect(one('router_version', v)).toBeNull();
    // reason: router.js REASONS
    for (const v of ['rescue', 'sticky', 'dosing', 'interaction', 'pregnancy', 'paediatric', 'differential', 'explicit', 'default']) expect(one('reason', v)).toBe(v);
    for (const v of ['short_question', 'complex_case', 'pediatric', 'Dosing', 'dosing ', 'ขนาดยา', 'patient Somchai asked about dosing']) expect(one('reason', v)).toBeNull();
    // evidence_level: post-filter EVIDENCE_LEVELS keys
    for (const v of ['high', 'moderate', 'low', 'expert', 'not_graded']) expect(one('evidence_level', v)).toBe(v);
    for (const v of ['very_low', 'expert_opinion', 'not graded', 'High', 'สูง']) expect(one('evidence_level', v)).toBeNull();
    // failed_over_from: a provider that may serve chat (lib/ai-providers.js AI_PROVIDER_CHOICES.chat)
    for (const v of ['anthropic', 'local', 'local-tutor']) expect(one('failed_over_from', v)).toBe(v);
    for (const v of ['openai', 'claude', 'Anthropic', 'local-tutor ', 'http://10.0.0.5:8000']) expect(one('failed_over_from', v)).toBeNull();
    // tier
    for (const v of ['fast', 'deep']) expect(one('tier', v)).toBe(v);
    for (const v of ['FAST', 'medium', '']) expect(one('tier', v)).toBeNull();
  });

  test('the provider list IS the backend\'s chat-provider list, not a copy', () => {
    const { AI_PROVIDER_CHOICES } = require('../src/lib/ai-providers');
    const { CHAT_PROVIDERS } = require('../src/services/middleware-flags');
    expect([...CHAT_PROVIDERS].sort()).toEqual([...AI_PROVIDER_CHOICES.chat].sort());
  });

  test('a turn whose flags carry unknown values stores them as NULL (not dropped wholesale, not stored raw)', async () => {
    mockRimplChat.mockResolvedValue(body({ middleware_flags: { ...FLAGS, reason: 'free text from the conversation', router_version: 'router-v9' } }));
    await send();
    expect(rpcCalls[0].p_middleware_flags).toEqual({ ...FLAGS, reason: null, router_version: 'router-v9' });
    mockRimplChat.mockResolvedValue(body({ middleware_flags: { ...FLAGS, reason: 'nope', router_version: 'r1' } }));
    await send();
    expect(rpcCalls[1].p_middleware_flags).toEqual({ ...FLAGS, reason: null, router_version: null });
  });

  test('passed to store_chat_turn as p_middleware_flags (whitelisted), in ONE call; no separate write', async () => {
    mockRimplChat.mockResolvedValue(deep({ middleware_flags: { ...deep().middleware_flags, provider_secret: 'x', nested: { a: 1 } } }));
    expect((await send()).status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(Object.keys(rpcCalls[0]).sort()).toEqual([...OLD_PARAMS, ...NEW_PARAMS].sort());
    expect(rpcCalls[0].p_middleware_flags).toEqual({
      router_version: ROUTER_V, tier: 'deep', reason: 'dosing', thinking: true, thinking_budget: 4096, evidence_level: null, failed_over_from: null,
    });
    expect(msgUpdates('middleware_flags')).toHaveLength(0);
    expect(m.all('messages', 'insert')).toHaveLength(0);
  });

  test('an older rimpl (no middleware_flags): p_middleware_flags is NULL and nothing else is written', async () => {
    mockRimplChat.mockResolvedValue(body({ middleware_flags: undefined }));
    await send();
    expect(rpcCalls[0].p_middleware_flags).toBeNull();
    expect(msgUpdates('middleware_flags')).toHaveLength(0);
  });

  test('never sent to the physician: the response is the unchanged whitelist (JSON and the streamed `done`)', async () => {
    const keys = ['content', 'input_tokens', 'message_id', 'output_tokens', 'refs', 'socratic_question', 'token_count', 'transcript'].sort();
    mockRimplChat.mockResolvedValue(deep());
    const r = await send();
    expect(Object.keys(r.body).sort()).toEqual(keys);
    settings.chat_streaming = 1;
    mockRimplChat.mockImplementation(streams([['delta', { text: 'Amoxicillin' }]], deep()));
    const s = await send({ stream: true });
    expect(Object.keys(parseSse(s.text).at(-1).data.body).sort()).toEqual(keys);
  });
});

describe('the superseded draft on the atomic path', () => {
  const draftTurn = (reason) => streams(
    [['delta', { text: 'no cite' }], ['replace', { reason }], ['delta', { text: 'Amoxicillin 1 g tds (BTS, 2019).' }]],
    body({ superseded_draft: 'no cite', superseded_reason: reason }));
  beforeEach(() => { settings.chat_streaming = 1; });

  test('stored by store_chat_turn itself — the route does NOT also write it (no double write)', async () => {
    mockRimplChat.mockImplementation(draftTurn('evidence'));
    expect((await send({ stream: true })).status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({ p_superseded_draft: 'no cite', p_superseded_reason: 'evidence', p_middleware_flags: FLAGS });
    expect(msgUpdates('superseded_draft')).toHaveLength(0);
    expect(msgUpdates('middleware_flags')).toHaveLength(0);
  });

  test('a reason the constraint does not know is sent as NULL; the draft still travels', async () => {
    mockRimplChat.mockImplementation(draftTurn('tone'));
    await send({ stream: true });
    expect(rpcCalls[0]).toMatchObject({ p_superseded_draft: 'no cite', p_superseded_reason: null });
  });

  test('no draft → no reason, even if rimpl names one', async () => {
    mockRimplChat.mockResolvedValue(body({ superseded_reason: 'citation' }));
    settings.chat_streaming = 0;
    await send();
    expect(rpcCalls[0]).toMatchObject({ p_superseded_draft: null, p_superseded_reason: null });
  });

  test('23514 on the reason (code ahead of the constraint): the turn is stored again with reason NULL, never lost', async () => {
    rpcHook = (a) => (a.p_superseded_reason != null
      ? { data: null, error: { code: '23514', message: 'new row for relation "messages" violates check constraint "messages_superseded_reason_check"' } } : null);
    mockRimplChat.mockImplementation(draftTurn('citation'));
    const r = await send({ stream: true });
    expect(parseSse(r.text).at(-1).data.status).toBe(200);
    expect(rpcCalls.map((a) => a.p_superseded_reason)).toEqual(['citation', null]);
    expect(rpcCalls[1].p_superseded_draft).toBe('no cite');
    expect(msgUpdates('superseded_draft')).toHaveLength(0);
  });
});

describe('code before migration-chat-turn-flags.sql: the old store_chat_turn signature', () => {
  beforeEach(() => { dbShape = 'v1'; migrated = false; settings.chat_streaming = 1; });

  test('missing new signature → ONE retry with exactly the old params, then the draft written the old way', async () => {
    mockRimplChat.mockImplementation(streams(
      [['delta', { text: 'no cite' }], ['replace', { reason: 'citation' }], ['delta', { text: 'Amoxicillin 1 g tds (BTS, 2019).' }]],
      deep({ superseded_draft: 'no cite', superseded_reason: 'citation' })));
    const r = await send({ stream: true });
    expect(parseSse(r.text).at(-1).data.status).toBe(200);
    expect(rpcCalls).toHaveLength(2);
    expect(Object.keys(rpcCalls[1]).sort()).toEqual([...OLD_PARAMS].sort());
    expect(m.all('messages', 'insert')).toHaveLength(0);   // stored by the old function, not the fallback
    const draft = msgUpdates('superseded_draft');
    expect(draft).toHaveLength(1);
    expect(draft[0].payload).toEqual({ superseded_draft: 'no cite', superseded_reason: 'citation' });
    expect(draft[0].eqs).toEqual(expect.arrayContaining([['id', ASSISTANT_ID], ['role', 'assistant']]));
    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /store_chat_turn has only its old 12-param signature.*migration-chat-turn-flags\.sql.*Turns go through the old signature/.test(l))).toBe(true);
    expect(lines.some((l) => /missing in BOTH signatures|two separate inserts/.test(l))).toBe(false);
  });

  test('the flags are tried as their own update and skipped, logged once, while the column is missing', async () => {
    mockRimplChat.mockResolvedValue(deep());
    settings.chat_streaming = 0;
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const fl = msgUpdates('middleware_flags');
    expect(fl).toHaveLength(2);
    expect(fl[0].payload).toEqual({ middleware_flags: deep().middleware_flags });
    expect(fl[0].eqs).toEqual(expect.arrayContaining([['id', ASSISTANT_ID], ['role', 'assistant']]));
    expect(errSpy.mock.calls.filter((c) => /messages\.middleware_flags missing/.test(String(c[0])))).toHaveLength(1);
  });

  test('columns migrated but PostgREST still serving the old signature: the flags land by the separate update', async () => {
    migrated = true;
    mockRimplChat.mockResolvedValue(body());
    settings.chat_streaming = 0;
    await send();
    expect(rpcCalls).toHaveLength(2);
    expect(msgUpdates('middleware_flags').map((q) => q.payload)).toEqual([{ middleware_flags: FLAGS }]);
    expect(errSpy.mock.calls.some((c) => /messages\.middleware_flags missing/.test(String(c[0])))).toBe(false);
  });
});

describe('no store_chat_turn at all: the two-insert fallback', () => {
  beforeEach(() => { dbShape = 'none'; migrated = false; });

  test('keeps working; the assistant INSERT names no new column; flags and draft are tolerant separate writes', async () => {
    settings.chat_streaming = 1;
    mockRimplChat.mockImplementation(streams(
      [['delta', { text: 'draft' }], ['replace', { reason: 'evidence' }], ['delta', { text: 'Amoxicillin 1 g tds (BTS, 2019).' }]],
      deep({ superseded_draft: 'draft', superseded_reason: 'evidence' })));
    const r = await send({ stream: true });
    expect(parseSse(r.text).at(-1).data.status).toBe(200);
    expect(rpcCalls).toHaveLength(2);    // the new signature, then the old: both missing
    const inserts = m.all('messages', 'insert').map((q) => q.payload);
    expect(inserts.map((p) => p.role)).toEqual(['physician', 'assistant']);
    for (const p of inserts) for (const k of ['middleware_flags', 'superseded_draft', 'superseded_reason']) expect(p).not.toHaveProperty(k);
    expect(msgUpdates('superseded_draft').map((q) => q.payload)).toEqual([{ superseded_draft: 'draft', superseded_reason: 'evidence' }]);
    expect(msgUpdates('middleware_flags')).toHaveLength(1);   // tried; the column is missing → skipped, logged
    expect(errSpy.mock.calls.some((c) => /messages\.middleware_flags missing/.test(String(c[0])))).toBe(true);
  });

  test('the log names THIS path: no function in either signature, two inserts — never "the old signature"', async () => {
    mockRimplChat.mockResolvedValue(body());
    await send();
    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /store_chat_turn is missing in BOTH signatures.*two separate inserts/.test(l))).toBe(true);
    expect(lines.some((l) => /old 12-param signature|old signature/.test(l))).toBe(false);
    expect(lines.some((l) => /missing function public\.store_chat_turn\(\) \(store\)/.test(l))).toBe(true);
  });
});

describe('SSE `status` relay', () => {
  beforeEach(() => { settings.chat_streaming = 1; });

  test('relayed as { phase } only; an unknown phase, a phase-less status and an unknown event name are dropped', async () => {
    mockRimplChat.mockImplementation(streams([
      ['status', { phase: 'thinking', tier: 'deep', budget: 4096 }],
      ['status', { phase: 'routing' }],
      ['status', null],
      ['provenance', { provider: 'anthropic' }],
      ['delta', { text: 'Amoxicillin 1 g tds (BTS, 2019).' }],
    ], body()));
    const r = await send({ stream: true });
    const ev = parseSse(r.text);
    expect(ev.map((e) => e.event)).toEqual(['status', 'delta', 'done']);
    expect(ev[0].data).toEqual({ phase: 'thinking' });
    expect(r.text).not.toMatch(/deep|4096|routing|provenance|anthropic/);
  });

  test('status does not touch what the physician was shown (the exposure record is the deltas only)', async () => {
    const err = Object.assign(new Error('RIMPL /chat error: 500'), { status: 500 });
    mockRimplChat.mockImplementation(streams([['status', { phase: 'thinking' }], ['delta', { text: 'Amox' }], ['status', { phase: 'thinking' }]], err));
    await send({ stream: true });
    const ex = m.all('audit_log', 'insert').map((q) => q.payload).find((p) => p.action === 'ple.stream_exposure');
    expect(ex.metadata.shown_text).toBe('Amox');
  });

  test('a status-only failure (thinking, then an error before any text) records no exposure; done carries the error', async () => {
    const busy = Object.assign(new Error('RIMPL /chat error: 503'), { status: 503, code: 'queue_full' });
    mockRimplChat.mockImplementation(streams([['status', { phase: 'thinking' }]], busy));
    const r = await send({ stream: true });
    const ev = parseSse(r.text);
    expect(ev.map((e) => e.event)).toEqual(['status', 'done']);
    expect(ev[1].data.status).toBe(503);
    expect(m.all('audit_log', 'insert').map((q) => q.payload).filter((p) => p.action === 'ple.stream_exposure')).toHaveLength(0);
  });
});

describe('deep_mode_at is never sent to the physician', () => {
  test('GET /ples/:id spreads the row WITHOUT deep_mode_at; the rest of the row is still there', async () => {
    pleRow.deep_mode_at = '2026-10-15T01:02:03Z';
    const r = await auth(request(app).get('/ples/ple1'));
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('deep_mode_at');
    expect(r.body).toMatchObject({ id: 'ple1', status: 'active', chief_complaint: 'cough', messages: [] });
  });

  test('POST /ples (create) returns the inserted row WITHOUT deep_mode_at', async () => {
    const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'cough' });
    expect(r.status).toBe(201);
    expect(m.all('ples', 'insert')).toHaveLength(1);
    expect(r.body).not.toHaveProperty('deep_mode_at');
    expect(r.body).toMatchObject({ id: 'ple1', chief_complaint: 'cough', patient_ref: null });
  });

  test('unmigrated (no such column): GET /ples/:id is unchanged', async () => {
    migrated = false;
    const r = await auth(request(app).get('/ples/ple1'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'ple1' });
    expect(r.body).not.toHaveProperty('deep_mode_at');
  });
});
