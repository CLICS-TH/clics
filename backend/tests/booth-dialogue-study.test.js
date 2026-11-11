const fs = require('fs');
const path = require('path');
const { stepRecords, studyTranscript, evaluateRequest, fenced, bankKey } = require('../src/services/booth-dialogue');
const { StudyCaseSchema } = require('../src/booth-cases/study-snapshot');

const KASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree.json'), 'utf8'));
const TIER = { B: 'best', R: 'reasonable', W: 'weaker' };
const bankFor = (tierPath) => [KASE.banks.step1, KASE.banks.step2[tierPath], KASE.banks.step3[tierPath]][tierPath.length];
const optionOf = (bank, tier) => bank.options.find((o) => o.tier === tier).id;

function walk(tierPath) {
  const steps = [...tierPath].map((letter, i) => {
    const bank = bankFor(tierPath.slice(0, i));
    return {
      ask: { variant: bank.variants.at(-1).id, bridge: i === 0 ? '' : `ต่อด้วยข้อ${i + 1}`, options: ['weaker', 'best', 'reasonable'].map((t) => optionOf(bank, t)) },
      answer: { choice: optionOf(bank, TIER[letter]) },
    };
  });
  return {
    asks: steps.map((s) => s.ask),
    answers: steps.map((s) => s.answer),
    replies: steps.map((_, i) => ({ strength: `**จุดเด่น**ข้อ${i + 1}`, weigh: i === 1 ? '' : 'ควรชั่งน้ำหนัก', safety: 'ระวัง' })),
    tierPath,
  };
}

const PATHS = ['B', 'R', 'W'].flatMap((a) => ['B', 'R', 'W'].flatMap((b) => ['B', 'R', 'W'].map((c) => a + b + c)));

test.each(PATHS)('a tapped play along %s rebuilds to the transcript the evaluator reads for it', (tierPath) => {
  const walked = walk(tierPath);
  expect(studyTranscript(KASE, stepRecords(walked), null)).toEqual({ messages: evaluateRequest(KASE, walked).transcript });
});

const DEIDENTIFIED = 'ให้ออกซิเจน [NAME-1]';
function typedWalk(deidentified = DEIDENTIFIED) {
  const walked = walk('RBW');
  walked.answers[1] = { text: 'ให้ออกซิเจน นายสมชาย', tier: 'B', deidentified };
  return walked;
}

test('a typed answer reads as its de-identified copy, without the fence the evaluator gets', () => {
  const walked = typedWalk();
  const asEvaluated = evaluateRequest(KASE, { ...walked, answers: walked.answers.map((a) => ('text' in a ? { text: a.deidentified } : a)) }).transcript;
  const unfenced = asEvaluated.map((t) => ({ ...t, content: t.content.replace(fenced(DEIDENTIFIED), DEIDENTIFIED) }));
  expect(unfenced).not.toEqual(asEvaluated);
  expect(studyTranscript(KASE, stepRecords(walked), null)).toEqual({ messages: unfenced });
});

const STEPS = stepRecords(typedWalk());
const at = (i, change) => STEPS.map((s, j) => (j === i ? change(s) : s));

test('a step record carrying a key a later writer added still rebuilds, as if the key were not there', () => {
  const added = at(0, (s) => ({ ...s, cache_hit: true, language_look: 'en' }));
  expect(studyTranscript(KASE, added, null)).toEqual(studyTranscript(KASE, STEPS, null));
  expect(studyTranscript(KASE, STEPS, null).messages).toHaveLength(6);
});

test('a typed answer with no de-identified copy does not rebuild, and says so', () => {
  expect(studyTranscript(KASE, stepRecords(typedWalk(null)), null)).toEqual({ why: 'no_deidentified_copy' });
});

test.each([
  ['two steps', STEPS.slice(0, 2)],
  ['four steps', [...STEPS, STEPS[0]]],
  ['null', null],
  ['an object', { 0: STEPS[0] }],
  ['a step with both a choice and typed text', at(0, (s) => ({ ...s, typed: 'x' }))],
  ['a step with neither a choice nor typed text', at(0, ({ choice, ...s }) => s)],
  ['a tier that is not a tier', at(2, (s) => ({ ...s, tier: 'great' }))],
  ['a variant its bank does not have', at(1, (s) => ({ ...s, variant: 'v9' }))],
  ['an option id its bank does not have', at(2, (s) => ({ ...s, options: [s.options[0], s.options[1], 'zz'] }))],
  ['a choice that was not offered', at(2, (s) => ({ ...s, choice: 'b', tier: 'best' }))],
  ['a choice whose tier is not the step\'s tier', at(2, (s) => ({ ...s, tier: 'best' }))],
])('%s is malformed', (_name, steps) => {
  expect(studyTranscript(KASE, steps, null)).toEqual({ why: 'malformed' });
});

