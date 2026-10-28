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
