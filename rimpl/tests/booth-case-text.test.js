// Case text is the booth's PII boundary: rimpl sends the vignette and every bank's text to the AI as written. The next
// step's BANK/SORT block (services/booth.js withBlock) goes after de-identification, and routes/chat.js reads a question
// that masks on its own apart from its answer (#406). So no case file may hold an identifier, and no rule may fire in
// one: a rule that fires would corrupt the text the AI reads and move that split. This scan reads every case file, live
// and staged, all steps, both languages.
const { stripPii } = require('../src/services/pii-filter');
const { CASES, reachableBanks, caseTexts } = require('./helpers/booth-cases');

const NOT_AGE = /\[(?!AGE-)[A-Z]+-\d+\]/;

// Case text the filter masks though it holds no identifier, cut before the scan. Each cut names the words that follow
// it, so the same word before a name or a place is not cut and still fails the scan. `seen` is case text it masks;
// `kept` is the word before an identifier.
const FALSE_POSITIVES = [
  {
    kind: 'the pronoun คุณ ("you") before a verb (#470)',
    cut: /คุณ(?= ?(?:จะ|คิด|คือ|สงสัย|บอก))/g,
    seen: 'คุณจะส่งตรวจอะไรเป็นอันดับแรก',
    kept: 'คุณสมศรี ใจดี',
  },
  {
    kind: 'รพ.จังหวัด (the provincial hospital) before รับ or ตอบรับ',
    cut: /(?<=รพ\.)จังหวัด(?=(?:ตอบ)?รับ)/g,
    seen: 'รพ.จังหวัดตอบรับการส่งต่อ จะส่งตัวอย่างไร',
    kept: 'รพ.จังหวัดเชียงใหม่รับตัวแล้ว',
  },
  {
    kind: 'the title เด็กหญิง ("girl") before วัย or อายุ (#470)',
    cut: /เด็กหญิง(?=วัย|อายุ)/g,
    seen: 'เด็กหญิงวัยขวบครึ่ง อาเจียนและถ่ายเหลวมา 2 วัน แม่พามาโรงพยาบาลชุมชน',
    kept: 'เด็กหญิงสมศรี ใจดี',
  },
];
const shielded = (text) => FALSE_POSITIVES.reduce((t, { cut }) => t.replace(cut, ''), text);

const SCANNED = CASES.flatMap(({ file, kase }) => caseTexts(kase).map((t) => ({ file, ...t })));

describe.each(FALSE_POSITIVES)('$kind', ({ cut, seen, kept }) => {
  test('masks case text that holds no identifier, and nothing is masked once it is cut', () => {
    expect(SCANNED.map(({ text }) => text)).toContain(seen);
    expect(stripPii(seen)).toMatch(NOT_AGE);
    expect(seen.replace(cut, '')).not.toBe(seen);
    expect(stripPii(shielded(seen))).toBe(shielded(seen));
  });

  test('is not cut before a name or a place, so case text holding one still fails the scan', () => {
    expect(kept.replace(cut, '')).toBe(kept);
    expect(stripPii(shielded(kept))).toMatch(NOT_AGE);
  });

  test('is still needed by some case text', () => {
    expect(SCANNED.some(({ text }) => text.replace(cut, '') !== text && NOT_AGE.test(stripPii(text)))).toBe(true);
  });
});

test('the scan reads every case file, live and staged, and every bank a play can reach in each', () => {
  expect(CASES.some(({ file }) => file.startsWith('NFCME-2026/'))).toBe(true);
  for (const { kase } of CASES) {
    const read = new Set(caseTexts(kase).map(({ at }) => at.replace(/\.(variants|options)\[.*$/, '')));
    expect(reachableBanks(kase).map(({ key }) => `banks.${key}`).filter((k) => !read.has(k))).toEqual([]);
  }
});

test('no case text masks as anything but an age, once the named false positives are cut', () => {
  const failures = SCANNED.filter(({ text }) => NOT_AGE.test(stripPii(shielded(text))))
    .map(({ file, at, text }) => `${file} ${at}: ${JSON.stringify(text)} -> ${JSON.stringify(stripPii(shielded(text)))}`);
  expect(failures).toEqual([]);
});
