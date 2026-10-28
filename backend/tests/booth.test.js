jest.mock('dotenv', () => ({ config: () => ({}) }));
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/services/rimpl-client', () => ({
  ...jest.requireActual('../src/services/rimpl-client'),
  rimplChat: jest.fn(),
  rimplEvaluate: jest.fn(),
}));
jest.mock('../src/lib/usage', () => {
  const actual = jest.requireActual('../src/lib/usage');
  return {
    ...actual,
    accrueUsage: jest.fn(actual.accrueUsage),
    reserveUsage: jest.fn(actual.reserveUsage),
    refundUsage: jest.fn(actual.refundUsage),
  };
});

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { supabase, __mock: m } = require('../src/lib/supabase');
const { rimplChat, rimplEvaluate } = require('../src/services/rimpl-client');
const usage = require('../src/lib/usage');
const app = require('../src/index');

const KASE = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/booth-cases/NFCME-2026.json'), 'utf8'));
const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const SCORE_WRITE_COLUMNS = ['status', 'composite', ...DOMAINS, 'scored_at'];
const RPC_ARG_KEYS = ['p_event', 'p_play', 'p_amount', 'p_ceiling', 'p_delta'];
const BOOTH_RPCS = ['booth_start_play', 'booth_reserve_spend', 'booth_settle_spend'];
const PILOT_TABLES = ['professionals', 'ples', 'messages', 'ai_evaluations', 'lpdp_snapshots', 'shadow_evaluations', 'councils'];
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const usd = (x) => Math.round(x * 1e6) / 1e6;

function eventSettings({ code = 'NFCME-2026', enabled = 1, opensAt = iso(-HOUR), closesAt = iso(HOUR), ceiling = 3 } = {}) {
  return [
    { key: 'booth_event_code', value: 0, value_text: code },
    { key: 'booth_enabled', value: enabled, value_text: null },
    { key: 'booth_opens_at', value: 0, value_text: opensAt },
    { key: 'booth_closes_at', value: 0, value_text: closesAt },
    { key: 'booth_play_ceiling_usd', value: ceiling, value_text: null },
  ];
}

const CLOSED = [
  ['switched off with no window (the seeded state)', 'off', { enabled: 0, opensAt: null, closesAt: null }],
  ['before opens_at', 'not_yet', { opensAt: iso(HOUR), closesAt: iso(2 * HOUR) }],
  ['after closes_at', 'ended', { opensAt: iso(-2 * HOUR), closesAt: iso(-1000) }],
  ['on with no window', 'misconfigured', { opensAt: null, closesAt: null }],
  ['on with closes_at before opens_at', 'misconfigured', { opensAt: iso(HOUR), closesAt: iso(-HOUR) }],
  ['on with a time that has no offset', 'misconfigured', { opensAt: '2026-01-01T08:00:00' }],
  ['on with a ceiling of 0', 'misconfigured', { ceiling: 0 }],
  ['on with no case file for the code', 'misconfigured', { code: 'NOPE-2026' }],
  ['on with a code that is not a file name', 'misconfigured', { code: '../booth-cases/NFCME-2026' }],
];

let plays;
let settings;
let rpcCalls;
let rpcOverride;
let afterReserve;

const matches = (row, ctx) => ctx.eqs.every(([c, v]) => row[c] === v)
  && ctx.iss.every(([c, v]) => (v === null ? row[c] == null : row[c] === v));

function scoreComplete(r) {
  const scored = r.status === 'scored';
  return scored === (r.composite != null) && scored === (r.scored_at != null)
    && DOMAINS.filter((k) => r[k] != null).length === (scored ? 7 : 0);
}

