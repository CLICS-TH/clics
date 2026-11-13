const fs = require('fs');
const path = require('path');

// Clinical rules the batch B safety gate (#384) found broken. The contract test cannot judge clinical truth, so each
// rule here reads the staged trees and replies for one defect the review let through.
const CASES = path.join(__dirname, '../src/booth-cases/staging/NFCME-2026');
const REPLIES = path.join(__dirname, '../../scripts/booth/sample-replies/staging/NFCME-2026');
const BATCH_B = ['adhf', 'copd-exacerbation', 'ectopic-rupture', 'toddler-gastro-dehydration'];
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const staged = BATCH_B.map((id) => ({
  id, kase: read(path.join(CASES, `${id}.json`)), replies: read(path.join(REPLIES, `${id}.json`)).replies,
}));
const banks = (kase) => Object.entries(kase.banks).flatMap(([step, b]) => (b.options
  ? [{ key: step, bank: b }]
  : Object.entries(b).map(([tier, bank]) => ({ key: `${step}.${tier}`, bank }))));
const options = (kase) => banks(kase).flatMap(({ key, bank }) => bank.options.map((o) => ({ key, o })));
const text = (o) => [o.label.en, o.line.en, o.label.th, o.line.th].join(' | ');

const WORD_HOURS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, twelve: 12 };
// Every hour count in a label or line that mentions a blood gas, in English or Thai; a next-day gas counts as a day.
const gasHours = (s) => s.split(' | ').filter((f) => /gas|ABG|ก๊าซ/i.test(f)).flatMap((f) => [
  ...[...f.matchAll(/(\d+|one|two|three|four|five|six|eight|twelve)\s*-?\s*(?:h\b|hrs?\b|hours?|ชม)/giu)]
    .map((m) => WORD_HOURS[m[1].toLowerCase()] ?? Number(m[1])),
  ...[...f.matchAll(/tomorrow|next morning|overnight|next day|พรุ่งนี้|เช้าวันรุ่งขึ้น/giu)].map(() => 24),
]);

test.each(staged)('$id: no NIV option puts the first repeat gas beyond 2 hours (BTS/ICS NIV)', ({ kase }) => {
  const late = options(kase).filter(({ o }) => /NIV|BiPAP/i.test(text(o)) && gasHours(text(o)).some((h) => h > 2))
    .map(({ key, o }) => `${key} ${o.id}: ${o.label.en}`);
  expect(late).toEqual([]);
});

// Banks whose every variant describes failing NIV: drowsier with a pH below 7.30 after NIV was offered.
const ESCALATION_BANKS = { 'copd-exacerbation': ['step5.W'] };
test.each(staged)('$id: every option after NIV failure escalates to ICU or intubation, with a safety line', ({ id, kase, replies }) => {
  const bad = (ESCALATION_BANKS[id] ?? []).flatMap((key) => banks(kase).find((b) => b.key === key).bank.options
    .filter((o) => !/ICU|intubat/i.test(o.label.en) || !/ICU|ใส่ท่อ/.test(o.label.th) || !replies[key][o.id].safety.trim())
    .map((o) => `${key} ${o.id}: ${o.label.en}`));
  expect(bad).toEqual([]);
});

// BTS/ICS AHRF 2016: when NIV fails, the ICU call is not delayed, so an option above weaker puts no step before it.
const ICU_LATER = /\b(?:then|before|first|after)\b[^.]*ICU|ICU\b[^.]*\b(?:after|later|next)\b|(?:แล้ว|ก่อน|หลังจาก|ค่อย)[^.]*ICU/i;
const ACTION = /NIV|BiPAP|intubat|ใส่ท่อ|senior|อาวุโส|steroid|สเตียรอยด์/i;
const icuFirst = (s) => s.search(/ICU/) >= 0 && (s.search(ACTION) < 0 || s.search(/ICU/) < s.search(ACTION));
test.each(staged)('$id: after NIV failure no option above weaker puts a step before the ICU call', ({ id, kase, replies }) => {
  const late = (ESCALATION_BANKS[id] ?? []).flatMap((key) => banks(kase).find((b) => b.key === key).bank.options
    .filter((o) => o.tier !== 'weaker' && (![o.label.en, o.label.th].every(icuFirst)
      || [text(o), replies[key][o.id].strength, replies[key][o.id].weigh].some((s) => ICU_LATER.test(s))))
    .map((o) => `${key} ${o.id}: ${o.label.en}`));
  expect(late).toEqual([]);
});

