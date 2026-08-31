// PIS-7 rubric anchors for the auditor scoring instrument (#11 — protect ICC at the source).
//
// THREE SOURCES, one authority. This file, `rimpl/src/lib/prompts.js` (PIS7_EVALUATOR_PROMPT), and
// the CREC082 attachment `PIS7_Rubric_Behavioral_Anchors_V2.0` all describe the same rubric — and
// the CREC document is the one the ethics committee approved, so where they differ IT WINS and the
// other two move. Human raters and the AI must converge on the same definition of each level, or
// the ICC between them measures the gap between two rubrics rather than the gap between two raters.
//
// What moved in the 2026-08 reconciliation: the 0-5 scale was bare intensity labels ("Low",
// "Moderate", "High"), which give a rater almost nothing to converge on. CREC defines each level
// BEHAVIOURALLY, and those definitions are now the anchors. Per-domain 0→3→5 anchors were added for
// the same reason — they are in the approved document and were missing here.

// `th`/`en` are the CREC behavioural definitions — the thing a rater calibrates against. `short` is
// for the chip row and the axis ends, where a full sentence does not fit and would be truncated
// mid-word. Both exist because dropping the definition to fit the UI is how a behavioural anchor
// quietly degrades back into an intensity label.
export type ScaleAnchor = { level: number; th: string; en: string; shortTh: string; shortEn: string };

// SCALE — verbatim from CREC082 PIS7_Rubric_Behavioral_Anchors_V2.0 ("นิยามทั่วไป").
// Behavioural, not intensity labels: "มีองค์ประกอบบางส่วนแต่ยังตื้น/ไม่เป็นระบบ" tells a rater what
// a 2 looks like; "Low" tells them nothing and leaves the level to personal calibration.
export const PIS7_SCALE: ScaleAnchor[] = [
  { level: 0, th: "ไม่พบหลักฐานหรือประเมินไม่ได้จาก transcript", en: "No evidence, or not assessable from the transcript", shortTh: "ไม่พบ", shortEn: "None" },
  { level: 1, th: "หลักฐานน้อยมาก / กระจัดกระจาย / คลาดเคลื่อนสำคัญ", en: "Very little evidence — scattered, or with significant errors", shortTh: "น้อยมาก", shortEn: "Minimal" },
  { level: 2, th: "มีองค์ประกอบบางส่วนแต่ยังตื้น / ไม่เป็นระบบ", en: "Some elements present, but shallow and unsystematic", shortTh: "ตื้น", shortEn: "Shallow" },
  { level: 3, th: "ระดับปานกลาง มีโครงสร้างพอสมควร", en: "Moderate — reasonably structured", shortTh: "ปานกลาง", shortEn: "Moderate" },
  { level: 4, th: "ชัดเจน เป็นระบบ เชื่อมโยงเหตุผล/ข้อจำกัดได้ดี", en: "Clear and systematic; links reasoning and limitations well", shortTh: "ชัดเจน", shortEn: "Clear" },
  { level: 5, th: "ลึก ต่อเนื่อง วิจารณ์และสังเคราะห์ได้เด่นชัด", en: "Deep and sustained; notably critical and synthesising", shortTh: "ลึก", shortEn: "Deep" },
];

// The scoring principle, verbatim from the same document. It belongs next to the scale because it
// governs every score: rate the EVIDENCE IN FRONT OF YOU, not the physician.
export const PIS7_PRINCIPLE = {
  th: "ให้คะแนนเฉพาะหลักฐานใน transcript/reflection ของ PLE นี้ ไม่ใช้ชื่อเสียงหรือความรู้ที่คาดเดาเกี่ยวกับแพทย์ และไม่ตีความคะแนนเป็นระดับ competence โดยรวม",
  en: "Score only the evidence in THIS PLE's transcript and reflection. Do not draw on the physician's reputation or assumed knowledge, and do not read the score as overall competence.",
};

// Also from the approved document: "Comment ควรบันทึกเมื่อคะแนน extreme, borderline หรือ anchor
// ไม่ชัด". A comment is expected at 0, 1, 4 and 5, on a borderline call, or when the anchor did not
// fit — the last of which is the signal that the ANCHOR needs rewriting, not the rater.
export const COMMENT_EXPECTED_LEVELS = [0, 1, 4, 5];

// Domain weights are NOT stored here — they live once in lib/labels.ts WEIGHTS (mirrored from
// backend/src/services/ple-gate.js). The scorer derives the displayed % from WEIGHTS[key].
export type RubricDomain = {
  key: string;
  th: string;
  en: string;
  criterion: string; // what high quality looks like
  floor: string; // what caps the score low
  // The 0→3→5 anchor triplet, verbatim from the CREC-approved document. `criterion`/`floor` are the
  // operational gloss the AI evaluator also uses; these are the approved wording a rater is
  // calibrated against, so both are shown.
  anchors: { th: [string, string, string]; en: [string, string, string] };
};

