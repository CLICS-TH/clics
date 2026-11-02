// Band descriptors for the booth result card (#250): one fixed Thai and English line for each PIS-7 domain and band.
// No imports, so the harness can load this file as a data: URL like booth-copy.js.
// Bands follow the rubric's own anchors (0 -> 3 -> 5, rimpl/src/lib/prompts.js PER-DOMAIN ANCHORS). Each line says what
// this one play showed, never what the physician is: the rubric forbids reading a score as overall competence.

/** 0-2 is the low band, 3 the middle, 4-5 the high. */
export const bandOf = (value) => (value <= 2 ? 'low' : value === 3 ? 'mid' : 'high');

export const BAND_LINES = Object.freeze({
  d1: {
    low: { th: 'คำถามรอบนี้ยังชี้จุดตัดสินใจสำคัญของเคสได้ไม่มาก', en: 'Your questions only partly reached the case\'s key decision.' },
    mid: { th: 'คำถามชัดเจนและเกี่ยวกับเคส แต่ยังไม่เจาะลึก', en: 'Clear, relevant questions that stayed general.' },
    high: { th: 'คำถามเฉพาะเจาะจงและนำไปสู่ประเด็นสำคัญของเคส', en: 'Specific questions that led to the case\'s key issues.' },
  },
  d2: {
    low: { th: 'เหตุผลรอบนี้ยังสั้น เชื่อมกลไกกับหลักฐานน้อย', en: 'Reasoning stayed brief, with little tying mechanism to evidence.' },
    mid: { th: 'มีเหตุผลที่เข้าใจได้ แต่ยังเชื่อมหลักฐานกับข้อจำกัดไม่ครบ', en: 'Sound reasoning, with evidence and limits not fully linked.' },
    high: { th: 'เหตุผลชัดเจน เชื่อมกลไก หลักฐาน และข้อจำกัดเข้าด้วยกัน', en: 'Strong reasoning that linked mechanism, evidence and limits.' },
  },
  d3: {
    low: { th: 'ใช้ข้อมูลเฉพาะของผู้ป่วยรายนี้ค่อนข้างน้อย', en: 'Little of this patient\'s own details was used.' },
    mid: { th: 'ใช้บริบทของผู้ป่วยบางส่วนประกอบการตัดสินใจ', en: 'Some of the patient\'s context shaped the decisions.' },
    high: { th: 'ใช้บริบทของผู้ป่วยได้ดีและรู้ข้อจำกัด', en: 'Used the patient\'s context well, aware of its limits.' },
  },
  d4: {
    low: { th: 'คำถามยังต่อยอดจากคำตอบที่ได้รับไม่มาก', en: 'Questions built little on the answers received.' },
    mid: { th: 'มีคำถามต่อยอดที่เกี่ยวข้อง แต่ยังไม่ปรับแนวทาง', en: 'Relevant follow-ups, but the approach did not adapt.' },
    high: { th: 'ปรับคำถามตามสิ่งที่ได้เรียนรู้ระหว่างทาง', en: 'Adapted questions to what the earlier answers showed.' },
  },
  d5: {
    low: { th: 'ยังตั้งข้อสงสัยต่อคำตอบของ AI ไม่มาก', en: 'Little questioning of what the AI said.' },
    mid: { th: 'ประเมินข้อจำกัดของ AI ได้พอสมควร', en: 'A fair appraisal of the AI\'s limits.' },
    high: { th: 'แยกข้อเท็จจริง ความไม่แน่นอน และข้อจำกัดได้ชัดเจน', en: 'Clearly separated fact, uncertainty and limitation.' },
  },
  d6: {
    low: { th: 'ยังสรุปหรือทบทวนสิ่งที่ได้เรียนรู้ไม่มาก', en: 'Little summing up of what was learned.' },
    mid: { th: 'สรุปประเด็นได้ แต่ยังไม่ระบุสิ่งที่จะเรียนต่อ', en: 'A reasonable summary, without a named next step.' },
    high: { th: 'สังเคราะห์ได้ดีและบอกสิ่งที่จะเรียนรู้ต่อ', en: 'Strong synthesis that named what to learn next.' },
  },
  d7: {
    low: { th: 'วิธีใช้ AI รอบนี้ยังมีที่ปรับปรุงได้มาก', en: 'How the AI was used this time has room to grow.' },
    mid: { th: 'สั่งงานและกำกับ AI ได้พอสมควร', en: 'A reasonable way of prompting and steering the AI.' },
    high: { th: 'ใช้ AI อย่างมีวิจารณญาณและรู้ข้อจำกัดของ AI', en: 'Used the AI critically, aware of its limits.' },
  },
});

/**
 * The domain keys, weakest first. A tie keeps the rubric's order (d1 before d2), so the same score always lists
 * the same two domains.
 * @param {Record<string, number>} domains
 */
export const weakestFirst = (domains) => Object.keys(BAND_LINES)
  .map((key, i) => ({ key, i, value: domains[key] }))
  .sort((a, b) => a.value - b.value || a.i - b.i)
  .map(({ key }) => key);
