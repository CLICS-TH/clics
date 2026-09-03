// Shared bilingual labels + small DOM helper for the physician UI.
// Loaded before each page's own script so these globals are available.
window.STATUS_LABELS = {
  active: 'กำลังดำเนินการ / Active',
  ended: 'สิ้นสุดแล้ว / Ended',
  ple_pass: 'ผ่าน PLE / Passed',
  ple_fail_t1: 'ไม่ผ่าน PLE / Failed',
  ple_flag_t2: 'รอตรวจสอบ / Under Review',
  evaluated: 'ประเมินแล้ว / Evaluated',
};

window.DOMAIN_LABELS = [
  'Clinical Question Intelligence', 'Reasoning Depth', 'Contextual Integration',
  'Iterative Inquiry', 'Critical Appraisal', 'Reflective Synthesis', 'AI Literacy & Prompt Skill',
];

// The four qualities that decide whether a session counts as a Professional Learning Episode.
// CREC082 PLE Instruction Sheet §1 — a meaningful problem, developing reasoning, integration of
// context/evidence, and reflective synthesis. These, and only these, produce the outcome.
window.QUALIFYING_LABELS = {
  c4: 'คำถามเชิงคลินิกที่มีความหมาย / Meaningful clinical question',
  c5: 'การพัฒนาเหตุผลต่อเนื่อง / Developing reasoning',
  c7: 'เชื่อมโยงบริบทและหลักฐาน / Context & evidence integration',
  c6: 'สรุปการเรียนรู้ / Reflective synthesis',
};

// Engagement measures. RECORDED, never a verdict — they used to terminate a session before it was
// ever assessed, which rejected concise but genuinely reflective episodes while passing rambling
// factual lookups. Shown neutrally so a physician is not told they "failed" something that did not
// decide anything.
window.ENGAGEMENT_LABELS = {
  c1: 'ระยะเวลา ≥ 10 นาที / Duration ≥ 10 min',
  c2: 'จำนวนรอบ ≥ 4 / Turns ≥ 4',
  c3: 'ความยาวบทสนทนา ≥ 10,000 tokens / Transcript length ≥ 10,000 tokens',
};

// Retained for anything still reading the flat map.
window.CRITERIA_LABELS = { ...window.ENGAGEMENT_LABELS, ...window.QUALIFYING_LABELS };

// Read a CSS custom property value off :root (used by the Chart.js pages).
window.cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
