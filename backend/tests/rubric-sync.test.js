// The PIS-7 rubric exists in three places, and only one of them is authoritative.
//
//   CREC082 PIS7_Rubric_Behavioral_Anchors_V2.0   <- approved by the ethics committee. WINS.
//   rimpl/src/lib/prompts.js  (PIS7_EVALUATOR_PROMPT)
//   audit-dashboard/lib/pis7-rubric.ts            (what human raters calibrate against)
//
// If the AI and the humans score against different rubrics, the ICC between them measures the gap
// between two rubrics rather than between two raters — and the gate is ICC >= 0.75, so that
// mismatch would be read as a reliability finding. This suite pins the reconciliation so the next
// edit to either file has to move both.
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const PROMPT = read('../../rimpl/src/lib/prompts.js');
const RUBRIC = read('../../audit-dashboard/lib/pis7-rubric.ts');
const { WEIGHTS } = require('../src/services/cle-gate');

describe('weights match the approved document', () => {
  test('D1 15 · D2 20 · D3 15 · D4 15 · D5 15 · D6 10 · D7 10', () => {
    // Verbatim from the CREC table. The document also says these are provisional starting values
    // and must NOT be retuned after seeing results to raise ICC — so a change here is a protocol
    // amendment, not a code change.
    expect(WEIGHTS).toEqual({ d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10 });
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

describe('the 0-5 scale is behavioural, not intensity labels', () => {
  test.each([
    [0, 'not assessable'],
    [1, 'scattered'],
    [2, 'shallow and unsystematic'],
    [3, 'reasonably structured'],
    [4, 'links reasoning and limitations'],
    [5, 'critical and synthesising'],
  ])('level %i carries its CREC definition in BOTH sources', (level, fragment) => {
    // "Low"/"Moderate"/"High" gave a rater nothing to converge on. The approved document defines
    // each level by what it looks like, and both raters must see the same words.
    expect(RUBRIC.toLowerCase()).toContain(fragment.toLowerCase());
    expect(PROMPT.toLowerCase()).toContain(fragment.toLowerCase());
  });
});

describe('per-domain 0→3→5 anchors are present in both sources', () => {
  test.each([
    ['d1', 'no assessable question'],
    ['d2', 'links mechanism, evidence and limits'],
    ['d3', 'aware of the limits'],
    ['d4', 'strategically adapts the questions'],
    ['d5', 'separates fact, uncertainty and limitation'],
    ['d6', 'names the next learning or action'],
    ['d7', 'critical use, aware of the limits'],
  ])('%s', (_key, anchor) => {
    expect(RUBRIC).toContain(anchor);
    expect(PROMPT).toContain(anchor);
  });
});

describe('the scoring principle survives in both', () => {
  test('score the episode, not the physician', () => {
    for (const src of [RUBRIC, PROMPT]) {
      expect(src.toLowerCase()).toMatch(/transcript and reflection|transcript\/reflection/);
      expect(src.toLowerCase()).toMatch(/overall competence/);
    }
  });

  test('the evaluator is told a [REFLECTION] turn is scorable evidence', () => {
    // Added with the reflection form: the rubric scores "transcript และ reflection", and d6's zero
    // anchor is literally "no reflection". Without this the model reads it as another chat turn.
    expect(PROMPT).toMatch(/\[REFLECTION\]/);
    expect(PROMPT).toMatch(/d6 in\s*\n?\/\/ particular|d6\s+in\s+particular/);
  });
});

describe('drift protection', () => {
  test('both files name the CREC document as the authority', () => {
    for (const src of [RUBRIC, PROMPT]) expect(src).toMatch(/PIS7_Rubric_Behavioral_Anchors_V2\.0/);
  });

  test('the prompt version is derived from the prompt text, so a rubric edit is visible in provenance', () => {
    // versions.js hashes PIS7_EVALUATOR_PROMPT into PROMPT_VERSION, which lands in every score's
    // provenance block. Scores either side of a rubric change therefore carry different
    // fingerprints — the §10.2 lock stays checkable without anyone remembering to bump a constant.
    const versions = read('../../rimpl/src/lib/versions.js');
    expect(versions).toMatch(/PROMPT_VERSION\s*=\s*`pis7-prompt-\$\{sha8\(PIS7_EVALUATOR_PROMPT\)\}`/);
  });
});
