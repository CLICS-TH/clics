#!/usr/bin/env node
'use strict';

// Builds rimpl/src/services/pii-clinical-leads.th.js: the words that open a Thai clinical phrase, so the
// 'th-given-surname' pass (pii-filter.js applyGivenSurnamePass) does not take "หายใจเหนื่อย" after
// "นายสมชาย" for a surname (#224). The list is MEASURED, not hand-picked:
//
//   1. Corpus: every Thai string in the repo's clinical JSON (scripts/calibration/**, scripts/quality/**:
//      anchor fixtures, held-out and pilot cases, model runs, the quality bank) plus the PIS-7 rubric text
//      (rimpl/src/lib/prompts.js, audit-dashboard/lib/pis7-rubric.ts). These hold no patient names.
//   2. Each maximal Thai run is split with ICU's Thai dictionary (Intl.Segmenter); its FIRST word is a lead.
//      A first word seen at least MIN_COUNT times is kept.
//   3. Plus SEED_LEADS: common symptom / history / exam / plan openers a small corpus may not hold yet.
//   4. Surname safety: a lead that is a prefix of a common surname component (TH_SURNAME_LEAD_MORPHEMES,
//      pii-names.th.js) would let that surname through, so it is dropped and replaced by its two-word
//      forms seen at least MIN_COUNT times (ใจ → ใจสั่น; ดี → ดีขึ้น). Given names are dropped too.
//
// Run from anywhere:  node rimpl/scripts/build-th-clinical-leads.js          (rewrites the file)
//                     node rimpl/scripts/build-th-clinical-leads.js --check  (exit 1 if it would change)
// ICU segmentation can shift between Node/ICU versions; the header records the ICU version used. A
// regenerated list is a PII-filter change: run `cd rimpl && npm test` (the leak suites) afterwards.

const fs = require('fs');
const path = require('path');
const { TH_GIVEN_NAMES, TH_SURNAME_LEAD_MORPHEMES } = require('../src/services/pii-names.th');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'rimpl', 'src', 'services', 'pii-clinical-leads.th.js');
const JSON_ROOTS = ['scripts/calibration', 'scripts/quality'];
const TEXT_FILES = ['rimpl/src/lib/prompts.js', 'audit-dashboard/lib/pis7-rubric.ts'];
const MIN_COUNT = 3;

// Symptom / history / exam / plan openers (each also passes the surname-safety filter below).
const SEED_LEADS = [
  // symptoms
  'แพ้', 'ชัก', 'หมด', 'หายใจ', 'เวียน', 'แน่น', 'ซึม', 'ตัว', 'หก', 'ไอ', 'ไข้', 'ปวด', 'เจ็บ', 'บวม',
  'ถ่าย', 'อาเจียน', 'คลื่นไส้', 'ท้อง', 'เหนื่อย', 'ซีด', 'อ่อนเพลีย', 'อ่อนแรง', 'จุก', 'เบื่อ', 'ล้ม',
  'หน้ามืด', 'ใจสั่น', 'ชา', 'คัน', 'ผื่น', 'ไข้สูง', 'หนาวสั่น', 'เสมหะ', 'ปัสสาวะ', 'อุจจาระ', 'เลือด',
  'น้ำหนัก', 'ผอม', 'นอนไม่หลับ', 'สับสน', 'กระสับกระส่าย', 'บ้าน', 'ตาเหลือง', 'ตามัว', 'หูอื้อ', 'กลืน',
  'สำลัก', 'แสบ', 'ร้อน', 'หนาว', 'เกร็ง', 'กระตุก', 'มึน', 'งง', 'ปาก', 'คอ', 'แขน', 'ขา', 'หลัง', 'เข่า',
  // history
  'ความ', 'ประวัติ', 'เคย', 'เป็น', 'มี', 'ไม่', 'ได้รับ', 'ญาติ', 'มารดา', 'บิดา', 'ครอบครัว', 'โรค',
  'เบาหวาน', 'ความดัน', 'ไขมัน', 'หัวใจ', 'ไต', 'ตับ', 'มะเร็ง', 'หอบหืด', 'ผ่าตัด', 'ตั้งครรภ์', 'คลอด',
  'ประจำเดือน', 'สูบ', 'ดื่ม', 'เสพ', 'ใช้ยา', 'ยา', 'วัคซีน', 'เข้า', 'นอน', 'อาศัย', 'ทำงาน', 'อาชีพ',
  // exam / investigation
  'ตรวจ', 'วัด', 'ฟัง', 'คลำ', 'เคาะ', 'ผล', 'ค่า', 'ภาพ', 'เอกซเรย์', 'อัลตราซาวด์', 'เจาะ', 'ส่ง',
  'สัญญาณชีพ', 'ชีพจร', 'อุณหภูมิ', 'ระดับ',
  // plan
  'แนะนำ', 'สั่ง', 'ให้', 'นัด', 'ติดตาม', 'รักษา', 'วินิจฉัย', 'ส่งต่อ', 'รับไว้', 'จำหน่าย', 'พัก',
  'งด', 'หยุด', 'เพิ่ม', 'ลด', 'ปรับ', 'เปลี่ยน', 'เริ่ม', 'ประเมิน', 'สังเกต', 'เฝ้าระวัง', 'อธิบาย',
];

