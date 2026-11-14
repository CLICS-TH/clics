// #474: a token's number must not move when a turn is added. A stored AI reply says [NAME-2]; the next call masks the
// whole session again, so if that value is then [NAME-3], the reply points at someone else. For generated chat and
// booth sessions, every value that call N masks keeps its token in call N+1 (the same session, one turn added), on each
// route, wherever master's route keeps it. Residual, by mechanism: when master's registry binds one word to two people
// (its restore entry to one, an alias or word alias to another: "นายสมชาย ใจดี" then "ชื่อ สมศรี ใจดี"), this branch
// refuses the first binding (heldByAnother reads the whole call) and the word takes a token of its own at its first
// mention, ahead of the names of later turns; such sessions are counted and capped, not exempt from the other checks.
// PII474_NUMBERING_SEEDS=<n> runs n seeds.
jest.mock('../src/services/ai', () => ({
  callAI: jest.fn(),
  providerSupportsThinking: jest.fn(),
  supportsThinking: jest.fn(),
  isProviderDown: jest.fn(),
}));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn() }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const { fenced } = require('../../backend/src/services/booth-dialogue');
const { historyGenerator, twoPeopleGenerator } = require('./helpers/pii-474-generator');

// The booth route on a filter whose makeRegistry hands over the call's registry (the first one the route makes).
function boothRoute(filterPath) {
  let route;
  let first = null;
  jest.isolateModules(() => {
    const f = jest.requireActual(filterPath);
    jest.doMock('../src/services/pii-filter', () => ({
      ...f, makeRegistry: () => { const r = f.makeRegistry(); first ??= r; return r; },
    }));
    route = require('../src/routes/chat')._deidentifyBoothTurnForTest;
  });
  return (args) => { first = null; route(args); return first; };
}
const ROUTES = {
  chat: (f) => (texts) => { const r = f.makeRegistry(); f.primeRegistry(texts, r, []); texts.forEach((t) => f.stripPii(t, r, [])); return r; },
  booth: (_f, path) => {
    const run = boothRoute(path);
    const Q = ['What is the most likely diagnosis?', 'Which first tests do you order?'];
    return (texts) => {
      const turns = texts.slice(1).flatMap((t, i) => [
        ...(i ? [{ role: 'assistant', content: 'Noted. Next?' }] : []),
        { role: 'physician', content: `${Q[i % 2]}\n${fenced(t)}` },
      ]);
      const message = turns.pop();
      return run({ chiefComplaint: texts[0], history: turns, message: message.content, hints: [], boothAnswer: texts[texts.length - 1] || undefined });
    };
  },
};
const FILTERS = { head: '../src/services/pii-filter', master: './fixtures/pii-filter.master-474' };
const LABELS = ['𝐍𝐚𝐦𝐞 ', '𝐇𝐍 12345 ', '𝐈𝐃 ', 'fever. 𝐍𝐚𝐦𝐞 ', '', '', ''];

// The token a registry masks a value under where it stands bare: an alias first, then a word alias, then its own token
// (applyBareNamePass reads the aliases first).
const bound = (r, e) => r.knownAliases(e.category)[e.value] ?? r.knownWordAliases(e.category)[e.value]
  ?? r.entries().find((x) => x.category === e.category && x.value === e.value)?.token;
// Each value call N masks whose token call N+1 (one turn more) gives another: `${category} ${value}`.
function moved(run, texts) {
  const before = run(texts.slice(0, -1));
  const after = run(texts);
  return before.entries().filter((e) => bound(before, e) !== bound(after, e)).map((e) => `${e.category} ${e.value}`);
}

// Whether master's registry binds a NAME word to two tokens.
const twoBindings = (r) => r.entries().some((e) => e.category === 'NAME' && [r.knownAliases('NAME')[e.value],
  r.knownWordAliases('NAME')[e.value]].some((t) => t !== undefined && t !== e.token));

const SEED_COUNT = Number(process.env.PII474_NUMBERING_SEEDS) || 6;
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => 474 + i);
const N = 100;

describe('#474 a token keeps its number when a turn is added', () => {
  test('the booth session of the review: Jaidee, learnt only from master\'s cut, stays NAME-1', () => {
    const run = ROUTES.booth(null, FILTERS.head);
    const texts = ['', '𝐍𝐚𝐦𝐞 Dr Somchai Jaidee', 'Prof John Smith reports pain and Jaidee has fever', 'Dr Lee and Jaidee and Smith'];
    expect(moved(run, texts)).toEqual([]);
    expect(bound(run(texts), { category: 'NAME', value: 'Jaidee' })).toBe('[NAME-1]');
  });

  describe.each(Object.keys(ROUTES))('%s route', (name) => {
    const head = ROUTES[name](require(FILTERS.head), FILTERS.head);
    const master = ROUTES[name](require(FILTERS.master), FILTERS.master);
    const tally = { split: 0, residual: 0 };
    test.each(SEEDS)('seed %i', (seed) => {
      const gens = [historyGenerator(seed), twoPeopleGenerator(seed)];
      let r = seed;
      const coin = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
      const found = [];
      let checked = 0;
      for (let n = 0; n < N; n += 1) {
        const g = gens[n % 2]();
        const texts = (Array.isArray(g) ? g : g.texts).map((t, i) => (i && name === 'booth' ? `${LABELS[Math.floor(coin() * LABELS.length)]}${t}` : t));
        if (texts.length < 3) continue;
        const byMaster = new Set(moved(master, texts));
        const m = moved(head, texts).filter((v) => !byMaster.has(v));
        if (twoBindings(master(texts))) { tally.split += 1; tally.residual += m.length ? 1 : 0; continue; }
        checked += 1;
        if (m.length) found.push({ texts, moved: m });
      }
      expect(found.slice(0, 5)).toEqual([]);
      expect(checked).toBeGreaterThan(N * 0.5);
    });
    // Over all seeds, not per seed: a seed holds about ten such sessions, too few to cap. Chat route, seeds 474-523, both
    // generators: 33 of the 365 such sessions move a number master keeps (95 at 56f8e6b3), and none of the 3852 others.
    test('sessions where master binds one word to two people: the residual stays capped', () => {
      expect(tally.split).toBeGreaterThan(0);
      expect(tally.residual).toBeLessThanOrEqual(Math.max(2, tally.split / 4));
    });
  });
});