function seedPlay(over = {}) {
  const row = {
    id: crypto.randomUUID(), event_code: 'NFCME-2026', tag: plays.size + 1, status: 'started', spend_usd: 0,
    composite: null, ...Object.fromEntries(DOMAINS.map((k) => [k, null])), created_at: iso(0), scored_at: null, ...over,
  };
  plays.set(row.id, row);
  return row;
}
const SCORED = { status: 'scored', composite: 59, d1: 3, d2: 4, d3: 3, d4: 2, d5: 3, d6: 2, d7: 3, scored_at: iso(-60_000) };

function fakeRpc(name, args) {
  rpcCalls.push([name, args]);
  if (rpcOverride[name]) return rpcOverride[name](args);
  if (name === 'booth_start_play') {
    const tags = [...plays.values()].filter((p) => p.event_code === args.p_event).map((p) => p.tag);
    const row = seedPlay({ event_code: args.p_event, tag: Math.max(0, ...tags) + 1 });
    return { data: [{ play_id: row.id, play_tag: row.tag }], error: null };
  }
  if (name === 'booth_reserve_spend') {
    const p = plays.get(args.p_play);
    let outcome;
    if (p && p.event_code === args.p_event && p.status === 'started') {
      if (usd(p.spend_usd + args.p_amount) <= args.p_ceiling) { p.spend_usd = usd(p.spend_usd + args.p_amount); outcome = 'reserved'; }
      else { p.status = 'unavailable'; outcome = 'ceiling'; }
    } else {
      outcome = p && p.event_code === args.p_event ? 'not_started' : 'not_found';
    }
    if (afterReserve) afterReserve(p);
    return { data: outcome, error: null };
  }
  if (name === 'booth_settle_spend') {
    const p = plays.get(args.p_play);
    if (p) p.spend_usd = usd(p.spend_usd + args.p_delta);
    return { data: null, error: null };
  }
  return { data: null, error: null };
}

function resolve(table, kind, ctx) {
  if (table === 'app_settings' && kind === 'list') {
    if (settings.error) return { data: null, error: settings.error };
    const keys = (ctx.ins.find(([c]) => c === 'key') || [])[1] || [];
    return settings.rows.filter((r) => keys.includes(r.key));
  }
  if (table === 'booth_plays' && kind === 'maybeSingle') {
    const row = [...plays.values()].find((r) => matches(r, ctx));
    return row ? { ...row } : null;
  }
  if (table === 'booth_plays' && kind === 'update') {
    const hits = [...plays.values()].filter((r) => matches(r, ctx));
    for (const r of hits) {
      const next = { ...r, ...ctx.payload };
      if (!scoreComplete(next)) return { data: null, error: { code: '23514', message: 'booth_plays_score_complete' } };
      plays.set(r.id, next);
    }
    return hits.map((r) => ({ id: r.id }));
  }
  return undefined;
}

let ipSeq = 0;
let ip;
const get = (p) => request(app).get(p).set('X-Forwarded-For', ip);
const post = (p, body) => request(app).post(p).set('X-Forwarded-For', ip).send(body);

const CHAT_OK = { content: 'AI reply', refs: [], token_count: 0, input_tokens: 3000, output_tokens: 200,
  provider: 'anthropic', model: 'claude-x', prompt_version: 'chat-prompt-abcd1234', failed_over_from: null };
const EVAL_OK = { ple_id: 'x', d1: 3, d2: 4, d3: 3, d4: 2, d5: 3, d6: 2, d7: 3, composite_score: 99,
  input_tokens: 20000, output_tokens: 2000, provider: 'anthropic' };

