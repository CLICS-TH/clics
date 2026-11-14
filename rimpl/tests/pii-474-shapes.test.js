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
  // A sub-number tail never takes a following date's day.
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
  // Middle dots read as spaces in the ID, HN and MRN passes.
  ['middle-dot ID', 'id 1·2345·67890·12·3 x', /67890/],
  ['middle-dot HN', 'HN·1234567 seen', /1234567/],
  ['middle-dot MRN', 'MRN·123456 seen', /123456/],
  // The ID's middle-dot rule counts separators, whatever script its digits are in.
  ['middle-dot ID, Thai digits', 'id ๑·๒๓๔๕·๖๗๘๙๐·๑๒·๓ x', /๖๗๘๙๐/],
  ['middle-dot ID, full-width digits', 'id １·２３４５·６７８９０·１２·３ x', /６７８９０/],
  // A local part past 64 characters is read from its last 64.
  ['middle-dot email, long local part', `mail ${'a'.repeat(70)}@example·com now`, /example/],
  // A numbered list item before a look-alike-dash phone or ID.
  ['numbered item, en-dash phone', '1. 081–234–5678', /234|5678/],
  ['numbered item, en-dash ID', '1. 1–2345–67890–12–3', /67890/],
  // A look-alike-dash ID in any grouping.
  ['en-dash ID, 1-5-5-1-1', 'id 1–23456–78901–2–3 x', /23456|78901/],
  ['en-dash ID, 2-3-5-1-2', 'id 12–345–67890–1–23–4 x', /67890/],
  ['HN tail of five digits', 'HN 1234/12345 seen', /12345/],
  // G2P1 and L4-5 are no dose unit.
  ['dashed date before G2P1A0', 'LMP 11-12-69 G2P1A0', /11-12-69/],
  ['dashed date before L4-5', 'op 11-12-69 L4-5 fusion', /11-12-69/],
  ['month-name date before G2P1', 'DOB 20 Oct 67 G2P1', /20 Oct 67/],
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
  ['dose range, unit glued, alone', '10-12-14mg'],
  ['vertebral level', 'op L4-5 fusion'],
  ['obstetric score', 'G2P1A0 at 32 weeks'],
  ['middle-dot sodium trend', 'Na 140·00 139·50'],
  ['middle-dot potassium range', 'K 3·5–5·0'],
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

