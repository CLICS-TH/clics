// #406: a booth physician turn is the bank question, a newline, then the visitor's typed answer
// (backend booth-dialogue.js dialogueTurns). A question that opens with the pronoun คุณ ("you") must not turn
// the answer under it into a name: the AI sorts and replies to that answer. Every request is built by the
// backend's own chatRequest and sent through POST /chat, so the route primes and strips it as in production.
jest.mock('../src/services/ai', () => ({
  callAI: jest.fn(),
  providerSupportsThinking: jest.fn(),
  supportsThinking: jest.fn(),
}));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn() }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { chatRequest, bankAt } = require('../../backend/src/services/booth-dialogue');
const { stripPii } = require('../src/services/pii-filter');
const { CASES, bankEntries, reachableBanks } = require('./helpers/booth-cases');

const ANSWERS = [
  'ให้ออกซิเจนและส่งตรวจเพิ่มเติม',
  'ส่งตรวจ CBC และ electrolyte',
  'ให้น้ำเกลือและยาปฏิชีวนะทันที',
  'คิดถึงภาวะช็อกจากการเสียเลือด',
];

// One play per (case file, bank, variant), live and staged, down the first tier path that reaches the bank: every step
// typed, the earlier steps with the first variant of their bank. Every bank, not every path: a bank's text is the same
// on each path to it.
const PLAYS = CASES.flatMap(({ file, kase }) => reachableBanks(kase).flatMap(({ key, tierPath, bank }) => bank.variants
  .map((v) => {
    const steps = tierPath.length + 1;
    const variants = [...Array(steps - 1)].map((_, i) => bankAt(kase, tierPath.slice(0, i)).variants[0].id).concat(v.id);
    const answers = variants.map((_, i) => ({ text: ANSWERS[(i + tierPath.length + v.id.length) % ANSWERS.length] }));
    const d = {
      answers,
      replies: answers.slice(1).map(() => ({ strength: 'ดี', weigh: '', safety: '' })),
      asks: variants.map((variant) => ({ variant, bridge: '' })),
      tierPath,
      unsorted: true,
    };
    return [`${file} ${key} ${v.id}`, kase, d];
  })));

beforeEach(() => {
  callAI.mockReset();
  callAI.mockResolvedValue({ text: '{}', tokenCount: 1, inputTokens: 1, outputTokens: 1, provider: 'local-tutor', model: 'm' });
});

test('every variant of every bank in every case file is played', () => {
  expect(CASES.some(({ file }) => file.startsWith('NFCME-2026/'))).toBe(true);
  const played = new Map();
  for (const [, kase, d] of PLAYS) {
    const bank = bankAt(kase, d.tierPath);
    played.set(bank, [...(played.get(bank) ?? []), d.asks.at(-1).variant]);
  }
  const variants = CASES.flatMap(({ file, kase }) => bankEntries(kase)
    .flatMap(([at, bank]) => bank.variants.map((v) => ({ name: `${file} ${at} ${v.id}`, bank, id: v.id }))));
  expect(variants.filter(({ bank, id }) => !played.get(bank)?.includes(id)).map(({ name }) => name)).toEqual([]);
  expect(PLAYS).toHaveLength(variants.length);
});

// The physician turns the AI got, the last one without the sort block after the answer (services/booth.js withSort).
const sentTurns = () => callAI.mock.calls[0][0].messages.filter((m) => m.role === 'user').map((m) => m.content.split('\n\nSORT: ')[0]);
// The typed answer as the AI saw it: inside the visitor fence (booth-dialogue.js fenced) when the turn has one.
const seenAnswer = (turn) => (turn.endsWith('\u27e7') ? turn.slice(turn.lastIndexOf('\u27e6') + 1, -1) : turn.slice(turn.lastIndexOf('\n') + 1));

test.each(PLAYS)('%s: each typed answer reaches the AI as typed, and is kept as the AI saw it', async (_name, kase, d) => {
  const res = await request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(kase, d) });
  expect(sentTurns().map(seenAnswer)).toEqual(d.answers.map(({ text }) => text));
  expect(res.body.answer_deidentified).toBe(d.answers[d.answers.length - 1].text);
});

// A play of `kase` down `tierPath`, every step typed with `texts`, each step on the variant named in `variants`.
function typedPlay(kase, tierPath, variants, texts) {
  const answers = texts.map((text) => ({ text }));
  return {
    answers,
    replies: answers.slice(1).map(() => ({ strength: 'ดี', weigh: '', safety: '' })),
    asks: variants.map((variant) => ({ variant, bridge: '' })),
    tierPath,
    unsorted: true,
  };
}
const caseFile = (name) => CASES.find(({ file }) => file === `NFCME-2026/${name}`).kase;