beforeEach(() => {
  ip = `10.${Math.floor(ipSeq / 250)}.${ipSeq % 250}.7`;
  ipSeq += 1;
  m.reset();
  m.state.resolve = resolve;
  supabase.rpc = async (name, args) => fakeRpc(name, args);
  plays = new Map();
  settings = { rows: eventSettings() };
  rpcCalls = [];
  rpcOverride = {};
  afterReserve = null;
  jest.clearAllMocks();
  rimplChat.mockImplementation(async () => ({ ...CHAT_OK }));
  rimplEvaluate.mockImplementation(async () => ({ ...EVAL_OK }));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => console.warn.mockRestore());

const picked = (i, id) => {
  const o = KASE.steps[i].options.find((x) => x.id === id);
  return `${o.label.th}: ${o.line.th}`;
};
const physicianTurn = (i, said) => ({
  role: 'physician', content: `${i === 0 ? `${KASE.vignette.th}\n\n` : ''}${KASE.steps[i].question.th}\n${said}`,
});
const aiTurn = (content) => ({ role: 'assistant', content });
const FULL = { answers: [{ choice: 'a' }, { choice: 'a' }, { choice: 'a' }], replies: ['r1', 'r2', 'r3'] };
const ROUTES = [
  ['/booth/plays', () => ({})],
  ['/booth/plays/:id/reply', () => ({ answers: [{ choice: 'a' }], replies: [] })],
  ['/booth/plays/:id/score', () => FULL],
];
const writes = () => m.state.queries.filter((q) => q.op !== 'select');
const rpcNamed = (name) => rpcCalls.filter(([n]) => n === name).map(([, a]) => a);

describe('GET /booth/status', () => {
  test('an open event answers 200 open with its code and case version, and is never cached', async () => {
    const res = await get('/booth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ open: true, event_code: 'NFCME-2026', case_version: KASE.version });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test.each(CLOSED)('%s answers 200 open:false with reason %s', async (_name, reason, over) => {
    settings = { rows: eventSettings(over) };
    const res = await get('/booth/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ open: false, reason });
  });

  test('a settings read error answers 503 unavailable, never open', async () => {
    settings = { error: { message: 'connection reset' } };
    const res = await get('/booth/status');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: expect.any(String), reason: 'unavailable' });
  });
});

describe.each(ROUTES)('POST %s while closed', (route, body) => {
  test.each(CLOSED)('%s answers 403 closed and calls neither the database functions nor rimpl', async (_name, _reason, over) => {
    settings = { rows: eventSettings(over) };
    const play = seedPlay();
    const res = await post(route.replace(':id', play.id), body());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: expect.any(String), reason: 'closed' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(rpcCalls).toEqual([]);
    expect(m.all('booth_plays')).toEqual([]);
    expect(rimplChat).not.toHaveBeenCalled();
    expect(rimplEvaluate).not.toHaveBeenCalled();
  });

  test('a settings read error answers 503 and starts nothing', async () => {
    settings = { error: { message: 'connection reset' } };
    const play = seedPlay();
    const res = await post(route.replace(':id', play.id), body());
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('unavailable');
    expect(rpcCalls).toEqual([]);
    expect(rimplChat).not.toHaveBeenCalled();
    expect(rimplEvaluate).not.toHaveBeenCalled();
  });
});

describe('POST /booth/plays', () => {
  test('answers 201 with the play id and tag from booth_start_play\'s first row, the case file and the answer bound', async () => {
    const playId = crypto.randomUUID();
    rpcOverride.booth_start_play = () => ({ data: [{ play_id: playId, play_tag: 42 }], error: null });
    const res = await post('/booth/plays', {});
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ play_id: playId, tag: 42, case: KASE, answer_max_chars: 500 });
    expect(rpcCalls).toEqual([['booth_start_play', { p_event: 'NFCME-2026' }]]);
  });

  test.each([
    ['an error', () => ({ data: null, error: { message: 'deadlock detected' } })],
    ['no row', () => ({ data: [], error: null })],
  ])('booth_start_play returning %s answers 503', async (_name, rpc) => {
    rpcOverride.booth_start_play = rpc;
    const res = await post('/booth/plays', {});
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('unavailable');
  });
});

