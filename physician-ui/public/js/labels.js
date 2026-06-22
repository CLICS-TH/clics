// Shared bilingual labels + small DOM helper for the physician UI.
// Loaded before each page's own script so these globals are available.
window.STATUS_LABELS = {
  active: 'กำลังดำเนินการ / Active',
  ended: 'สิ้นสุดแล้ว / Ended',
  cle_pass: 'ผ่าน CLE / Passed',
  cle_fail_t1: 'ไม่ผ่าน CLE / Failed',
  cle_flag_t2: 'รอตรวจสอบ / Under Review',
  evaluated: 'ประเมินแล้ว / Evaluated',
};

window.DOMAIN_LABELS = [
  'Clinical Question Intelligence', 'Reasoning Depth', 'Contextual Integration',
  'Iterative Inquiry', 'Critical Appraisal', 'Reflective Synthesis', 'AI Literacy & Prompt Skill',
];

window.CRITERIA_LABELS = {
  c1: 'ระยะเวลา ≥ 10 นาที / Duration ≥ 10 min',
  c2: 'จำนวนรอบ ≥ 4 / Turns ≥ 4',
  c3: 'Tokens ≥ 10,000',
  c4: 'คำถามเชิงคลินิก / Clinical Question',
  c5: 'Follow-up เชิงลึก ≥ 2 / Deep Follow-ups ≥ 2',
  c6: 'สรุปการเรียนรู้ / Learning Summary',
};

// Read a CSS custom property value off :root (used by the Chart.js pages).
window.cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