// Spec #370's five-step layout: one step-1 bank, then three banks per step keyed on the previous step's tier.
const fiveBank = (tag) => ({
  variants: [{ id: 'v1', question: { th: `คำถาม ${tag}`, en: `Question ${tag}` } }, { id: 'v2', question: { th: `อีกคำถาม ${tag}`, en: `Other ${tag}` } }],
  options: [['a', 'best'], ['b', 'reasonable'], ['c', 'weaker']].map(([id, tier]) => ({
    id, tier, label: { th: `ตัวเลือก${tag}${id}`, en: `Option ${tag}${id}` }, line: { th: `เหตุผล${tag}${id}`, en: `Why ${tag}${id}` },
  })),
});
const byPrevious = (n) => Object.fromEntries(['B', 'R', 'W'].map((l) => [l, fiveBank(`${n}${l}`)]));
const FIVE = StudyCaseSchema.parse({
  case_id: 'five-step', event_code: 'NFCME-2026', version: '9', teaser: { th: 'ชายวัย 40 ปี', en: 'A man of 40' },
  vignette: { th: 'ผู้ป่วยชายไข้สูง', en: 'A man with a high fever' },
  banks: { step1: fiveBank('1'), step2: byPrevious(2), step3: byPrevious(3), step4: byPrevious(4), step5: byPrevious(5) },
});

test('a five-step play rebuilds against a five-step snapshot, each step from the bank of the previous step\'s tier', () => {
  const tierPath = 'RBWBR';
  const choice = { B: 'a', R: 'b', W: 'c' };
  const walked = {
    asks: [...tierPath].map((_, i) => ({ variant: 'v1', bridge: i === 0 ? '' : `ต่อ${i + 1}`, options: ['c', 'a', 'b'] })),
    answers: [...tierPath].map((l) => ({ choice: choice[l] })),
    replies: [...tierPath].map((_, i) => ({ strength: `ดี${i + 1}`, weigh: '', safety: '' })),
    tierPath,
  };
  expect(studyTranscript(FIVE, stepRecords(walked), null)).toEqual({
    messages: [
      { role: 'physician', content: 'ผู้ป่วยชายไข้สูง\n\nคำถาม 1\nตัวเลือก1b: เหตุผล1b' },
      { role: 'assistant', content: 'ดี1 ต่อ2' },
      { role: 'physician', content: 'คำถาม 2R\nตัวเลือก2Ra: เหตุผล2Ra' },
      { role: 'assistant', content: 'ดี2 ต่อ3' },
      { role: 'physician', content: 'คำถาม 3B\nตัวเลือก3Bc: เหตุผล3Bc' },
      { role: 'assistant', content: 'ดี3 ต่อ4' },
      { role: 'physician', content: 'คำถาม 4W\nตัวเลือก4Wa: เหตุผล4Wa' },
      { role: 'assistant', content: 'ดี4 ต่อ5' },
      { role: 'physician', content: 'คำถาม 5B\nตัวเลือก5Bb: เหตุผล5Bb' },
      { role: 'assistant', content: 'ดี5' },
    ],
  });
  expect([bankKey(FIVE, 'RB'), bankKey(KASE, 'RB')]).toEqual(['step3.B', 'step3.RB']);
  expect(studyTranscript(FIVE, STEPS, null)).toEqual({ why: 'malformed' });
});

test('a play is rebuilt in the primary language of the look it was scored in, from its snapshot (#377)', () => {
  const tierPath = 'BRWBR';
  const choice = { B: 'a', R: 'b', W: 'c' };
  const records = stepRecords({
    asks: [...tierPath].map((_, i) => ({ variant: 'v2', bridge: i === 0 ? '' : `Next ${i + 1}`, options: ['a', 'b', 'c'] })),
    answers: [...tierPath].map((l) => ({ choice: choice[l] })),
    replies: [...tierPath].map((_, i) => ({ strength: `Good ${i + 1}`, weigh: '', safety: '' })),
    tierPath,
  });
  const english = {
    messages: [
      { role: 'physician', content: 'A man with a high fever\n\nOther 1\nOption 1a: Why 1a' },
      { role: 'assistant', content: 'Good 1 Next 2' },
      { role: 'physician', content: 'Other 2B\nOption 2Bb: Why 2Bb' },
      { role: 'assistant', content: 'Good 2 Next 3' },
      { role: 'physician', content: 'Other 3R\nOption 3Rc: Why 3Rc' },
      { role: 'assistant', content: 'Good 3 Next 4' },
      { role: 'physician', content: 'Other 4W\nOption 4Wa: Why 4Wa' },
      { role: 'assistant', content: 'Good 4 Next 5' },
      { role: 'physician', content: 'Other 5B\nOption 5Bb: Why 5Bb' },
      { role: 'assistant', content: 'Good 5' },
    ],
  };
  expect(studyTranscript(FIVE, records, 'en')).toEqual(english);
  expect(studyTranscript(FIVE, records, 'en+th')).toEqual(english);
  const thai = studyTranscript(FIVE, records, 'th');
  expect(thai.messages[0].content).toBe('ผู้ป่วยชายไข้สูง\n\nอีกคำถาม 1\nตัวเลือก1a: เหตุผล1a');
  expect(thai.messages[8].content).toBe('อีกคำถาม 5B\nตัวเลือก5Bb: เหตุผล5Bb');
  // A play scored before #377 has no look; the kiosk showed it as th+en.
  expect([studyTranscript(FIVE, records, 'th+en'), studyTranscript(FIVE, records, null)]).toEqual([thai, thai]);
});

// A missing look (a caller that forgot the column) is refused like an unknown one, never read as Thai.
test.each([['an unknown look', 'fr'], ['a look in the wrong case', 'EN'], ['no look argument at all', undefined]])(
  '%s is malformed', (_name, look) => {
    expect(studyTranscript(KASE, STEPS, look)).toEqual({ why: 'malformed' });
  },
);
