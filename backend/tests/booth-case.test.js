jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const fs = require('fs');
const path = require('path');
const { __mock: m } = require('../src/lib/supabase');
const { boothStatus } = require('../src/services/booth');

const DIR = path.join(__dirname, '../src/booth-cases');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
const readCase = (file) => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
const HOUR = 3_600_000;

function openEventNamed(code) {
  m.state.resolve = (table, kind) => (table === 'app_settings' && kind === 'list' ? [
    { key: 'booth_event_code', value: 0, value_text: code },
    { key: 'booth_enabled', value: 1, value_text: null },
    { key: 'booth_opens_at', value: 0, value_text: new Date(Date.now() - HOUR).toISOString() },
    { key: 'booth_closes_at', value: 0, value_text: new Date(Date.now() + HOUR).toISOString() },
    { key: 'booth_play_ceiling_usd', value: 3, value_text: null },
  ] : undefined);
}

beforeEach(() => m.reset());
afterEach(() => jest.restoreAllMocks());

test('the booth-cases folder holds at least the NFCME-2026 case', () => {
  expect(FILES).toContain('NFCME-2026.json');
});

test.each(FILES)('%s loads as an open event named after the file, with its version', async (file) => {
  const code = file.replace(/\.json$/, '');
  openEventNamed(code);
  const { body } = await boothStatus();
  expect(body).toEqual({ open: true, event_code: code, case_version: readCase(file).version });
});

test('NFCME-2026 says it is a placeholder in the flag and in both vignette prefixes, all or none', () => {
  const kase = readCase('NFCME-2026.json');
  const placeholder = kase.placeholder === true;
  expect(kase.vignette.th.startsWith('[เคสตัวอย่างชั่วคราว]')).toBe(placeholder);
  expect(kase.vignette.en.startsWith('[PLACEHOLDER CASE]')).toBe(placeholder);
});

describe('the NFCME-2026 case fits the kiosk pop-up', () => {
  const kase = readCase('NFCME-2026.json');

  // Thai combining marks take no width, so Thai counts spacing characters. The step-3 sheet fills
  // the 1080x1920 screen down to the case card's minimum height, so each field keeps the line
  // count measured at the kiosk's font sizes: question 2 lines, label 1, line th 1 / en 2.
  const LIMITS = {
    vignette: { th: 300, en: 450 },
    question: { th: 48, en: 80 },
    label: { th: 26, en: 36 },
    line: { th: 44, en: 70 },
  };
  const COMBINING = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/gu;
  const THAI = /[\u0E00-\u0E7F]/;
  const width = { th: (s) => s.replace(COMBINING, '').length, en: (s) => s.length };

  const fields = [{ kind: 'vignette', path: 'vignette', text: kase.vignette }];
  kase.steps.forEach((step, i) => {
    fields.push({ kind: 'question', path: `steps[${i}].question`, text: step.question });
    step.options.forEach((o, j) => {
      fields.push({ kind: 'label', path: `steps[${i}].options[${j}].label`, text: o.label });
      fields.push({ kind: 'line', path: `steps[${i}].options[${j}].line`, text: o.line });
    });
  });
  const texts = fields.flatMap((f) => ['th', 'en'].map((lang) => ({ ...f, lang, s: f.text[lang] })));
  const allStrings = (v, at = '') => (typeof v === 'string' ? [[at, v]]
    : Object.entries(v ?? {}).flatMap(([k, x]) => allStrings(x, at ? `${at}.${k}` : k)));

  test('is the real case, not a placeholder', () => {
    expect([undefined, false]).toContain(kase.placeholder);
  });

  test('has three steps of options a, b and c', () => {
    expect(kase.steps.map((s) => s.options.map((o) => o.id))).toEqual([['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c']]);
  });

  test('writes every field in Thai script for th and without it for en', () => {
    const bad = texts.filter(({ lang, s }) => typeof s !== 'string' || !s.trim()
      || (lang === 'th' ? !THAI.test(s) : THAI.test(s)));
    expect(bad.map(({ path, lang, s }) => `${path}.${lang}: ${JSON.stringify(s)}`)).toEqual([]);
  });

  test('keeps every field within its line budget', () => {
    const over = texts.map((t) => ({ ...t, n: width[t.lang](t.s), max: LIMITS[t.kind][t.lang] }))
      .filter(({ n, max }) => n > max);
    expect(over.map(({ path, lang, n, max }) => `${path}.${lang} is ${n} (limit ${max})`)).toEqual([]);
  });

  test('makes no overclaim', () => {
    const BANNED = ['on-premise', 'on premise', 'validated', 'ติดตั้งภายในองค์กร'];
    const hits = allStrings(kase).flatMap(([at, s]) => BANNED
      .filter((w) => s.toLowerCase().includes(w)).map((w) => `${at}: ${w}`));
    expect(hits).toEqual([]);
  });

  test('argues each option line for its option, never against it', () => {
    const against = { th: (s) => /แต่(?!ละ)|ไม่/.test(s), en: (s) => /\b(but|not|no)\b/i.test(s) };
    const bad = texts.filter(({ kind, lang, s }) => kind === 'line' && against[lang](s));
    expect(bad.map(({ path, lang, s }) => `${path}.${lang}: ${s}`)).toEqual([]);
  });

  // The booth prompt may not name the better choice, so nothing guarantees the AI reply corrects an
  // unsafe option. A word scan catches the wait-and-see class (holding treatment until a result); it
  // cannot judge every other unsafe plan, which stays with the physician read.
  test('offers no option that withholds or delays treatment', () => {
    const withholds = {
      th: /เลี่ยง|งดยา|ชะลอ|รอผล|รอดูอาการ|ยังไม่ให้|ไม่ให้ยา/,
      en: /\b(avoid|avoids|withhold|withholds|delay|delays|defer|defers|await|awaits|wait|waits|hold off|until)\b/i,
    };
    const bad = texts.filter(({ kind, lang, s }) => (kind === 'label' || kind === 'line') && withholds[lang].test(s));
    expect(bad.map(({ path, lang, s }) => `${path}.${lang}: ${s}`)).toEqual([]);
  });
});

