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

module.exports = { TH_GIVEN_NAMES };
