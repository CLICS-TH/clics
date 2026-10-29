'use strict';

// Curated, CONSERVATIVE gazetteer of common Thai GIVEN names — the secondary backstop for a bare,
// unlabelled name when no structured patient_ref intake was entered (pii-filter.js intake-hint pass
// is the precise primary). Masked by the 'th-gazetteer' pass ONLY at a detectable boundary (or glued
// after ของ / กับ / ให้) AND when standalone or immediately followed by a clinical-lead word. A masked entry
// then anchors the 'th-given-surname' pass, which takes the surname next to it.
//
// CURATION RULES (over-masking clinical phrases is the worse error — see pii-filter.js):
//  - Each entry MUST be >= 3 Thai characters.
//  - Each entry MUST be a distinctly personal name, NOT a common clinical/everyday word, and MUST NOT
//    be in MED_SHIELD or begin a TH_CLINICAL_LEADS phrase. Re-check the survive-corpus test on any add.
//  - pii-filter.js keeps these out of the clinical allowlist (isClinicalRun) whatever its lists hold.
//  - Keep the list SMALL and high-precision. Recall is intentionally sacrificed for precision; the
//    intake-hint layer is what gives broad coverage.
const TH_GIVEN_NAMES = Object.freeze(new Set([
  'สมชาย', 'สมหญิง', 'สมศรี', 'สมพร', 'สมศักดิ์', 'สมบัติ',
  'วีระ', 'วิชัย', 'ปรีชา', 'ประเสริฐ', 'ธนกร', 'ธีรพงษ์',
  'ศิริพร', 'วราภรณ์', 'กิตติ', 'ชัยวัฒน์', 'ก้องภพ', 'นพดล',
  'อนุชา', 'จิราพร',
]));

// Curated list of Chinese-Thai CLAN surnames (the "แซ่X" family). The title-led name rule masks ONLY
// the given name; a bare surname next to it is taken by the 'th-given-surname' pass (pii-filter.js
// applyGivenSurnamePass), which keeps a word only when the whole word is on the clinical allowlist. The
// "แซ่" prefix is an UNAMBIGUOUS surname marker that never appears in clinical text, so these are masked
// VERBATIM in any position by the 'th-clan-surname' pass — no boundary/clinical-lead guard needed,
// which also closes the glued-surname form ("...แซ่ลี้เข้ารับการรักษา") the 'th-given-surname' pass cannot see.
//
// SCOPE / CURATION (over-masking clinical text is the worse error):
//  - ONLY แซ่-prefixed surnames belong here — they are verifiably collision-free with everyday/clinical
//    Thai. Do NOT hand-seed NATIVE Thai surnames: many double as given names, place names, clinics or
//    pharmacies (e.g. ศรีสุวรรณ is also a district/hospital, มณีรัตน์ a female given name + pharmacy,
//    ศิริวัฒน์ both a given name and a surname), so a standalone occurrence would over-mask
//    clinical/contextual content. A native surname is masked by the intake-hint pass (the recorded
//    patient_ref — the PRIMARY layer) or, next to a masked given name, by the 'th-given-surname' pass
//    (no list: any word not wholly on the clinical allowlist). A native surname with no masked given name
//    beside it and no patient_ref still leaks: docs/MIDDLEWARE-KNOWN-GAPS.md.
//  - Exact strings (a generic "แซ่"+run regex can't tell where a glued surname ends).
const TH_SURNAMES = Object.freeze(new Set([
  'แซ่ลี้', 'แซ่ตั้ง', 'แซ่เล้า', 'แซ่ลิ้ม', 'แซ่อึ้ง', 'แซ่โง้ว', 'แซ่ฉั่ว', 'แซ่เตียว',
  'แซ่จึง', 'แซ่ภู่', 'แซ่ตัน', 'แซ่เฮ้ง',
]));

// Common components of native Thai surnames (ศรี-สุข, ทอง-ดี, วงศ์-ใหญ่, แก้ว-มณี, บุญ-มา…). NOT used to mask
// anything. pii-filter.js keeps every one of these out of the clinical allowlist (the 'th-given-surname' pass
// keeps a word next to a masked given name only when it splits wholly into allowlist words, so an allowlist
// word "สุข" would let มีสุข through in clear), and never takes a lone component as an alias head. Adding an
// entry only ever narrows the allowlist (fail-closed). tests/pii-leak-adversarial.test.js checks no allowlist
// word is one of these; its independent surname sample is deliberately NOT drawn from this list.
const TH_SURNAME_MORPHEMES = Object.freeze([
  'ใจ', 'ดี', 'ศรี', 'สุข', 'ทอง', 'บุญ', 'แก้ว', 'วงศ์', 'วงษ์', 'รัตน', 'รัตนะ', 'ชัย', 'ไชย',
  'ประเสริฐ', 'สมบูรณ์', 'เจริญ', 'ทรัพย์', 'มณี', 'พันธ์', 'พันธุ์', 'กุล', 'ศักดิ์', 'จันทร์', 'จันทร',
  'พงษ์', 'พงศ์', 'สวัสดิ์', 'นาค', 'เพชร', 'เงิน', 'รุ่ง', 'เรือง', 'ธรรม', 'มั่น', 'ยิ่ง', 'สม',
  'อินทร์', 'อินทร', 'ทิพย์', 'ปัญญา', 'วิเศษ', 'สุวรรณ', 'กิตติ', 'ชาญ', 'ณัฐ', 'ธน', 'นิล', 'บัว',
  'พร', 'ภู', 'มหา', 'ยอด', 'รักษ์', 'ลิ้ม', 'วัฒน', 'วีระ', 'ศิริ', 'สิริ', 'สาย', 'หอม', 'อ่อน',
  'อุดม', 'เกษม', 'เกียรติ', 'เขียว', 'คง', 'จิต', 'เฉลิม', 'แสง', 'โชค', 'เลิศ', 'สุภา', 'อมร',
  'สมุทร', 'ทวี', 'เพ็ญ', 'วัน', 'นาม', 'บุตร', 'ปาน', 'พึ่ง', 'ใหญ่', 'น้อย', 'งาม', 'ฤทธิ์', 'เดช',
  'ทอ', 'เทพ', 'พิทักษ์', 'ไพ', 'ภักดี', 'มงคล', 'ราช', 'สกุล', 'สง่า', 'สิทธิ์', 'อำนวย', 'เอี่ยม',
  'ขาว', 'ดำ', 'แดง', 'เหลือง', 'คำ', 'แสน', 'พลอย', 'ประ', 'จำ', 'ศรีสุข', 'วงศ์ใหญ่', 'ทองดี',
  'สุขสวัสดิ์', 'รัตนพันธ์', 'บุญมา', 'แก้วมณี', 'ใจดี',
]);

module.exports = { TH_GIVEN_NAMES, TH_SURNAMES, TH_SURNAME_MORPHEMES };
