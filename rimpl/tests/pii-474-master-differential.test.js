// #474 invariant: this branch masks more than master and never less. Over the seeded strings of the folds-only-add test
// (look-alike digits, dashes and middle dots), and over an ASCII variant whose joiners and separators are '.', '-' and
// '/', every letter or digit master's stripPii masks must be masked by this branch's. Master's filter is frozen in
// tests/fixtures/pii-filter.master-474.js (master 9438d7a2, its require paths alone changed).
const { stripPii } = require('../src/services/pii-filter');
const master = require('./fixtures/pii-filter.master-474');
const { generator, maskedSet, counted } = require('./helpers/pii-474-generator');

// Text that is not counted. The label word of an identifier whose value another pass masked first (age 66·05… masks 66
// in a phone, leaving the word age; บ้านเลขที่ 93/1/… in a date), the same words the folds-only-add test exempts. And,
// pending an owner ruling, the version and section numbers this branch no longer reads as dates in any case or after a
// colon (VERSION 2024.10.1, Section: 1.2.10), which master masked, with the digits master's date read glued after them
// (VERSION 2024.10.1３ is the date 2024.10.13 to master).
const NOT_COUNTED_RE = /(?:VERSION 2024\.10\.1|Section: 1\.2\.10)\p{N}{0,2}|age|อายุ|ปี|บ้านเลขที่|HN|MRN|AN/gu;

const SEEDS = [474, 1, 2, 3, 4, 5];
const N = 3000;

describe.each([
  ['look-alike', false],
  ['ASCII', true],
])('#474 against master, %s strings', (_name, ascii) => {
  test.each(SEEDS)('seed %i: every letter or digit master masks is masked', (seed) => {
    const next = generator(seed, { ascii });
    const lost = [];
    let compared = 0;
    let masterMasked = 0;
    for (let n = 0; n < N; n += 1) {
      const input = next();
      if (/[[\]]/.test(input)) continue;
      const m = master.stripPii(input);
      const h = stripPii(input);
      const a = maskedSet(input, m);
      const b = maskedSet(input, h);
      if (!a || !b) continue;
      compared += 1;
      if (m !== input) masterMasked += 1;
      const count = counted(input, NOT_COUNTED_RE);
      const at = a.findIndex((x, i) => x && !b[i] && count[i]);
      if (at >= 0) lost.push({ input, master: m, head: h, at });
    }
    expect(lost.slice(0, 5)).toEqual([]);
    // Not vacuous: most strings align, and master masks something in most of them.
    expect(compared).toBeGreaterThan(N * 0.8);
    expect(masterMasked).toBeGreaterThan(N * 0.5);
  });
});
