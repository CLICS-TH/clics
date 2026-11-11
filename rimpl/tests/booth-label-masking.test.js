// A booth visitor may type a patient identifier behind its label ("HN 1234567", "Patient name Dalton Prewitt"), in the
// language of the look they play in (#377): an English look sends the English vignette and questions. Every row of
// tests/helpers/booth-labels.js, in both languages, goes through POST /chat in booth_mode the way the backend builds
// it, and no word or digit run of the value may reach the AI or the kept answer_deidentified.
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
const { chatRequest, fenced, bankAt } = require('../../backend/src/services/booth-dialogue');
const { stripPii } = require('../src/services/pii-filter');
const { BOOTH_LABELS, LANGUAGES, labelRows } = require('./helpers/booth-labels');

const CASES_DIR = path.join(__dirname, '../../backend/src/booth-cases/NFCME-2026');
const CASES = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => [f, JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8'))]);
const kase = CASES.find(([f]) => f === 'adhf.json')[1];
const LOOK = { th: 'th', en: 'en' };
const OTHER_ANSWERS = { th: ['ให้ยาขับปัสสาวะ', 'ให้ออกซิเจน'], en: ['Give a diuretic', 'Give oxygen'] };

const TOKEN = /\[[A-Z]+-\d+\]/g;
const parts = (value) => value.split(/[\s/-]+/).filter(Boolean);
// The parts long enough that finding one anywhere in the request means the value leaked.
const wireParts = (value) => parts(value).filter((p) => p.length >= 3);
const expectAbsent = (text, value) => {
  expect(text).toMatch(TOKEN);
  const rest = text.replace(TOKEN, '');
  for (const part of parts(value)) expect(rest).not.toContain(part);
};

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
    look: LOOK[language],
  };
}

// The request the backend sends (fenced, #400), or the same turns unfenced, as a backend before #400 sent them.
const SHAPES = {
  fenced: (d) => chatRequest(kase, d),
  unfenced: (d) => {
    const req = chatRequest(kase, d);
    return { ...req, history: req.history.map((m) => ({ ...m, content: unfence(m.content) })), message: unfence(req.message) };
  },
};
const [FENCE_HEAD, FENCE_TAIL] = fenced('@@').split('@@');
const unfence = (content) => (content.endsWith(FENCE_TAIL) ? content.replace(FENCE_HEAD, '').slice(0, -FENCE_TAIL.length) : content);
const sentTurns = () => callAI.mock.calls[0][0].messages.filter((m) => m.role === 'user').map((m) => m.content.split('\n\nSORT: ')[0]);
const wire = () => JSON.stringify(callAI.mock.calls);

test('every value part is absent from the case text, so finding it in a request means it leaked', () => {
  const caseText = JSON.stringify(CASES.map(([, k]) => k));
  for (const row of BOOTH_LABELS) for (const lang of LANGUAGES) for (const part of wireParts(row.value[lang])) expect(caseText).not.toContain(part);
});

describe.each(LANGUAGES.flatMap((lang) => Object.keys(SHAPES).map((shape) => [lang, shape])))(
  '%s look, %s turn: a value typed behind its label in the answer',
  (lang, shape) => {
    const send = (d) => request(app).post('/chat').send({ ple_id: 'x', ...SHAPES[shape](d) });

    test.each(labelRows(lang))('%s (%s) at step 1, after the vignette', async (_kind, label, value) => {
      const res = await send(typedPlay(lang, '', [`${label} ${value}`]));
      expect(sentTurns()[0]).toContain(`\n\n${bankAt(kase, '').variants[0].question[lang]}\n`);
      for (const part of wireParts(value)) expect(wire()).not.toContain(part);
      expectAbsent(res.body.answer_deidentified, value);
    });

    test.each(labelRows(lang))('%s (%s) at step 2, then in the next turn\'s history', async (_kind, label, value) => {
      const [first, third] = OTHER_ANSWERS[lang];
      const second = await send(typedPlay(lang, 'W', [first, `${label} ${value}`]));
      for (const part of wireParts(value)) expect(wire()).not.toContain(part);
      expectAbsent(second.body.answer_deidentified, value);
      callAI.mockClear();
      await send(typedPlay(lang, 'WB', [first, `${label} ${value}`, third]));
      for (const part of wireParts(value)) expect(wire()).not.toContain(part);
      expect(sentTurns()).toHaveLength(3);
    });
  },
);

// #412: a bank question that ENDS in the label, with the value typed under it. On master the fence note sits between
// them and keeps them apart. #414 fixes that structure; its check iterates this same table (labelRows, both
// languages) once it lands, and these todos go with it.
describe('#414: a question ending in the label masks the value typed under it', () => {
  for (const lang of LANGUAGES) {
    for (const [kind, label, value] of labelRows(lang)) test.todo(`#414 ${lang}: ${kind}, "${label}" ends the question, "${value}" typed under it`);
  }
});

// Vetted English case text holds no PII, and routes/chat.js reads a question that masks on its own apart from its
// answer (#406), so an English label rule that fires in case text would both corrupt the case and move that split.
test('no vetted English case text masks as anything but an age', () => {
  const texts = CASES.flatMap(([, k]) => {
    const banks = [k.banks.step1, ...Object.values(k.banks.step2), ...Object.values(k.banks.step3)];
    return [k.vignette.en, ...banks.flatMap((b) => [...b.variants.map((v) => v.question.en),
      ...b.options.flatMap((o) => [o.label.en, o.line.en])])];
  });
  expect(texts.length).toBeGreaterThan(1000);
  for (const t of texts) expect(stripPii(t).replace(/\[AGE-\d+\]/g, '')).not.toMatch(TOKEN);
});

// The filter runs on every English PLE turn too: a place label in clinical prose keeps the words after it.
test.each([
  'In this province leptospirosis is common.',
  'Cases rise in the district during floods.',
  'The village water supply may be contaminated.',
  'Name the next test.',
  'Address hypoxia first.',
])('clinical prose "%s" passes the filter unchanged', (t) => {
  expect(stripPii(t)).toBe(t);
});

// A turn may be 24000 chars (lib/turn-limits.js). A label separator written as two adjacent \s* runs (HN's before this
// change) took ~0.4 s on a label followed by that much whitespace; a linear one takes ~1 ms.
test.each(['Patient name', 'Name is', 'Province:', 'Address', 'Mr', 'HN', 'Hospital number', 'MRN', 'ID number'])(
  'the English label "%s" before 24000 spaces is masked in linear time',
  (label) => {
    const started = Date.now();
    stripPii(`${label}${' '.repeat(24000)}!`);
    expect(Date.now() - started).toBeLessThan(100);
  },
);
