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

// Curated list of Chinese-Thai CLAN surnames (the "แซ่X" family). The title-led name rule deliberately
// masks ONLY the given name (over-masking a clinical phrase after a name is the worse error — see
// pii-filter.js TH_NAME_RE), leaving a bare surname like "นายสมชาย แซ่ลี้" in clear text. The "แซ่"
// prefix is an UNAMBIGUOUS surname marker that never appears in clinical text, so these are masked
// VERBATIM in any position by the 'th-clan-surname' pass — no boundary/clinical-lead guard needed,
// which also closes the glued-surname form ("...แซ่ลี้เข้ารับการรักษา").
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

module.exports = { TH_GIVEN_NAMES, TH_SURNAMES };
