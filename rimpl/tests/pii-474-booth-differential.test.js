// #474 on the booth route: deidentifyBoothTurn (routes/chat.js) cuts each fenced typed answer at its first identifier
// label (maskLabelledTail) before priming. This branch also finds a label in the folded view (𝐍𝐚𝐦𝐞, 𝐇𝐍, 𝐈𝐃), so it can
// cut earlier than master, and master read, and learnt names from, the text between the two cuts. Every string the
// route returns (what reaches the AI, and the kept answer) must leave no letter or digit in clear more often than the
// same route run with master's filter (tests/fixtures/pii-filter.master-474.js). PII474_BOOTH_SEEDS=<n> runs n seeds.
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
const { historyGenerator, moreInClear } = require('./helpers/pii-474-generator');

const head = require('../src/services/pii-filter');
const master = require('./fixtures/pii-filter.master-474');
const headRoute = require('../src/routes/chat')._deidentifyBoothTurnForTest;
// The same route file with master's filter in place of this branch's (the mock outlives the block: require nothing after).
let masterRoute;
jest.isolateModules(() => {
  jest.doMock('../src/services/pii-filter', () => require('./fixtures/pii-filter.master-474'));
  masterRoute = require('../src/routes/chat')._deidentifyBoothTurnForTest;
});

const SEED_COUNT = Number(process.env.PII474_BOOTH_SEEDS) || 6;
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => 474 + i);
const N = 100;

const Q1 = 'What is the most likely diagnosis?';
const Q2 = 'Which first tests do you order?';

// Every string the route hands on: the clean chief complaint, each clean turn, the clean message, the kept answer.
function outputs(route, f, { cc, history, message, boothAnswer, patientRef = null }) {
  const r = route({ chiefComplaint: cc, history, message, hints: f.deriveHintTokens(patientRef), boothAnswer });
  return [r.cleanChiefComplaint, ...r.cleanHistory.map((m) => m.content), r.cleanMessage, r.cleanBoothAnswer ?? ''];
}

function lost(call) {
  const m = outputs(masterRoute, master, call);
  const h = outputs(headRoute, head, call);
  return h.flatMap((t, i) => {
    const extra = moreInClear(t, m[i]);
    return extra.length ? [{ call, at: i, master: m[i], head: t, extra }] : [];
  });
}

// One booth call: a first physician turn, an AI reply, then the message, each physician answer fenced.
const call = (a1, a2, { reply = 'Good start. Next, which tests?', cc } = {}) => ({
  cc,
  history: [{ role: 'physician', content: `${Q1}\n${fenced(a1)}` }, { role: 'assistant', content: reply }],
  message: `${Q2}\n${fenced(a2)}`,
  boothAnswer: a2,
});

