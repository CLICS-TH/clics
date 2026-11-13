// Case text is the booth's PII boundary: rimpl sends the vignette and every bank's text to the AI as written, and the
// variant and option ids with it (services/booth.js bankIn). The next step's BANK/SORT block (services/booth.js
// withBlock) goes after de-identification, and routes/chat.js reads a question that masks on its own apart from its
// answer (#406). So no case file may hold an identifier, and no rule may fire in one: a rule that fires would corrupt
// the text the AI reads and move that split. This scan reads every case file, live and staged, all steps, both
// languages, and every id.
const { stripPii, BOOTH_ID_LABELS } = require('../src/services/pii-filter');
const { CASES, reachableBanks, caseTexts, caseIds } = require('./helpers/booth-cases');
const { labelRows } = require('./helpers/booth-labels');

const NOT_AGE = /\[(?!AGE-)[A-Z]+-\d+\]/;

// Case text the filter masks though it holds no identifier, each pinned to its file, its place and its whole text
// (gate #370 on PR #482). A pin covers that one string and nothing else: a new string that masks, or an edit of a
// pinned one, fails the scan. A rule keyed on the words around a match could not tell คุณจะ ("you will") from a name
// that starts with the same syllables (คุณคิดา ใจดี), so the scan holds no such rule.
const KHUN = 'the pronoun คุณ ("you") before a verb (#470, #407)';
const PROVINCIAL = 'รพ.จังหวัด (the provincial hospital), read as a place (an open owner ruling on PR #482)';
const GIRL = 'the title เด็กหญิง ("girl") before an age (#470)';
const PINNED = [
  [[KHUN], 'NFCME-2026/adhf.json', 'banks.step2.B.variants[0].question.th', "คุณจะส่งตรวจอะไรเป็นอันดับแรก"],
  [[KHUN], 'NFCME-2026/adhf.json', 'banks.step2.B.variants[1].question.th', "ที่ห้องฉุกเฉินตอนนี้ คุณจะตรวจอะไรก่อน"],
  [[KHUN], 'NFCME-2026/adhf.json', 'banks.step2.R.variants[0].question.th', "คุณจะส่งตรวจอะไรเป็นอันดับแรก"],
  [[KHUN], 'NFCME-2026/adhf.json', 'banks.step2.W.variants[2].question.th', "คุณจะส่งตรวจอะไรเป็นอันดับแรก"],
  [[KHUN], 'NFCME-2026/alcohol-pancreatitis.json', 'banks.step4.B.variants[1].question.th', "ผ่านไป 48 ชม. อาการดีขึ้นชัดเจน คุณจะทำอย่างไรต่อ"],
  [[KHUN], 'NFCME-2026/alcohol-pancreatitis.json', 'banks.step4.R.variants[1].question.th', "ผ่านไป 48 ชม. ดีขึ้นช้า ยังเบื่ออาหาร คุณจะทำอย่างไร"],
  [[KHUN], 'NFCME-2026/dka-young-adult.json', 'banks.step2.B.variants[0].question.th', "คุณสงสัย DKA จะส่งตรวจอะไรก่อน"],
  [[KHUN], 'staging/NFCME-2026/dka-young-adult.json', 'banks.step2.B.variants[0].question.th', "คุณสงสัย DKA จะส่งตรวจอะไรก่อน"],
  [[KHUN], 'staging/NFCME-2026/dka-young-adult.json', 'banks.step2.R.variants[0].question.th', "คุณสงสัยภาวะน้ำตาลสูงวิกฤต จะตรวจอะไรก่อน"],
  [[KHUN], 'NFCME-2026/dka-young-adult.json', 'banks.step2.R.variants[0].question.th', "คุณสงสัยภาวะน้ำตาลสูงวิกฤต จะตรวจอะไรก่อน"],
  [[KHUN], 'NFCME-2026/ectopic-rupture.json', 'banks.step1.variants[2].question.th', "คุณคิดว่าอาการนี้เกิดจากอะไร"],
  [[KHUN], 'NFCME-2026/ectopic-rupture.json', 'banks.step4.W.variants[1].question.th', "วันที่ 2 มีไข้ขึ้นใหม่และอ่อนเพลีย คุณจะทำอะไรต่อ"],
  [[KHUN], 'NFCME-2026/leptospirosis.json', 'banks.step1.variants[2].question.th', "หลังลุยน้ำท่วม คุณคิดถึงโรคใดเป็นอันดับแรก"],
  [[KHUN], 'NFCME-2026/leptospirosis.json', 'banks.step2.B.variants[0].question.th', "คุณจะส่งตรวจอะไรเป็นอันดับแรก"],
  [[KHUN], 'NFCME-2026/leptospirosis.json', 'banks.step2.B.variants[1].question.th', "วันนี้ที่โรงพยาบาลชุมชนคุณจะตรวจอะไรก่อน"],
  [[KHUN], 'NFCME-2026/leptospirosis.json', 'banks.step2.R.variants[1].question.th', "คุณจะส่งตรวจอะไรเป็นอันดับแรก"],
  [[KHUN], 'NFCME-2026/leptospirosis.json', 'banks.step2.W.variants[0].question.th', "ทูร์นิเคต์เทสต์ให้ผลลบ คุณจะตรวจอะไรก่อน"],
  [[KHUN], 'NFCME-2026/leptospirosis.json', 'banks.step2.W.variants[1].question.th', "คุณจะส่งตรวจอะไรเป็นอันดับแรก"],
  [[KHUN], 'NFCME-2026/leptospirosis.json', 'banks.step2.W.variants[2].question.th', "ไข้วันที่ 3 คุณจะตรวจอะไรก่อนในวันนี้"],
  [[KHUN], 'NFCME-2026/leptospirosis.json', 'banks.step3.R.variants[1].question.th', "คุณจะรักษาผู้ป่วยรายนี้อย่างไรตั้งแต่วันนี้"],
  [[KHUN], 'NFCME-2026/leptospirosis.json', 'banks.step4.B.variants[1].question.th', "ผ่านไป 48 ชม. อาการดีขึ้นชัดเจน คุณจะทำอย่างไรต่อ"],
  [[KHUN], 'NFCME-2026/leptospirosis.json', 'banks.step4.R.variants[1].question.th', "ผ่านไป 48 ชม. อาการดีขึ้นบ้าง คุณจะทำอย่างไรต่อ"],
  [[KHUN], 'NFCME-2026/leptospirosis.json', 'banks.step5.R.variants[1].question.th', "ไข้หายแล้ว ยังอ่อนเพลียอยู่ คุณจะติดตามอย่างไร"],
  [[KHUN], 'NFCME-2026/melioidosis-farmer.json', 'banks.step3.B.variants[1].question.th', "คุณจะรักษาผู้ป่วยรายนี้ต่ออย่างไรตั้งแต่วันนี้"],
  [[KHUN], 'NFCME-2026/melioidosis-farmer.json', 'banks.step5.B.variants[1].question.th', "ผู้ป่วยหายดีพอจะกลับบ้านแล้ว คุณจะวางแผนอย่างไร"],
  [[KHUN], 'NFCME-2026/motorcycle-shock.json', 'banks.step3.B.variants[0].question.th', "ความดันลดเหลือ 82/56 ชีพจร 132 คุณจะรักษาอย่างไร"],
  [[KHUN], 'NFCME-2026/motorcycle-shock.json', 'banks.step3.R.variants[1].question.th', "เอกซเรย์ปกติ ท้องซ้ายบนกดเจ็บมากขึ้น คุณจะรักษาอย่างไร"],
  [[KHUN], 'NFCME-2026/motorcycle-shock.json', 'banks.step3.W.variants[1].question.th', "ผลตรวจเบื้องต้นปกติ ชีพจร 130 คุณจะรักษาอย่างไร"],
  [[KHUN], 'NFCME-2026/motorcycle-shock.json', 'banks.step4.W.variants[1].question.th', "ให้เลือดอยู่ ชีพจรยังคง 124 คุณจะทำอะไรต่อ"],
  [[PROVINCIAL], 'NFCME-2026/motorcycle-shock.json', 'banks.step5.B.variants[0].question.th', "ตอนนี้ความดัน 94/62 รพ.จังหวัดรับตัวแล้ว จะส่งอย่างไร"],
  [[PROVINCIAL], 'NFCME-2026/motorcycle-shock.json', 'banks.step5.R.variants[1].question.th', "รพ.จังหวัดตอบรับการส่งต่อ จะส่งตัวอย่างไร"],
  [[PROVINCIAL, KHUN], 'NFCME-2026/motorcycle-shock.json', 'banks.step5.W.variants[0].question.th', "ความดัน 84/56 รพ.จังหวัดรับตัวแล้ว คุณจะทำอะไร"],
  [[KHUN], 'NFCME-2026/sjs-ten-allopurinol.json', 'banks.step1.variants[2].question.th', "คุณคิดว่าเขาเป็นโรคอะไร"],
  [[KHUN], 'NFCME-2026/sjs-ten-allopurinol.json', 'banks.step5.B.variants[1].question.th', "สามสัปดาห์ต่อมา หายดี กลับมาที่คลินิกคุณ จะติดตามอย่างไร"],
  [[GIRL], 'NFCME-2026/toddler-gastro-dehydration.json', 'teaser.th', "เด็กหญิงวัยขวบครึ่ง อาเจียนและถ่ายเหลวมา 2 วัน แม่พามาโรงพยาบาลชุมชน"],
  [[GIRL], 'NFCME-2026/toddler-gastro-dehydration.json', 'vignette.th', "ผู้ป่วยสมมติ เด็กหญิงอายุ 1 ปี 6 เดือน แม่พามาโรงพยาบาลชุมชนเพราะถ่ายเหลวเป็นน้ำวันละราว 8 ครั้งมา 2 วัน ไม่มีมูกเลือด วันนี้อาเจียน 3 ครั้ง ไข้ 38.2 °C งอแง ตาโหล ดื่มน้ำอย่างกระหายเมื่อยื่นให้ หนังหน้าท้องคืนกลับช้า ชีพจร 140 ครั้ง/นาที capillary refill 2 วินาที ผ้าอ้อมเปียกน้อยลง น้ำหนัก 10 กก."],
  [[KHUN], 'NFCME-2026/toddler-gastro-dehydration.json', 'banks.step2.B.variants[0].question.th', "คุณจะตรวจหรือประเมินอะไรเป็นอันดับแรก"],
  [[KHUN], 'NFCME-2026/toddler-gastro-dehydration.json', 'banks.step2.R.variants[0].question.th', "คุณบอกสาเหตุแล้ว จะตรวจอะไรเป็นอันดับแรก"],
  [[KHUN], 'NFCME-2026/toddler-gastro-dehydration.json', 'banks.step2.W.variants[1].question.th', "คุณจะตรวจหรือประเมินสิ่งใดเป็นอันดับแรก"],
];
const pinAt = (file, at) => `${file} ${at}`;
const PINS = new Map(PINNED.map(([, file, at, text]) => [pinAt(file, at), text]));

