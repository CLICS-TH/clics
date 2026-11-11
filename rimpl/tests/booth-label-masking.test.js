// A booth visitor may type a patient identifier behind its label ("HN 1234567", "Patient name Dalton Prewitt"), in
// either look's language (#377). A value typed after a label has no end a rule can find, so in a typed answer
// everything from the first label on is one token (maskLabelledTail, #422). Every row of tests/helpers/booth-labels.js
// in both languages, and every shape that leaked past the value-extent rules, goes through POST /chat in booth_mode
// the way the backend builds it.
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
const { LANGUAGES, labelRows } = require('./helpers/booth-labels');

const CASES_DIR = path.join(__dirname, '../../backend/src/booth-cases/NFCME-2026');
const CASES = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => [f, JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8'))]);
const kase = CASES.find(([f]) => f === 'adhf.json')[1];
const OTHER_ANSWERS = { th: ['ให้ยาขับปัสสาวะ', 'ให้ออกซิเจน'], en: ['Give a diuretic', 'Give oxygen'] };
const NEUTRAL = { th: 'ให้ฟูโรซีไมด์', en: 'Give furosemide' };

// Each shape leaked part of its value past the value-extent rules at 0df2e919 (doublej gate, #422 finding 1), or
// masked clinical text elsewhere in the call through an alias (finding 2). [typed answer, the text before its label].
const LEAKED = [
  ['Name: Dalton prewitt', ''],
  ['Name: Dalton van Prewitt', ''],
  ['Name dalton prewitt', ''],
  ['Province nakhon pathom', ''],
  ['Name: dalton province prewitt', ''],
  ['Address: 12 Village\ngreen', ''],
  ['Address: 12 Hospital Road', ''],
  ['Name: Dalton No Prewitt', ''],
  ['Mr Dalton James Prewitt', ''],
  ['Address: 123/45 Soi Wattana Suthep Road Mueang Lamphun Chiang Mai', ''],
  ['Name:\nSurname: Prewitt', ''],
  ['The diagnosis name is heart failure.', 'The diagnosis '],
  ['Patient name: dalton prewitt ran out of his tablets', ''],
  ['Give oxygen first. hn1234567', 'Give oxygen first. '],
];

const TOKEN = /\[[A-Z]+-\d+\]/;
const FENCE_RE = /⟦([^⟦⟧]*)⟧/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oneToken = (before) => new RegExp(`^${escapeRe(before)}${TOKEN.source}$`);

beforeEach(() => {
  callAI.mockReset();
  callAI.mockResolvedValue({ text: '{}', tokenCount: 1, inputTokens: 1, outputTokens: 1, provider: 'local-tutor', model: 'm' });
});

function typedPlay(language, tierPath, texts) {
  const answers = texts.map((text) => ({ text }));
  return {
    answers,
    replies: answers.slice(1).map(() => ({ strength: 'ok', weigh: '', safety: '' })),
    asks: texts.map(() => ({ variant: 'v1', bridge: '' })),
    tierPath,
    unsorted: true,
    look: language,
  };
}

const send = (d) => request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(kase, d) });
const userTurns = () => callAI.mock.calls[0][0].messages.filter((m) => m.role === 'user').map((m) => m.content);
// The text inside every fence the AI was sent, in answer order.
const fences = () => userTurns().flatMap((c) => [...c.matchAll(FENCE_RE)].map((m) => m[1]));
// The AI call with every typed answer emptied: what must not change when one answer holds a labelled value.
const outsideAnswers = () => JSON.stringify(callAI.mock.calls).replace(FENCE_RE, '⟦⟧');

// Plants `typed` as the answer at `at` of `texts`. That answer reaches the AI and the kept answer as one token from its
// label on, and the rest of the call is the call with an unlabelled answer in its place, so no value part reaches the AI
// anywhere else and none became an alias masking text elsewhere.
async function expectMasked(language, tierPath, texts, at, typed, before) {
  const play = (answer) => typedPlay(language, tierPath, texts.map((t, i) => (i === at ? answer : t)));
  const res = await send(play(typed));
  expect(res.status).toBe(200);
  expect(fences()[at]).toMatch(oneToken(before));
  if (at === texts.length - 1) expect(res.body.answer_deidentified).toMatch(oneToken(before));
  const masked = outsideAnswers();
  callAI.mockClear();
  await send(play(NEUTRAL[language]));
  expect(masked).toBe(outsideAnswers());
}

