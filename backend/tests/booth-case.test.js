jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stamped } = require('./helpers/booth-tree');
const { __mock: m } = require('../src/lib/supabase');
const { readEventCases, boothStatus } = require('../src/services/booth');

const TABLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-path-score-table.json'), 'utf8'));
const FIXTURE = { ...JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree.json'), 'utf8')), path_score_table: TABLE };
const EVENT = FIXTURE.event_code;
const HOUR = 3_600_000;

/** A fresh cases folder holding `files` ({ 'EVENT/name.json': case or raw text }). */
function casesDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cases-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(stamped(content)));
  }
  return dir;
}
const edited = (fn) => { const k = structuredClone(FIXTURE); fn(k); return k; };
const at = (k) => `${k.event_code}/${k.case_id}.json`;

beforeEach(() => { m.reset(); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); delete process.env.BOOTH_CASES_DIR; });

test('an admitted case in its event folder, named after its case_id, is loaded with its path score table', () => {
  expect(readEventCases(casesDir({ [at(FIXTURE)]: FIXTURE }), EVENT).cases).toEqual([FIXTURE]);
});

test('the event\'s cases come back ordered by case_id, whatever the folder order', () => {
  const second = edited((k) => { k.case_id = 'b-case'; });
  const first = edited((k) => { k.case_id = 'a-case'; });
  const loaded = readEventCases(casesDir({ [at(second)]: second, [at(first)]: first }), EVENT).cases;
  expect(loaded.map((k) => k.case_id)).toEqual(['a-case', 'b-case']);
});

test.each([
  ['no admission marker', (k) => { delete k.admission; }],
  ['a safety review but no sandbox run', (k) => { delete k.admission.sandbox; }],
  ['a sandbox run but no safety review', (k) => { delete k.admission.safety_review; }],
  ['a missing step-3 bank', (k) => { delete k.banks.step3.WW; }],
  ['a default trio with two best options', (k) => { k.banks.step1.default_trio = ['a', 'b', 'd']; }],
  ['no path score table', (k) => { delete k.path_score_table; }],
  ['a table missing a path', (k) => { delete k.path_score_table.paths.WRB; }],
  ['an older sandbox waiver and a table whose re-check failed, with no waiver on its run', (k) => {
    delete k.admission.sandbox;
    delete k.admission.table_check;
    k.admission.owner_waiver = { date: '2026-11-03', adr: '0005', reason: 'Owner waiver', sandbox_run_id: 'sbx-fixture' };
  }],
  ['a table waiver on an earlier table run', (k) => {
    delete k.admission.table_check;
    k.admission.table_waiver = { date: '2026-11-09', adr: '0005', reason: 'Owner waiver', run_id: 'ptb-earlier' };
  }],
])('a case with %s is left out', (_name, fn) => {
  const k = edited(fn);
  expect(readEventCases(casesDir({ [at(FIXTURE)]: k }), EVENT).cases).toEqual([]);
});

test.each([
  ['a file name other than its case_id', { [`${EVENT}/other.json`]: FIXTURE }],
  ['a folder other than its event_code', { [`ELSEWHERE-2026/${FIXTURE.case_id}.json`]: FIXTURE }, 'ELSEWHERE-2026'],
  ['a file that is not JSON', { [at(FIXTURE)]: '{ "case_id": ' }],
  ['no folder for the event', {}],
])('%s is left out', (_name, files, code = EVENT) => {
  expect(readEventCases(casesDir(files), code).cases).toEqual([]);
});

describe('GET /booth/status reads the served case', () => {
  function openEvent() {
    m.state.resolve = (table, kind) => (table === 'app_settings' && kind === 'list' ? [
      { key: 'booth_event_code', value: 0, value_text: EVENT },
      { key: 'booth_enabled', value: 1, value_text: null },
      { key: 'booth_opens_at', value: 0, value_text: new Date(Date.now() - HOUR).toISOString() },
      { key: 'booth_closes_at', value: 0, value_text: new Date(Date.now() + HOUR).toISOString() },
      { key: 'booth_play_ceiling_usd', value: 3, value_text: null },
    ] : undefined);
  }

  test('an event with an admitted case is open', async () => {
    process.env.BOOTH_CASES_DIR = casesDir({ [at(FIXTURE)]: FIXTURE });
    openEvent();
    expect((await boothStatus()).body).toEqual({ open: true, event_code: EVENT });
  });

  test.each([
    ['is unadmitted', (k) => { delete k.admission; }],
    ['has no path score table', (k) => { delete k.path_score_table; }],
  ])('an event whose only case %s is misconfigured', async (_name, fn) => {
    process.env.BOOTH_CASES_DIR = casesDir({ [at(FIXTURE)]: edited(fn) });
    openEvent();
    expect((await boothStatus()).body).toEqual({ open: false, reason: 'misconfigured', event_code: EVENT });
  });
});
