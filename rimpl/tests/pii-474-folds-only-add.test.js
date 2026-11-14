// #474 invariant: the folded run of each pass (look-alike dashes, middle dots, circled and keycap digits, mathematical
// letters) only adds masks. Over seeded random strings that mix identifiers, look-alikes and clinical text, every
// character stripPii masks with the folds turned off must still be masked with them on. The folds-off arm is this
// branch's first run alone, not master: it already holds the new passes and guards. pii-474-master-differential.test.js
// compares against master itself.
const filter = require('../src/services/pii-filter');
const { generator, maskedSet, counted } = require('./helpers/pii-474-generator');

const { stripPii } = filter;

// A lost character counts when it is a letter or digit of the input, outside two kinds of text that hold no identifier.
// The clinical strings that the folds-off run masks only while a digit is glued after them, which the folded run may mask first:
// a version or section number read as a date (NUMBERED: VERSION 2024.10.1-０５·１７０·３８９８), a dose range read as a date
// (NOT_DOSE: titrate 10-12-14 mg0️⃣1️⃣4️⃣…). And the label word of an identifier whose value a folded run masked first
// (age 66·05・⓪②⓪・6087 masks 66 in the phone; บ้านเลขที่ 93/1/①… in a date). Punctuation between masks is no identifier.
const NOT_COUNTED_RE = /VERSION 2024\.10\.1|Section: 1\.2\.10|titrate 10-12-14 mg|age|อายุ|ปี|บ้านเลขที่|HN|MRN|AN/g;

describe('#474 the folded run only adds masks', () => {
  afterEach(() => filter._setFoldsForTest(true));

  test('over 4000 seeded random strings, every letter or digit masked without the folds is masked with them', () => {
    const next = generator(474);
    const lost = [];
    let compared = 0;
    let foldsMasked = 0;
    const N = 4000;
    for (let n = 0; n < N; n += 1) {
      const input = next();
      if (/[[\]]/.test(input)) continue;
      filter._setFoldsForTest(false);
      const off = stripPii(input);
      filter._setFoldsForTest(true);
      const on = stripPii(input);
      if (on !== off) foldsMasked += 1;
      const a = maskedSet(input, off);
      const b = maskedSet(input, on);
      if (!a || !b) continue;
      compared += 1;
      const count = counted(input, NOT_COUNTED_RE);
      const at = a.findIndex((m, i) => m && !b[i] && count[i]);
      if (at >= 0) lost.push({ input, off, on, at });
    }
    expect(lost.slice(0, 5)).toEqual([]);
    // The check is not vacuous: most strings align, and the folds change many outputs.
    expect(compared).toBeGreaterThan(N * 0.8);
    expect(foldsMasked).toBeGreaterThan(N * 0.2);
  });
});