// Thai COPD guideline 2565/2022 p.77: a beta-lactam/beta-lactamase inhibitor, doxycycline, a respiratory quinolone or a
// macrolide is the usual first antibiotic in an exacerbation, so where step 3 picks the first antibiotic an oral one
// alone is never tiered weaker. A switch hours later (step 4) is weaker for its timing, not its drug.
const THAI_FIRST_LINE = /amox-clav|doxycycline|levofloxacin|moxifloxacin|azithromycin|clarithromycin/i;
test('copd-exacerbation: no Thai first-line oral antibiotic option is tiered weaker', () => {
  const { kase } = staged.find((s) => s.id === 'copd-exacerbation');
  const low = options(kase).filter(({ key, o }) => key.startsWith('step3') && THAI_FIRST_LINE.test(o.label.en) && !/\bIV\b/.test(o.label.en) && o.tier === 'weaker')
    .map(({ key, o }) => `${key} ${o.id}: ${o.label.en}`);
  expect(low).toEqual([]);
});

const CONGESTED = /swollen|swelling|o?edema|crackles|congest|still breathless/i;
const CLEARED = /no longer (?:swollen|congested)|(?:swelling|o?edema|congestion) (?:has )?(?:gone|cleared)/gi;
test.each(staged)('$id: no option sends home a patient every variant describes as still congested (ESC HF)', ({ kase }) => {
  const home = banks(kase).filter(({ bank }) => bank.variants.every((v) => CONGESTED.test(v.question.en.replace(CLEARED, ''))))
    .flatMap(({ key, bank }) => bank.options.filter((o) => /\bhome\b|discharg/i.test(o.label.en) || /กลับบ้าน|จำหน่าย/.test(o.label.th))
      .map((o) => `${key} ${o.id}: ${o.label.en}`));
  expect(home).toEqual([]);
});

// NICE NG126 (updated 2026) rec 1.18.1, WHO abortion care (2022) and RTCOG CPG OB 66-031 (2023): no anti-D before 12 weeks.
test.each(staged)('$id: no anti-D option is tiered above weaker before 12 weeks of pregnancy', ({ kase }) => {
  const weeks = [...kase.vignette.en.matchAll(/(\d+)\s*weeks?/gi)].map((m) => Number(m[1]));
  const early = weeks.length > 0 && Math.max(...weeks) < 12;
  const offered = options(kase).filter(({ o }) => early && /anti-?D|Rh immun/i.test(o.label.en) && o.tier !== 'weaker')
    .map(({ key, o }) => `${key} ${o.id}: ${o.tier}`);
  expect(offered).toEqual([]);
});

test.each(staged)('$id: its safety review names the Thai and WHO sources it checked, not recall', ({ kase }) => {
  const { findings } = kase.admission.safety_review;
  expect(findings).not.toMatch(/recall/i);
  expect(findings).toMatch(/Thai[^.;]*\b(?:20|25)\d\d\b/);
  expect(findings).toMatch(/WHO/);
  const none = findings.match(/[^.]*\bno(?:ne)?\b[^.]*\b(?:guideline|source)[^.]*\b(?:exists?|covers?|appl(?:y|ies))\b[^.]*/gi) ?? [];
  expect(none.filter((s) => !/search/i.test(s))).toEqual([]);
});

// The gate's source rulings: the WHO hospital manual that covers acute pulmonary oedema, the current (2022) Thai COPD
// guideline, and the WHO obstetric manual that covers ectopic pregnancy.
const REQUIRED_SOURCE = {
  adhf: /IMAI/, 'copd-exacerbation': /Thai[^.;]*\b(?:2022|2565)\b/, 'ectopic-rupture': /Managing complications in pregnancy/i,
};
test.each(staged.filter(({ id }) => REQUIRED_SOURCE[id]))('$id: its safety review cites the source the gate requires', ({ id, kase }) => {
  expect(kase.admission.safety_review.findings).toMatch(REQUIRED_SOURCE[id]);
});

// AC2: the review covers every changed variant and option, so fixes made after it are re-checked on the final tree.
test.each(staged)('$id: its safety review records a fresh non-author re-check of the final tree', ({ kase }) => {
  expect(kase.admission.safety_review.findings).toMatch(/re-check[^.]*non-author[^.]*final tree/i);
});
