#!/usr/bin/env node
'use strict';

// Builds rimpl/src/services/pii-clinical-words.th.js: the closed vocabulary of Thai clinical / function
// words. The 'th-given-surname' pass (pii-filter.js applyGivenSurnamePass) lets a word next to a masked
// given name through only when the WHOLE word splits into words from this list ("หายใจเหนื่อย" =
// หายใจ + เหนื่อย); anything else is taken for the surname (#224). The list is MEASURED, not hand-picked:
//
//   1. Corpus: every Thai string in the repo's clinical JSON (scripts/calibration/**, scripts/quality/**:
//      anchor fixtures, held-out and pilot cases, model runs, the quality bank) plus the PIS-7 rubric text
//      (rimpl/src/lib/prompts.js, audit-dashboard/lib/pis7-rubric.ts). These hold no patient names.
//   2. Each maximal Thai run is split with ICU's Thai dictionary (Intl.Segmenter). A word seen at least
//      MIN_COUNT times is kept.
//   3. Plus SEED_WORDS: common symptom / history / exam / plan words a small corpus may not hold yet.
//   4. Surname safety: a word that IS a common surname component (TH_SURNAME_MORPHEMES, pii-names.th.js)
//      would let a surname built from it and another list word through (มี + สุข), so it is dropped and
//      replaced by its two-word forms seen at least MIN_COUNT times whose second word is no component
//      either (ใจ → ใจสั่น; ดี → ดีขึ้น; never ใจดี). Given names are dropped too.
//
// Run from anywhere:  node rimpl/scripts/build-th-clinical-words.js          (rewrites the file)
//                     node rimpl/scripts/build-th-clinical-words.js --check  (exit 1 if it would change)
// ICU segmentation can shift between Node/ICU versions; the header records the ICU version used. A
// regenerated list is a PII-filter change: run `cd rimpl && npm test` (the leak suites) afterwards.

const fs = require('fs');
const path = require('path');
const { TH_GIVEN_NAMES, TH_SURNAME_MORPHEMES } = require('../src/services/pii-names.th');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'rimpl', 'src', 'services', 'pii-clinical-words.th.js');
const JSON_ROOTS = ['scripts/calibration', 'scripts/quality'];
const TEXT_FILES = ['rimpl/src/lib/prompts.js', 'audit-dashboard/lib/pis7-rubric.ts'];
const MIN_COUNT = 3;

