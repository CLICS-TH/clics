// The superadmin booth card's endpoints (#214): GET/PATCH /admin/booth. Only a superadmin may read or change
// the booth event; the counts read plays and scored plays, never 'unavailable' as an outcome; a window must
// carry an explicit offset and close after it opens.
jest.mock('dotenv', () => ({ config: () => ({}) }));
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/lib/audit', () => ({ logEvent: jest.fn(async () => {}), logEventStrict: jest.fn(async () => ({ ok: true })) }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { __mock: m } = require('../src/lib/supabase');
const { logEvent } = require('../src/lib/audit');
const app = require('../src/index');
const { SUPERADMIN, ADMIN, AUDITOR, PHYSICIAN } = require('./helpers/roles');

// The real NFCME-2026 case may be unadmitted, so the event's case here is the fixture filed under that code.
const CASES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cases-'));
const kase = { ...JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree.json'), 'utf8')), event_code: 'NFCME-2026' };
fs.mkdirSync(path.join(CASES_DIR, 'NFCME-2026'));
fs.writeFileSync(path.join(CASES_DIR, 'NFCME-2026', `${kase.case_id}.json`), JSON.stringify(kase));
process.env.BOOTH_CASES_DIR = CASES_DIR;
afterAll(() => { delete process.env.BOOTH_CASES_DIR; });

const OPENS = '2026-11-03T08:00:00+07:00';
const CLOSES = '2026-11-04T18:00:00+07:00';

let settings;
let plays;
let playsError;

function seed() {
  settings = new Map([
    ['booth_event_code', { value: 0, value_text: 'NFCME-2026' }],
    ['booth_enabled', { value: 0, value_text: null }],
    ['booth_opens_at', { value: 0, value_text: null }],
    ['booth_closes_at', { value: 0, value_text: null }],
    ['booth_play_ceiling_usd', { value: 3, value_text: null }],
  ]);
  plays = [
    { event_code: 'NFCME-2026', status: 'scored', spend_usd: 0.31 },
    { event_code: 'NFCME-2026', status: 'scored', spend_usd: 0.29 },
    { event_code: 'NFCME-2026', status: 'unavailable', spend_usd: 0.35 },
    { event_code: 'NFCME-2026', status: 'started', spend_usd: 0.05 },
    { event_code: 'OTHER-2026', status: 'scored', spend_usd: 9 },
  ];
  playsError = null;
}

function resolve(table, kind, ctx) {
  if (table === 'app_settings' && kind === 'list') {
    const keys = (ctx.ins.find(([c]) => c === 'key') || [])[1] || [];
    return keys.filter((k) => settings.has(k)).map((key) => ({ key, ...settings.get(key) }));
  }
  if (table === 'app_settings' && kind === 'upsert') {
    for (const r of [].concat(ctx.payload)) settings.set(r.key, { value: r.value, value_text: r.value_text });
    return null;
  }
  if (table === 'booth_plays' && kind === 'list') {
    if (playsError) return { data: null, error: playsError };
    const code = ctx.id('event_code');
    return plays.filter((p) => p.event_code === code);
  }
  return undefined;
}

const as = (caller) => {
  m.state.caller = caller;
  return {
    get: () => request(app).get('/admin/booth').set('Authorization', 'Bearer t'),
    patch: (body) => request(app).patch('/admin/booth').set('Authorization', 'Bearer t').send(body),
  };
};

beforeEach(() => {
  m.reset();
  m.state.resolve = resolve;
  seed();
  logEvent.mockClear();
});

describe('GET /admin/booth', () => {
  it('returns the settings and the event totals, counting an in-flight unavailable play as a play only', async () => {
    const res = await as(SUPERADMIN).get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      event_code: 'NFCME-2026', enabled: false, opens_at: null, closes_at: null, ceiling_usd: 3, state: 'off',
      plays: 4, scored: 2, spend_usd: 1,
    });
  });

  it('reports a failed plays read as unknown, not as zero', async () => {
    playsError = { message: 'boom' };
    const res = await as(SUPERADMIN).get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plays: null, scored: null, spend_usd: null });
  });
});

