// The Booth Mode page's endpoints (owner, 2026-11-24): GET /admin/booth/standings ranks every scored play the kiosk
// ranks, overall and per case, whatever the event's window; GET /admin/booth/export.json hands a superadmin every play
// for internal research (ADR 0014), typed text screened again, and sends nothing when its audit row cannot be written.
jest.mock('dotenv', () => ({ config: () => ({}) }));
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/lib/audit', () => ({ logEvent: jest.fn(async () => {}), logEventStrict: jest.fn(async () => ({ ok: true })) }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stamped } = require('./helpers/booth-tree');
const request = require('supertest');
const { __mock: m } = require('../src/lib/supabase');
const { logEventStrict } = require('../src/lib/audit');
const { stepCount } = require('../src/services/booth-dialogue');
const { displayScore } = require('../src/booth-cases/display-score');
const app = require('../src/index');
const { SUPERADMIN, ADMIN, AUDITOR, PHYSICIAN } = require('./helpers/roles');

const CASES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-monitor-'));
const kase = { ...JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree.json'), 'utf8')), event_code: 'NFCME-2026',
  path_score_table: JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-path-score-table.json'), 'utf8')) };
fs.mkdirSync(path.join(CASES_DIR, 'NFCME-2026'));
fs.writeFileSync(path.join(CASES_DIR, 'NFCME-2026', `${kase.case_id}.json`), JSON.stringify(stamped(kase)));
process.env.BOOTH_CASES_DIR = CASES_DIR;
afterAll(() => { delete process.env.BOOTH_CASES_DIR; });

const STEPS = stepCount(kase);
const PATH = 'B'.repeat(STEPS);
const MAX_ROWS = 1000;
const REPLY = { strength: 'ดี', weigh: 'พิจารณา', safety: 'ปลอดภัย' };

let settings;
let plays;
let playsError;

const play = (over) => ({
  id: `p-${over.tag}`, event_code: 'NFCME-2026', status: 'scored', ranked: true, case_id: kase.case_id, case_version: kase.version,
  tier_path: PATH, replied_step: STEPS, composite: 50, d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3,
  score_source: 'table', language_look: 'th', spend_usd: 0.01, created_at: '2026-11-20T03:00:00Z',
  scored_at: '2026-11-20T03:05:00Z', steps: null, ...over,
});

function seed() {
  settings = new Map([
    ['booth_event_code', { value: 0, value_text: 'NFCME-2026' }],
    ['booth_enabled', { value: 0, value_text: null }],
    ['booth_play_ceiling_usd', { value: 3, value_text: null }],
  ]);
  plays = [
    play({ tag: 1, composite: 40, scored_at: '2026-11-20T03:05:00Z' }),
    play({ tag: 2, composite: 60, scored_at: '2026-11-20T04:05:00Z' }),
    // Ties the top score but scored later, so it ranks second.
    play({ tag: 3, composite: 60, scored_at: '2026-11-20T05:05:00Z' }),
    play({ tag: 4, composite: 55, case_id: 'retired-case', case_version: '1' }),
    // Left off the board, as the kiosk leaves them off: unranked, not scored, another step count, another event.
    play({ tag: 5, composite: 99, ranked: false }),
    play({ tag: 6, composite: null, status: 'started', scored_at: null }),
    play({ tag: 7, composite: 98, tier_path: 'B'.repeat(STEPS + 2) }),
    play({ tag: 8, composite: 97, event_code: 'OTHER-2026' }),
  ];
  playsError = null;
}

const likeMatches = (value, pattern) => typeof value === 'string' && new RegExp(`^${pattern.replace(/_/g, '.').replace(/%/g, '.*')}$`).test(value);

function resolve(table, kind, ctx) {
  if (table === 'app_settings' && kind === 'list') {
    const keys = (ctx.ins.find(([c]) => c === 'key') || [])[1] || [];
    return keys.filter((k) => settings.has(k)).map((key) => ({ key, ...settings.get(key) }));
  }
  if (table === 'booth_plays' && kind === 'list') {
    if (playsError) return { data: null, error: playsError };
    const rows = plays.filter((p) => ctx.eqs.every(([c, v]) => p[c] === v) && ctx.likes.every(([c, pat]) => likeMatches(p[c], pat)));
    const [from, to] = ctx.range ?? [0, Infinity];
    return rows.slice(from, Math.min(to + 1, from + MAX_ROWS));
  }
  return undefined;
}

const as = (caller) => {
  m.state.caller = caller;
  return (url) => request(app).get(url).set('Authorization', 'Bearer t');
};

beforeEach(() => {
  m.reset();
  m.state.resolve = resolve;
  seed();
  logEventStrict.mockClear();
  logEventStrict.mockImplementation(async () => ({ ok: true }));
});

describe('superadmin only', () => {
  it.each([['admin', ADMIN], ['auditor', AUDITOR], ['physician', PHYSICIAN]])('refuses %s', async (_name, who) => {
    expect((await as(who)('/admin/booth/standings')).status).toBe(403);
    expect((await as(who)('/admin/booth/export.json')).status).toBe(403);
    expect(logEventStrict).not.toHaveBeenCalled();
  });
});

describe('GET /admin/booth/standings', () => {
  it('ranks what the kiosk ranks, by raw score, an equal score to the earlier play, overall and per case', async () => {
    const res = await as(SUPERADMIN)('/admin/booth/standings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_code: 'NFCME-2026', steps: STEPS, total: 4 });
    expect(res.body.overall.map((r) => [r.rank, r.tag, r.raw])).toEqual([[1, 2, 60], [2, 3, 60], [3, 4, 55], [4, 1, 40]]);
    expect(res.body.overall[0]).toEqual({ rank: 1, tag: 2, score: displayScore(60, STEPS), raw: 60, case_id: kase.case_id,
      case_version: kase.version, scored_at: '2026-11-20T04:05:00Z' });
    expect(res.body.cases.map((c) => [c.case_id, c.teaser, c.rows.map((r) => [r.rank, r.tag])])).toEqual([
      [kase.case_id, kase.teaser, [[1, 2], [2, 3], [3, 1]]],
      // A case no longer in the pool keeps its rows, after the pool.
      ['retired-case', null, [[1, 4]]],
    ]);
  });

  it('reads past the 1000 rows one request returns', async () => {
    plays = Array.from({ length: 1205 }, (_, i) => play({ tag: i + 1, composite: 30 + (i % 40) }));
    const res = await as(SUPERADMIN)('/admin/booth/standings');
    expect(res.body.total).toBe(1205);
    expect(res.body.overall).toHaveLength(1205);
  });

  it('lists the pool with no rows when nothing is scored, and nothing when no event is set', async () => {
    plays = [];
    const empty = await as(SUPERADMIN)('/admin/booth/standings');
    expect(empty.body).toMatchObject({ total: 0, overall: [], cases: [{ case_id: kase.case_id, rows: [] }] });
    settings.set('booth_event_code', { value: 0, value_text: null });
    const none = await as(SUPERADMIN)('/admin/booth/standings');
    expect(none.body).toMatchObject({ event_code: null, total: 0, overall: [], cases: [] });
  });

  it('says it could not read rather than showing an empty board', async () => {
    playsError = { message: 'boom' };
    const res = await as(SUPERADMIN)('/admin/booth/standings');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/standings/);
  });
});

describe('GET /admin/booth/export.json', () => {
  const typedStep = (typed, reply = REPLY) => ({ variant: 'v1', bridge: 'b', options: ['a', 'b', 'c'], typed, reply, tier: 'best' });
  const tappedStep = { variant: 'v1', bridge: 'b', options: ['a', 'b', 'c'], choice: 'a', reply: REPLY, tier: 'best' };

  it('sends every play of the event, every status, with the tag, the timestamps and the spend, and audits it', async () => {
    const res = await as(SUPERADMIN)('/admin/booth/export.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="clics-booth-NFCME-2026-\d{4}-\d{2}-\d{2}\.json"$/);
    const body = JSON.parse(res.text);
    expect(body.export).toMatchObject({ kind: 'clics-booth-internal', event_code: 'NFCME-2026', counts: { plays: 7, scored: 6 } });
    expect(body.export.use).toMatch(/Internal use only/);
    expect(body.plays.map((p) => p.tag)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(body.plays[0]).toMatchObject({ tag: 1, player: '#001', status: 'scored', raw_composite: 40, spend_usd: 0.01,
      created_at: '2026-11-20T03:00:00Z', scored_at: '2026-11-20T03:05:00Z', domains: { d1: 3, d7: 3 }, dialogue: null });
    expect(body.plays.find((p) => p.tag === 6)).toMatchObject({ status: 'started', raw_composite: null, display_score: null });
    expect(logEventStrict).toHaveBeenCalledWith(expect.objectContaining({ action: 'booth.export', actorRole: 'superadmin',
      metadata: expect.objectContaining({ event_code: 'NFCME-2026', plays: 7 }) }));
  });

  it('gives a five-step play the display score the kiosk showed, and any other play its raw score', async () => {
    plays = [play({ tag: 1, composite: 45.5, tier_path: 'BBBBB' }), play({ tag: 2, composite: 45.5, tier_path: 'BBB' })];
    const body = JSON.parse((await as(SUPERADMIN)('/admin/booth/export.json')).text);
    expect(body.plays.map((p) => p.display_score)).toEqual([displayScore(45.5, 5), 45.5]);
    expect(displayScore(45.5, 5)).not.toBe(45.5);
  });

  it('withholds a typed answer and its AI reply when the screen finds something, and keeps clean ones', async () => {
    plays = [play({ tag: 1, steps: [
      tappedStep,
      typedStep('ให้ออกซิเจนและตรวจ CBC'),
      typedStep('โทร 081-234-5678 ได้เลย'),
      typedStep(null),
      typedStep('ปรึกษาอายุรแพทย์', { ...REPLY, safety: 'เบอร์ 0812345678' }),
    ] })];
    const body = JSON.parse((await as(SUPERADMIN)('/admin/booth/export.json')).text);
    const [tapped, clean, phone, noCopy, replyLeak] = body.plays[0].dialogue;
    expect(tapped).toEqual(tappedStep);
    expect(clean).toEqual(typedStep('ให้ออกซิเจนและตรวจ CBC'));
    expect(phone).toMatchObject({ typed: null, reply: null, withheld: 'flagged' });
    expect(noCopy).toMatchObject({ typed: null, withheld: 'no_deidentified_copy' });
    expect(replyLeak).toMatchObject({ typed: null, reply: null, withheld: 'flagged' });
    expect(JSON.stringify(body)).not.toMatch(/081-234-5678|0812345678/);
    expect(body.export.counts).toMatchObject({ steps: 5, typed_steps: 4, withheld_flagged: 2, withheld_no_copy: 1 });
  });

  // The bridge into a step is the AI's, written from the previous answer, and stored on the step it leads into: a
  // tapped step carries it too. A tapped step's reply came from the AI before the reply bank (#490) and off five steps.
  it('screens the AI bridge on every step and the reply of a tapped step, and withholds a step that trips it', async () => {
    const leakyBridge = 'ขอบคุณสำหรับเบอร์ 081.234.5678 ครับ';
    plays = [play({ tag: 1, tier_path: 'BBB', steps: [
      { ...tappedStep, bridge: '' },
      { ...tappedStep, bridge: leakyBridge },
      { ...typedStep('ให้ออกซิเจน'), bridge: leakyBridge },
    ] }), play({ tag: 2, tier_path: 'BBB', steps: [
      { ...tappedStep, reply: { ...REPLY, weigh: 'ผู้ป่วยแจ้งเบอร์ 0812345678 ไว้' } },
    ] })];
    const body = JSON.parse((await as(SUPERADMIN)('/admin/booth/export.json')).text);
    const [[noBridge, tappedLeak, typedLeak], [aiReplyLeak]] = body.plays.map((p) => p.dialogue);
    // Step 0's reply and the bridge into step 1 came from one AI call, and the auditor read joins them: both go.
    expect(noBridge).toEqual({ ...tappedStep, reply: null, bridge: null, withheld: 'flagged' });
    expect(tappedLeak).toEqual({ ...tappedStep, reply: null, bridge: null, withheld: 'flagged' });
    expect(typedLeak).toMatchObject({ typed: null, reply: null, bridge: null, withheld: 'flagged' });
    expect(aiReplyLeak).toEqual({ ...tappedStep, reply: null, bridge: null, withheld: 'flagged' });
    expect(JSON.stringify(body)).not.toMatch(/081\.234\.5678|0812345678/);
    expect(body.export.counts).toMatchObject({ steps: 4, typed_steps: 1, withheld_flagged: 4, withheld_no_copy: 0 });
  });

  // The auditor read screens step i's reply and the bridge into step i+1 as one turn (dialogueTurns): a number split
  // across the two passes each field alone and must still be caught.
  it('screens a reply joined to the next bridge, as the auditor read does, and withholds both steps', async () => {
    const { flaggedForAuditor } = require('../src/services/booth-dialogue');
    const tail = 'โทรกลับที่ 081 23';
    const head = '45 678 นะครับ';
    expect([flaggedForAuditor(tail), flaggedForAuditor(head), flaggedForAuditor(`${tail} ${head}`)]).toEqual([false, false, true]);
    plays = [play({ tag: 1, tier_path: 'BBB', steps: [
      { ...tappedStep, reply: { ...REPLY, safety: tail } },
      { ...tappedStep, bridge: head },
      tappedStep,
    ] })];
    const body = JSON.parse((await as(SUPERADMIN)('/admin/booth/export.json')).text);
    const [first, second, third] = body.plays[0].dialogue;
    expect(first).toMatchObject({ reply: null, bridge: null, withheld: 'flagged' });
    expect(second).toMatchObject({ reply: null, bridge: null, withheld: 'flagged' });
    expect(third).toEqual(tappedStep);
  });

  it('exports only a step record\'s known keys, so a key a later writer adds never goes out unscreened', async () => {
    plays = [play({ tag: 1, steps: [{ ...tappedStep, note: 'เบอร์ญาติ 0812345678', reply: { ...REPLY, extra: 'x' } }, 'junk'] })];
    const body = JSON.parse((await as(SUPERADMIN)('/admin/booth/export.json')).text);
    expect(body.plays[0].dialogue).toEqual([tappedStep, null]);
  });

  it('sends nothing when the audit row cannot be written', async () => {
    logEventStrict.mockImplementation(async () => ({ error: { message: 'down' } }));
    const res = await as(SUPERADMIN)('/admin/booth/export.json');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: expect.stringMatching(/audit log/) });
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('sends nothing, and audits nothing, when the plays cannot be read', async () => {
    playsError = { message: 'boom' };
    const res = await as(SUPERADMIN)('/admin/booth/export.json');
    expect(res.status).toBe(502);
    expect(logEventStrict).not.toHaveBeenCalled();
  });
});
