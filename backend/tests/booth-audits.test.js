jest.mock('dotenv', () => ({ config: () => ({}) }));
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { stamped } = require('./helpers/booth-tree');
const { __mock: m } = require('../src/lib/supabase');
const { stepRecords } = require('../src/services/booth-dialogue');
const { PHYSICIAN, SPECIAL, AUDITOR, AUDITOR_B, ADMIN, SUPERADMIN } = require('./helpers/roles');
const app = require('../src/index');

const TABLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-path-score-table.json'), 'utf8'));
const KASE = { ...JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree.json'), 'utf8')), path_score_table: TABLE };
const CASES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cases-'));
fs.mkdirSync(path.join(CASES_DIR, KASE.event_code));
fs.writeFileSync(path.join(CASES_DIR, KASE.event_code, `${KASE.case_id}.json`), JSON.stringify(stamped(KASE)));
process.env.BOOTH_CASES_DIR = CASES_DIR;
afterAll(() => { delete process.env.BOOTH_CASES_DIR; });

const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const SCORE_COLUMNS = ['composite', ...DOMAINS, 'tier_path', 'score_source', 'tag'];
const SCORE_KEYS = new Set([...SCORE_COLUMNS, 'tier', 'demo', 'audit']);

const B1 = KASE.banks.step1;
const B2 = KASE.banks.step2.R;
const B3 = KASE.banks.step3.RB;
const DEIDENTIFIED = 'ให้ยาปฏิชีวนะ [NAME-1]';
const WALKED = {
  answers: [{ choice: 'c' }, { text: 'ให้ยาปฏิชีวนะ นายสมชาย', tier: 'B', deidentified: DEIDENTIFIED }, { choice: 'd' }],
  replies: [
    { strength: '**ซักประวัติ**ครบ', weigh: 'ควรถามเรื่องยา', safety: '' },
    { strength: 'ดี', weigh: '', safety: 'ระวังภาวะหายใจล้มเหลว' },
    { strength: '', weigh: 'ลองคิดถึงเชื้อดื้อยา', safety: '' },
  ],
  asks: [
    { variant: 'v1', bridge: '', options: ['a', 'c', 'd'] },
    { variant: 'v2', bridge: 'ลองคิดต่ออีกขั้น', options: ['b', 'c', 'd'] },
    { variant: 'v1', bridge: 'ต่อไปเป็นการรักษา', options: ['a', 'c', 'd'] },
  ],
  tierPath: 'RBW',
};
const STEPS = stepRecords(WALKED);

const question = (bank, variant) => bank.variants.find((v) => v.id === variant).question.th;
const said = (bank, id) => { const o = bank.options.find((x) => x.id === id); return `${o.label.th}: ${o.line.th}`; };
const MESSAGES = [
  { role: 'physician', content: `${KASE.vignette.th}\n\n${question(B1, 'v1')}\n${said(B1, 'c')}` },
  { role: 'assistant', content: 'ซักประวัติครบ ควรถามเรื่องยา ลองคิดต่ออีกขั้น' },
  { role: 'physician', content: `${question(B2, 'v2')}\n${DEIDENTIFIED}` },
  { role: 'assistant', content: 'ดี ระวังภาวะหายใจล้มเหลว ต่อไปเป็นการรักษา' },
  { role: 'physician', content: `${question(B3, 'v1')}\n${said(B3, 'd')}` },
  { role: 'assistant', content: 'ลองคิดถึงเชื้อดื้อยา' },
];

const DEMO = { composite: 73.41, d1: 1, d2: 4, d3: 2, d4: 5, d5: 0, d6: 3, d7: 1 };
const CANARIES = ['73.41', 'RBW', 'table', 'best', 'reasonable', 'weaker', '03:12:44'];
const SCORES = { d1: 3, d2: 4, d3: 2, d4: 3, d5: 4, d6: 3, d7: 2 };
const SCORES_COMPOSITE = 62;
const NOW = '2026-11-21T08:00:00.000Z';

let plays;
let audits;
let auditsError;
let insertError;
let staleAuditReads;

function seedPlay(over = {}) {
  const row = {
    id: crypto.randomUUID(), event_code: KASE.event_code, tag: 917, status: 'scored', spend_usd: 0, ...DEMO,
    created_at: '2026-11-20T03:00:00.000Z', scored_at: '2026-11-20T03:12:44.120Z', ranked: true, case_id: KASE.case_id,
    case_version: KASE.version, tier_path: 'RBW', replied_step: 3, steps: STEPS, score_source: 'table', ...over,
  };
  plays.set(row.id, row);
  return row;
}
const seedAudit = (play, auditor) => audits.set(`${play.id}|${auditor.id}`, { play_id: play.id, auditor_id: auditor.id, ...SCORES, created_at: NOW });

const columns = (ctx) => ctx.selectArgs[0].split(',').map((c) => c.trim());
const project = (row, ctx) => (columns(ctx)[0] === '*' ? { ...row } : Object.fromEntries(columns(ctx).map((c) => [c, row[c]])));
const matches = (row, ctx) => ctx.eqs.every(([c, v]) => row[c] === v)
  && ctx.nots.every(([c, op, v]) => op === 'is' && v === null && row[c] != null);
function ordered(rows, ctx) {
  const out = [...rows];
  for (const [col, opts] of [...ctx.orders].reverse()) {
    const dir = opts?.ascending === false ? -1 : 1;
    out.sort((a, b) => (a[col] < b[col] ? -dir : a[col] > b[col] ? dir : 0));
  }
  return ctx.limit == null ? out : out.slice(0, ctx.limit);
}
const answer = (rows, ctx, kind) => {
  const found = ordered(rows.filter((r) => matches(r, ctx)), ctx).map((r) => project(r, ctx));
  return kind === 'list' ? found : found[0] ?? null;
};

function resolve(table, kind, ctx) {
  if (table === 'booth_plays') return answer([...plays.values()], ctx, kind);
  if (table === 'booth_audits' && kind === 'insert') {
    if (insertError) return { error: insertError };
    const key = `${ctx.payload.play_id}|${ctx.payload.auditor_id}`;
    if (audits.has(key)) return { error: { code: '23505', message: 'duplicate key value violates unique constraint "booth_audits_pkey"' } };
    audits.set(key, { ...ctx.payload, created_at: NOW });
    return null;
  }
  if (table === 'booth_audits') {
    if (auditsError) return { data: null, error: auditsError };
    return answer(staleAuditReads ? [] : [...audits.values()], ctx, kind);
  }
  return undefined;
}

const as = (caller) => {
  m.state.caller = caller;
  const auth = (r) => (caller ? r.set('Authorization', 'Bearer t') : r);
  return {
    queue: () => auth(request(app).get('/auditor/booth')),
    study: (id) => auth(request(app).get(`/auditor/booth/${id}`)),
    submit: (id, body = SCORES) => auth(request(app).post(`/auditor/booth/${id}/audit`)).send(body),
  };
};
const listed = (row, audited = false) => ({
  id: row.id, played_on: row.scored_at.slice(0, 10), case: { case_id: KASE.case_id, teaser: KASE.teaser }, audited,
});
const studyPlay = (row) => ({ id: row.id, played_on: row.scored_at.slice(0, 10), case: { case_id: KASE.case_id, teaser: KASE.teaser } });
const boothQueries = () => m.state.queries.filter((q) => q.table.startsWith('booth_'));
const inserts = () => m.state.queries.filter((q) => q.op !== 'select');

function keysOf(value) {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
  return [];
}

beforeEach(() => {
  m.reset();
  m.state.resolve = resolve;
  plays = new Map();
  audits = new Map();
  auditsError = null;
  insertError = null;
  staleAuditReads = false;
});

describe('who may audit', () => {
  const routes = (caller, id) => [as(caller).queue(), as(caller).study(id), as(caller).submit(id)];

  test('no token gets 401 on every route, before any booth read', async () => {
    const play = seedPlay();
    for (const res of await Promise.all(routes(null, play.id))) expect(res.status).toBe(401);
    expect(boothQueries()).toEqual([]);
  });

  test.each([['a physician without audit rights', PHYSICIAN], ['an admin', ADMIN], ['a superadmin', SUPERADMIN]])(
    '%s gets 403 on every route, before any booth read', async (_who, caller) => {
      const play = seedPlay();
      for (const res of await Promise.all(routes(caller, play.id))) {
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Requires role: auditor' });
      }
      expect(boothQueries()).toEqual([]);
    },
  );

  test('an auditor of either council and a physician who can audit get the same cross-council queue', async () => {
    const older = seedPlay({ scored_at: '2026-11-19T01:00:00.000Z' });
    const newer = seedPlay({ scored_at: '2026-11-20T01:00:00.000Z' });
    for (const caller of [AUDITOR, AUDITOR_B, SPECIAL]) {
      const res = await as(caller).queue();
      expect(res.status).toBe(200);
      expect(res.body).toEqual([listed(newer), listed(older)]);
    }
  });

  test('a play is dated by its Bangkok day, never its exact time', async () => {
    const lateUtc = seedPlay({ scored_at: '2026-11-19T18:30:05.000Z' });
    const [item] = (await as(AUDITOR).queue()).body;
    expect(item.played_on).toBe('2026-11-20');
    expect(JSON.stringify(item)).not.toContain('18:30');
    expect((await as(AUDITOR).study(lateUtc.id)).body.play.played_on).toBe('2026-11-20');
  });

  test('an auditor who has not recorded the pilot consent can still submit', async () => {
    const play = seedPlay();
    const res = await as({ ...AUDITOR, consented_at: null }).submit(play.id);
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('revealed');
  });
});

describe('the queue', () => {
  test('lists the scored plays whose transcript rebuilds whole, newest first', async () => {
    const middle = seedPlay({ scored_at: '2026-11-20T02:00:00.000Z' });
    const oldest = seedPlay({ scored_at: '2026-11-20T01:00:00.000Z' });
    const newest = seedPlay({ scored_at: '2026-11-20T03:00:00.000Z' });
    const typedHole = STEPS.map((s, i) => (i === 1 ? { ...s, typed: null } : s));
    const unknownVariant = STEPS.map((s, i) => (i === 2 ? { ...s, variant: 'v9' } : s));
    seedPlay({ status: 'started', composite: null, scored_at: null, steps: null });
    seedPlay({ steps: null, scored_at: '2026-11-20T04:00:00.000Z' });
    seedPlay({ steps: typedHole, scored_at: '2026-11-20T04:00:00.000Z' });
    seedPlay({ case_version: 'not-on-disk', scored_at: '2026-11-20T04:00:00.000Z' });
    seedPlay({ steps: unknownVariant, scored_at: '2026-11-20T04:00:00.000Z' });
    seedPlay({ case_id: 'no-such-case', scored_at: '2026-11-20T04:00:00.000Z' });

    const res = await as(AUDITOR).queue();
    expect(res.status).toBe(200);
    expect(res.body).toEqual([listed(newest), listed(middle), listed(oldest)]);
  });

  test('stops at the 200 newest plays', async () => {
    const at = (i) => new Date(Date.UTC(2026, 10, 20, 0, 0, i)).toISOString();
    const seeded = Array.from({ length: 201 }, (_, i) => seedPlay({ scored_at: at(i) }));
    const res = await as(AUDITOR).queue();
    expect(res.body).toHaveLength(200);
    expect(res.body[0].id).toBe(seeded[200].id);
    expect(res.body.map((p) => p.id)).not.toContain(seeded[0].id);
  });

  test('marks a play audited only by the caller\'s own audit', async () => {
    const theirs = seedPlay({ scored_at: '2026-11-20T02:00:00.000Z' });
    const mine = seedPlay({ scored_at: '2026-11-20T01:00:00.000Z' });
    seedAudit(theirs, AUDITOR_B);
    seedAudit(mine, AUDITOR);
    const res = await as(AUDITOR).queue();
    expect(res.body).toEqual([listed(theirs, false), listed(mine, true)]);
  });

  test('answers 502 when the audits cannot be read', async () => {
    seedPlay();
    auditsError = { code: '42P01', message: 'relation "public.booth_audits" does not exist' };
    const res = await as(AUDITOR).queue();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Could not load the booth case studies — try again' });
  });
});

describe('blinding before the submit', () => {
  test('the queue and a blind study read no score column of the play', async () => {
    const play = seedPlay();
    await as(AUDITOR).queue();
    await as(AUDITOR).study(play.id);
    const reads = m.all('booth_plays', 'select');
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const q of reads) expect(columns(q).filter((c) => SCORE_COLUMNS.includes(c))).toEqual([]);
  });

  test('no score key and no score value reaches the queue or a blind study', async () => {
    const play = seedPlay();
    const bodies = [(await as(AUDITOR).queue()).body, (await as(AUDITOR).study(play.id)).body];
    expect(bodies[0]).toHaveLength(1);
    expect(bodies[1].state).toBe('blind');
    for (const body of bodies) {
      expect(keysOf(body).filter((k) => SCORE_KEYS.has(k))).toEqual([]);
      const text = JSON.stringify(body);
      for (const canary of CANARIES) expect(text).not.toContain(canary);
    }
  });

  test('a blind study is the play and its transcript, unfenced, with the typed answer de-identified', async () => {
    const play = seedPlay();
    const res = await as(AUDITOR).study(play.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'blind', play: studyPlay(play), messages: MESSAGES });
    const text = JSON.stringify(res.body);
    for (const fence of ['⟦', '⟧', 'Typed by the visitor']) expect(text).not.toContain(fence);
  });
});