describe.each(LANGUAGES)('%s look: a value typed behind its label is one token from the label on', (lang) => {
  const [first, third] = OTHER_ANSWERS[lang];

  test.each(labelRows(lang))('%s (%s %s) at step 1, after the vignette', async (_kind, label, value) => {
    await expectMasked(lang, '', [''], 0, `${label} ${value}`, '');
    expect(userTurns()[0]).toContain(`\n\n${bankAt(kase, '').variants[0].question[lang]}\n`);
  });

  test.each(labelRows(lang))('%s (%s %s) at step 2, then in the next turn\'s history', async (_kind, label, value) => {
    await expectMasked(lang, 'W', [first, ''], 1, `${label} ${value}`, '');
    callAI.mockClear();
    await expectMasked(lang, 'WB', [first, '', third], 1, `${label} ${value}`, '');
    expect(userTurns()).toHaveLength(3);
  });
});

describe.each(LEAKED)('%j, typed in the English look', (typed, before) => {
  test('at step 1, after the vignette', async () => {
    await expectMasked('en', '', [''], 0, typed, before);
  });

  test('at step 2, then in the next turn\'s history', async () => {
    await expectMasked('en', 'W', ['Give a diuretic', ''], 1, typed, before);
    callAI.mockClear();
    await expectMasked('en', 'WB', ['Give a diuretic', '', 'Give oxygen'], 1, typed, before);
  });
});

// A tapped answer is vetted option text, sent unfenced; the label rule never reads it. This line holds จังหวัด.
test.each(LANGUAGES)('%s look: a tapped option reaches the AI as written', async (lang) => {
  const best = (tierPath) => ({ choice: bankAt(kase, tierPath).options.find((o) => o.tier === 'best').id });
  const refer = bankAt(kase, 'BB').options.find((o) => o.id === 'refer');
  const d = {
    answers: [best(''), best('B'), { choice: 'refer' }],
    replies: [{ strength: 'ok', weigh: '', safety: '' }, { strength: 'ok', weigh: '', safety: '' }],
    asks: [{ variant: 'v1', bridge: '' }, { variant: 'v1', bridge: '' }, { variant: 'v1', bridge: '' }],
    tierPath: 'BB',
    look: lang,
  };
  expect(refer.line.th).toContain('จังหวัด');
  await send(d);
  expect(userTurns().at(-1)).toContain(`${refer.label[lang]}: ${refer.line[lang]}`);
  expect(fences()).toEqual([]);
});

// #412: a bank question that ENDS in the label, with the value typed under it. On master the fence note sits between
// them and keeps them apart. #414 fixes that structure; its check iterates this same table (labelRows, both
// languages) once it lands, and these todos go with it.
describe('#414: a question ending in the label masks the value typed under it', () => {
  for (const lang of LANGUAGES) {
    for (const [kind, label, value] of labelRows(lang)) test.todo(`#414 ${lang}: ${kind}, "${label}" ends the question, "${value}" typed under it`);
  }
});

// Vetted English case text holds no PII, and routes/chat.js reads a question that masks on its own apart from its
// answer (#406), so a rule that fires in case text would both corrupt the case and move that split.
test('no vetted English case text masks as anything but an age', () => {
  const texts = CASES.flatMap(([, k]) => {
    const banks = [k.banks.step1, ...Object.values(k.banks.step2), ...Object.values(k.banks.step3)];
    return [k.vignette.en, ...banks.flatMap((b) => [...b.variants.map((v) => v.question.en),
      ...b.options.flatMap((o) => [o.label.en, o.line.en])])];
  });
  expect(texts.length).toBeGreaterThan(1000);
  for (const t of texts) expect(stripPii(t).replace(/\[AGE-\d+\]/g, '')).not.toMatch(TOKEN);
});
