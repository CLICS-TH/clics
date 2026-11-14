// #474: identifier shapes stripPii and the booth label rule let through, and a version string they over-masked.
// One row per shape: [shape, input, a pattern of the raw identifier that must be gone]. Keep rows hold clinical text
// that must come back exactly as written.
const { stripPii, maskLabelledTail, makeRegistry } = require('../src/services/pii-filter');

const phoneWith = (sep) => `call 081${sep}234${sep}5678 now`;
const hex = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

const LEAK = [
  // Dates
  ['date slash year-first', 'visit 2569/12/11 follow', /2569|12\/11/],
  ['date slash year-first, one-digit month and day', 'visit 2024/1/5 follow', /2024/],
  ['date dash day-first', 'seen 11-12-2569 today', /2569/],
  ['date dash day-first, two-digit year', 'seen 11-12-69 today', /11-12|69/],
  ['date iso single digit', 'on 2026-1-5 admitted', /2026/],
  ['dotted date two spaces', 'born 1999.  1.2 x', /1999/],
  ['dotted date day-first, three spaces', 'born 20.   10.   2026 x', /2026/],
  // The NUMBERING_LABEL v must start a word, or "Nov" reads as a version label.
  ['dotted date after Nov', 'seen Nov 20.10.2026', /2026/],
  ['dotted date after NOV', 'seen NOV 20.10.2026', /2026/],
  ['month-name en', 'DOB 20 Oct 1967 ok', /1967/],
  ['month-name en, full', 'DOB 20 October 1967 ok', /1967/],
  ['month-name en, month first', 'DOB Oct 20, 1967 ok', /1967/],
  ['month-name en, upper case', 'DOB 20 OCT 1967 ok', /1967/],
  ['month-name en, lower case month first', 'dob oct 20, 1967 ok', /1967/],
  ['month-name th', 'เกิด 20 ตุลาคม 2510 ค่ะ', /2510/],
  ['month-name th, abbreviated, two-digit year', 'เกิด 20 ต.ค. 10 ค่ะ', /20 ต\.ค\.|ต\.ค\. 10/],
  ['month-name th, full, two-digit year', 'เกิด 5 มีนาคม 67 ค่ะ', /67/],
  ['month-name th, abbreviated, four-digit year', 'เกิด 1 ม.ค. 2501 ค่ะ', /2501/],
  // Separator look-alikes
  ['en dash phone', 'call 081–234–5678 now', /234/],
  ['nb hyphen phone', 'call 081‑234‑5678 now', /234/],
  ['middle dot phone', 'call 081·234·5678 now', /234/],
  ['ID U+2011', 'id 1‑2345‑67890‑12‑3 x', /67890/],
  ...['‐', '‑', '‒', '–', '—', '―', '⁃', '−', '﹘', '﹣']
    .map((d) => [`dash ${hex(d)} phone`, phoneWith(d), /234/]),
  ...['·', '‧', '∙', '⋅', '・'].map((d) => [`middle dot ${hex(d)} phone`, phoneWith(d), /234/]),
  // Non-decimal digits
  ['keycap phone', 'tel 0️⃣8️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣ x', /\d\uFE0F?\u20E3/],
  ['keycap phone, no variation selector', 'tel 0⃣8⃣1⃣2⃣3⃣4⃣5⃣6⃣7⃣8⃣ x', /\d\u20E3/],
  ['circled phone', 'tel ⓪⑧①②③④⑤⑥⑦⑧ x', /⑧①②/],
  ['negative circled phone', 'tel ⓿❽❶❷❸❹❺❻❼❽ x', /❽❶❷/],
  ['dingbat circled phone', 'tel \u{1F10B}➇➀➁➂➃➄➅➆➇ x', /➇➀➁/],
  ['dingbat negative circled phone', 'tel \u{1F10C}➑➊➋➌➍➎➏➐➑ x', /➑➊➋/],
  ['math bold HN', '𝐇𝐍 12345678 seen', /12345678/],
  // Labels
  ['Ward colon', 'Ward: 5A bed 3', /5A/],
  ['ward hash', 'ward #4B bed 3', /4B/],
  ['หอผู้ป่วย colon', 'หอผู้ป่วย: 7 เตียง 3', /: 7/],
  ['age equals', 'age = 45 male', /45/],
  ['Age=', 'Age=45 male', /45/],
  ['อายุ =', 'อายุ = 45 เพศชาย', /45/],
  ['อายุ:', 'อายุ: 45 ปี เพศชาย', /45/],
  ['HN tail', 'HN 1234/67 seen', /\/67|67/],
  ['HN tail, spaced', 'HN 1234 / 67 seen', /67/],
  ['MRN tail', 'MRN 123456/67 seen', /67/],
  ['AN tail, spaced', 'AN 1234 / 67 seen', /67/],
  ['house no tail', 'บ้านเลขที่ 99 / 1 ถนน', /\/ 1/],
  ['house no dash tail', 'เลขที่ 99 - 1 ถนน', /- 1/],
];

