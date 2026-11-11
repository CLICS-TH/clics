jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const fs = require('fs');
const path = require('path');
const { readEventCases, SAFE_EVENT_CODE } = require('../src/services/booth');
const { snapshotFile, snapshotState, snapshotProblem, StudyCaseSchema, readStudyCase } = require('../src/booth-cases/study-snapshot');
const { bankAt, stepRecords, studyTranscript, LOOK_LANGUAGE } = require('../src/services/booth-dialogue');

// readEventCases logs each case it leaves out; the invariant reads only the admitted ones.
beforeAll(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterAll(() => jest.restoreAllMocks());

const DIR = path.join(__dirname, '../src/booth-cases');
const EVENTS = fs.readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && SAFE_EVENT_CODE.test(d.name)).map((d) => d.name);
const SNAPSHOTS = EVENTS.flatMap((code) => {
  const dir = path.join(DIR, code, 'versions');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => path.join(dir, f)) : [];
});

test('the event folders hold admitted cases and snapshots to check', () => {
  expect(EVENTS).toContain('NFCME-2026');
  expect(EVENTS.flatMap((code) => readEventCases(DIR, code)).length).toBeGreaterThan(0);
  expect(SNAPSHOTS.length).toBeGreaterThan(0);
});

test('every admitted case version has a study snapshot that is exactly its case file\'s', () => {
  const problems = EVENTS.flatMap((code) => readEventCases(DIR, code).flatMap((kase) => {
    const { state } = snapshotState(DIR, kase);
    return state === 'kept' ? [] : [snapshotProblem(kase, state)];
  }));
  expect(problems).toEqual([]);
});

const LETTERS = ['B', 'R', 'W'];
const TIER = { B: 'best', R: 'reasonable', W: 'weaker' };

/** A tapped play along `tierPath`: each step the bank's first variant and its first option of each tier. */
function walk(kase, tierPath) {
  const steps = [...tierPath].map((letter, i) => {
    const bank = bankAt(kase, tierPath.slice(0, i));
    const options = LETTERS.map((l) => bank.options.find((o) => o.tier === TIER[l]).id);
    return { ask: { variant: bank.variants[0].id, bridge: '', options }, answer: { choice: options[LETTERS.indexOf(letter)] } };
  });
  const replies = steps.map(() => ({ strength: 'ดี', weigh: '', safety: '' }));
  return { asks: steps.map((s) => s.ask), answers: steps.map((s) => s.answer), replies, tierPath };
}

test.each(SNAPSHOTS.map((f) => [path.relative(DIR, f), f]))('%s is a study snapshot of its own case and version, and rebuilds a play in every look', (_name, file) => {
  const parsed = StudyCaseSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  expect(parsed.error?.issues ?? []).toEqual([]);
  const { event_code: code, case_id: id, version, banks } = parsed.data;
  expect(file).toBe(snapshotFile(DIR, code, id, version));
  const kase = readStudyCase(DIR, code, id, version);
  const tierPath = Object.keys(banks).map((_, i) => LETTERS[i % 3]).join('');
  const steps = stepRecords(walk(kase, tierPath));
  // null is a play scored before #377; each look reads in its primary language (#377).
  for (const look of [null, ...Object.keys(LOOK_LANGUAGE)]) {
    const physician = studyTranscript(kase, steps, look).messages?.filter((t) => t.role === 'physician');
    expect(physician).toHaveLength(tierPath.length);
    expect(physician[0].content.startsWith(`${kase.vignette[LOOK_LANGUAGE[look ?? 'th+en']]}\n\n`)).toBe(true);
  }
});
