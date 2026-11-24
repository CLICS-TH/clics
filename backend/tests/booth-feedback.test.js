// Anonymous booth feedback (ADR 0015): POST /booth/feedback stores one row with a Bangkok date and no time, only while
// the booth is open, and keeps a comment only as rimpl's de-identified copy.
jest.mock('dotenv', () => ({ config: () => ({}) }));
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/services/rimpl-client', () => ({ ...jest.requireActual('../src/services/rimpl-client'), rimplDeidentify: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { stamped } = require('./helpers/booth-tree');
const { __mock: m } = require('../src/lib/supabase');
const { rimplDeidentify } = require('../src/services/rimpl-client');
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
  rimplDeidentify.mockReset();
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
