'use strict';

// Curated, CONSERVATIVE gazetteer of common Thai GIVEN names — the secondary backstop for a bare,
// unlabelled name when no structured patient_ref intake was entered (pii-filter.js intake-hint pass
// is the precise primary). Used only by the 'th-gazetteer' pass, which masks an entry ONLY at a
// detectable boundary AND when it is standalone or immediately followed by a clinical-lead word.
//
// CURATION RULES (over-masking clinical phrases is the worse error — see pii-filter.js):
//  - Each entry MUST be >= 3 Thai characters.
//  - Each entry MUST be a distinctly personal name, NOT a common clinical/everyday word, and MUST NOT
//    be in MED_SHIELD or begin a TH_CLINICAL_LEADS phrase. Re-check the survive-corpus test on any add.
//  - Keep the list SMALL and high-precision. Recall is intentionally sacrificed for precision; the
//    intake-hint layer is what gives broad coverage.
const TH_GIVEN_NAMES = Object.freeze(new Set([
  'สมชาย', 'สมหญิง', 'สมศรี', 'สมพร', 'สมศักดิ์', 'สมบัติ',
  'วีระ', 'วิชัย', 'ปรีชา', 'ประเสริฐ', 'ธนกร', 'ธีรพงษ์',
  'ศิริพร', 'วราภรณ์', 'กิตติ', 'ชัยวัฒน์', 'ก้องภพ', 'นพดล',
  'อนุชา', 'จิราพร',
]));

// Curated list of Chinese-Thai CLAN surnames (the "แซ่X" family). The title-led name rule masks ONLY
// the given name; a space-separated bare surname after it is taken by the guarded 'th-given-surname'
// pass (pii-filter.js applyGivenSurnamePass), which skips a token that opens a clinical phrase. The
// "แซ่" prefix is an UNAMBIGUOUS surname marker that never appears in clinical text, so these are masked
// VERBATIM in any position by the 'th-clan-surname' pass — no boundary/clinical-lead guard needed,
// which also closes the glued-surname form ("...แซ่ลี้เข้ารับการรักษา") the space-led pass cannot see.
//
// SCOPE / CURATION (over-masking clinical text is the worse error):
//  - ONLY แซ่-prefixed surnames belong here — they are verifiably collision-free with everyday/clinical
//    Thai. Do NOT hand-seed NATIVE Thai surnames: many double as given names, place names, clinics or
//    pharmacies (e.g. ศรีสุวรรณ is also a district/hospital, มณีรัตน์ a female given name + pharmacy,
//    ศิริวัฒน์ both a given name and a surname), so a standalone occurrence would over-mask
//    clinical/contextual content. Native-surname coverage is the intake-hint pass's job (the recorded
//    patient_ref — the PRIMARY layer) or an authoritative Ministry-of-Interior surname registry.
//  - Exact strings (a generic "แซ่"+run regex can't tell where a glued surname ends).
const TH_SURNAMES = Object.freeze(new Set([
  'แซ่ลี้', 'แซ่ตั้ง', 'แซ่เล้า', 'แซ่ลิ้ม', 'แซ่อึ้ง', 'แซ่โง้ว', 'แซ่ฉั่ว', 'แซ่เตียว',
  'แซ่จึง', 'แซ่ภู่', 'แซ่ตัน', 'แซ่เฮ้ง',
]));

// Common LEADING components of native Thai surnames (ศรี-สุข, ทอง-ดี, วงศ์-ใหญ่, แก้ว-มณี, บุญ-มา…). NOT used
// to mask anything. scripts/build-th-clinical-leads.js drops any corpus lead that is a prefix of one of
// these, because the 'th-given-surname' pass skips every word that BEGINS with a lead: a lead "ทอง"
// (from ทองคำ) would let ทองดี through in clear. A word dropped here falls back to its two-word form
// (ใจ → ใจสั่น, ดี → ดีขึ้น), which no surname begins with. Adding an entry only ever narrows the lead list
// (fail-closed): add freely, then rerun the script. tests/pii-leak-adversarial.test.js checks that every
// generated lead respects this list and that sample surnames built on it are masked.
const TH_SURNAME_LEAD_MORPHEMES = Object.freeze([
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

module.exports = { TH_GIVEN_NAMES, TH_SURNAMES, TH_SURNAME_LEAD_MORPHEMES };
