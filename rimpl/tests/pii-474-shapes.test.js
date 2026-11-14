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
  // Review round: a sub-number tail never takes a following date's day.
  ['HN then a slash date', 'HN 1234567 / 20/10/2569 seen', /2569|\/10\//],
  ['AN glued to a slash date', 'AN 123456/20/10/69 seen', /10\/69/],
  ['HN then a dotted date', 'HN 1234567 / 20.10.2569 seen', /2569/],
  ['MRN then a dashed date', 'MRN 123456 / 20-10-2569 seen', /2569/],
  ['house number then a dotted date', 'เลขที่ 99 - 20.10.2569 ถนน', /2569/],
  // Middle dots read as '.' in the dotted phone, dotted date and email passes only.
  ['middle-dot date, day first', 'seen 20·10·2569 x', /2569/],
  ['middle-dot date, year first', 'seen 2026·10·20 x', /2026/],
  ['ASCII dotted date then a middle dot and digit', 'seen 20.10.2569·5 x', /2569/],
  ['middle dot in an email local part', 'mail somchai·j@example.com now', /somchai|example/],
  ['middle dot in an email domain', 'mail somchai@example·com now', /somchai|example/],
  ['middle-dot email then HN', 'mail somchai·j@example.com·HN 1234567', /1234567|somchai/],
  ['date then a middle-dot email', 'on 20/10/2569-somchai·j@example.com', /2569|example/],
  // A rejected run is retried from its next character (applyPass).
  ['short number then a landline, en dash', 'call 05–021234567 now', /1234567/],
  ['short number then a landline, middle dot', 'call 05·021234567 now', /1234567/],
  ['short number then a landline, hyphen', 'call 05-021234567 now', /1234567/],
  ['short number, landline, then a date', 'call 05–021234567 20/10/2569', /1234567|2569/],
  ['phone then an ID-shaped run', 'tel 0812345678 081-234-5678 x', /234|5678/],
  // Numbering labels: any case and a colon only for section, version, chapter.
  ...['V: ', 'Rev: ', 'ข้อ: ', 'SEC ', 'VER ', 'v: ', 'Ver: '].map((l) => [`dotted date after ${JSON.stringify(l)}`, `${l}20.10.2569`, /2569/]),
  ['dotted date then a dash look-alike and a dashed date', 'seen 20.10.2569–11-12-69', /2569|11-12/],
  // Full dates with an ordinal day, a two-digit year, dashes, the era, a spaced abbreviation.
  ['month-name en, ordinal month first', 'DOB Oct 20th, 1967 ok', /1967/],
  ['month-name en, ordinal day first', 'DOB 20th Oct 1967 ok', /1967/],
  ...['1st', '2nd', '3rd', '21st', '22nd', '23rd'].map((d) => [`month-name en, ${d}`, `DOB ${d} Jan 2001 ok`, /2001/]),
  ['month-name en, of', 'DOB 20th of October 1967 ok', /1967/],
  ['month-name en, two-digit year', 'DOB 20 Oct 67 ok', /20 Oct|67/],
  ['month-name en, dashed', 'DOB 20-Oct-1967 ok', /1967/],
  ['month-name en, dashed two-digit year', 'DOB 20-Oct-67 ok', /Oct-67/],
  ['month-name th, dashed', 'เกิด 20-ต.ค.-2510 ค่ะ', /2510/],
  ['month-name th, abbreviated, พ.ศ.', 'เกิด 20 ต.ค. พ.ศ. 2510 ค่ะ', /2510/],
  ['month-name th, full, พ.ศ.', 'เกิด 20 ตุลาคม พ.ศ. 2510 ค่ะ', /2510/],
  ['month-name th, ค.ศ.', 'เกิด 5 มี.ค. ค.ศ. 1967 ค่ะ', /1967/],
  ['month-name th, spaced abbreviation', 'เกิด 20 ต. ค. 2510 ค่ะ', /2510/],
  // Double circled, parenthesized and full-stop digits.
  ['double circled phone', 'tel ⓪⓼⓵⓶⓷⓸⓹⓺⓻⓼ x', /⓼⓵⓶/],
  ['parenthesized phone', 'tel ⓪⑻⑴⑵⑶⑷⑸⑹⑺⑻ x', /⑻⑴⑵/],
  ['full-stop phone', 'tel ⓪⒏⒈⒉⒊⒋⒌⒍⒎⒏ x', /⒏⒈⒉/],
  ['parenthesized ID', 'id ⑴⑵⑶⑷⑸⑹⑺⑻⑼⑴⑵⑶⑷ x', /⑴⑵⑶/],
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
  ['middle-dot creatinine trend', 'Cr 1·05 1·12 1·20 1·31'],
  ['middle-dot haemoglobin trend', 'Hb 12·5 11·8 10·2 9·6 9·1 8·7'],
  ['middle-dot dose', 'give 2·5 mg'],
  ['month and year, Thai', 'ตุลาคม 2510'],
  ['month and year, English', 'since October 2024'],
  ['month and Buddhist year', 'เดือน ตุลาคม พ.ศ. 2567'],
  ...['mg', 'MG', 'mcg', 'µg', 'g', 'mL', 'ml', 'L', 'units', 'unit', 'IU', 'mmol', 'mEq']
    .map((u) => [`dose range before ${u}`, `titrate 10-12-14 ${u}`]),
  ['dose range, unit glued', 'titrate 10-12-14mg'],
  ['day, month and a dose', 'given 2 May 10 mg'],
  ['day, month and a time', 'on 3 Jan 10:30 seen'],
  ['full-stop list', '⒈ aspirin ⒉ clopidogrel'],
  ['parenthesized list', '⑴ ASA ⑵ P2Y12'],
  ['ECG software version', 'ECG software version: 2024.10.1'],
  ['chapter colon', 'chapter: 3.1.10'],
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

describe('#474 exact outputs', () => {
  test.each([
    ['a slash date then a middle dot and digit keeps the tail', 'seen 20/10/2569·5 x', 'seen [DATE-1]·5 x'],
    ['an HN sub-number is one token', 'HN 1234/67 seen', '[HN-1] seen'],
    ['a dashed day-first two-digit year is a date', '11-12-69 seen', '[DATE-1] seen'],
    ['the short number before a landline stays', 'call 05–021234567 now', 'call 05–[PHONE-1] now'],
    ['a middle-dot phone', 'call 081·234·5678 now', 'call [PHONE-1] now'],
    // A / or - group glued to a numbered section takes its label's exemption away, as before #474 (NUMBERED).
    ['a section number glued to a slash date', 'Section: 1.2.1020/10/2569', 'Section: [DATE-1]/10/2569'],
  ])('%s', (_shape, input, out) => {
    expect(stripPii(input)).toBe(out);
  });
});

// Accepted residuals (#474 owner ruling): a two-digit enclosed number and a mathematical-letter label glued to its digits
// stay as written.
describe('#474 residuals stay as written', () => {
  test.each([
    ['circled ten and up', 'tel ⑩⑧①②③④⑤⑥⑦⑧ x'],
    ['double circled ten', 'tel ⓾⓼⓵⓶⓷⓸⓹⓺⓻⓼ x'],
    ['math-letter HN glued to digits', 'see 𝐇𝐍1234567 x'],
  ])('%s', (_shape, input) => {
    expect(stripPii(input)).toBe(input);
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

// The email scan tried every start of a long run of address characters (emailExecFrom); the look-alikes of #474 make
// more text such a run. Before: about 3 s each at this length.
test.each([
  ['hyphens', '05-'.repeat(20000)],
  ['en dashes', '05–'.repeat(20000)],
  ['middle dots', '1·'.repeat(20000)],
  ['dots', '1.'.repeat(20000)],
])('a long run of digits and %s, then an @, finishes in linear time', (_kind, run) => {
  const t0 = process.hrtime.bigint();
  stripPii(`${run}@ x`);
  expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(1500);
});
