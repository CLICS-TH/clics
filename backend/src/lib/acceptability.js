// Brief acceptability questionnaire (CREC082 ICF §3 step 4, Protocol V4.1 objective 5, SAP secondary
// outcome). One per physician, at the end of participation — normally after their last PLE.
//
// Protocol objective 5 names what it has to cover:
//   "เพื่อประเมินความยอมรับของระบบ ภาระเวลา เหตุการณ์ด้านข้อมูล/ความเป็นส่วนตัว และข้อเสนอแนะ
//    ผ่าน brief acceptability questionnaire หลัง PLE ครั้งสุดท้าย โดยไม่มี qualitative interview"
//
// So the four DOMAINS below are the protocol's, not invented: system acceptability, time burden,
// data/privacy experience, and free-text suggestions.
//
// ⚠️ THE ITEM WORDING IS PROVISIONAL. The domains come from the protocol; the exact sentences do not
// appear in any approved document, and a research instrument's wording is the research team's and
// the IRB's to set — not a developer's. These are a working set so the endpoint, the storage, and
// the reporting can be built and tested now. Replace them with the approved instrument before the
// first participant, and bump INSTRUMENT_VERSION when you do, so responses collected under different
// wording are never pooled as if they answered the same question.
const INSTRUMENT_VERSION = 'provisional-v1';

// Likert 1-5. Kept as data rather than hardcoded into a form so the approved wording can land
// without touching the endpoint or the schema.
const ITEMS = [
  { key: 'acceptable',    domain: 'acceptability', th: 'โดยรวมแล้ว ระบบนี้เป็นวิธีที่ยอมรับได้สำหรับการเก็บหน่วยกิตการศึกษาต่อเนื่อง', en: 'Overall, this is an acceptable way to earn continuing-education credit.' },
  { key: 'fair',          domain: 'acceptability', th: 'การประเมินสะท้อนการคิดเชิงคลินิกของข้าพเจ้าได้อย่างเป็นธรรม',                  en: 'The assessment reflected my clinical reasoning fairly.' },
  { key: 'time_burden',   domain: 'burden',        th: 'เวลาที่ใช้ต่อหนึ่ง Learning Episode เหมาะสม',                                   en: 'The time each learning episode took was reasonable.' },
  { key: 'workload_fit',  domain: 'burden',        th: 'ข้าพเจ้าสามารถทำกิจกรรมนี้ควบคู่กับภาระงานปกติได้',                             en: 'I could fit this alongside my normal workload.' },
  { key: 'privacy_ok',    domain: 'privacy',       th: 'ข้าพเจ้ามั่นใจว่าข้อมูลของข้าพเจ้าและของผู้ป่วยได้รับการคุ้มครอง',               en: 'I was confident my data, and any patient data, was protected.' },
  { key: 'privacy_clear', domain: 'privacy',       th: 'ระบบอธิบายชัดเจนว่าข้อมูลใดถูกเก็บและถูกส่งไปที่ใด',                           en: 'It was clear what data was collected and where it went.' },
  { key: 'would_use',     domain: 'acceptability', th: 'ข้าพเจ้าจะใช้ระบบนี้อีก หากมีให้ใช้จริง',                                       en: 'I would use this again if it were available.' },
];

const KEYS = ITEMS.map(i => i.key);
const SCALE_MIN = 1, SCALE_MAX = 5;

// Validate a submitted answer map. Partial answers are allowed on purpose: ICF §7 makes
// participation voluntary, and refusing the whole form because one item is blank would turn "I would
// rather not answer that one" into no data at all.
function validateAnswers(answers) {
  if (answers == null || typeof answers !== 'object' || Array.isArray(answers)) {
    return { ok: false, code: 'answers_not_an_object' };
  }
  const clean = {};
  for (const [k, v] of Object.entries(answers)) {
    if (!KEYS.includes(k)) return { ok: false, code: 'unknown_item', item: k };
    if (v === null || v === undefined || v === '') continue;  // left blank — allowed
    const n = Number(v);
    if (!Number.isInteger(n) || n < SCALE_MIN || n > SCALE_MAX) {
      return { ok: false, code: 'out_of_scale', item: k };
    }
    clean[k] = n;
  }
  return { ok: true, answers: clean };
}

module.exports = { INSTRUMENT_VERSION, ITEMS, KEYS, SCALE_MIN, SCALE_MAX, validateAnswers };