describe('a broken case closes the booth as misconfigured', () => {
  const good = readCase('NFCME-2026.json');
  const edit = (code, fn) => { const k = structuredClone(good); k.event_code = code; fn(k); return k; };
  const realRead = fs.readFileSync;
  let n = 0;
  const serve = (code, kase) => jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => (
    String(p).endsWith(`${code}.json`) ? JSON.stringify(kase) : realRead(p, ...rest)));

  test('an unchanged copy served the same way loads open, so the cases below fail on their edit alone', async () => {
    serve('GOOD-1', edit('GOOD-1', () => {}));
    openEventNamed('GOOD-1');
    expect((await boothStatus()).body).toMatchObject({ open: true, case_version: good.version });
  });

  test.each([
    ['a fourth option', (k) => k.steps[0].options.push({ ...k.steps[0].options[0], id: 'd' })],
    ['a duplicated option id', (k) => { k.steps[1].options[2].id = 'a'; }],
    ['an empty English line', (k) => { k.steps[2].options[0].line.en = ' '; }],
    ['two steps', (k) => k.steps.pop()],
    ['an unknown key', (k) => { k.steps[0].hint = 'x'; }],
    ['an event code other than its file name', (k) => { k.event_code = 'ELSEWHERE-2026'; }],
  ])('%s', async (_name, fn) => {
    n += 1;
    const code = `BAD-${n}`;
    serve(code, edit(code, fn));
    openEventNamed(code);
    const { body } = await boothStatus();
    expect(body).toMatchObject({ open: false, reason: 'misconfigured', case_version: null });
  });

  test('a file that is not JSON', async () => {
    jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => (
      String(p).endsWith('NOTJSON-1.json') ? '{ "event_code": ' : realRead(p, ...rest)));
    openEventNamed('NOTJSON-1');
    expect((await boothStatus()).body).toMatchObject({ open: false, reason: 'misconfigured' });
  });

  test('no file for the code', async () => {
    openEventNamed('MISSING-2026');
    expect((await boothStatus()).body).toMatchObject({ open: false, reason: 'misconfigured' });
  });
});