// Master masks each of these, reading the look-alike as an unknown character beside the identifier. The first run of
// each pass reads master's view, so it makes the same mask (applyPass).
describe('#474 a look-alike glued to an identifier loses no mask', () => {
  test.each([
    ['circled digit before a phone', 'tel ①0812345678 x', /5678/],
    ['circled digit after a phone', 'tel 0812345678① x', /5678/],
    ['circled digit and slash before a date', 'on ①/20/10/2569 x', /2569/],
    ['keycap before a phone', 'tel 1️⃣0812345678 x', /5678/],
    ['math letter before a date', 'on 𝐀20/10/2569 x', /2569/],
    ['math letters before an ID', 'id 𝐃𝐎𝐁1234567890123 x', /67890/],
    ['math letter before HN', 'see 𝐀HN 1234567 x', /1234567/],
    // Once a residual: the folded run reads a mathematical-letter label glued to its digits.
    ['math-letter HN glued to digits', 'see 𝐇𝐍1234567 x', /1234567/],
    ['minus sign before a LINE id', 'add −line id abc_12 x', /abc_12/],
    // A middle dot reads as a space, never a decimal point, so the date does not end inside a decimal (NOT_IN_DECIMAL).
    ['date then middle dot and digit', 'seen 20/10/2569·5 x', /2569/],
    // The first run reads the mathematical letters as written, so they take no NUMBERING_LABEL exemption.
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
    // A / or - group glued to a numbered section takes its label's exemption away (NUMBERED).
    ['a section number glued to a slash date', 'Section: 1.2.1020/10/2569', 'Section: [DATE-1]/10/2569'],
    // A text with a look-alike is read first in master's view (applyPass), and the folded run never cuts an identifier in
    // two (cutsIdentifier): each output is master's.
    ['an HN, an en dash, a slash date', 'HN 1234567–20/10/2569 seen', '[HN-1]–[DATE-1] seen'],
    ['an MRN, an en dash, a slash date', 'MRN 123456–20/10/2569 seen', '[MRN-1]–[DATE-1] seen'],
    ['an HN, an en dash, an ISO date', 'HN 1234567–2026-10-20 seen', '[HN-1]–[DATE-1] seen'],
    ['a landline, an en dash, a slash date', 'โทร 02 123 4567–5/10/2569 seen', 'โทร [PHONE-1]–[DATE-1] seen'],
    ['a short number, a landline, a phone', 'x 05–021234567 02-123-4567 y', 'x 05–[PHONE-1] [PHONE-2] y'],
    ['a short number, a landline, a date', 'call 05–021234567 20/10/2569', 'call 05–[PHONE-1] [DATE-1]'],
    ['an HN, a middle dot, a slash date', 'HN 1234567·20/10/2569', '[HN-1]·[DATE-1]'],
    ['a dotted year-first date, an en dash, a dashed date', 'seen 2026.10.20–11-12-69', 'seen [DATE-2]–[DATE-1]'],
    // An email read through middle dots ends where the next address starts.
    ['two emails joined by a middle dot', 'a@x.com·info@jaidee-clinic.co.th', '[EMAIL-1]·[EMAIL-2]'],
    ['two emails joined by a middle dot, short TLD word', 'a@x.com·me@somchai.net', '[EMAIL-1]·[EMAIL-2]'],
    // The folded run never cuts what master's view masks: a keycap or circled digit read as 1 would open a 13-digit ID
    // that takes the date's day, or leave the ID's last digit.
    ['a keycap, a phone, a date', '1️⃣ 081 234 5678 20/10/2569', '1️⃣ [PHONE-1] [DATE-1]'],
    ['a circled digit, a phone, a date', '① 081 234 5678 20/10/2569', '① [PHONE-1] [DATE-1]'],
    ['a parenthesized digit, an ID', '⑴ 1 2345 67890 12 3', '⑴ [ID-1]'],
    // A keycap is three units in master's view and one in the folded view: positions are compared in the text.
    ['keycaps and dashes, an HN, a phone', '1️⃣–2️⃣–3️⃣–4️⃣–5️⃣– HN 12–34567–081 234 5678 ok', '1️⃣–2️⃣–3️⃣–4️⃣–5️⃣– [HN-1]–[PHONE-1] ok'],
    // An HN sub-number never opens a phone, and a middle dot ends an HN before a phone the folded run reads.
    ['an HN, a slash, a dashed phone', 'HN 1234567/081-234-5678', '[HN-1]/[PHONE-1]'],
    ['an HN, a slash, a spaced phone', 'HN 1234567/081 234 5678', '[HN-1]/[PHONE-1]'],
    ['an MRN, a slash, a landline', 'MRN 123456/02-123-4567', '[MRN-1]/[PHONE-1]'],
    // A sub-number that opens no date or phone stays in the HN, whatever follows it.
    ['an HN sub-number, then a count', 'HN 1234/67 2 ครั้ง', '[HN-1] 2 ครั้ง'],
    ['an HN sub-number, then a phone', 'HN 1234567/12 081-234-5678', '[HN-1] [PHONE-1]'],
    ['an HN and a phone joined by middle dots', 'HN·1234567·081·234·5678', '[HN-1]·[PHONE-1]'],
    // A dashed day-first date never opens on the day of a dotted year-first date.
    ['a dotted year-first date, a hyphen, a dashed date', 'x 2026.10.20-11-12-69 ok', 'x [DATE-2]-[DATE-1] ok'],
    // A list number glued to a dashed date: the date is masked whole, never cut at its day.
    ['a list number, a dashed date', '1.5.20-10-2569', '1.5.[DATE-1]'],
    ['a two-digit list number, a dashed date', '1.13.20-10-2569', '1.13.[DATE-1]'],
    ['a list number, an en-dashed date', '1.5.20–10–2569', '1.5.[DATE-1]'],
    // The run on master's view takes in the middle-dot-joined local pieces before an address.
    ['a middle dot in an email local part', 'mail somchai·j@example.com now', 'mail [EMAIL-1] now'],
    ['middle dots in an email local part', 'mail a·b·c@example.com now', 'mail [EMAIL-1] now'],
    ['a date, a hyphen, a middle-dot email', 'x 20/10/2569-somchai·j@example.com', 'x [DATE-1]-[EMAIL-1]'],
    // A run that opens with a phone is two phones only when the rest of its number is one more phone.
    ['a phone then a phone', 'tel 0812345678 081-234-5678 x', 'tel [PHONE-1] [PHONE-2] x'],
  ])('%s', (_shape, input, out) => {
    expect(stripPii(input)).toBe(out);
  });
});

// Accepted residual (#474 owner ruling): a two-digit enclosed number stays as written.
describe('#474 residuals stay as written', () => {
  test.each([
    ['circled ten and up', 'tel ⑩⑧①②③④⑤⑥⑦⑧ x'],
    ['double circled ten', 'tel ⓾⓼⓵⓶⓷⓸⓹⓺⓻⓼ x'],
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

// "LINE" then a long run of spaces and no id must not backtrack quadratically.
test('a LINE label followed by 40000 spaces finishes in linear time', () => {
  const input = `LINE${' '.repeat(40000)}!`;
  const t0 = process.hrtime.bigint();
  stripPii(input);
  expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(100);
});

// The email scan tries one start per run of address characters (emailExecFrom), a run longer than GUARD_FALLBACK_MAX
// is not retried unit by unit, and the dots run caps an email's local part (EMAIL_LOCAL_MAX), so each stays linear.
test.each([
  ['digits and middle dots before an @', `${'1·'.repeat(40000)}@a·com`],
  ['letters and middle dots before an email', `${'a·'.repeat(40000)}a@example·xyz`],
])('%s at n = 40000 finishes in linear time', (_kind, input) => {
  const t0 = process.hrtime.bigint();
  stripPii(input);
  expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(200);
});

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