const THAI_RUN = /[ก-ฮะ-๎]+/g;
const segmenter = new Intl.Segmenter('th', { granularity: 'word' });

function collectStrings() {
  const strings = [];
  const collect = (v) => {
    if (typeof v === 'string') { if (/[ก-๛]/.test(v)) strings.push(v); }
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.json')) collect(JSON.parse(fs.readFileSync(p, 'utf8')));
    }
  };
  JSON_ROOTS.forEach((r) => walk(path.join(REPO, r)));
  for (const f of TEXT_FILES) strings.push(fs.readFileSync(path.join(REPO, f), 'utf8'));
  return [...new Set(strings)];
}

// A lead blocks every surname that begins with it.
const blocksSurname = (lead) => TH_SURNAME_LEAD_MORPHEMES.some((m) => m.startsWith(lead));
const usable = (lead) => lead.length >= 2 && !blocksSurname(lead) && !TH_GIVEN_NAMES.has(lead);

function build() {
  const strings = collectStrings();
  const first = new Map();
  const firstTwo = new Map();
  let tokens = 0;
  for (const s of strings) {
    for (const [run] of s.matchAll(THAI_RUN)) {
      tokens += 1;
      const words = [...segmenter.segment(run)].map((x) => x.segment);
      first.set(words[0], (first.get(words[0]) || 0) + 1);
      if (words.length > 1) {
        const two = words[0] + words[1];
        if (!firstTwo.has(words[0])) firstTwo.set(words[0], new Map());
        const m = firstTwo.get(words[0]);
        m.set(two, (m.get(two) || 0) + 1);
      }
    }
  }
  const leads = new Set();
  const consider = (w, viaCorpus) => {
    if (usable(w)) { leads.add(w); return; }
    if (!viaCorpus) return;
    for (const [two, n] of firstTwo.get(w) || []) if (n >= MIN_COUNT && usable(two)) leads.add(two);
  };
  for (const [w, n] of first) if (n >= MIN_COUNT) consider(w, true);
  for (const w of SEED_LEADS) consider(w, first.has(w));
  const sorted = [...leads].sort((a, b) => a.localeCompare(b, 'th') || a.length - b.length);
  return { sorted, strings: strings.length, tokens };
}

function render({ sorted, strings, tokens }) {
  const lines = [];
  for (let i = 0; i < sorted.length; i += 10) lines.push('  ' + sorted.slice(i, i + 10).map((w) => `'${w}'`).join(', ') + ',');
  return `'use strict';

// GENERATED by rimpl/scripts/build-th-clinical-leads.js — do not edit by hand; edit the script's SEED_LEADS
// or TH_SURNAME_LEAD_MORPHEMES (pii-names.th.js) and rerun it.
// Corpus: ${strings} Thai strings / ${tokens} Thai runs (${JSON_ROOTS.join(', ')}, ${TEXT_FILES.join(', ')});
// first ICU word seen >= ${MIN_COUNT} times, plus seed leads, minus any prefix of a surname component.
// ICU ${process.versions.icu}. ${sorted.length} leads.
//
// Words that open a Thai clinical / function phrase. The 'th-given-surname' pass (pii-filter.js) does not
// take a word that begins with one of these for a surname after a masked given name.
const TH_CORPUS_CLINICAL_LEADS = Object.freeze([
${lines.join('\n')}
]);

module.exports = { TH_CORPUS_CLINICAL_LEADS };
`;
}

const result = build();
const text = render(result);
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) { console.error(`${path.relative(REPO, OUT)} is stale: rerun without --check`); process.exit(1); }
  console.log(`${path.relative(REPO, OUT)} is current (${result.sorted.length} leads)`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(REPO, OUT)}: ${result.sorted.length} leads from ${result.strings} strings / ${result.tokens} runs`);
}