const KEEP = [
  ['VERSION caps', 'VERSION 2024.10.1'],
  ['version colon', 'ECG software version: 2024.10.1'],
  ['Section colon', 'Section: 1.2.10'],
  ['SECTION caps', 'see SECTION 1.2.10'],
  ['BP', 'BP 120/80 HR 90'],
  ['lab', 'Na 140.00 139.50'],
  ['dose range', 'titrate 5-10-15 mg'],
  ['superscript cube', 'WBC 12 x 10³/µL'],
  ['superscript nine', 'Plt 250 x 10⁹/L'],
  ['fraction', 'take ½ tab bid'],
  ['middle-dot decimal', 'Hb 12·5 g/dL'],
  ['ward round', 'ward round at 8'],
  ['Ward: round', 'Ward: round at 8'],
  ['wards', 'wards are full'],
];

describe('#474 stripPii masks each shape', () => {
  test.each(LEAK)('%s', (_shape, input, raw) => {
    expect(stripPii(input)).not.toMatch(raw);
  });
});

describe('#474 stripPii keeps clinical text', () => {
  test.each(KEEP)('%s', (_shape, input) => {
    expect(stripPii(input)).toBe(input);
  });
});

// A look-alike glued to an identifier folds only where it cannot join it (asciiView, JOINS): each of these was masked
// before #474 because the look-alike read as an unknown character beside it.
describe('#474 a look-alike glued to an identifier loses no mask', () => {
  test.each([
    ['circled digit before a phone', 'tel ①0812345678 x', /5678/],
    ['circled digit after a phone', 'tel 0812345678① x', /5678/],
    ['circled digit and slash before a date', 'on ①/20/10/2569 x', /2569/],
    ['keycap before a phone', 'tel 1️⃣0812345678 x', /5678/],
    ['math letter before a date', 'on 𝐀20/10/2569 x', /2569/],
    ['math letters before an ID', 'id 𝐃𝐎𝐁1234567890123 x', /67890/],
    ['math letter before HN', 'see 𝐀HN 1234567 x', /1234567/],
    ['minus sign before a LINE id', 'add −line id abc_12 x', /abc_12/],
    // A middle dot reads as a space, never a decimal point, so the date does not end inside a decimal (NOT_IN_DECIMAL).
    ['date then middle dot and digit', 'seen 20/10/2569·5 x', /2569/],
    // The dotted-date passes read mathematical letters as written, so a label in them takes no NUMBERING_LABEL exemption.
    ['math-letter version label before a dotted date', '𝐯𝐞𝐫𝐬𝐢𝐨𝐧 20.10.2026', /2026/],
  ])('%s', (_shape, input, raw) => {
    expect(stripPii(input)).not.toMatch(raw);
  });
});

describe('#474 booth label rule reads mathematical letters', () => {
  test.each([
    ['math bold Name', '𝐍𝐚𝐦𝐞: Somchai Jaidee', /Somchai|Jaidee/],
    ['math bold AN', '𝐀𝐍 123456', /123456/],
  ])('%s', (_shape, input, raw) => {
    expect(maskLabelledTail(input, makeRegistry())).not.toMatch(raw);
  });
});

// #474 comment: "LINE" then a long run of spaces and no id backtracked quadratically (909 ms at n = 40000).
test('a LINE label followed by 40000 spaces finishes in linear time', () => {
  const input = `LINE${' '.repeat(40000)}!`;
  const t0 = process.hrtime.bigint();
  stripPii(input);
  expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(100);
});
