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

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { chatRequest, bankAt } = require('../../backend/src/services/booth-dialogue');
const { stripPii } = require('../src/services/pii-filter');

const CASES_DIR = path.join(__dirname, '../../backend/src/booth-cases/NFCME-2026');
const ANSWERS = [
  'ให้ออกซิเจนและส่งตรวจเพิ่มเติม',
  'ส่งตรวจ CBC และ electrolyte',
  'ให้น้ำเกลือและยาปฏิชีวนะทันที',
  'คิดถึงภาวะช็อกจากการเสียเลือด',
];
const L = ['B', 'R', 'W'];
const PATHS = ['', ...L, ...L.flatMap((x) => L.map((y) => x + y))];

// One play per (case, path, variant): every step typed, the earlier steps with the first variant of their bank.
const PLAYS = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort().flatMap((file) => {
  const kase = JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), 'utf8'));
  return PATHS.flatMap((tierPath) => bankAt(kase, tierPath).variants.map((v) => {
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
    return [`${file} ${tierPath || '-'} ${v.id}`, kase, d];
  }));
});

beforeEach(() => {
  callAI.mockReset();
  callAI.mockResolvedValue({ text: '{}', tokenCount: 1, inputTokens: 1, outputTokens: 1, provider: 'local-tutor', model: 'm' });
});

test('every NFCME-2026 case and path is played', () => {
  expect(new Set(PLAYS.map(([, kase]) => kase)).size).toBe(11);
  expect(PLAYS.length).toBeGreaterThan(300);
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
const caseFile = (name) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, name), 'utf8'));

// #401: the kept answer is exactly the answer text the AI saw. At step 1 the vignette comes first; a masked answer
// under a question read together with it must not carry the question line (PR #407 round 2).
test('a masked step-1 answer is kept exactly as the AI saw it, without the question', async () => {
  const kase = caseFile('adhf.json');
  const d = typedPlay(kase, '', ['v1'], ['นายพรรณราย ตัวดี']);
  const res = await request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(kase, d) });
  const seen = seenAnswer(sentTurns()[0]);
  expect(seen).toMatch(/^นาย\[NAME-\d+\] \[NAME-\d+\]$/);
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

// #412: the backend puts a note line between the question and the fenced answer (#400). A label that ends a bank
// question must still mask the value typed under it, in the AI's text and in the kept copy, at step 1 (after the
// vignette) and in a later step's history. Each bank question here ends in a label that masks the value when the two
// are read together, and does not mask on its own.
describe('a bank question that ends in an identifier label masks the value typed under it', () => {
  const LABELLED = [
    ['an HN', 'HN', '1234567'],
    ['an MRN', 'MRN', '65-012345'],
    ['a surname', 'นามสกุล', 'ทองเปลว'],
    ['a title', 'นาย', 'พรรณราย ทองเปลว'],
    ['a subdistrict', 'ตำบล', 'บางรัก'],
    ['a province', 'จังหวัด', 'นครปฐม'],
  ];
  // adhf.json with the first variant of the bank at `tierPath` asking for `label`.
  const labelled = (tierPath, label) => {
    const kase = caseFile('adhf.json');
    const { question } = bankAt(kase, tierPath).variants[0];
    question.th = `${question.th} ระบุ${label}`;
    expect(stripPii(question.th)).toBe(question.th);
    return kase;
  };
  // A value counts as masked when the answer holds a token and no word of the value, nor any run of its digits.
  const expectMasked = (text, value) => {
    expect(text).toMatch(/\[[A-Z]+-\d+\]/);
    for (const part of value.split(' ')) expect(text).not.toContain(part);
    expect(text.replace(/\[[A-Z]+-\d+\]/g, '')).not.toMatch(/\d{3,}/);
  };

  test.each(LABELLED)('%s at step 1', async (_kind, label, value) => {
    const kase = labelled('', label);
    const res = await request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(kase, typedPlay(kase, '', ['v1'], [value])) });
    for (const part of value.split(' ')) expect(JSON.stringify(callAI.mock.calls)).not.toContain(part);
    const seen = seenAnswer(sentTurns()[0]);
    expectMasked(seen, value);
    expect(res.body.answer_deidentified).toBe(seen);
  });

  test.each(LABELLED)('%s at step 2, then in its history', async (_kind, label, value) => {
    const kase = labelled('W', label);
    const second = await request(app).post('/chat')
      .send({ ple_id: 'x', ...chatRequest(kase, typedPlay(kase, 'W', ['v1', 'v1'], ['ให้ยาขับปัสสาวะ', value])) });
    expectMasked(second.body.answer_deidentified, value);
    expect(second.body.answer_deidentified).toBe(seenAnswer(sentTurns()[1]));
    callAI.mockClear();
    await request(app).post('/chat')
      .send({ ple_id: 'x', ...chatRequest(kase, typedPlay(kase, 'WB', ['v1', 'v1', 'v1'], ['ให้ยาขับปัสสาวะ', value, 'ให้ออกซิเจน'])) });
    const wire = JSON.stringify(callAI.mock.calls);
    for (const part of value.split(' ')) expect(wire).not.toContain(part);
    expectMasked(seenAnswer(sentTurns()[1]), value);
  });
});

