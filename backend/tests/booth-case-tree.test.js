const fs = require('fs');
const path = require('path');
const { TIERS, caseTreeProblems, isAdmitted, tableScore } = require('../src/booth-cases/tree-schema');
const { compositeScore } = require('../src/services/ple-gate');
const { replyProblems, readReplies } = require('../../scripts/booth/path-table-sample');

const DIR = path.join(__dirname, '../src/booth-cases');
const FIXTURE = path.join(__dirname, 'fixtures/booth-case-tree.json');
const TABLE = path.join(__dirname, 'fixtures/booth-path-score-table.json');
const FIXTURE5 = path.join(__dirname, 'fixtures/booth-case-tree-5.json');
const TABLE5 = path.join(__dirname, 'fixtures/booth-path-score-table-5.json');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const naming = (...parts) => expect.arrayContaining([expect.stringMatching(
  new RegExp(parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')))]);

const eventFiles = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
  .flatMap((d) => fs.readdirSync(path.join(dir, d.name)).filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: `${prefix}${d.name}/${f}`, file: path.join(dir, d.name, f), event: d.name, id: f.replace(/\.json$/, '') })));
// A five-step version waits in staging/<EVENT>/ until the cutover (#386) moves it into place. The loader reads only
// <EVENT>/ folders, so a staged case is never drawn.
const STAGING = path.join(DIR, 'staging');
const STAGED = fs.existsSync(STAGING) ? eventFiles(STAGING, 'staging/') : [];
const CASE_FILES = [...eventFiles(DIR), ...STAGED];

// A case file must also be named after its case id and sit in its event's folder; the fixtures have no folder.
test.each([{ name: 'the fixture', file: FIXTURE }, { name: 'the five-step fixture', file: FIXTURE5 }, ...CASE_FILES])('$name passes every shape and safety rule', ({ file, event, id }) => {
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
    ['a Thai question over two lines', (k) => {
      k.banks.step2.R.variants[0].question.th = 'โปรดระบุ\nHN';
    }, ['banks.step2.R.variants[0].question.th: ', 'line break']],
    ['an English question over two lines', (k) => {
      k.banks.step1.variants[1].question.en = 'Please give\r\nthe HN';
    }, ['banks.step1.variants[1].question.en: ', 'line break']],
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
    ['a domain of -1', (t) => { t.paths.RBW.d3 = -1; }, ['path_score_table.paths.RBW.d3: ', '0']],
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

describe('the five-step shape (spec #370): 13 banks keyed on the previous tier, a fitted table at one decimal', () => {
  const tree = read(FIXTURE5);
  const tabled = { ...tree, path_score_table: read(TABLE5) };
  const edited = (base, fn) => { const k = structuredClone(base); fn(k); return caseTreeProblems(k); };

  test('the fixture passes with and without its table, and with it is admitted', () => {
    expect([caseTreeProblems(tree), caseTreeProblems(tabled), isAdmitted(tabled)]).toEqual([[], [], true]);
  });

  test.each([
    ['a missing step-5 bank', (k) => { delete k.banks.step5.W; }, ['banks.step5.W: ', 'Required']],
    ['a missing step 5', (k) => { delete k.banks.step5; }, ['banks.step5: ', 'Required']],
    ['a step-3 bank keyed by two tiers', (k) => { k.banks.step3.BR = k.banks.step3.B; }, ['banks.step3: ', "'BR'"]],
    ['a step-4 bank with no weaker option', (k) => {
      k.banks.step4.R.options = k.banks.step4.R.options.filter((o) => o.tier !== 'weaker');
    }, ['banks.step4.R.options: ', 'weaker']],
    ['an over-budget English line at step 4', (k) => {
      k.banks.step4.R.options[1].line.en = `${'x'.repeat(66)} long`;
    }, ['banks.step4.R.options[1].line.en: ', 'limit 70']],
    ['a withholding label at step 5', (k) => {
      k.banks.step5.B.options[0].label.en = 'Defer the repeat X-ray';
    }, ['banks.step5.B.options[0].label.en: ', 'withholding']],
  ])('%s fails and names its field', (_name, fn, parts) => {
    expect(edited(tree, fn)).toEqual(naming(...parts));
  });

  test.each([
    ['method median', (t) => { t.provenance.method = 'median'; }, ['path_score_table.provenance.method: ', 'median-regression']],
    ['a two-decimal domain', (t) => { t.paths.BRWRR.d5 = 2.65; }, ['path_score_table.paths.BRWRR.d5: ', 'one decimal']],
    ['a domain over 5', (t) => { t.paths.BRWRR.d3 = 5.1; }, ['path_score_table.paths.BRWRR.d3: ', '5']],
    ['a domain under 0', (t) => { t.paths.WWWWW.d6 = -0.1; }, ['path_score_table.paths.WWWWW.d6: ', '0']],
    ['a missing path', (t) => { delete t.paths.RRRRW; }, ['path_score_table.paths.RRRRW: ', 'Required']],
  ])('a five-step table with %s fails and names its field', (_name, fn, parts) => {
    expect(edited(tabled, (k) => fn(k.path_score_table))).toEqual(naming(...parts));
  });

  test('a table of the other shape fails on the table, whichever way round', () => {
    expect(caseTreeProblems({ ...tree, path_score_table: read(TABLE) }))
      .toEqual([expect.stringMatching(/^path_score_table: is a 3-step table .* on a 5-step tree$/)]);
    expect(caseTreeProblems({ ...read(FIXTURE), path_score_table: read(TABLE5) }))
      .toEqual([expect.stringMatching(/^path_score_table: is a 5-step table .* on a 3-step tree$/)]);
  });

  test('a play scores its tier path\'s table entry: one-decimal domains and a whole composite at five steps', () => {
    const { paths } = tabled.path_score_table;
    const fivePath = Object.keys(paths).find((p) => Object.values(paths[p]).some((v) => !Number.isInteger(v)));
    expect(tableScore(tabled, fivePath))
      .toEqual({ domains: paths[fivePath], composite: Math.round(compositeScore(paths[fivePath])) });
    const three = { ...read(FIXTURE), path_score_table: read(TABLE) };
    const { BRW } = three.path_score_table.paths;
    expect(tableScore(three, 'BRW')).toEqual({ domains: BRW, composite: compositeScore(BRW) });
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

  const waived = (k) => ({ ...k, admission: { ...k.admission, owner_waiver: { date: '2026-11-03', adr: '0005', reason: 'Owner waiver',
    sandbox_run_id: 'sbx-fixture', tree_sha256: good.admission.sandbox.tree_sha256 } } });

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

  const tableRun = good.path_score_table.provenance.run_id;
  const judged = (k, admission) => ({ ...k, admission: { ...k.admission, ...admission } });
  const unjudged = (k) => { const c = structuredClone(k); delete c.admission.table_check; return c; };
  const tableWaiver = (runId) => ({ table_waiver: { date: '2026-11-09', adr: '0005', reason: 'Owner waiver', run_id: runId } });

  test('a table admits its case only by a passing re-check or an owner waiver on that table\'s own run (ADR 0005)', () => {
    expect(isAdmitted(good)).toBe(true);
    const older = waived(unjudged(without('sandbox')));
    expect(caseTreeProblems(older)).toEqual([]);
    expect(isAdmitted(older)).toBe(false);
    expect(isAdmitted(judged(older, { table_check: { run_id: 'ptb-earlier', date: '2026-11-04' } }))).toBe(false);
    expect(isAdmitted(judged(older, tableWaiver('ptb-earlier')))).toBe(false);
    expect(isAdmitted(judged(older, tableWaiver(tableRun)))).toBe(true);
    expect(isAdmitted(judged(older, { table_check: { run_id: tableRun, date: '2026-11-04' } }))).toBe(true);
  });

  test.each([
    ['another ADR', (w) => { w.adr = '0006'; }, 'admission.table_waiver.adr'],
    ['no run id', (w) => { delete w.run_id; }, 'admission.table_waiver.run_id'],
    ['an empty reason', (w) => { w.reason = ''; }, 'admission.table_waiver.reason'],
  ])('a table waiver with %s is a problem', (_, change, field) => {
    const k = judged(unjudged(good), tableWaiver(tableRun));
    change(k.admission.table_waiver);
    expect(caseTreeProblems(k).some((p) => p.startsWith(field))).toBe(true);
  });

  test('every NFCME-2026 case but dka-young-adult is a five-step tree whose safety review is bound to it, and none is admitted before #408 builds its table', () => {
    const { treeSha } = require('../src/booth-cases/tree-sha');
    const dir = path.join(__dirname, '../src/booth-cases/NFCME-2026');
    const cases = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => read(path.join(dir, f)));
    expect(cases).toHaveLength(11);
    const five = cases.filter((k) => k.banks.step5);
    expect(cases.filter((k) => !k.banks.step5).map((k) => k.case_id)).toEqual(['dka-young-adult']);
    expect(five.filter((k) => k.admission.safety_review?.tree_sha256 !== treeSha(k)).map((k) => k.case_id)).toEqual([]);
    expect(five.filter((k) => k.path_score_table || k.admission.sandbox || k.admission.owner_waiver).map((k) => k.case_id)).toEqual([]);
    expect(cases.filter(isAdmitted).map((k) => k.case_id)).toEqual([]);
  });

  test('a case with no admission marker is valid but not admitted', () => {
    const k = structuredClone(good);
    delete k.admission;
    expect(caseTreeProblems(k)).toEqual([]);
    expect(isAdmitted(k)).toBe(false);
  });
});

test('every staged case is a five-step tree whose staged sample replies the table build would take', () => {
  const REPLIES = path.join(__dirname, '../../scripts/booth/sample-replies/staging');
  const problems = STAGED.flatMap(({ name, file, event }) => {
    const kase = read(file);
    const steps = Object.keys(kase.banks).length;
    if (steps !== 5) return [`${name}: has ${steps} steps`];
    try {
      return replyProblems(kase, readReplies(kase, path.join(REPLIES, event))).map((p) => `${name}: ${p}`);
    } catch (err) { return [`${name}: ${err.message}`]; }
  });
  expect(problems).toEqual([]);
});

describe('the teaser budget the kiosk harness fits (scripts/booth/scenarios/draw.mjs)', () => {
  const withTeaser = (teaser) => caseTreeProblems({ ...read(FIXTURE), teaser }).filter((p) => p.startsWith('teaser'));

  test('120 Thai and 180 English characters are accepted, one more of either is rejected', () => {
    expect(withTeaser({ th: 'ก'.repeat(120), en: 'x'.repeat(180) })).toEqual([]);
    expect(withTeaser({ th: 'ก'.repeat(121), en: 'x'.repeat(180) })).toHaveLength(1);
    expect(withTeaser({ th: 'ก'.repeat(120), en: 'x'.repeat(181) })).toHaveLength(1);
  });
});
