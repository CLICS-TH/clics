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

// The NFCME-2026 pool holds no admitted case between the five-step move (#386) and its tables (#408), so the snapshot
// check below may read none; the snapshots of every version played before the move stay and are checked here.
test('the event folders keep the snapshot of every NFCME-2026 version admitted before the five-step move', () => {
  expect(EVENTS).toContain('NFCME-2026');
  const before = { adhf: [3, 4], 'alcohol-pancreatitis': [2, 3], 'copd-exacerbation': [4, 5], 'dka-young-adult': [4, 5],
    'ectopic-rupture': [3, 4], leptospirosis: [2, 3], 'melioidosis-farmer': [2, 3], 'motorcycle-shock': [1, 2],
    organophosphate: [2, 3], 'sjs-ten-allopurinol': [2, 3], 'toddler-gastro-dehydration': [1, 2] };
  const kept = new Set(SNAPSHOTS.map((f) => path.relative(DIR, f)));
  const lost = Object.entries(before).flatMap(([id, versions]) => versions.map((v) => `NFCME-2026/versions/${id}@${v}.json`))
    .filter((f) => !kept.has(f));
  expect(lost).toEqual([]);
});

test('every admitted case version has a study snapshot that is exactly its case file\'s', () => {
  const problems = EVENTS.flatMap((code) => readEventCases(DIR, code).cases.flatMap((kase) => {
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

// The auditor's screen cuts the case's own text (gate #370 round 3): a lab value in it, such as leptospirosis'
// platelets (110,000), would otherwise withhold every play through its bank. A tapped play along every tier path of
// every snapshot rebuilds, in every look.
const pathsOf = (n) => (n === 0 ? [''] : pathsOf(n - 1).flatMap((p) => LETTERS.map((l) => p + l)));
test.each(SNAPSHOTS.map((f) => [path.relative(DIR, f), f]))('%s rebuilds a tapped play along every tier path', (_name, file) => {
  const { event_code: code, case_id: id, version, banks } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const kase = readStudyCase(DIR, code, id, version);
  const withheld = pathsOf(Object.keys(banks).length).flatMap((tierPath) => {
    const steps = stepRecords(walk(kase, tierPath));
    return [null, ...Object.keys(LOOK_LANGUAGE)].flatMap((look) => {
      const rebuilt = studyTranscript(kase, steps, look);
      return rebuilt.messages ? [] : [`${tierPath} ${look}: ${rebuilt.why}`];
    });
  });
  expect(withheld).toEqual([]);
});