// #401: the kept answer is exactly the answer text the AI saw. At step 1 the vignette comes first; a masked answer
// under a question read together with it must not carry the question line (PR #407 round 2).
test('a masked step-1 answer is kept exactly as the AI saw it, without the question', async () => {
  const kase = caseFile('adhf.json');
  const d = typedPlay(kase, '', ['v1'], ['นายพรรณราย ตัวดี']);
  const res = await request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(kase, d) });
  const seen = seenAnswer(sentTurns()[0]);
  expect(seen).toMatch(/^\[[A-Z]+-\d+\]$/); // นาย is a label: one token from it on (#422)
  expect(res.body.answer_deidentified).toBe(seen);
});

// ACCEPTED RESIDUAL (#406, owner ruling on PR #407: "Accept, document fully"; docs/MIDDLEWARE-KNOWN-GAPS.md). Under a
// bank question that masks on its own, the answer is read apart from it, so what master masked there only through
// the คุณ over-mask goes out as typed, and is kept as typed. Master sends the same text in clear under every other
// bank question. These expectations pin what the head sends today, so any change to the class is visible. Names
// are synthetic and outside every gazetteer.
describe('accepted residual: an untitled name typed under a question that masks on its own goes out as typed', () => {
  const kase = caseFile('adhf.json');
  const KHUN = bankAt(kase, 'B').variants.find((v) => v.id === 'v1').question.th;
  const PLAIN = bankAt(kase, 'BB').variants.find((v) => v.id === 'v1').question.th;

  test('the questions are one that masks on its own and one that does not', () => {
    expect(KHUN).toBe('คุณจะส่งตรวจอะไรเป็นอันดับแรก');
    expect(stripPii(KHUN)).not.toBe(KHUN);
    expect(stripPii(PLAIN)).toBe(PLAIN);
  });

  test.each([
    ['a lone unknown word (the gate done-state input: booth question + ทองเปลว)', 'ทองเปลว'],
    ['an untitled full name on one line', 'พรรณราย ทองเปลว'],
    ['an untitled full name over two lines', 'พรรณราย\nทองเปลว'],
    ['an untitled full name over two lines (\\r\\n; the backend fence drops the \\r)', 'พรรณราย\r\nทองเปลว', 'พรรณราย\nทองเปลว'],
    ['a surname followed by clinical words', 'ทองเปลว ปวดท้อง'],
  ])('%s', async (_kind, said, sent = said) => {
    const d = typedPlay(kase, 'B', ['v1', 'v1'], ['ให้ยาขับปัสสาวะ', said]);
    const res = await request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(kase, d) });
    expect(seenAnswer(sentTurns()[1])).toBe(sent);
    expect(res.body.answer_deidentified).toBe(sent);
  });

  test('a later mention of that word, under a question that does not mask, also goes out as typed', async () => {
    const d = typedPlay(kase, 'BB', ['v1', 'v1', 'v1'], ['ให้ยาขับปัสสาวะ', 'ทองเปลว แพ้ยา penicillin', 'ญาติของทองเปลวโทรมา']);
    const res = await request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(kase, d) });
    const [, second, third] = sentTurns().map(seenAnswer);
    expect(second).toBe('ทองเปลว แพ้ยา penicillin');
    expect(third).toBe('ญาติของทองเปลวโทรมา');
    expect(res.body.answer_deidentified).toBe('ญาติของทองเปลวโทรมา');
  });

  test('a titled name under the same question is still masked', async () => {
    const d = typedPlay(kase, 'B', ['v1', 'v1'], ['ให้ยาขับปัสสาวะ', 'นายพรรณราย ทองเปลว']);
    const res = await request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(kase, d) });
    const wire = JSON.stringify(callAI.mock.calls);
    for (const part of ['พรรณราย', 'ทองเปลว']) {
      expect(wire).not.toContain(part);
      expect(res.body.answer_deidentified).not.toContain(part);
    }
  });
});

// routes/chat.js reads a bank question apart from the answer only when the question masks on its own. Such a
// question must give the answer no label context, or splitting it off would unmask a value master masks (#375).
test('no question read apart from its answer ends in an identifier label', () => {
  const questions = [...new Set(CASES.flatMap(({ kase }) => bankEntries(kase)
    .flatMap(([, bank]) => bank.variants.flatMap((v) => [v.question.th, v.question.en]))))];
  const apart = questions.filter((q) => stripPii(q) !== q);
  expect(apart.length).toBeGreaterThan(0);
  for (const q of apart) {
    for (const value of ['1234567', '0812345678', '65-012345', '1-2345-67890-12-3']) {
      expect(stripPii(`${q}\n${value}`).endsWith(`\n${stripPii(value)}`)).toBe(true);
    }
  }
});
