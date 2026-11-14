// #474 invariant across the texts of one call: every route primes ONE registry over all of a call's texts, so a name
// master learns in one text masks it in the others. In each text, every letter or digit master masks must be masked by
// this branch too, through stripHistoryPii and through makeRegistry + primeRegistry + stripPii (the chat, booth,
// deidentify, audit-discuss and readiness routes). Checked by count per text (moreInClear), which needs no alignment.
// Master's filter is frozen in tests/fixtures/pii-filter.master-474.js. PII474_HISTORY_SEEDS=<n> runs n seeds.
const head = require('../src/services/pii-filter');
const master = require('./fixtures/pii-filter.master-474');
const { historyGenerator, moreInClear } = require('./helpers/pii-474-generator');

const SEED_COUNT = Number(process.env.PII474_HISTORY_SEEDS) || 12;
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => 474 + i);
const N = 150;

const viaHistory = (f, texts) => f.stripHistoryPii(texts.map((content) => ({ role: 'physician', content }))).map((m) => m.content);
const viaPrime = (f, texts) => {
  const registry = f.makeRegistry();
  f.primeRegistry(texts, registry, []);
  return texts.map((t) => f.stripPii(t, registry, []));
};

// Each text's letters or digits this branch leaves in clear more often than master does, per route.
function lost(texts) {
  const out = [];
  for (const [route, run] of [['stripHistoryPii', viaHistory], ['primeRegistry', viaPrime]]) {
    const m = run(master, texts);
    const h = run(head, texts);
    h.forEach((t, i) => {
      const extra = moreInClear(t, m[i]);
      if (extra.length) out.push({ route, texts, master: m, head: h, turn: i, extra });
    });
  }
  return out;
}

describe('#474 against master, the texts of one call', () => {
  // Rows where a pass of this branch eats the context master's name pass reads (WARD with a colon or #, the English
  // month date, the middle-dot email widened left), so the name master learns there was not learnt by the branch.
  test.each([
    [['Ward: Mr Smith', 'Smith reports chest pain'], ['[WARD-1] [NAME-1]', '[NAME-1] reports chest pain']],
    [['Smith reports chest pain', 'Ward: Mr Smith'], ['[NAME-1] reports chest pain', '[WARD-1] [NAME-1]']],
    [['Seen by Dr. June 5, 2024', 'June has fever'], ['Seen by Dr. [DATE-1]', '[NAME-1] has fever']],
    [['ward: Dr Somchai Jaidee', 'Jaidee called back'], ['[WARD-1] [NAME-1]', '[NAME-1] called back']],
    [['Ward#Mrs Brown', 'Brown is stable'], ['[WARD-1] [NAME-1]', '[NAME-1] is stable']],
    [['Dr. Somchai Jaidee·md@hospital.com', 'Jaidee called back'], ['Dr [NAME-1] [EMAIL-1]', '[NAME-1] called back']],
  ])('%j', (texts, expected) => {
    expect(viaHistory(head, texts)).toEqual(expected);
    expect(viaPrime(head, texts)).toEqual(expected);
    expect(lost(texts)).toEqual([]);
  });

  describe.each([
    ['look-alike', false],
    ['ASCII', true],
  ])('%s strings', (_name, ascii) => {
    test.each(SEEDS)('seed %i: every letter or digit master masks in a text is masked', (seed) => {
      const next = historyGenerator(seed, { ascii });
      const found = [];
      let crossText = 0;
      for (let n = 0; n < N; n += 1) {
        const texts = next();
        // Master masks some text differently than it does alone: what it learnt in another text of the call counts.
        if (viaHistory(master, texts).some((t, i) => t !== master.stripPii(texts[i]))) crossText += 1;
        found.push(...lost(texts));
      }
      expect(found.slice(0, 5)).toEqual([]);
      expect(crossText).toBeGreaterThan(N * 0.8); // not vacuous
    });
  });
});
