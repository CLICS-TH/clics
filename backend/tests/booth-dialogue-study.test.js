const fs = require('fs');
const path = require('path');
const { stepRecords, studyTranscript, evaluateRequest, fenced } = require('../src/services/booth-dialogue');

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
  expect(studyTranscript(KASE, stepRecords(walked))).toEqual(evaluateRequest(KASE, walked).transcript);
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
  expect(studyTranscript(KASE, stepRecords(walked))).toEqual(unfenced);
});

const STEPS = stepRecords(typedWalk());
const at = (i, change) => STEPS.map((s, j) => (j === i ? change(s) : s));

test.each([
  ['two steps', STEPS.slice(0, 2)],
  ['four steps', [...STEPS, STEPS[0]]],
  ['null', null],
  ['an object', { 0: STEPS[0] }],
  ['a typed answer with no de-identified copy', stepRecords(typedWalk(null))],
  ['a step with both a choice and typed text', at(0, (s) => ({ ...s, typed: 'x' }))],
  ['a step with neither a choice nor typed text', at(0, ({ choice, ...s }) => s)],
  ['a step with a key the writer never writes', at(0, (s) => ({ ...s, tier_path: 'RBW' }))],
  ['a tier that is not a tier', at(2, (s) => ({ ...s, tier: 'great' }))],
  ['a variant its bank does not have', at(1, (s) => ({ ...s, variant: 'v9' }))],
  ['an option id its bank does not have', at(2, (s) => ({ ...s, options: [s.options[0], s.options[1], 'zz'] }))],
  ['a choice that was not offered', at(2, (s) => ({ ...s, choice: 'b', tier: 'best' }))],
  ['a choice whose tier is not the step\'s tier', at(2, (s) => ({ ...s, tier: 'best' }))],
])('%s rebuilds to null', (_name, steps) => {
  expect(studyTranscript(KASE, steps)).toBeNull();
});
