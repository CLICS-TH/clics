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

// Each token of this branch whose restore entries hold values master gave different tokens: two referents merged. No
// kind is exempt (#474).
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
      if (new Set(es.map((e) => e.of)).size > 1) out.push({ route, texts, token, of: es.map((e) => `${e.of}=${e.value}`) });
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
    // The union over master's name binds its parts as master does (aliasLikeMaster), so the bare surname keeps its token.
    [['ward: Dr Somchai Jaidee', 'Jaidee called back'], ['[WARD-1] [NAME-1] [NAME-1]', '[NAME-1] called back']],
    [['Ward#Mrs Brown', 'Brown is stable'], ['[WARD-1] [NAME-1]', '[NAME-1] is stable']],
    // This branch masks the given name as a name and the surname inside the email: the name's token learns the surname
    // master binds to it (aliasLikeMaster), so the bare surname keeps that token.
    [['Dr. Somchai Jaidee·md@hospital.com', 'Jaidee called back'], ['Dr [NAME-1] [EMAIL-1]', '[NAME-1] called back']],
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

  // A word master knew as another person, read in context a pass of this branch eats, is not bound to a name of this
  // branch, as a taken surname or an alias (heldByAnother); the union masks it under a token of its own (#474).
  test.each([
    [['นางสมชาย ใจดี Brown has fever', 'Mr Brown∙x.y@hospital.com'], ['นาง[NAME-1] [NAME-1] [NAME-2] has fever', 'Mr [EMAIL-1]']],
    [['คุณสมศรี ทองคำ May', 'with Dr May 28, 2024'], ['คุณ[NAME-1] [NAME-1] [NAME-2]', 'with Dr [DATE-1]']],
    [['คุณสมศรี ทองคำ Lee', 'Ward: Dr. Lee'], ['คุณ[NAME-1] [NAME-1] [NAME-2]', '[WARD-1]. [NAME-2]']],
    [['Dr Brown∙jb@hosp.org', 'Mr Brown Smith, Called Smith back', 'Brown +66 99 231 3039', 'Called Brown back',
      'with Dr Brown Smith 3 2025', 'Dr Brown'],
    ['Dr [EMAIL-1]', 'Mr [NAME-2], Called [NAME-2] back', '[NAME-1] [PHONE-1]', 'Called [NAME-1] back', 'with Dr [NAME-2] 3 2025',
      'Dr [NAME-1]']],
    // The union mints by its own value, never by master's token: the two registries reach one span through aliases
    // bound first-wins, so one span may stand for two people (Brown of ทองคำ here, of Smith Brown in master).
    [['นางทองคำ Brown', 'ward#Mr Smith Brown, Brown.', 'Mr Smith Brown'],
      ['นาง[NAME-1] [NAME-3]', '[WARD-1] [NAME-3] [NAME-3], [NAME-3].', 'Mr [NAME-3]']],
    [['Ward: Dr. ทองคำ สมชาย, April', 'Ward# Mrs June April April has fever', 'Prof June April'],
      ['[WARD-1]. [NAME-1] [NAME-1], [NAME-3]', '[WARD-2] [NAME-3] [NAME-3] [NAME-3] has fever', 'Prof [NAME-3]']],
    // Master's name pass reads "Lee Dr" as one name: the Dr is masked, as master masks it.
    [['HN 1234567 ศรีสุข สมศรี, Lee∙x.y@hospital.com', 'Name: Lee', 'ศรีสุขมาด้วยไข้', 'WARD:Prof Lee Dr Lee'],
      ['[HN-1] [NAME-1] [NAME-1], [EMAIL-1]', 'Name: [NAME-2]', '[NAME-1]มาด้วยไข้', '[WARD-1] [NAME-2] [NAME-3] [NAME-2]']],
  ])('two people master keeps apart stay apart: %j', (texts, expected) => {
    expect(viaHistory(head, texts)).toEqual(expected);
    expect(viaPrime(head, texts)).toEqual(expected);
    expect(lost(texts)).toEqual([]);
    expect(merged(texts)).toEqual([]);
  });

  // Master takes MRN, glued to a value master does not read as one, for a surname. A Latin alias matches inside a token,
  // so binding it would break this branch's [MRN-1] into [[NAME-2]-1] (aliasLikeMaster never binds a token's category).
  test('a word that is a token category is never bound as a name part', () => {
    const texts = ['คุณสมชาย, MRN ②⑨⑨③①⑤② ok', 'MRN noted'];
    expect(viaHistory(head, texts)[0]).toBe('คุณ[NAME-1], [MRN-1] ok');
    expect(viaPrime(head, texts)[0]).toBe('คุณ[NAME-1], [MRN-1] ok');
    expect(lost(texts)).toEqual([]);
    expect(merged(texts)).toEqual([]);
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
        found.push(...lost(texts), ...merged(texts));
      }
      expect(found.slice(0, 5)).toEqual([]);
      expect(crossText).toBeGreaterThan(N * 0.6); // not vacuous: 135 to 145 of 150 on the 24 seeds today
    });
  });
});