// #412: every real bank question, in each language the backend sends it in (#377 adds English: `look` picks the
// language, and the vignette and question are set in both slots so the request is the same with or without #377),
// ending in each kind of identifier label, with a matching value typed under it. The value never reaches the AI nor
// answer_deidentified, whether routes/chat.js reads the question with the answer or apart (a question that masks on
// its own, #406), and the kept copy is the text inside the fence the AI saw. Every request is the backend's own
// chatRequest, through POST /chat.
describe('every bank question that ends in an identifier label masks the value typed under it', () => {
  // Every title the filter knows (pii-filter.js TH_TITLES, EN_TITLES): each question that masks on its own gets every
  // one, the others one each in turn.
  const TH_TITLES = ['นพ.', 'พญ.', 'ด.ช.', 'ด.ญ.', 'เด็กชาย', 'เด็กหญิง', 'เด็กทารก', 'นางสาว', 'นาง', 'นาย', 'คุณ'];
  const EN_TITLES = ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Prof'];
  const LABELS = [
    ['a given name', 'ชื่อ', 'พรรณราย'],
    ['a nickname', 'ชื่อเล่น', 'แป้งร่ำ'],
    ['a surname', 'นามสกุล', 'ทองเปลว'],
    ['a Thai title', TH_TITLES, 'พรรณราย ทองเปลว'],
    ['an English title', EN_TITLES, 'Johnathan Smithers'],
    ['a LINE id', 'LINE ID', 'pannarai99'],
    ['a subdistrict', 'ตำบล', 'บางรัก'],
    ['a district', 'อำเภอ', 'บางรัก'],
    ['a province', 'จังหวัด', 'นครปฐม'],
    ['an HN', 'HN', '1234567'],
    ['an MRN', 'MRN', '65-012345'],
    ['a national ID', 'เลขบัตรประชาชน', '1234567890123'],
  ];
  const LEAD = { th: ' ระบุ', en: ' ' };
  // One play per distinct question text and language, the question at the step of its bank, every step typed.
  const seen = new Set();
  const QUESTIONS = PLAYS.flatMap(([, kase, d]) => {
    const variant = d.asks[d.asks.length - 1].variant;
    const { question } = bankAt(kase, d.tierPath).variants.find((v) => v.id === variant);
    return ['th', 'en'].filter((lang) => !seen.has(`${lang}:${question[lang]}`) && seen.add(`${lang}:${question[lang]}`))
      .map((lang) => ({ kase, d, variant, lang, question: question[lang] }));
  });

  test('every distinct question is here in both languages, the questions that mask on their own among them', () => {
    expect(QUESTIONS.filter((q) => q.lang === 'th').length).toBeGreaterThan(150);
    expect(QUESTIONS.filter((q) => q.lang === 'en').length).toBeGreaterThan(150);
    expect(QUESTIONS.filter((q) => stripPii(q.question) !== q.question).length).toBeGreaterThan(0);
  });

  // Each question with each label of a kind, or with one of them in turn (a question that masks on its own takes all).
  const labelled = (labels) => QUESTIONS.flatMap((q, i) => (typeof labels === 'string' ? [labels]
    : stripPii(q.question) !== q.question ? labels : [labels[i % labels.length]]).map((label) => ({ ...q, label })));

  test.each(LABELS)('%s', async (_kind, labels, value) => {
    const leaks = [];
    for (const { kase: base, d, variant, lang, question, label } of labelled(labels)) {
      const kase = structuredClone(base);
      const v = bankAt(kase, d.tierPath).variants.find((x) => x.id === variant);
      v.question.th = `${question}${LEAD[lang]}${label}`;
      v.question.en = v.question.th;
      if (lang === 'en') kase.vignette.th = kase.vignette.en;
      const answers = [...d.answers.slice(0, -1), { text: value }];
      callAI.mockClear();
      const res = await request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(kase, { ...d, answers, look: lang }) });
      const wire = JSON.stringify(callAI.mock.calls);
      const kept = res.body.answer_deidentified;
      const parts = value.split(' ');
      const where = [
        parts.some((part) => wire.includes(part)) && 'AI',
        parts.some((part) => (kept ?? '').includes(part)) && 'stored',
        kept !== seenAnswer(sentTurns().pop()) && 'stored copy is not the fenced text',
      ].filter(Boolean);
      if (where.length) leaks.push(`${lang} ${JSON.stringify(v.question.th)}: ${where.join(', ')}`);
    }
    expect(leaks).toEqual([]);
  }, 60000);
});

// #412: a question holding a line break must not move the fence. rimpl reads the fence from the end of the turn, so
// the value under an HN label on the question's second line is masked like the one-line question's.
// (backend/src/booth-cases/tree-schema.js also refuses such a question.)
test.each([
  ['on one line', 'โปรดระบุHN'],
  ['over two lines', 'โปรดระบุ\nHN'],
])('a question ending in an HN label %s masks the value typed under it', async (_kind, question) => {
  const kase = caseFile('adhf.json');
  bankAt(kase, '').variants[0].question.th = question;
  const res = await request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(kase, typedPlay(kase, '', ['v1'], ['1234567'])) });
  expect(JSON.stringify(callAI.mock.calls)).not.toContain('1234567');
  expect(res.body.answer_deidentified).toBe('[HN-1]');
  expect(seenAnswer(sentTurns()[0])).toBe('[HN-1]');
});