describe('the submit', () => {
  test.each([
    ['a score above 5', { ...SCORES, d1: 6 }],
    ['a fraction', { ...SCORES, d2: 2.5 }],
    ['a negative score', { ...SCORES, d3: -1 }],
    ['a missing domain', (({ d7, ...rest }) => rest)(SCORES)],
    ['a composite', { ...SCORES, composite: 62 }],
    ['an auditor id', { ...SCORES, auditor_id: AUDITOR_B.id }],
  ])('refuses %s with 400 and writes nothing', async (_name, body) => {
    const play = seedPlay();
    const res = await as(AUDITOR).submit(play.id, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(inserts()).toEqual([]);
  });

  test('a play id that is not a uuid is not found, with no booth read', async () => {
    const res = await as(AUDITOR).submit('not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'booth_study_not_found' });
    expect(boothQueries()).toEqual([]);
  });

  test.each([
    ['an unknown play', () => ({ id: crypto.randomUUID() })],
    ['a play that is not scored', () => seedPlay({ status: 'unavailable' })],
    ['a play whose transcript does not rebuild', () => seedPlay({ steps: STEPS.slice(0, 2) })],
  ])('%s is not found and cannot be audited', async (_name, make) => {
    const play = make();
    const read = await as(AUDITOR).study(play.id);
    const res = await as(AUDITOR).submit(play.id);
    expect([read.status, res.status]).toEqual([404, 404]);
    expect(res.body).toEqual({ error: 'Not found', code: 'booth_study_not_found' });
    expect(inserts()).toEqual([]);
  });

  test('stores exactly the seven scores under the caller, and reveals the demo score', async () => {
    const play = seedPlay();
    const res = await as(AUDITOR).submit(play.id);
    expect(res.status).toBe(201);
    expect(inserts().map((q) => [q.table, q.op, q.payload])).toEqual([
      ['booth_audits', 'insert', { play_id: play.id, auditor_id: AUDITOR.id, ...SCORES }],
    ]);
    expect(res.body).toEqual({
      state: 'revealed', play: studyPlay(play), messages: MESSAGES,
      audit: { ...SCORES, composite: SCORES_COMPOSITE, created_at: NOW },
      demo: DEMO,
    });
  });

  test('a second submit by the same auditor is refused and writes nothing', async () => {
    const play = seedPlay();
    expect((await as(AUDITOR).submit(play.id)).status).toBe(201);
    const again = await as(AUDITOR).submit(play.id, { ...SCORES, d1: 5 });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'Already audited', code: 'booth_already_audited' });
    expect(m.all('booth_audits', 'insert')).toHaveLength(1);
    expect([...audits.values()][0].d1).toBe(SCORES.d1);
  });

  test('a submit that loses the race to the primary key is refused', async () => {
    const play = seedPlay();
    seedAudit(play, AUDITOR);
    staleAuditReads = true;
    const res = await as(AUDITOR).submit(play.id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Already audited', code: 'booth_already_audited' });
  });

  test('any other write error answers 502', async () => {
    const play = seedPlay();
    insertError = { code: '08006', message: 'connection failure' };
    const res = await as(AUDITOR).submit(play.id);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Could not save the audit — try again' });
  });

  test('after the submit the study is revealed to that auditor and stays blind to another', async () => {
    const play = seedPlay();
    await as(AUDITOR).submit(play.id);
    const mine = await as(AUDITOR).study(play.id);
    expect(mine.body).toMatchObject({ state: 'revealed', audit: { ...SCORES, composite: SCORES_COMPOSITE }, demo: DEMO });
    const theirs = await as(AUDITOR_B).study(play.id);
    expect(theirs.body).toEqual({ state: 'blind', play: studyPlay(play), messages: MESSAGES });
  });
});
