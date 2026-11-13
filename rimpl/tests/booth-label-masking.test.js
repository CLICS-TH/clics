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

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { chatRequest, bankAt, stepCount } = require('../../backend/src/services/booth-dialogue');
const { tierPaths } = require('../../backend/src/booth-cases/tree-schema');
const { maskLabelledTail, makeRegistry } = require('../src/services/pii-filter');
const { LANGUAGES, labelRows } = require('./helpers/booth-labels');
const { CASES } = require('./helpers/booth-cases');

const kase = CASES.find(({ file }) => file === 'NFCME-2026/adhf.json').kase;
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
  // A label written plural, glued to its value or inside a word passed the whole-word rule at 86f14f96 (re-gate).
  ['Names: Dalton Prewitt', ''],
  ['Patient names Dalton Prewitt', ''],
  ['fullname Dalton Prewitt', 'full'],
  ['NameDalton Prewitt', ''],
  ['MrDalton Prewitt', ''],
  ['Misses: Dalton Prewitt', ''],
  ['IDs 1234567', ''],
];

// Clinical words a booth answer keeps whole: the short labels match only at a word start.
test.each(['admission to ICU', 'start dobutamine', 'newborn jaundice', 'admit to hospital now', 'identify the cause',
  'early mobilisation', 'consider IV fluid'])('the clinical answer %j keeps every word', (answer) => {
  expect(maskLabelledTail(answer, makeRegistry())).toBe(answer);
});

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

const send = (d, k = kase) => request(app).post('/chat').send({ ple_id: 'x', ...chatRequest(k, d) });
const userTurns = () => callAI.mock.calls[0][0].messages.filter((m) => m.role === 'user').map((m) => m.content);
// The text inside every fence the AI was sent, in answer order.
const fences = () => userTurns().flatMap((c) => [...c.matchAll(FENCE_RE)].map((m) => m[1]));
// The AI call with every typed answer emptied: what must not change when one answer holds a labelled value.
const outsideAnswers = () => JSON.stringify(callAI.mock.calls).replace(FENCE_RE, '⟦⟧');

// Plants `typed` as the answer at `at` of `texts`. That answer reaches the AI and the kept answer as one token from its
// label on, and the rest of the call is the call with an unlabelled answer in its place, so no value part reaches the AI
// anywhere else and none became an alias masking text elsewhere.
async function expectMasked(language, tierPath, texts, at, typed, before, k = kase) {
  const play = (answer) => typedPlay(language, tierPath, texts.map((t, i) => (i === at ? answer : t)));
  const res = await send(play(typed), k);
  expect(res.status).toBe(200);
  expect(fences()[at]).toMatch(oneToken(before));
  if (at === texts.length - 1) expect(res.body.answer_deidentified).toMatch(oneToken(before));
  const masked = outsideAnswers();
  callAI.mockClear();
  await send(play(NEUTRAL[language]), k);
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

// What the AI is sent around a typed answer differs by case and step: the vignette, the step's question, and whether
// that question masks on its own and is read apart from the answer (#406). Every step of every case file, live and
// staged, is played once per language, down a tier path that differs from pair to pair, the label rows taken in turn.
const STEPS = CASES.flatMap(({ file, kase: k }) => Array.from({ length: stepCount(k) }, (_, i) => [file, i + 1, k]));

describe.each(LANGUAGES)('%s look: a labelled value typed at any step of any case is one token from the label on', (lang) => {
  const rows = labelRows(lang);
  const others = OTHER_ANSWERS[lang];
  const plays = STEPS.map(([file, step, k], i) => {
    const through = step < stepCount(k) ? step : step - 1;
    const tierPath = tierPaths(through)[i % 3 ** through];
    return [file, step, ...rows[i % rows.length], k, tierPath];
  });

  test.each(plays)('%s step %i: %s', async (_file, step, _kind, label, value, k, tierPath) => {
    const texts = Array.from({ length: step }, (_, j) => others[j % others.length]);
    await expectMasked(lang, tierPath.slice(0, step - 1), texts, step - 1, `${label} ${value}`, '', k);
    if (step < stepCount(k)) {
      callAI.mockClear();
      await expectMasked(lang, tierPath, [...texts, others[step % others.length]], step - 1, `${label} ${value}`, '', k);
      expect(userTurns()).toHaveLength(step + 1);
    }
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
// them and keeps them apart. #414 fixes that structure; its check iterates this same table (labelRows) once it
// lands, and these todos go with it. The English rows moved to #453 by owner ruling at the #370 gate.
describe('#414: a question ending in the label masks the value typed under it', () => {
  for (const [kind, label, value] of labelRows('th')) test.todo(`#414 th: ${kind}, "${label}" ends the question, "${value}" typed under it`);
});
