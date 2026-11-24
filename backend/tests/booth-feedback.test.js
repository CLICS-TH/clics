// Anonymous booth feedback (ADR 0015): POST /booth/feedback stores one row with a Bangkok date and no time, only while
// the booth is open, and keeps a comment only as rimpl's de-identified copy.
jest.mock('dotenv', () => ({ config: () => ({}) }));
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/lib/audit', () => ({ logEvent: jest.fn(async () => {}), logEventStrict: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/services/rimpl-client', () => ({ ...jest.requireActual('../src/services/rimpl-client'), rimplDeidentify: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { stamped } = require('./helpers/booth-tree');
const { __mock: m } = require('../src/lib/supabase');
const { rimplDeidentify } = require('../src/services/rimpl-client');
const { logEventStrict } = require('../src/lib/audit');
const { SUPERADMIN, ADMIN, AUDITOR, PHYSICIAN } = require('./helpers/roles');
const app = require('../src/index');

const CASES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-feedback-'));
const kase = { ...JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree.json'), 'utf8')), event_code: 'NFCME-2026',
  path_score_table: JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-path-score-table.json'), 'utf8')) };
fs.mkdirSync(path.join(CASES_DIR, 'NFCME-2026'));
fs.writeFileSync(path.join(CASES_DIR, 'NFCME-2026', `${kase.case_id}.json`), JSON.stringify(stamped(kase)));
process.env.BOOTH_CASES_DIR = CASES_DIR;
afterAll(() => { delete process.env.BOOTH_CASES_DIR; });

const GOOD = { form: 'fb-1', case_id: kase.case_id,
  answers: { role: 'physician', mood: 'enjoyed', felt_like: ['real_patient', 'exam'], easy: 4, real: 5, fair: 3, use: 9 } };

let settings;
let inserts;
let insertError;
let stored;
let storedError;

function seed(enabled = 1) {
  const now = Date.now();
  settings = new Map([
    ['booth_event_code', { value: 0, value_text: 'NFCME-2026' }],
    ['booth_enabled', { value: enabled, value_text: null }],
    ['booth_opens_at', { value: 0, value_text: new Date(now - 3600_000).toISOString() }],
    ['booth_closes_at', { value: 0, value_text: new Date(now + 3600_000).toISOString() }],
    ['booth_play_ceiling_usd', { value: 3, value_text: null }],
  ]);
}

function resolve(table, kind, ctx) {
  if (table === 'app_settings' && kind === 'list') {
    const keys = (ctx.ins.find(([c]) => c === 'key') || [])[1] || [];
    return keys.filter((k) => settings.has(k)).map((key) => ({ key, ...settings.get(key) }));
  }
  if (table === 'booth_feedback' && kind === 'insert') {
    if (insertError) return { data: null, error: insertError };
    inserts.push(ctx.payload);
    return { data: null, error: null };
  }
  if (table === 'booth_feedback' && kind === 'list') {
    if (storedError) return { data: null, error: storedError };
    const rows = stored.filter((r) => ctx.eqs.every(([c, v]) => r[c] === v));
    const [from, to] = ctx.range ?? [0, Infinity];
    return rows.slice(from, to + 1);
  }
  return undefined;
}

const post = (body) => request(app).post('/booth/feedback').send(body);
const bangkokDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const withAnswers = (over) => ({ ...GOOD, answers: { ...GOOD.answers, ...over } });

beforeEach(() => {
  m.reset();
  m.state.resolve = resolve;
  seed();
  inserts = [];
  insertError = null;
  stored = [];
  storedError = null;
  rimplDeidentify.mockReset();
  logEventStrict.mockClear();
  logEventStrict.mockImplementation(async () => ({ ok: true }));
});

it('stores one row for the open event with the date and no time', async () => {
  const res = await post(GOOD);
  expect(res.status).toBe(201);
  expect(res.body).toEqual({});
  expect(inserts).toHaveLength(1);
  expect(Object.keys(inserts[0]).sort()).toEqual(['answers', 'case_id', 'comment', 'event_code', 'form', 'submitted_on']);
  expect(inserts[0]).toMatchObject({ event_code: 'NFCME-2026', case_id: kase.case_id, form: 'fb-1', answers: GOOD.answers, comment: null });
  expect(inserts[0].submitted_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(inserts[0].submitted_on).toBe(bangkokDate());
  expect(rimplDeidentify).not.toHaveBeenCalled();
});

it.each([
  ['an unknown top-level key', { ...GOOD, tag: 42 }],
  ['a play id', { ...GOOD, play_id: 'x' }],
  ['an unknown answer key', withAnswers({ tag: 1 })],
  ['easy above range', withAnswers({ easy: 6 })],
  ['use above range', withAnswers({ use: 11 })],
  ['a fractional easy', withAnswers({ easy: 2.5 })],
  ['an empty felt_like', withAnswers({ felt_like: [] })],
  ['a repeated felt_like', withAnswers({ felt_like: ['exam', 'exam'] })],
  ['an unknown mood', withAnswers({ mood: 'happy' })],
  ['another form version', { ...GOOD, form: 'fb-2' }],
  ['a 1001-character comment', { ...GOOD, comment: 'ก'.repeat(1001) }],
])('refuses %s', async (_name, body) => {
  const res = await post(body);
  expect(res.status).toBe(400);
  expect(res.body.reason).toBe('bad_request');
  expect(inserts).toHaveLength(0);
  expect(rimplDeidentify).not.toHaveBeenCalled();
});

it('refuses while the booth is closed and stores nothing', async () => {
  seed(0);
  const res = await post(GOOD);
  expect(res.status).toBe(403);
  expect(res.body.reason).toBe('closed');
  expect(inserts).toHaveLength(0);
  const open = await request(app).get('/booth/feedback');
  expect(open.status).toBe(200);
  expect(open.body).toEqual({ open: false });
});

it('says the booth is open while it is', async () => {
  const res = await request(app).get('/booth/feedback');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ open: true });
});

it('stores an unknown case as null', async () => {
  const res = await post({ ...GOOD, case_id: 'no-such-case' });
  expect(res.status).toBe(201);
  expect(inserts[0].case_id).toBeNull();
});

it('stores only the de-identified comment', async () => {
  rimplDeidentify.mockResolvedValue({ messages: [{ role: 'user', content: '[NAME-1] ดูแลดีมาก' }] });
  const res = await post({ ...GOOD, comment: ' นพ.สมชาย ดูแลดีมาก ' });
  expect(res.status).toBe(201);
  expect(rimplDeidentify).toHaveBeenCalledTimes(1);
  expect(rimplDeidentify).toHaveBeenCalledWith({ messages: [{ role: 'user', content: 'นพ.สมชาย ดูแลดีมาก' }] });
  expect(inserts[0].comment).toBe('[NAME-1] ดูแลดีมาก');
  expect(JSON.stringify(inserts[0])).not.toContain('สมชาย');
});

it('a blank comment is null and skips rimpl', async () => {
  const res = await post({ ...GOOD, comment: '  \n ' });
  expect(res.status).toBe(201);
  expect(inserts[0].comment).toBeNull();
  expect(rimplDeidentify).not.toHaveBeenCalled();
});

it('fails closed when de-identification fails, and never logs the comment', async () => {
  const secret = 'โทร 081-234-5678 คุณสมชาย';
  rimplDeidentify.mockRejectedValue(new Error(`rimpl down while masking ${secret}`));
  const spies = ['error', 'warn', 'log'].map((k) => jest.spyOn(console, k).mockImplementation(() => {}));
  try {
    const res = await post({ ...GOOD, comment: secret });
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('comment_unavailable');
    expect(inserts).toHaveLength(0);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('081-234-5678');
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
});

it('says unavailable when the row cannot be written', async () => {
  insertError = { message: 'down' };
  const res = await post(GOOD);
  expect(res.status).toBe(503);
  expect(res.body.reason).toBe('unavailable');
});

it('logs a failed insert by its code alone, never the answers or the comment', async () => {
  insertError = { code: '42501', message: 'permission denied for ' + JSON.stringify(GOOD.answers) };
  rimplDeidentify.mockResolvedValue({ messages: [{ role: 'user', content: 'ความเห็นลับ' }] });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await post({ ...GOOD, comment: 'ความเห็นลับ' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[booth-feedback] insert failed', '42501');
  } finally { warn.mockRestore(); }
});

describe('admin', () => {
  const row = (over) => ({ id: 'id-x', event_code: 'NFCME-2026', case_id: kase.case_id, form: 'fb-1', submitted_on: '2026-11-20',
    answers: GOOD.answers, comment: null, ...over });
  const as = (caller) => {
    m.state.caller = caller;
    return (url) => request(app).get(url).set('Authorization', 'Bearer t');
  };

  it('superadmin reads every row of the current event, newest date first, flagged comments withheld', async () => {
    stored = [
      row({ id: 'a', submitted_on: '2026-11-19', comment: 'ดีมาก' }),
      row({ id: 'b', submitted_on: '2026-11-20', comment: 'โทร 0812345678' }),
      row({ id: 'c', submitted_on: '2026-11-20', comment: null }),
      row({ id: 'd', event_code: 'OTHER-2026', comment: 'ของงานอื่น' }),
    ];
    const res = await as(SUPERADMIN)('/admin/booth/feedback');
    expect(res.status).toBe(200);
    expect(res.body.event_code).toBe('NFCME-2026');
    expect(res.body.form).toBe('fb-1');
    expect(res.body.counts).toEqual({ answers: 3, comments: 2, comments_withheld: 1 });
    expect(res.body.rows.map((r) => r.date)).toEqual(['2026-11-20', '2026-11-20', '2026-11-19']);
    const flagged = res.body.rows.find((r) => r.withheld === 'flagged');
    expect(flagged).toMatchObject({ comment: null, withheld: 'flagged' });
    expect(JSON.stringify(res.body)).not.toContain('0812345678');
    expect(JSON.stringify(res.body)).not.toContain('ของงานอื่น');
    expect(res.body.rows.find((r) => r.comment === 'ดีมาก')).toBeTruthy();
  });

  it('reads past the 1000-row page', async () => {
    stored = Array.from({ length: 1001 }, (_v, i) => row({ id: `i${i}` }));
    const res = await as(SUPERADMIN)('/admin/booth/feedback');
    expect(res.body.counts.answers).toBe(1001);
  });

  it('answers 502 when the rows cannot be read', async () => {
    storedError = { message: 'down' };
    expect((await as(SUPERADMIN)('/admin/booth/feedback')).status).toBe(502);
    expect((await as(SUPERADMIN)('/admin/booth/feedback.json')).status).toBe(502);
    expect(logEventStrict).not.toHaveBeenCalled();
  });

  it('with no event code set, reads as an empty event and exports an empty file, not an outage', async () => {
    settings.delete('booth_event_code');
    stored = [row({ id: 'a' })];
    const read = await as(SUPERADMIN)('/admin/booth/feedback');
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ event_code: null, form: 'fb-1', rows: [], counts: { answers: 0, comments: 0, comments_withheld: 0 } });
    const file = await as(SUPERADMIN)('/admin/booth/feedback.json');
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toBe('attachment; filename="booth-feedback-none.json"');
    expect(JSON.parse(file.text)).toEqual({ export: { event_code: null, counts: { answers: 0, comments: 0, comments_withheld: 0 }, form: 'fb-1' }, rows: [] });
    expect(logEventStrict).toHaveBeenCalledWith(expect.objectContaining({ action: 'booth.feedback_export',
      metadata: { event_code: null, answers: 0, comments: 0, comments_withheld: 0 } }));
  });

  it('only a superadmin can read or export', async () => {
    for (const who of [ADMIN, AUDITOR, PHYSICIAN]) {
      expect((await as(who)('/admin/booth/feedback')).status).toBe(403);
      expect((await as(who)('/admin/booth/feedback.json')).status).toBe(403);
    }
    expect(logEventStrict).not.toHaveBeenCalled();
  });

  it('export writes its audit row first and sends nothing when it fails', async () => {
    stored = [row({ id: 'a', comment: 'โทร 0812345678' }), row({ id: 'b' })];
    const ok = await as(SUPERADMIN)('/admin/booth/feedback.json');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-disposition']).toBe('attachment; filename="booth-feedback-NFCME-2026.json"');
    expect(logEventStrict).toHaveBeenCalledWith(expect.objectContaining({ action: 'booth.feedback_export', actorRole: 'superadmin',
      metadata: { event_code: 'NFCME-2026', answers: 2, comments: 1, comments_withheld: 1 } }));
    const body = JSON.parse(ok.text);
    expect(body.export).toMatchObject({ event_code: 'NFCME-2026', form: 'fb-1', counts: { answers: 2, comments: 1, comments_withheld: 1 } });
    expect(body.rows).toHaveLength(2);
    expect(ok.text).not.toContain('0812345678');

    logEventStrict.mockImplementation(async () => ({ error: 'x' }));
    const refused = await as(SUPERADMIN)('/admin/booth/feedback.json');
    expect(refused.status).toBe(503);
    expect(refused.text).not.toContain('rows');
    expect(refused.headers['content-disposition']).toBeUndefined();
  });

  it('rows within a date come back in content order, not insertion order', async () => {
    const A = { ...GOOD.answers, use: 1 };
    const B = { ...GOOD.answers, use: 2 };
    stored = [
      row({ id: '3', case_id: null, answers: A }),
      row({ id: '2', case_id: 'zeta', answers: A }),
      row({ id: '9', case_id: 'alpha', answers: B }),
      row({ id: '1', case_id: 'alpha', answers: A }),
    ];
    const expected = [['alpha', 1], ['alpha', 2], ['zeta', 1], [null, 1]];
    const shape = (rows) => rows.map((r) => [r.case_id, r.answers.use]);
    const read = await as(SUPERADMIN)('/admin/booth/feedback');
    expect(shape(read.body.rows)).toEqual(expected);
    const exported = JSON.parse((await as(SUPERADMIN)('/admin/booth/feedback.json')).text);
    expect(shape(exported.rows)).toEqual(expected);
    for (const r of [...read.body.rows, ...exported.rows]) expect(r).not.toHaveProperty('id');
  });
});