describe('PATCH /admin/booth', () => {
  it('switches the event on with a +07:00 window and a ceiling, and audits the change', async () => {
    const res = await as(SUPERADMIN).patch({ enabled: true, opens_at: OPENS, closes_at: CLOSES, ceiling_usd: 2.5 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, opens_at: OPENS, closes_at: CLOSES, ceiling_usd: 2.5 });
    expect(settings.get('booth_enabled').value).toBe(1);
    expect(settings.get('booth_opens_at').value_text).toBe(OPENS);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'booth_settings',
      metadata: { enabled: true, opens_at: OPENS, closes_at: CLOSES, ceiling_usd: 2.5 } }));
  });

  it('writes the switch and both bounds together, and leaves the ceiling alone unless it is sent', async () => {
    settings.set('booth_opens_at', { value: 0, value_text: OPENS });
    settings.set('booth_closes_at', { value: 0, value_text: CLOSES });
    await as(SUPERADMIN).patch({ enabled: true });
    const upsert = m.find('app_settings', 'upsert');
    expect(upsert.payload.map((r) => [r.key, r.value, r.value_text])).toEqual([
      ['booth_enabled', 1, null], ['booth_opens_at', 0, OPENS], ['booth_closes_at', 0, CLOSES]]);
  });

  it('writes only the ceiling when only the ceiling is sent', async () => {
    await as(SUPERADMIN).patch({ ceiling_usd: 2 });
    expect(m.find('app_settings', 'upsert').payload.map((r) => r.key)).toEqual(['booth_play_ceiling_usd']);
  });

  it.each([
    ['a time with no offset', { opens_at: '2026-11-03T08:00:00' }],
    ['a window that closes before it opens', { opens_at: CLOSES, closes_at: OPENS }],
    ['a zero ceiling', { ceiling_usd: 0 }],
    ['a ceiling past the sanity bound', { ceiling_usd: 500 }],
    ['an unknown field', { event_code: 'X' }],
    ['an empty body', {}],
  ])('refuses %s and writes nothing', async (_name, body) => {
    const res = await as(SUPERADMIN).patch(body);
    expect(res.status).toBe(400);
    expect(m.find('app_settings', 'upsert')).toBeUndefined();
  });

  it('checks a single new time against the stored one', async () => {
    settings.set('booth_closes_at', { value: 0, value_text: OPENS });
    const res = await as(SUPERADMIN).patch({ opens_at: CLOSES });
    expect(res.status).toBe(400);
  });

  it.each([
    ['clearing a bound while the booth is on', true, { closes_at: null }],
    ['switching on with no window stored', false, { enabled: true }],
    ['switching on with only one bound', false, { enabled: true, opens_at: OPENS, closes_at: null }],
  ])('refuses %s, leaving the stored settings as they were', async (_name, on, body) => {
    settings.set('booth_enabled', { value: on ? 1 : 0, value_text: null });
    if (on) {
      settings.set('booth_opens_at', { value: 0, value_text: OPENS });
      settings.set('booth_closes_at', { value: 0, value_text: CLOSES });
    }
    const res = await as(SUPERADMIN).patch(body);
    expect(res.status).toBe(400);
    expect(m.find('app_settings', 'upsert')).toBeUndefined();
    expect((await as(SUPERADMIN).get()).body.state).not.toBe('misconfigured');
  });

  it('never stores a window that closes before it opens, whatever order two overlapping saves run in', async () => {
    // Two tabs both loaded 08:00-18:00. One moves the opening to 17:00, the other the closing to 09:00; each is a
    // valid window on its own. Both reads are held until both have happened, so each request checks its edit
    // against the window the other is about to change.
    const day = (h) => `2026-11-03T${h}:00:00+07:00`;
    settings.set('booth_opens_at', { value: 0, value_text: day('08') });
    settings.set('booth_closes_at', { value: 0, value_text: day('18') });
    const { supabase } = require('../src/lib/supabase');
    const from = supabase.from;
    let release;
    const bothRead = new Promise((r) => { release = r; });
    let held = 0;
    const spy = jest.spyOn(supabase, 'from').mockImplementation((table) => {
      const q = from(table);
      if (table !== 'app_settings') return q;
      const select = q.select;
      q.select = (...a) => {
        if (held >= 2) return select(...a);
        held += 1;
        if (held === 2) release();
        const then = q.then;
        q.then = (ok, fail) => { const read = then((r) => r); return bothRead.then(() => read).then(ok, fail); };
        return select(...a);
      };
      return q;
    });
    try {
      const results = await Promise.all([as(SUPERADMIN).patch({ opens_at: day('17') }), as(SUPERADMIN).patch({ closes_at: day('09') })]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
    } finally {
      spy.mockRestore();
    }
    expect(held).toBe(2);
    expect(Date.parse(settings.get('booth_opens_at').value_text))
      .toBeLessThan(Date.parse(settings.get('booth_closes_at').value_text));
  });

  it('clears the window with null', async () => {
    settings.set('booth_opens_at', { value: 0, value_text: OPENS });
    const res = await as(SUPERADMIN).patch({ opens_at: null });
    expect(res.status).toBe(200);
    expect(res.body.opens_at).toBeNull();
  });
});

describe.each([['admin', ADMIN], ['auditor', AUDITOR], ['physician', PHYSICIAN]])('a %s', (_role, caller) => {
  it('cannot read the booth settings', async () => {
    const res = await as(caller).get();
    expect(res.status).toBe(403);
    expect(m.find('booth_plays')).toBeUndefined();
  });

  it('cannot change the booth settings', async () => {
    const res = await as(caller).patch({ enabled: true });
    expect(res.status).toBe(403);
    expect(m.find('app_settings', 'upsert')).toBeUndefined();
  });
});