describe('#474 booth route against master', () => {
  test('the master route runs master filter', () => {
    expect(masterRoute).not.toBe(headRoute);
    expect(head.maskLabelledTail('𝐍𝐚𝐦𝐞 x', head.makeRegistry())).toBe('[PII-1]');
    const c = call('𝐍𝐚𝐦𝐞 Dr Somchai Jaidee', 'x');
    expect(outputs(masterRoute, master, c)[1]).toBe(`${Q1}\n${fenced('𝐍𝐚𝐦𝐞 Dr [NAME-1]')}`);
    expect(outputs(headRoute, head, c)[1]).toBe(`${Q1}\n${fenced('[PII-1]')}`);
  });

  // [first answer, message answer, options, clean message answer of this branch, kept answer of this branch].
  test.each([
    ['𝐍𝐚𝐦𝐞 Dr Somchai Jaidee', 'Jaidee has fever', {}, '[NAME-1] has fever', '[NAME-1] has fever'],
    ['𝐇𝐍 12345 Dr Somchai Jaidee', 'Jaidee has fever', {}, '[NAME-1] has fever', '[NAME-1] has fever'],
    ['𝐈𝐃 12345 Dr Somchai Jaidee', 'Somchai has fever', {}, '[NAME-1] has fever', '[NAME-1] has fever'],
    ['fever 3 days. 𝐍𝐚𝐦𝐞 Dr Somchai Jaidee', 'Jaidee has fever', {}, '[NAME-1] has fever', '[NAME-1] has fever'],
    ['𝐍𝐚𝐦𝐞 คุณสมชาย ใจดี', 'ใจดีมาด้วยไข้', {}, '[NAME-1]มาด้วยไข้', '[NAME-1]มาด้วยไข้'],
    ['𝐇𝐍 12345 คุณสมชาย ใจดี', 'สมชายมาด้วยไข้', {}, '[NAME-1]มาด้วยไข้', '[NAME-1]มาด้วยไข้'],
  ])('%j, then %j', (a1, a2, opts, cleanAnswer, kept) => {
    const c = call(a1, a2, opts);
    const h = outputs(headRoute, head, c);
    expect(h[3]).toBe(`${Q2}\n${fenced(cleanAnswer)}`);
    expect(h[4]).toBe(kept);
    expect(lost(c)).toEqual([]);
  });

  // The name bare in the AI's reply, in the chief complaint, or in the turn before the labelled one.
  test.each([
    ['in the reply', call('𝐍𝐚𝐦𝐞 Dr Somchai Jaidee', 'sepsis', { reply: 'Jaidee looks septic. Next?' }), 2, '[NAME-1] looks septic. Next?'],
    ['in the chief complaint', call('𝐍𝐚𝐦𝐞 Dr Somchai Jaidee', 'sepsis', { cc: 'Jaidee, 42M, fever' }), 0, '[NAME-1], 42M, fever'],
    ['in the reply, Thai', call('𝐍𝐚𝐦𝐞 คุณสมชาย ใจดี', 'เลปโตสไปโรสิส', { reply: 'ใจดีดูติดเชื้อรุนแรง ต่อไป?' }), 2, '[NAME-1]ดูติดเชื้อรุนแรง ต่อไป?'],
    ['in an earlier turn', {
      history: [
        { role: 'physician', content: `${Q1}\n${fenced('Jaidee has fever')}` },
        { role: 'assistant', content: 'Next?' },
        { role: 'physician', content: `${Q2}\n${fenced('𝐇𝐍 12345 Dr Somchai Jaidee')}` },
        { role: 'assistant', content: 'And then?' },
      ],
      message: `${Q2}\n${fenced('sepsis')}`,
      boothAnswer: 'sepsis',
    }, 1, `${Q1}\n${fenced('[NAME-1] has fever')}`],
  ])('the name bare %s', (_where, c, at, expected) => {
    expect(outputs(headRoute, head, c)[at]).toBe(expected);
    expect(lost(c)).toEqual([]);
  });

  // Generated calls: the texts of one call (historyGenerator) as booth turns, each physician answer opening with a folded
  // label half the time, so this branch cuts it earlier than master.
  const LABELS = ['𝐍𝐚𝐦𝐞 ', '𝐍𝐚𝐦𝐞: ', '𝐇𝐍 12345 ', '𝐈𝐃 ', 'fever. 𝐍𝐚𝐦𝐞 '];
  test.each(SEEDS)('seed %i: every letter or digit master masks is masked', (seed) => {
    const next = historyGenerator(seed);
    let r = seed;
    const coin = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
    const found = [];
    let cutDiffers = 0;
    for (let n = 0; n < N; n += 1) {
      const texts = next();
      const answers = [];
      const said = (t) => {
        const a = coin() < 0.5 ? `${LABELS[Math.floor(coin() * LABELS.length)]}${t}` : t;
        answers.push(a);
        return a;
      };
      const mid = texts.slice(1, -1);
      const history = mid.map((t, i) => (i % 2 === 0
        ? { role: 'physician', content: `${i ? Q2 : Q1}\n${fenced(said(t))}` } : { role: 'assistant', content: t }));
      const answer = said(texts[texts.length - 1]);
      const c = { cc: texts[0], history, message: `${Q2}\n${fenced(answer)}`, boothAnswer: answer || undefined };
      if (answers.some((a) => head.maskLabelledTail(a, head.makeRegistry()) !== master.maskLabelledTail(a, master.makeRegistry()))) {
        cutDiffers += 1;
      }
      found.push(...lost(c));
    }
    expect(found.slice(0, 5)).toEqual([]);
    expect(cutDiffers).toBeGreaterThan(N * 0.3); // not vacuous
  });
});
