// Clinical rules the batch-C five-step cases (#385) must keep, from the spec #370 round-3 gate. The contract test
// cannot judge clinical truth, so each rule here pins one finding the safety review missed, across every bank,
// variant and option of the three staged cases.
const fs = require('fs');
const path = require('path');
const { readReplies } = require('../../scripts/booth/path-table-sample');

const STAGING = path.join(__dirname, '../src/booth-cases/staging/NFCME-2026');
const REPLIES = path.join(__dirname, '../../scripts/booth/sample-replies/staging/NFCME-2026');
const CASES = ['alcohol-pancreatitis', 'motorcycle-shock', 'sjs-ten-allopurinol'];

const text = (o) => [o.label.en, o.label.th, o.line.en, o.line.th].join('\n');

const RULES = [
  {
    // ATLS 10th ed. and RCST trauma guidance: before the bleeding is controlled, and with no head injury, aim for a
    // systolic of 80-90. Pushing to a normal pressure can restart the bleeding.
    name: 'a normal-pressure target before bleeding control is weaker, and its reply names the rebleeding risk',
    applies: (o) => /normal (BP|blood pressure|pressure)|(BP|pressure) (is |back )?(to )?normal|normotens|ความดัน(ให้|กลับ)?(เป็น|มา)?ปกติ/i.test(text(o))
      || /(systolic|BP|pressure|ความดัน)\D{0,20}1[0-9]{2}\b/i.test(text(o)),
    holds: (o, reply) => o.tier === 'weaker'
      && /เลือดออก(เพิ่ม|ซ้ำ|มากขึ้น)|ก้อนเลือด.{0,20}หลุด|ลิ่มเลือด.{0,20}หลุด/.test(`${reply.weigh}\n${reply.safety}`),
  },
  {
    // BAD 2016 (UK SJS/TEN guideline): burn formulas over-estimate fluid needs in TEN; titrate to urine output.
    name: 'a burn-formula fluid plan is weaker unless it titrates to urine output',
    applies: (o) => /burn formula|parkland|สูตรแผลไหม้|สูตรพาร์คแลนด์/i.test(text(o)),
    holds: (o) => o.tier === 'weaker' || /urine|ปัสสาวะ/i.test(text(o)),
  },
  {
    // WHO and BAD 2016 supportive care: no prophylactic antibiotics; treat a documented infection only.
    name: 'an antibiotic is offered only where every question of its bank states a sign of infection',
    applies: (o) => /antibiot|antimicrob|ยาฆ่าเชื้อ|ยาปฏิชีวนะ|cef|cillin|penem|floxacin|mycin|cycline|chloramphenicol|metronidazole|vancomycin|co-trimoxazole|fusidic|mupirocin/i.test(text(o)),
    holds: (o, reply, bank) => bank.variants.every((v) => /infect|pus\b|purulent|cellulitis|pneumonia|ติดเชื้อ|หนอง/i.test(`${v.question.en}\n${v.question.th}`)),
  },
];

const banksOf = (kase) => Object.entries(kase.banks).flatMap(([step, b]) =>
  (b.variants ? [[step, b]] : Object.entries(b).map(([tier, bank]) => [`${step}.${tier}`, bank])));

test.each(CASES)('%s keeps the round-3 clinical rules in every bank', (id) => {
  const kase = JSON.parse(fs.readFileSync(path.join(STAGING, `${id}.json`), 'utf8'));
  const replies = readReplies(kase, REPLIES);
  const broken = banksOf(kase).flatMap(([key, bank]) => bank.options.flatMap((o) =>
    RULES.filter((r) => r.applies(o) && !r.holds(o, replies[key]?.[o.id] ?? {}, bank))
      .map((r) => `${key} ${o.id} (${o.label.en}): ${r.name}`)));
  expect(broken).toEqual([]);
});