// An id is sent as written, so it may not change at all; case text may mask only as an age.
const masks = ({ kind, text }) => (kind === 'id' ? stripPii(text) !== text : NOT_AGE.test(stripPii(text)));
const pinned = ({ kind, file, at, text }) => kind === 'text' && PINS.get(pinAt(file, at)) === text;
/** What the scan reads in one case file: every string with its place, and every id. */
const scanned = (file, kase) => [
  ...caseTexts(kase).map((t) => ({ file, kind: 'text', ...t })),
  ...caseIds(kase).map((t) => ({ file, kind: 'id', ...t })),
];
/** The scan's verdict: each string or id that masks and is not pinned, as "<file> <place>: <text> -> <masked>". */
const scanFailures = (entries) => entries.filter((t) => masks(t) && !pinned(t))
  .map(({ file, at, text }) => `${file} ${at}: ${JSON.stringify(text)} -> ${JSON.stringify(stripPii(text))}`);

const SCANNED = CASES.flatMap(({ file, kase }) => scanned(file, kase));

test('the scan reads every case file, live and staged, and every bank a play can reach in each', () => {
  expect(CASES.some(({ file }) => file.startsWith('NFCME-2026/'))).toBe(true);
  for (const { kase } of CASES) {
    const read = new Set(caseTexts(kase).map(({ at }) => at.replace(/\.(variants|options)\[.*$/, '')));
    expect(reachableBanks(kase).map(({ key }) => `banks.${key}`).filter((k) => !read.has(k))).toEqual([]);
  }
});

test('no case text masks as anything but an age, and no id masks at all, but the pinned strings', () => {
  expect(scanFailures(SCANNED)).toEqual([]);
});

test.each(PINNED)('pinned (%s): %s %s is that case text and still masks', (_why, file, at, text) => {
  const entry = SCANNED.find((t) => t.file === file && t.at === at);
  expect(entry?.text).toBe(text);
  expect(masks(entry)).toBe(true);
});

// A case with one string or id replaced, read the way the scan reads the case.
const caseFile = (file) => CASES.find((c) => c.file === file);
const setAt = (obj, at, value) => {
  const keys = at.split(/\.|\[(\d+)\]/).filter(Boolean);
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
};
const injected = (file, at, value) => {
  const kase = structuredClone(caseFile(file).kase);
  setAt(kase, at, value);
  return scanned(file, kase);
};

// gate #370 on PR #482: names after the words the old prefix cuts allowed (คุณ before คิด, เด็กหญิง before วัย),
// and a name or a place after the pinned strings' own openings. Each is injected at a pinned place and at one no pin
// covers.
const ADHF = 'NFCME-2026/adhf.json';
const TODDLER = 'NFCME-2026/toddler-gastro-dehydration.json';
const MOTORCYCLE = 'NFCME-2026/motorcycle-shock.json';
test.each([
  ['คุณคิดา ใจดี มาด้วยไข้', ADHF, 'banks.step2.B.variants[0].question.th'],
  ['คุณคิดา ใจดี มาด้วยไข้', ADHF, 'vignette.th'],
  ['คุณคิดดี ทองเปลว', ADHF, 'banks.step2.B.variants[0].question.th'],
  ['คุณคิดดี ทองเปลว', ADHF, 'banks.step3.B.options[0].line.th'],
  ['เด็กหญิงวัยวดี ทองเปลว', TODDLER, 'teaser.th'],
  ['เด็กหญิงวัยวดี ทองเปลว', TODDLER, 'banks.step1.variants[0].question.th'],
  ['คุณสมศรี ใจดี', ADHF, 'banks.step2.B.variants[0].question.th'],
  ['เด็กหญิงสมศรี ใจดี', TODDLER, 'teaser.th'],
  ['รพ.จังหวัดเชียงใหม่รับตัวแล้ว', MOTORCYCLE, 'banks.step5.R.variants[1].question.th'],
])('case text %j at %s %s fails the scan', (text, file, at) => {
  expect(NOT_AGE.test(stripPii(text))).toBe(true);
  expect(scanFailures(injected(file, at, text))).toEqual([expect.stringContaining(`${file} ${at}: ${JSON.stringify(text)}`)]);
});

test.each([
  ['hn1234567', 'banks.step1.variants[0].id'],
  ['hn1234567', 'banks.step2.B.options[1].id'],
  ['v0812345678', 'banks.step2.B.variants[1].id'],
])('an id %j at %s fails the scan', (id, at) => {
  expect(scanFailures(injected(ADHF, at, id))).toEqual([expect.stringContaining(`${ADHF} ${at}: "${id}"`)]);
});

// routes/chat.js boothTurnPieces fences only the typed answer, and maskLabelledTail masks from a label on inside the
// fence. A question that ends in an identifier label ("...ชื่อ", "...HN") puts the label outside the fence, so the
// value typed under it goes to the AI and answer_deidentified as typed. No bank question may end in one (gate #370
// on PR #482). The labels are every booth label row (helpers/booth-labels.js) and every label maskLabelledTail reads.
const unique = (xs) => [...new Set(xs)];
const LABELS = unique([...['th', 'en'].flatMap((lang) => labelRows(lang).map(([, label]) => label)),
  ...BOOTH_ID_LABELS.th, ...BOOTH_ID_LABELS.en]);
const bare = (s) => s.replace(/[\s\p{P}\p{S}]+$/u, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A Latin label ends the question only as a whole word, in any case ("...the HN", not "...newborn"); a Thai label at
// the tail in any form.
const TAILS = LABELS.map((label) => ({
  label,
  re: /[A-Za-z]/.test(bare(label))
    ? new RegExp(`(?<![A-Za-z])${bare(label).split(' ').map(escapeRe).join('[^A-Za-z]{0,3}')}$`, 'i')
    : new RegExp(`${escapeRe(bare(label))}$`),
}));
const questionsOf = (file, kase) => scanned(file, kase).filter(({ at }) => /\.question\.(th|en)$/.test(at));
/** Each question that ends in a label, once, naming the labels it ends in. */
const labelTails = (entries) => entries.flatMap(({ file, at, text }) => {
  const labels = TAILS.filter(({ re }) => re.test(bare(text))).map(({ label }) => label);
  return labels.length ? [`${file} ${at}: ${JSON.stringify(text)} ends in the label ${labels.map((l) => JSON.stringify(l)).join(' or ')}`] : [];
});

test('the label list holds the labels this check exists for', () => {
  expect(LABELS).toEqual(expect.arrayContaining(['ชื่อ', 'HN', 'นามสกุล', 'เลขบัตรประชาชน', 'เบอร์', 'Name', 'ID', 'Phone']));
});

test('no bank question, any variant, either language, any case file, ends in an identifier label', () => {
  const questions = CASES.flatMap(({ file, kase }) => questionsOf(file, kase));
  expect(questions.length).toBeGreaterThan(0);
  expect(labelTails(questions)).toEqual([]);
});

test.each([
  ['ผู้ป่วยรายนี้ชื่อ', 'banks.step2.B.variants[0].question.th'],
  ['โปรดระบุชื่อ:', 'banks.step3.B.variants[1].question.th'],
  ['ระบุ HN ของผู้ป่วย HN', 'banks.step1.variants[0].question.th'],
  ['What is the HN?', 'banks.step2.B.variants[0].question.en'],
  ['Please give the patient name:', 'banks.step4.B.variants[0].question.en'],
])('a planted question %j at %s is caught', (question, at) => {
  const kase = structuredClone(caseFile(ADHF).kase);
  setAt(kase, at, question);
  expect(labelTails(questionsOf(ADHF, kase))).toEqual([expect.stringContaining(`${ADHF} ${at}: `)]);
});
