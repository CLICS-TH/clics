const fs = require('fs');
const path = require('path');
const { TIERS, caseTreeProblems, isAdmitted } = require('../src/booth-cases/tree-schema');

const DIR = path.join(__dirname, '../src/booth-cases');
const FIXTURE = path.join(__dirname, 'fixtures/booth-case-tree.json');
const TABLE = path.join(__dirname, 'fixtures/booth-path-score-table.json');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const naming = (...parts) => expect.arrayContaining([expect.stringMatching(
  new RegExp(parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')))]);

const CASE_FILES = fs.readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
  .flatMap((d) => fs.readdirSync(path.join(DIR, d.name)).filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: `${d.name}/${f}`, file: path.join(DIR, d.name, f), event: d.name, id: f.replace(/\.json$/, '') })));

// A case file must also be named after its case id and sit in its event's folder; the fixture has no folder.
test.each([{ name: 'the fixture', file: FIXTURE }, ...CASE_FILES])('$name passes every shape and safety rule', ({ file, event, id }) => {
  const kase = read(file);
  expect({ problems: caseTreeProblems(kase), case_id: kase.case_id, event_code: kase.event_code })
    .toEqual({ problems: [], case_id: id ?? kase.case_id, event_code: event ?? kase.event_code });
});

test('the tiers are best, reasonable and weaker, lettered B, R and W', () => {
  expect(TIERS.map((t) => `${t.name}:${t.letter}`)).toEqual(['best:B', 'reasonable:R', 'weaker:W']);
});

describe('a single edit to the fixture fails and names the field', () => {
  const good = read(FIXTURE);
  const edited = (fn) => { const k = structuredClone(good); fn(k); return caseTreeProblems(k); };

  test('the unedited fixture has no problems, so each edit below fails on its edit alone', () => {
    expect(edited(() => {})).toEqual([]);
  });

  test.each([
    ['a bank with no reasonable option', (k) => {
      k.banks.step3.BR.options = k.banks.step3.BR.options.filter((o) => o.tier !== 'reasonable');
    }, ['banks.step3.BR.options: ', 'reasonable']],
    ['a 14th bank in step 2', (k) => { k.banks.step2.X = k.banks.step2.B; }, ['banks.step2: ', "'X'"]],
    ['a 14th bank in step 3', (k) => { k.banks.step3.BX = k.banks.step3.BB; }, ['banks.step3: ', "'BX'"]],
    ['a missing step-3 bank', (k) => { delete k.banks.step3.WW; }, ['banks.step3.WW: ']],
    ['an over-budget English line', (k) => {
      k.banks.step2.R.options[0].line.en = `${'x'.repeat(66)} long`;
    }, ['banks.step2.R.options[0].line.en: ', 'limit 70']],
    ['an over-budget Thai label', (k) => {
      k.banks.step1.options[2].label.th = 'ก'.repeat(27);
    }, ['banks.step1.options[2].label.th: ', 'limit 26']],
    ['a withholding label', (k) => {
      k.banks.step3.WB.options[1].label.en = 'Await the sputum culture';
    }, ['banks.step3.WB.options[1].label.en: ', 'withholding']],
    ['an inflected delaying label', (k) => {
      k.banks.step3.BB.options[0].label.en = 'Antibiotics postponed 2 days';
    }, ['banks.step3.BB.options[0].label.en: ', 'withholding']],
    ['a bare Thai wait in a line', (k) => {
      k.banks.step3.BB.options[0].line.th = 'รอเพาะเชื้อก่อนให้ยาจะแม่นกว่า';
    }, ['banks.step3.BB.options[0].line.th: ', 'withholding']],
    ['a line that hedges against its option', (k) => {
      k.banks.step1.options[0].line.en = 'It is unlikely to fit here.';
    }, ['banks.step1.options[0].line.en: ', 'argues against']],
    ['a delaying Thai question variant', (k) => {
      k.banks.step3.BB.variants[1].question.th = 'คุณจะรอผลเพาะเชื้อก่อนหรือไม่';
    }, ['banks.step3.BB.variants[1].question.th: ', 'รอผล']],
    ['Thai script in an English field', (k) => {
      k.banks.step2.W.options[3].label.en = 'Sputum ย้อมแกรม';
    }, ['banks.step2.W.options[3].label.en: ', 'has Thai script']],
    ['no Thai script in a Thai field', (k) => { k.vignette.th = 'A 52-year-old man'; }, ['vignette.th: ', 'has no Thai script']],
    ['a line that argues against its option', (k) => {
      k.banks.step1.options[0].line.en = 'Likely, but crackles alone are weak.';
    }, ['banks.step1.options[0].line.en: ', 'argues against']],
    ['an overclaim in the vignette', (k) => { k.vignette.en += ' Seen at a validated clinic.'; }, ['vignette.en: ', 'validated']],
    ['a duplicate option id', (k) => { k.banks.step3.RR.options[1].id = 'a'; }, ['banks.step3.RR.options[1].id: ', 'duplicate']],
    ['a default trio with two options of one tier', (k) => {
      k.banks.step2.B.default_trio = ['a', 'b', 'c'];
    }, ['banks.step2.B.default_trio: ', 'one option per tier']],
    ['a default trio naming an unknown option', (k) => {
      k.banks.step1.default_trio[2] = 'z';
    }, ['banks.step1.default_trio[2]: ', '"z"']],
    ['an English teaser that names the diagnosis', (k) => {
      k.teaser.en = 'A man with fever, cough and pneumonia on his mind';
    }, ['teaser.en: ', 'pneumonia']],
    ['a Thai teaser that hints the diagnosis', (k) => {
      k.teaser.th = 'ชายวัย 52 ปี ไข้ ไอ ปอดเป็นอะไร';
    }, ['teaser.th: ', 'ปอด']],
    ['an admission date that is not a calendar date', (k) => {
      k.admission.safety_review.date = '2026-02-30';
    }, ['admission.safety_review.date: ', 'calendar date']],
    ['an unknown key on an option', (k) => { k.banks.step1.options[0].hint = 'x'; }, ['banks.step1.options[0]: ', "'hint'"]],
  ])('%s', (_name, fn, parts) => {
    expect(edited(fn)).toEqual(naming(...parts));
  });
});

describe('the path score table (ADR 0009)', () => {
  const tabled = { ...read(FIXTURE), path_score_table: read(TABLE) };
  const edited = (fn) => { const k = structuredClone(tabled); fn(k.path_score_table); return caseTreeProblems(k); };
  const PROVENANCE = ['evaluator_model', 'prompt_sha256', 'decoding', 'samples_per_path', 'method', 'run_id', 'date', 'tree_sha256'];

  test('the fixture with the table attached passes every shape and safety rule', () => {
    expect(edited(() => {})).toEqual([]);
  });

  test.each([
    ['a missing path', (t) => { delete t.paths.WRB; }, ['path_score_table.paths.WRB: ', 'Required']],
    ['an extra path', (t) => { t.paths.BBBB = t.paths.BBB; }, ['path_score_table.paths: ', "'BBBB'"]],
    ['a domain of 0', (t) => { t.paths.RBW.d3 = 0; }, ['path_score_table.paths.RBW.d3: ', '1']],
    ['a domain of 6', (t) => { t.paths.RBW.d3 = 6; }, ['path_score_table.paths.RBW.d3: ', '5']],
    ['a fractional domain', (t) => { t.paths.BRW.d4 = 2.5; }, ['path_score_table.paths.BRW.d4: ', 'integer']],
    ['a missing domain', (t) => { delete t.paths.WWB.d7; }, ['path_score_table.paths.WWB.d7: ', 'Required']],
    ['a domain sent as text', (t) => { t.paths.BBB.d1 = '5'; }, ['path_score_table.paths.BBB.d1: ', 'number']],
    ...PROVENANCE.map((key) => [`no provenance ${key}`, (t) => { delete t.provenance[key]; }, [`path_score_table.provenance.${key}: `]]),
    ['a method other than median', (t) => { t.provenance.method = 'mean'; }, ['path_score_table.provenance.method: ', 'median']],
    ['a prompt_sha256 that is not 64 hex', (t) => { t.provenance.prompt_sha256 = t.provenance.prompt_sha256.slice(1); },
      ['path_score_table.provenance.prompt_sha256: ', '64']],
    ['a negative temperature', (t) => { t.provenance.decoding.temperature = -0.1; }, ['path_score_table.provenance.decoding.temperature: ']],
    ['a fractional max_tokens', (t) => { t.provenance.decoding.max_tokens = 40.5; }, ['path_score_table.provenance.decoding.max_tokens: ']],
    ['no samples per path', (t) => { t.provenance.samples_per_path = 0; }, ['path_score_table.provenance.samples_per_path: ']],
    ['an unknown key in provenance', (t) => { t.provenance.by = 'owner'; }, ['path_score_table.provenance: ', "'by'"]],
  ])('%s fails and names its field', (_name, fn, parts) => {
    expect(edited(fn)).toEqual(naming(...parts));
  });

  test('a tree edited after its table was built fails on the table\'s tree hash; a new version or admission does not', () => {
    const k = structuredClone(tabled);
    k.version = '9';
    k.admission.owner_waiver = { date: '2026-11-04', adr: '0005', reason: 'r', sandbox_run_id: 's' };
    expect(caseTreeProblems(k)).toEqual([]);
    k.banks.step1.options[0].line.th += ' ค่ะ';
    expect(caseTreeProblems(k)).toEqual([expect.stringMatching(/^path_score_table\.provenance\.tree_sha256: is not this tree's hash/)]);
  });
});

test('a Thai line may say since or each without reading as but', () => {
  const k = read(FIXTURE);
  k.banks.step1.options[0].line.th = 'ไข้ตั้งแต่ 3 วันก่อน แต่ละอาการเข้าได้';
  expect(caseTreeProblems(k)).toEqual([]);
});

describe('admission', () => {
  const good = { ...read(FIXTURE), path_score_table: read(TABLE) };
  const without = (part) => { const k = structuredClone(good); delete k.admission[part]; return k; };

  test('a case with the safety review, the sandbox run and its path score table is admitted', () => {
    expect(isAdmitted(good)).toBe(true);
  });

  test('a case without its path score table is valid but not admitted (ADR 0005, 0009)', () => {
    const { path_score_table: _table, ...untabled } = good;
    expect(caseTreeProblems(untabled)).toEqual([]);
    expect(isAdmitted(untabled)).toBe(false);
  });

  test.each(['safety_review', 'sandbox'])('a case without its %s part is valid but not admitted', (part) => {
    expect(caseTreeProblems(without(part))).toEqual([]);
    expect(isAdmitted(without(part))).toBe(false);
  });

  const waived = (k) => ({ ...k, admission: { ...k.admission,
    owner_waiver: { date: '2026-11-03', adr: '0005', reason: 'Owner waiver', sandbox_run_id: 'sbx-fixture' } } });

  test('an owner waiver stands in for the sandbox run, never for the safety review', () => {
    expect(caseTreeProblems(waived(without('sandbox')))).toEqual([]);
    expect(isAdmitted(waived(without('sandbox')))).toBe(true);
    expect(isAdmitted(waived(without('safety_review')))).toBe(false);
  });

  test.each([
    ['another ADR', (w) => { w.adr = '0006'; }, 'admission.owner_waiver.adr'],
    ['no run id', (w) => { delete w.sandbox_run_id; }, 'admission.owner_waiver.sandbox_run_id'],
    ['an empty reason', (w) => { w.reason = ''; }, 'admission.owner_waiver.reason'],
    ['a date that is not a calendar date', (w) => { w.date = '2026-02-30'; }, 'admission.owner_waiver.date'],
    ['an extra field', (w) => { w.by = 'owner'; }, 'admission.owner_waiver'],
  ])('a waiver with %s is a problem', (_, change, field) => {
    const k = waived(without('sandbox'));
    change(k.admission.owner_waiver);
    expect(caseTreeProblems(k).some((p) => p.startsWith(field))).toBe(true);
  });

  test('every NFCME-2026 case is admitted with its path score table: leptospirosis by the sandbox, the other ten by the owner waiver', () => {
    const dir = path.join(__dirname, '../src/booth-cases/NFCME-2026');
    const cases = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => read(path.join(dir, f)));
    expect(cases).toHaveLength(11);
    expect(cases.filter((k) => !k.path_score_table).map((k) => k.case_id)).toEqual([]);
    expect(cases.filter(isAdmitted)).toHaveLength(11);
    expect(cases.filter((k) => k.admission.sandbox).map((k) => k.case_id)).toEqual(['leptospirosis']);
    expect(cases.filter((k) => k.admission.owner_waiver)).toHaveLength(10);
  });

  test('a case with no admission marker is valid but not admitted', () => {
    const k = structuredClone(good);
    delete k.admission;
    expect(caseTreeProblems(k)).toEqual([]);
    expect(isAdmitted(k)).toBe(false);
  });
});

describe('the teaser budget the kiosk harness fits (scripts/booth/scenarios/draw.mjs)', () => {
  const withTeaser = (teaser) => caseTreeProblems({ ...read(FIXTURE), teaser }).filter((p) => p.startsWith('teaser'));

  test('120 Thai and 180 English characters are accepted, one more of either is rejected', () => {
    expect(withTeaser({ th: 'ก'.repeat(120), en: 'x'.repeat(180) })).toEqual([]);
    expect(withTeaser({ th: 'ก'.repeat(121), en: 'x'.repeat(180) })).toHaveLength(1);
    expect(withTeaser({ th: 'ก'.repeat(120), en: 'x'.repeat(181) })).toHaveLength(1);
  });
});
