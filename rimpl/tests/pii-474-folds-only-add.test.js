// #474 invariant: the folded run of each pass (look-alike dashes, middle dots, circled and keycap digits, mathematical
// letters) only adds masks. Over seeded random strings that mix identifiers, look-alikes and clinical text, every
// character stripPii masks with the folds turned off must still be masked with them on. The folds-off arm is this
// branch's first run alone, not master: it already holds the new passes and guards. pii-474-master-differential.test.js
// compares against master itself.
const filter = require('../src/services/pii-filter');
const { generator, maskedSet, counted } = require('./helpers/pii-474-generator');

const { stripPii } = filter;

// A lost character counts when it is a letter or digit of the input, outside one kind of text that holds no identifier:
// a dose range that the folds-off run masks only while a digit is glued after it, which the folded run may mask first
// (NOT_DOSE: titrate 10-12-14 mg๐๓-628-6️⃣5️⃣…). A label word is counted: master's mask of a label with its value is
// made whatever the folded run takes (stripPii). Punctuation between masks is no identifier. Version and section numbers
// are counted (#474 owner ruling).
const NOT_COUNTED_RE = /titrate 10-12-14 mg/g;

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
