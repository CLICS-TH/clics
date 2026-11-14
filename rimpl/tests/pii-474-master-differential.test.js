// #474 invariant: this branch masks more than master and never less. Over the seeded strings of the folds-only-add test
// (look-alike digits, dashes and middle dots), and over an ASCII variant whose joiners and separators are '.', '-' and
// '/', every letter or digit master's stripPii masks must be masked by this branch's. Master's filter is frozen in
// tests/fixtures/pii-filter.master-474.js (master 9438d7a2, its require paths alone changed).
// stripPii makes it so by construction (it makes every mask of master's this filter left a letter or digit of in clear),
// so nothing is exempt. The owner-approved dose range (titrate 10-12-14 mg) is no exemption either: master masks none.
const { stripPii } = require('../src/services/pii-filter');
const master = require('./fixtures/pii-filter.master-474');
const { generator, maskedSet, counted, moreInClear } = require('./helpers/pii-474-generator');

const SEEDS = [474, 1, 2, 3, 4, 5];
const N = 3000;
const NOTHING = /(?!)/g;

describe.each([
  ['look-alike', false],
  ['ASCII', true],
])('#474 against master, %s strings', (_name, ascii) => {
  test.each(SEEDS)('seed %i: every letter or digit master masks is masked', (seed) => {
    const next = generator(seed, { ascii });
    const lost = [];
    const more = [];
    let compared = 0;
    let masterMasked = 0;
    for (let n = 0; n < N; n += 1) {
      const input = next();
      const m = master.stripPii(input);
      const h = stripPii(input);
      if (m !== input) masterMasked += 1;
      // Counted per letter or digit (moreInClear): needs no alignment, so it also checks the strings maskedSet cannot place.
      const extra = moreInClear(h, m);
      if (extra.length) more.push({ input, master: m, head: h, extra });
      if (/[[\]]/.test(input)) continue;
      const a = maskedSet(input, m);
      const b = maskedSet(input, h);
      if (!a || !b) continue;
      compared += 1;
      const count = counted(input, NOTHING);
      const at = a.findIndex((x, i) => x && !b[i] && count[i]);
      if (at >= 0) lost.push({ input, master: m, head: h, at });
    }
    expect(lost.slice(0, 5)).toEqual([]);
    expect(more.slice(0, 5)).toEqual([]);
    // Not vacuous: most strings align, and master masks something in most of them.
    expect(compared).toBeGreaterThan(N * 0.7);
    expect(masterMasked).toBeGreaterThan(N * 0.5);
  });
});
