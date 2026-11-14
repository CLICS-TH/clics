// #474 invariant across the texts of one call: every route primes ONE registry over all of a call's texts, so a name
// master learns in one text masks it in the others. In each text, every letter or digit master masks must be masked by
// this branch too, through stripHistoryPii and through makeRegistry + primeRegistry + stripPii (the chat, booth,
// deidentify, audit-discuss and readiness routes). Checked by count per text (moreInClear), which needs no alignment.
// Master's filter is frozen in tests/fixtures/pii-filter.master-474.js. PII474_HISTORY_SEEDS=<n> runs n seeds.
const head = require('../src/services/pii-filter');
const master = require('./fixtures/pii-filter.master-474');
const { historyGenerator, twoPeopleGenerator, moreInClear } = require('./helpers/pii-474-generator');

const SEED_COUNT = Number(process.env.PII474_HISTORY_SEEDS) || 12;
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => 474 + i);
const N = 150;

// Each route returns the masked texts; `registry`, when given, is the one the call ran on.
const viaHistory = (f, texts, registry = f.makeRegistry()) => f
  .stripHistoryPii(texts.map((content) => ({ role: 'physician', content })), [], registry).map((m) => m.content);
const viaPrime = (f, texts, registry = f.makeRegistry()) => {
  f.primeRegistry(texts, registry, []);
  return texts.map((t) => f.stripPii(t, registry, []));
};
const ROUTES = [['stripHistoryPii', viaHistory], ['primeRegistry', viaPrime]];

// Each token of this branch whose restore entries hold values master gave different tokens: two referents merged.
// `taken` marks the one kind left (#474 residual), where the extra value is a word this branch's own surname pass took
// next to a name (takeSurnames, master's rule): a pass of this branch ate the context master read that word in ("Mr
// Brown∙x.y@hospital.com", "Dr May 28, 2024", "Ward: Dr. Lee"), so master knew it as another person and this branch
// as the surname beside the name. The word stays masked; it shares that name's token. No union makes one.
function merged(texts) {
  const out = [];
  for (const [route, run] of ROUTES) {
    const m = master.makeRegistry();
    const h = head.makeRegistry();
    run(master, texts, m);
    run(head, texts, h);
    const ofMaster = new Map(m.entries().map((e) => [`${e.category} ${e.value}`, e.token]));
    const byToken = new Map();
    for (const e of h.entries()) {
      const t = ofMaster.get(`${e.category} ${e.value}`);
      if (t) byToken.set(e.token, [...(byToken.get(e.token) ?? []), { ...e, of: t }]);
    }
    for (const [token, es] of byToken) {
      if (new Set(es.map((e) => e.of)).size < 2) continue;
      const rest = es.filter((e) => h.knownWordAliases(e.category)[e.value] !== token);
      out.push({ route, texts, token, of: es.map((e) => `${e.of}=${e.value}`), taken: new Set(rest.map((e) => e.of)).size < 2 });
    }
  }
  return out;
}
const tokensIn = (t) => new Set(t.match(/\[[A-Z]+-\d+\]/g) ?? []);

// Each text's letters or digits this branch leaves in clear more often than master does, per route.
function lost(texts) {
  const out = [];
  for (const [route, run] of ROUTES) {
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
    // This branch masks the given name as a name and the surname inside the email, so no mask of its spans master's
    // name: the bare surname takes a token of its own (one person split, never two merged).
    [['Dr. Somchai Jaidee·md@hospital.com', 'Jaidee called back'], ['Dr [NAME-1] [EMAIL-1]', '[NAME-2] called back']],
  ])('%j', (texts, expected) => {
    expect(viaHistory(head, texts)).toEqual(expected);
    expect(viaPrime(head, texts)).toEqual(expected);
    expect(lost(texts)).toEqual([]);
    expect(merged(texts)).toEqual([]);
  });

  // Two people who share a name part, one written where this branch eats master's context: the union over the one
  // master masks must not take the other's token, in that text or in a later one through the shadow's map (#474).
  // [texts, the indexes of the two texts that name each person by a part of their own].
  test.each([
    [['Prof John Smith', 'WARD:Prof John Brown', 'Smith has fever', 'Brown has fever'], [2, 3]],
    [['Dr Mary Jaidee', 'WARD:Prof Somchai Jaidee', 'Mary has fever', 'Somchai has fever'], [2, 3]],
    [['Green has fever', 'Lee reports chest pain', 'Ward# Dr Lee Robert Prof Robert Green'], [0, 1]],
  ])('two people keep two tokens: %j', (texts, [a, b]) => {
    for (const [, run] of ROUTES) {
      const m = run(master, texts);
      const h = run(head, texts);
      expect([...tokensIn(m[a])].some((t) => tokensIn(m[b]).has(t))).toBe(false);
      expect(tokensIn(h[a]).size).toBe(1);
      expect(tokensIn(h[b]).size).toBe(1);
      expect(tokensIn(h[a])).not.toEqual(tokensIn(h[b]));
    }
    expect(lost(texts)).toEqual([]);
    expect(merged(texts)).toEqual([]);
  });

  // The residual kind `merged` lets through, pinned: the word is masked, under the name's token.
  test.each([
    [['นางสมชาย ใจดี Brown has fever', 'Mr Brown∙x.y@hospital.com'], ['นาง[NAME-1] [NAME-1] [NAME-1] has fever', 'Mr [EMAIL-1]']],
    [['คุณสมศรี ทองคำ May', 'with Dr May 28, 2024'], ['คุณ[NAME-1] [NAME-1] [NAME-1]', 'with Dr [DATE-1]']],
  ])('residual, a surname taken beside a name: %j', (texts, expected) => {
    expect(viaHistory(head, texts)).toEqual(expected);
    expect(viaPrime(head, texts)).toEqual(expected);
    expect(lost(texts)).toEqual([]);
    const m = merged(texts);
    expect(m.length).toBe(2);
    expect(m.every((x) => x.taken)).toBe(true);
  });

  test.each(SEEDS)('seed %i: two people who share a name part are never merged', (seed) => {
    const next = twoPeopleGenerator(seed);
    const found = [];
    for (let n = 0; n < N; n += 1) {
      const { texts, mentions } = next();
      found.push(...lost(texts), ...merged(texts));
      for (const [route, run] of ROUTES) {
        const m = run(master, texts);
        const h = run(head, texts);
        const of = (out, i) => new Set(mentions.filter((x) => x.i === i).flatMap((x) => [...tokensIn(out[texts.indexOf(x.text)])]));
        const both = (out) => [...of(out, 0)].filter((t) => of(out, 1).has(t));
        if (both(h).length > both(m).length) found.push({ route, texts, master: m, head: h });
      }
    }
    expect(found.slice(0, 5)).toEqual([]);
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
        found.push(...lost(texts), ...merged(texts).filter((x) => !x.taken));
      }
      expect(found.slice(0, 5)).toEqual([]);
      expect(crossText).toBeGreaterThan(N * 0.6); // not vacuous: 135 to 145 of 150 on the 24 seeds today
    });
  });
});
