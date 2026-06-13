// PIS-7 rubric anchors for the auditor scoring instrument (#11 — protect ICC at the source).
// MIRRORED from the AI evaluator's rubric in `rimpl/src/lib/prompts.js` (PIS7_EVALUATOR_PROMPT) so
// human raters converge on the SAME definition of each level the AI uses. KEEP IN SYNC with that file.

export type ScaleAnchor = { level: number; th: string; en: string };

// SCALE: 0=Not observed … 5=Very High (verbatim from prompts.js).
export const PIS7_SCALE: ScaleAnchor[] = [
  { level: 0, th: "ไม่พบ", en: "Not observed" },
  { level: 1, th: "น้อยมาก", en: "Very Low" },
  { level: 2, th: "น้อย", en: "Low" },
  { level: 3, th: "ปานกลาง", en: "Moderate" },
  { level: 4, th: "สูง", en: "High" },
  { level: 5, th: "สูงมาก", en: "Very High" },
];

// Domain weights are NOT stored here — they live once in lib/labels.ts WEIGHTS (mirrored from
// backend/src/services/cle-gate.js). The scorer derives the displayed % from WEIGHTS[key].
export type RubricDomain = {
  key: string;
  th: string;
  en: string;
  criterion: string; // what high quality looks like
  floor: string; // what caps the score low
};

export const PIS7_RUBRIC: RubricDomain[] = [
  {
    key: "d1", th: "ปัญญาในการตั้งคำถามคลินิก", en: "Clinical Question Intelligence",
    criterion: "Questions are case-specific and expose real decision points.",
    floor: "Generic “what's the differential?” questions score ≤2.",
  },
  {
    key: "d2", th: "ความลึกของการให้เหตุผล", en: "Reasoning Depth",
    criterion: "Commits to ranked hypotheses with justification, weighs risk–benefit, updates when contradicted.",
    floor: "A list of diagnoses without ranking/justification is ≤2.",
  },
  {
    key: "d3", th: "การบูรณาการบริบท", en: "Contextual Integration",
    criterion: "This patient's age / comorbidities / setting visibly change the reasoning.",
    floor: "Mentioning context without it altering any decision is ≤2.",
  },
  {
    key: "d4", th: "การสืบค้นแบบต่อยอด", en: "Iterative Inquiry",
    criterion: "Each turn builds on the AI's previous answer — probes, narrows, tests.",
    floor: "Restarting or topic-hopping is ≤2.",
  },
  {
    key: "d5", th: "การประเมินอย่างมีวิจารณญาณ", en: "Critical Appraisal",
    criterion: "Questions AI output, requests evidence, notes uncertainty or disagreement.",
    floor: "Accepting everything unexamined is ≤1.",
  },
  {
    key: "d6", th: "การสังเคราะห์เชิงสะท้อนคิด", en: "Reflective Synthesis",
    criterion: "An explicit, case-grounded takeaway in the physician's own words.",
    floor: "A generic “very useful, I learned a lot” is ≤1.",
  },
  {
    key: "d7", th: "ความรู้เท่าทัน AI และทักษะการพรอมต์", en: "AI Literacy & Prompt Skill",
    criterion: "Precise prompts, verification of outputs, clinical ownership of the final plan.",
    floor: "Vague prompts and uncritical copy-through score low.",
  },
];

// Shared evidence threshold (applies to every domain).
export const PIS7_EVIDENCE_NOTE =
  "A 4–5 in any domain requires a specific, case-grounded physician utterance you could quote. If you can't quote one, the score is at most 3.";