describe('POST /booth/plays/:id/reply', () => {
  test('step 1 sends the vignette, the question and the tapped option\'s Thai label and line in booth mode, capped at 30 s', async () => {
    const play = seedPlay();
    const res = await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'b' }], replies: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'replied', reply: 'AI reply' });
    expect(rimplChat.mock.calls).toEqual([[{
      ple_id: play.id, history: [], message: physicianTurn(0, picked(0, 'b')).content, language: 'th',
      booth_mode: true,
    }, { timeoutMs: 30000 }]]);
  });

  test('step 3 sends the earlier turns as history in order, typed text as written', async () => {
    const play = seedPlay();
    const typed = 'my own words\nsecond line';
    const res = await post(`/booth/plays/${play.id}/reply`, {
      answers: [{ choice: 'a' }, { text: typed }, { choice: 'c' }], replies: ['r1', 'r2'],
    });
    expect(res.status).toBe(200);
    const [args] = rimplChat.mock.calls[0];
    expect(args.history).toEqual([physicianTurn(0, picked(0, 'a')), aiTurn('r1'), physicianTurn(1, typed), aiTurn('r2')]);
    expect(args.message).toBe(physicianTurn(2, picked(2, 'c')).content);
  });

  test('an empty reply from an earlier step is left out of the history', async () => {
    const play = seedPlay();
    await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }, { choice: 'b' }, { choice: 'c' }], replies: ['', 'r2'] });
    expect(rimplChat.mock.calls[0][0].history).toEqual([physicianTurn(0, picked(0, 'a')), physicianTurn(1, picked(1, 'b')), aiTurn('r2')]);
  });

  test('a reply over 1200 characters is clipped to 1200, so the kiosk can send it back on the next step', async () => {
    rimplChat.mockImplementation(async () => ({ ...CHAT_OK, content: 'ก'.repeat(5000) }));
    const play = seedPlay();
    const first = await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }], replies: [] });
    expect(first.body.reply).toBe('ก'.repeat(1200));
    const second = await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }, { choice: 'a' }], replies: [first.body.reply] });
    expect(second.status).toBe(200);
  });

  test('the call reserves 0.05 against the ceiling, then settles to the tokens rimpl reports, priced by provider', async () => {
    const play = seedPlay();
    await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }], replies: [] });
    expect(rpcNamed('booth_reserve_spend')).toEqual([{ p_play: play.id, p_event: 'NFCME-2026', p_amount: 0.05, p_ceiling: 3 }]);
    expect(rpcNamed('booth_settle_spend')).toEqual([{ p_play: play.id, p_delta: expect.closeTo(0.012 - 0.05, 9) }]);
    expect(plays.get(play.id).spend_usd).toBeCloseTo(0.012, 9);

    rimplChat.mockImplementation(async () => ({ ...CHAT_OK, provider: 'local' }));
    await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }, { choice: 'a' }], replies: ['AI reply'] });
    expect(plays.get(play.id).spend_usd).toBeCloseTo(0.012, 9);
  });

  test('a 500-character typed answer is accepted', async () => {
    const play = seedPlay();
    const res = await post(`/booth/plays/${play.id}/reply`, { answers: [{ text: 'x'.repeat(500) }], replies: [] });
    expect(res.status).toBe(200);
  });

  test.each([
    ['an unknown option id', { answers: [{ choice: 'd' }], replies: [] }],
    ['a typed answer over 500 characters', { answers: [{ text: 'x'.repeat(501) }], replies: [] }],
    ['a typed answer of spaces only', { answers: [{ text: '   ' }], replies: [] }],
    ['both a choice and text', { answers: [{ choice: 'a', text: 'hi' }], replies: [] }],
    ['a reply count that is not answers - 1', { answers: [{ choice: 'a' }, { choice: 'a' }], replies: [] }],
    ['a fourth answer', { answers: [{ choice: 'a' }, { choice: 'a' }, { choice: 'a' }, { choice: 'a' }], replies: ['', '', ''] }],
    ['an echoed reply over 1200 characters', { answers: [{ choice: 'a' }, { choice: 'a' }], replies: ['x'.repeat(1201)] }],
    ['an extra field', { answers: [{ choice: 'a' }], replies: [], step: 1 }],
    ['no body', undefined],
  ])('%s answers 400 bad_request before any spend', async (_name, body) => {
    const play = seedPlay();
    const res = await post(`/booth/plays/${play.id}/reply`, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), reason: 'bad_request' });
    expect(rpcCalls).toEqual([]);
    expect(rimplChat).not.toHaveBeenCalled();
  });

  test('an unknown play answers 404, and a malformed id answers 404 without reaching the database', async () => {
    const unknown = await post(`/booth/plays/${crypto.randomUUID()}/reply`, { answers: [{ choice: 'a' }], replies: [] });
    expect(unknown.status).toBe(404);
    expect(unknown.body.reason).toBe('not_found');
    rpcCalls = [];
    const malformed = await post('/booth/plays/not-a-uuid/reply', { answers: [{ choice: 'a' }], replies: [] });
    expect(malformed.status).toBe(404);
    expect(malformed.body.reason).toBe('not_found');
    expect(rpcCalls).toEqual([]);
    expect(rimplChat).not.toHaveBeenCalled();
  });

  test.each([
    ['scored', SCORED],
    ['unavailable', { status: 'unavailable' }],
    ['abandoned', { status: 'abandoned' }],
  ])('a %s play answers 409 not_started', async (_name, over) => {
    const play = seedPlay(over);
    const res = await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }], replies: [] });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('not_started');
    expect(rimplChat).not.toHaveBeenCalled();
  });

  test('a rimpl failure answers 502 ai_unavailable, keeps the reservation, and the next step still goes on', async () => {
    rimplChat.mockRejectedValueOnce(Object.assign(new Error('RIMPL /chat error: 503'), { status: 503 }));
    const play = seedPlay();
    const failed = await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }], replies: [] });
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ error: expect.any(String), reason: 'ai_unavailable' });
    expect(rpcNamed('booth_settle_spend')).toEqual([]);
    expect(plays.get(play.id)).toMatchObject({ status: 'started', spend_usd: 0.05 });

    const next = await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }, { choice: 'b' }], replies: [''] });
    expect(next.status).toBe(200);
  });

  test('an empty AI reply answers 502 ai_unavailable after the call is priced', async () => {
    rimplChat.mockImplementation(async () => ({ ...CHAT_OK, content: '  ' }));
    const play = seedPlay();
    const res = await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }], replies: [] });
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe('ai_unavailable');
    expect(plays.get(play.id).spend_usd).toBeCloseTo(0.012, 9);
  });
});