export const PIS7_RUBRIC: RubricDomain[] = [
  {
    key: "d1", th: "ปัญญาในการตั้งคำถามคลินิก", en: "Clinical Question Intelligence",
    criterion: "Questions are case-specific and expose real decision points.",
    floor: "Generic “what's the differential?” questions score ≤2.",
    anchors: {
      th: ["0 ไม่มีคำถามที่ประเมินได้", "3 คำถามชัด/เกี่ยวข้อง", "5 ลึก เฉพาะเจาะจง นำไปสู่การเรียนรู้"],
      en: ["0 no assessable question", "3 clear, relevant question", "5 deep and specific; leads somewhere"],
    },
  },
  {
    key: "d2", th: "ความลึกของการให้เหตุผล", en: "Reasoning Depth",
    criterion: "Commits to ranked hypotheses with justification, weighs risk–benefit, updates when contradicted.",
    floor: "A list of diagnoses without ranking/justification is ≤2.",
    anchors: {
      th: ["0 ไม่พบ reasoning", "3 reasoning พอสมควร", "5 reasoning ลึก เชื่อมกลไก/หลักฐาน/ข้อจำกัด"],
      en: ["0 no reasoning", "3 reasonable reasoning", "5 deep; links mechanism, evidence and limits"],
    },
  },
  {
    key: "d3", th: "การบูรณาการบริบท", en: "Contextual Integration",
    criterion: "This patient's age / comorbidities / setting visibly change the reasoning.",
    floor: "Mentioning context without it altering any decision is ≤2.",
    anchors: {
      th: ["0 ไม่ใช้บริบท", "3 บูรณาการบางส่วน", "5 รอบด้านและตระหนักข้อจำกัด"],
      en: ["0 no use of context", "3 partial integration", "5 thorough, and aware of the limits"],
    },
  },
  {
    key: "d4", th: "การสืบค้นแบบต่อยอด", en: "Iterative Inquiry",
    criterion: "Each turn builds on the AI's previous answer — probes, narrows, tests.",
    floor: "Restarting or topic-hopping is ≤2.",
    anchors: {
      th: ["0 ไม่มี follow-up", "3 follow-up ที่เกี่ยวข้อง", "5 ปรับคำถามอย่างมีกลยุทธ์"],
      en: ["0 no follow-up", "3 relevant follow-up", "5 strategically adapts the questions"],
    },
  },
  {
    key: "d5", th: "การประเมินอย่างมีวิจารณญาณ", en: "Critical Appraisal",
    criterion: "Questions AI output, requests evidence, notes uncertainty or disagreement.",
    floor: "Accepting everything unexamined is ≤1.",
    anchors: {
      th: ["0 ไม่วิพากษ์ AI", "3 ประเมินข้อจำกัดพอสมควร", "5 แยกข้อเท็จจริง/ความไม่แน่นอน/ข้อจำกัดได้ดี"],
      en: ["0 no critique of the AI", "3 reasonable appraisal of limits", "5 separates fact, uncertainty and limitation well"],
    },
  },
  {
    key: "d6", th: "การสังเคราะห์เชิงสะท้อนคิด", en: "Reflective Synthesis",
    criterion: "An explicit, case-grounded takeaway in the physician's own words.",
    floor: "A generic “very useful, I learned a lot” is ≤1.",
    anchors: {
      th: ["0 ไม่มี reflection", "3 สรุป/สะท้อนพอสมควร", "5 สังเคราะห์ลึกและระบุ next learning/action"],
      en: ["0 no reflection", "3 reasonable summary/reflection", "5 deep synthesis; names the next learning or action"],
    },
  },
  {
    key: "d7", th: "ความรู้เท่าทัน AI และทักษะการพรอมต์", en: "AI Literacy & Prompt Skill",
    criterion: "Precise prompts, verification of outputs, clinical ownership of the final plan.",
    floor: "Vague prompts and uncritical copy-through score low.",
    anchors: {
      th: ["0 ใช้ AI ไม่เหมาะสม", "3 ใช้ prompt/กำกับคำตอบพอสมควร", "5 ใช้อย่างมีวิจารณญาณและรู้ข้อจำกัด"],
      en: ["0 inappropriate use of AI", "3 reasonable prompting and steering", "5 critical use, aware of the limits"],
    },
  },
];

// Shared evidence threshold (applies to every domain).
export const PIS7_EVIDENCE_NOTE =
  "A 4–5 in any domain requires a specific, case-grounded physician utterance you could quote. If you can't quote one, the score is at most 3.";

// The per-assessment confirmations the approved form ends with — distinct from the one-time
// confidentiality/COI consent recorded once per account, because these are claims about THIS
// assessment.
//
// MIRRORS backend/src/lib/schemas.js SCORE_ATTESTATIONS. The keys must match exactly: the route
// re-checks the full set and rejects the submission if any is missing, so a key that drifts here
// produces a form the rater can complete and the server will refuse.
export const ATTESTATIONS = [
  { key: 'all_domains_scored',  th: 'ให้คะแนน D1–D7 ครบ', en: 'Scored all seven domains' },
  { key: 'comments_recorded',   th: 'บันทึกความเห็นที่จำเป็นแล้ว', en: 'Recorded the comments the form expects' },
  { key: 'scored_independently', th: 'ให้คะแนนโดยอิสระ และไม่ได้เห็นคะแนน AI', en: 'Scored independently, without seeing the AI score' },
  { key: 'no_identifiers_found', th: 'ไม่พบข้อมูลระบุตัวบุคคล หรือแจ้งแล้ว', en: 'Found no identifying information, or reported it' },
  { key: 'weights_provisional', th: 'เข้าใจว่าน้ำหนักแต่ละหมวดยังเป็นค่าชั่วคราว', en: 'Understand the domain weights are provisional' },
] as const;