// Symptom / history / exam / plan words (each also passes the surname-safety filter below).
const SEED_WORDS = [
  // symptoms
  'แพ้', 'ชัก', 'หมด', 'หายใจ', 'เวียน', 'แน่น', 'ซึม', 'ตัว', 'หก', 'ไอ', 'ไข้', 'ปวด', 'เจ็บ', 'บวม',
  'ถ่าย', 'อาเจียน', 'คลื่นไส้', 'ท้อง', 'เหนื่อย', 'ซีด', 'อ่อนเพลีย', 'อ่อนแรง', 'จุก', 'เบื่อ', 'ล้ม',
  'หน้ามืด', 'ใจสั่น', 'ชา', 'คัน', 'ผื่น', 'ไข้สูง', 'หนาวสั่น', 'เสมหะ', 'ปัสสาวะ', 'อุจจาระ', 'เลือด',
  'น้ำหนัก', 'ผอม', 'นอนไม่หลับ', 'สับสน', 'กระสับกระส่าย', 'บ้าน', 'ตาเหลือง', 'ตัวเหลือง', 'ตามัว', 'หูอื้อ', 'กลืน',
  'สำลัก', 'แสบ', 'ร้อน', 'หนาว', 'เกร็ง', 'กระตุก', 'มึน', 'งง', 'ปาก', 'คอ', 'แขน', 'ขา', 'หลัง', 'เข่า',
  'บ่น', 'จิตใจ', 'ตัวแดง', 'แดงทั้งตัว', 'ผื่นแดง', 'ดีขึ้น', 'แย่ลง', 'คงที่', 'ขัด', 'ศีรษะ', 'หน้าอก', 'ห้องน้ำ',
  // history
  'ความ', 'ประวัติ', 'เคย', 'เป็น', 'มี', 'ไม่', 'ได้รับ', 'ญาติ', 'มารดา', 'บิดา', 'ครอบครัว', 'โรค',
  'เบาหวาน', 'ความดัน', 'ไขมัน', 'หัวใจ', 'ไต', 'ตับ', 'มะเร็ง', 'หอบหืด', 'ผ่าตัด', 'ตั้งครรภ์', 'คลอด',
  'ประจำเดือน', 'สูบ', 'ดื่ม', 'เสพ', 'ใช้ยา', 'ยา', 'วัคซีน', 'เข้า', 'นอน', 'อาศัย', 'ทำงาน', 'อาชีพ',
  'สามี', 'ภรรยา', 'ลูก', 'เล่า', 'ฟอก', 'ฟอกไต', 'บุหรี่', 'ซอง', 'สุรา', 'ประจำตัว', 'สม่ำเสมอ', 'พา',
  'เพนนิซิลลิน', 'เพนิซิลลิน', 'ซัลฟา', 'แอสไพริน', 'พาราเซตามอล', 'ไอบูโพรเฟน', 'อะม็อกซีซิลลิน',
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

const MORPHEMES = new Set(TH_SURNAME_MORPHEMES);
const usable = (w) => w.length >= 2 && !MORPHEMES.has(w) && !TH_GIVEN_NAMES.has(w);

function build() {
  const strings = collectStrings();
  const counts = new Map();
  const pairs = new Map(); // morpheme word -> Map(two-word form -> count)
  let tokens = 0;
  for (const s of strings) {
    for (const [run] of s.matchAll(THAI_RUN)) {
      tokens += 1;
      const words = [...segmenter.segment(run)].map((x) => x.segment);
      words.forEach((w, i) => {
        counts.set(w, (counts.get(w) || 0) + 1);
        const next = words[i + 1];
        if (next === undefined || !MORPHEMES.has(w) || MORPHEMES.has(next)) return;
        if (!pairs.has(w)) pairs.set(w, new Map());
        const m = pairs.get(w);
        m.set(w + next, (m.get(w + next) || 0) + 1);
      });
    }
  }
  const words = new Set();
  for (const [w, n] of counts) {
    if (n < MIN_COUNT) continue;
    if (usable(w)) words.add(w);
    else for (const [two, k] of pairs.get(w) || []) if (k >= MIN_COUNT && usable(two)) words.add(two);
  }
  for (const w of SEED_WORDS) if (usable(w)) words.add(w);
  const sorted = [...words].sort((a, b) => a.localeCompare(b, 'th') || a.length - b.length);
  return { sorted, strings: strings.length, tokens };
}

function render({ sorted, strings, tokens }) {
  const lines = [];
  for (let i = 0; i < sorted.length; i += 10) lines.push('  ' + sorted.slice(i, i + 10).map((w) => `'${w}'`).join(', ') + ',');
  return `'use strict';

// GENERATED by rimpl/scripts/build-th-clinical-words.js — do not edit by hand; edit the script's SEED_WORDS
// or TH_SURNAME_MORPHEMES (pii-names.th.js) and rerun it.
// Corpus: ${strings} Thai strings / ${tokens} Thai runs (${JSON_ROOTS.join(', ')}, ${TEXT_FILES.join(', ')});
// every ICU word seen >= ${MIN_COUNT} times, plus seed words, minus surname components and given names.
// ICU ${process.versions.icu}. ${sorted.length} words.
//
// Thai clinical / function words. The 'th-given-surname' pass (pii-filter.js) keeps a word next to a masked
// given name only when the whole word splits into words from this list.
const TH_CORPUS_CLINICAL_WORDS = Object.freeze([
${lines.join('\n')}
]);

module.exports = { TH_CORPUS_CLINICAL_WORDS };
`;
}

const result = build();
const text = render(result);
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) { console.error(`${path.relative(REPO, OUT)} is stale: rerun without --check`); process.exit(1); }
  console.log(`${path.relative(REPO, OUT)} is current (${result.sorted.length} words)`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(REPO, OUT)}: ${result.sorted.length} words from ${result.strings} strings / ${result.tokens} runs`);
}