describe('the per-play ceiling', () => {
  test('with 2.97 of 3.00 spent a reply is refused before rimpl: 200 unavailable, and the play ends unavailable', async () => {
    const play = seedPlay({ spend_usd: 2.97 });
    const res = await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }], replies: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unavailable' });
    expect(rimplChat).not.toHaveBeenCalled();
    expect(plays.get(play.id)).toMatchObject({ status: 'unavailable', spend_usd: 2.97 });
  });

  test('the ceiling is booth_play_ceiling_usd: at 0.10, the third reply of a play whose replies cost 0.045 is refused', async () => {
    settings = { rows: eventSettings({ ceiling: 0.1 }) };
    rimplChat.mockImplementation(async () => ({ ...CHAT_OK, input_tokens: 10000, output_tokens: 1000 }));
    const play = seedPlay();
    const statuses = [];
    for (const n of [1, 2, 3]) {
      const res = await post(`/booth/plays/${play.id}/reply`, {
        answers: Array.from({ length: n }, () => ({ choice: 'a' })), replies: Array.from({ length: n - 1 }, () => 'AI reply'),
      });
      statuses.push(res.body.status);
    }
    expect(statuses).toEqual(['replied', 'replied', 'unavailable']);
    expect(rimplChat).toHaveBeenCalledTimes(2);
    expect(rpcNamed('booth_reserve_spend').map((a) => a.p_ceiling)).toEqual([0.1, 0.1, 0.1]);
  });

  test('the score reserves 0.30 against the same ceiling: over it the evaluator is not called and the play ends unavailable', async () => {
    const play = seedPlay({ spend_usd: 2.8 });
    const res = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unavailable' });
    expect(rpcNamed('booth_reserve_spend')).toEqual([{ p_play: play.id, p_event: 'NFCME-2026', p_amount: 0.3, p_ceiling: 3 }]);
    expect(rimplEvaluate).not.toHaveBeenCalled();
    expect(plays.get(play.id)).toMatchObject({ status: 'unavailable', composite: null });
  });

  test('after a ceiling refusal, a reply answers 409 and a score answers 200 unavailable', async () => {
    const play = seedPlay({ spend_usd: 2.97 });
    await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }], replies: [] });
    const reply = await post(`/booth/plays/${play.id}/reply`, { answers: [{ choice: 'a' }, { choice: 'a' }], replies: [''] });
    expect(reply.status).toBe(409);
    const score = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(score.status).toBe(200);
    expect(score.body).toEqual({ status: 'unavailable' });
    expect(rimplEvaluate).not.toHaveBeenCalled();
  });
});

describe('POST /booth/plays/:id/score', () => {
  test('calls the evaluator once with the six-turn transcript, shadow false and a 60 s cap', async () => {
    const play = seedPlay();
    const typed = 'ตรวจ CURB-65';
    await post(`/booth/plays/${play.id}/score`, { answers: [{ choice: 'a' }, { choice: 'b' }, { text: typed }], replies: ['r1', 'r2', 'r3'] });
    expect(rimplEvaluate.mock.calls).toEqual([[{
      ple_id: play.id,
      transcript: [physicianTurn(0, picked(0, 'a')), aiTurn('r1'), physicianTurn(1, picked(1, 'b')), aiTurn('r2'),
        physicianTurn(2, typed), aiTurn('r3')],
      patient_ref: null, chief_complaint: KASE.vignette.th, shadow: false,
    }, { timeoutMs: 60000 }]]);
  });

  test('success answers the composite recomputed with the pilot weights and the seven domains, ignoring rimpl\'s composite', async () => {
    const play = seedPlay();
    const res = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'scored', composite: 59, domains: { d1: 3, d2: 4, d3: 3, d4: 2, d5: 3, d6: 2, d7: 3 } });
  });

  test('success claims the play, then stores only status, composite, d1-d7 and scored_at', async () => {
    const play = seedPlay();
    await post(`/booth/plays/${play.id}/score`, FULL);
    const updates = m.all('booth_plays', 'update');
    expect(updates.map((u) => u.payload.status)).toEqual(['unavailable', 'scored']);
    expect(updates[0].eqs).toContainEqual(['status', 'started']);
    expect(Object.keys(updates[0].payload)).toEqual(['status']);
    expect(Object.keys(updates[1].payload).sort()).toEqual([...SCORE_WRITE_COLUMNS].sort());
    expect(plays.get(play.id)).toMatchObject({ status: 'scored', composite: 59, d2: 4, scored_at: expect.any(String) });
  });

  test('the evaluator call is priced and settled against its 0.30 reservation', async () => {
    const play = seedPlay();
    await post(`/booth/plays/${play.id}/score`, FULL);
    expect(rpcNamed('booth_settle_spend')).toEqual([{ p_play: play.id, p_delta: expect.closeTo(0.09 - 0.3, 9) }]);
    expect(plays.get(play.id).spend_usd).toBeCloseTo(0.09, 9);
  });

  test('a 60 s timeout answers 200 unavailable, leaves no score, and keeps the reservation', async () => {
    rimplEvaluate.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    const play = seedPlay();
    const res = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unavailable' });
    expect(plays.get(play.id)).toMatchObject({ status: 'unavailable', composite: null, d1: null, scored_at: null, spend_usd: 0.3 });
    expect(rpcNamed('booth_settle_spend')).toEqual([]);
  });

  test.each([
    ['rimpl 502', () => Promise.reject(Object.assign(new Error('RIMPL /evaluate error: 502'), { status: 502 }))],
    ['rimpl 503 queue full', () => Promise.reject(Object.assign(new Error('RIMPL /evaluate error: 503'), { status: 503 }))],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('%s answers 200 unavailable', async (_name, impl) => {
    rimplEvaluate.mockImplementation(impl);
    const play = seedPlay();
    const res = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unavailable' });
    expect(plays.get(play.id).status).toBe('unavailable');
  });

  test.each([
    ['a domain above 5', { d3: 6 }],
    ['a fractional domain', { d4: 2.5 }],
    ['a missing domain', { d7: undefined }],
    ['a domain sent as text', { d1: '3' }],
  ])('an evaluator body with %s answers 200 unavailable, after the call is priced', async (_name, over) => {
    rimplEvaluate.mockImplementation(async () => ({ ...EVAL_OK, ...over }));
    const play = seedPlay();
    const res = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(res.body).toEqual({ status: 'unavailable' });
    expect(plays.get(play.id)).toMatchObject({ status: 'unavailable', composite: null });
    expect(plays.get(play.id).spend_usd).toBeCloseTo(0.09, 9);
  });

  test('a repeated score answers the stored score with no second evaluator call and no new spend', async () => {
    const play = seedPlay();
    const first = await post(`/booth/plays/${play.id}/score`, FULL);
    const again = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(rimplEvaluate).toHaveBeenCalledTimes(1);
    expect(rpcNamed('booth_reserve_spend')).toHaveLength(1);
  });

  test('a play scored earlier answers its stored row', async () => {
    const play = seedPlay({ ...SCORED, composite: 71.5, d1: 5 });
    const res = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(res.body).toEqual({ status: 'scored', composite: 71.5, domains: { d1: 5, d2: 4, d3: 3, d4: 2, d5: 3, d6: 2, d7: 3 } });
    expect(rimplEvaluate).not.toHaveBeenCalled();
  });

  test.each(['unavailable', 'abandoned'])('a %s play answers 200 unavailable with no reservation and no evaluator call', async (status) => {
    const play = seedPlay({ status });
    const res = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unavailable' });
    expect(rpcCalls).toEqual([]);
    expect(rimplEvaluate).not.toHaveBeenCalled();
  });

  test('an unknown play answers 404', async () => {
    const res = await post(`/booth/plays/${crypto.randomUUID()}/score`, FULL);
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe('not_found');
  });

  test('a play from another event answers 404', async () => {
    const play = seedPlay({ event_code: 'OTHER-2025' });
    const res = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(res.status).toBe(404);
  });

  test('a score whose claim finds the play already taken answers 200 unavailable and never calls the evaluator', async () => {
    const play = seedPlay();
    afterReserve = (p) => { p.status = 'unavailable'; };
    const res = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(res.body).toEqual({ status: 'unavailable' });
    expect(rimplEvaluate).not.toHaveBeenCalled();
  });

  test('a score whose finish matches no row answers unavailable, never a score that is not stored', async () => {
    const play = seedPlay();
    rimplEvaluate.mockImplementation(async () => { plays.delete(play.id); return { ...EVAL_OK }; });
    const res = await post(`/booth/plays/${play.id}/score`, FULL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unavailable' });
  });

  test.each([
    ['two answers', { answers: [{ choice: 'a' }, { choice: 'a' }], replies: ['r1', 'r2'] }],
    ['two replies', { answers: FULL.answers, replies: ['r1', 'r2'] }],
  ])('a score dialogue with %s answers 400', async (_name, body) => {
    const play = seedPlay();
    const res = await post(`/booth/plays/${play.id}/score`, body);
    expect(res.status).toBe(400);
    expect(rimplEvaluate).not.toHaveBeenCalled();
  });
});

describe('write surface (ADR 0004)', () => {
  const ANSWER = 'SENTINEL-ANSWER-7f3a ตอบเอง';
  const REPLY = 'SENTINEL-REPLY-91c2';

  async function wholePlay() {
    rimplChat.mockImplementation(async () => ({ ...CHAT_OK, content: REPLY }));
    const start = await post('/booth/plays', {});
    const id = start.body.play_id;
    const answers = [{ text: ANSWER }, { choice: 'b' }, { choice: 'c' }];
    const statuses = [];
    for (const n of [1, 2, 3]) {
      const res = await post(`/booth/plays/${id}/reply`, { answers: answers.slice(0, n), replies: Array(n - 1).fill(REPLY) });
      statuses.push(res.body.status);
    }
    const score = await post(`/booth/plays/${id}/score`, { answers, replies: Array(3).fill(REPLY) });
    return { start, statuses, score };
  }

  test('a whole play of three replies and a score runs, so the guest 2-prompt cap does not apply', async () => {
    const { start, statuses, score } = await wholePlay();
    expect(start.status).toBe(201);
    expect(statuses).toEqual(['replied', 'replied', 'replied']);
    expect(score.body.status).toBe('scored');
  });

  test('a whole play writes booth_plays only, through the three functions and the score columns', async () => {
    await wholePlay();
    expect(new Set(m.state.queries.map((q) => q.table))).toEqual(new Set(['app_settings', 'booth_plays']));
    expect(writes().length).toBeGreaterThan(0);
    for (const w of writes()) {
      expect(w.table).toBe('booth_plays');
      expect(w.op).toBe('update');
      expect(SCORE_WRITE_COLUMNS).toEqual(expect.arrayContaining(Object.keys(w.payload)));
    }
    expect([...new Set(rpcCalls.map(([n]) => n))].sort()).toEqual([...BOOTH_RPCS].sort());
    for (const [, args] of rpcCalls) expect(RPC_ARG_KEYS).toEqual(expect.arrayContaining(Object.keys(args)));
  });

  test('no answer or reply text reaches any write or function call', async () => {
    await wholePlay();
    const written = JSON.stringify([writes().map((w) => w.payload), rpcCalls]);
    expect(written).not.toContain('SENTINEL');
    expect(rimplChat.mock.calls.at(-1)[0].history.map((t) => t.content).join('\n')).toContain(ANSWER);
  });

  test('no spend reaches professionals or the pool: no usage meter runs, no usage rpc fires, no pilot table is read', async () => {
    await wholePlay();
    expect(usage.accrueUsage).not.toHaveBeenCalled();
    expect(usage.reserveUsage).not.toHaveBeenCalled();
    expect(usage.refundUsage).not.toHaveBeenCalled();
    const names = rpcCalls.map(([n]) => n);
    for (const meter of ['increment_usage', 'reserve_usage', 'total_usage_sum']) expect(names).not.toContain(meter);
    for (const t of PILOT_TABLES) expect(m.all(t)).toEqual([]);
  });
});

describe('rate limits', () => {
  test('the 41st booth request in a minute from one IP answers 429', async () => {
    for (let i = 0; i < 40; i += 1) expect((await get('/booth/status')).status).toBe(200);
    const limited = await get('/booth/status');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: expect.any(String) });
    expect(limited.headers['cache-control']).toBe('no-store');
  });

  test('the 13th call under /booth/plays in a minute answers 429 while /booth/status still answers', async () => {
    for (let i = 0; i < 12; i += 1) expect((await post('/booth/plays', {})).status).toBe(201);
    expect((await post('/booth/plays', {})).status).toBe(429);
    expect((await get('/booth/status')).status).toBe(200);
  });

  test('the guest per-IP limits do not reach /booth, and booth traffic leaves the guest budget alone', async () => {
    for (let i = 0; i < 16; i += 1) expect((await get('/booth/status')).status).toBe(200);
    expect((await post('/guest/start', {})).status).toBe(201);
  });
});
