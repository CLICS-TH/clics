// Band descriptors for the booth result card (#250): one fixed Thai and English line for each PIS-7 domain and band.
// No imports, so the harness can load this file as a data: URL like booth-copy.js.
// Bands follow the rubric's own anchors (0 -> 3 -> 5, rimpl/src/lib/prompts.js PER-DOMAIN ANCHORS). Each line says what
// this one three-tap play showed (answers, choices, replies), never a free chat or what the physician is: the rubric forbids
// reading a score as overall competence. Thai and English make the same strength of claim.

/** Recorded like a case's admission.safety_review (ADR 0005): a fresh AI reviewer read all 21 pairs. */
export const SAFETY_REVIEW = Object.freeze({
  model: 'claude-opus-5-5',
  date: '2026-11-02',
  findings: 'No clinical claims and no judgment of the physician. Fixed: d5 claimed option-weighing the scorer cannot see, d2 drifted from depth of reasoning, English low bands harsher than Thai, d4 wrong for the first answer, Thai d1/d2/d6 read as translated.',
});

/** 0-2 is the low band, 3 the middle, 4-5 the high. */
export const bandOf = (value) => (value <= 2 ? 'low' : value === 3 ? 'mid' : 'high');

export const BAND_LINES = Object.freeze({
  d1: {
    low: { th: 'คำตอบสามขั้นนี้ยังไม่ตรงประเด็นหลักของเคสนัก', en: 'Your three answers only partly addressed the case\'s main issue.' },
    mid: { th: 'คำตอบสามขั้นนี้เกี่ยวกับเคส แต่ยังไม่ลงไปที่ประเด็นหลัก', en: 'Your three answers related to the case but stayed general.' },
    high: { th: 'คำตอบสามขั้นนี้ตรงประเด็นหลักของเคสอย่างเจาะจง', en: 'Your three answers were specific to the case\'s main issue.' },
  },
  d2: {
    low: { th: 'ในคำตอบรอบนี้ ยังไม่ค่อยเห็นเหตุผลเบื้องหลังการเลือก', en: 'Your answers did not show much of the reasoning behind them.' },
    mid: { th: 'คำตอบรอบนี้มีเหตุผลที่เข้าใจได้ แต่ยังไม่ลงลึก', en: 'Your answers gave sensible reasons but did not go into depth.' },
    high: { th: 'คำตอบรอบนี้ให้เหตุผลได้ชัดเจนและลงลึก', en: 'Your answers gave clear reasons that went into depth.' },
  },
  d3: {
    low: { th: 'คำตอบรอบนี้ใช้รายละเอียดของผู้ป่วยรายนี้ไม่มากนัก', en: 'Your answers did not draw much on this patient\'s details.' },
    mid: { th: 'คำตอบรอบนี้ใช้รายละเอียดของผู้ป่วยรายนี้บางส่วน', en: 'Your answers used some of this patient\'s details.' },
    high: { th: 'คำตอบรอบนี้ใช้รายละเอียดของผู้ป่วยรายนี้ได้หลายจุด', en: 'Your answers used many of this patient\'s details.' },
  },
  d4: {
    low: { th: 'คำตอบขั้นถัดมายังต่อยอดจากขั้นก่อนหน้าไม่มากนัก', en: 'Your later answers did not build much on the step before.' },
    mid: { th: 'คำตอบขั้นถัดมาต่อยอดจากขั้นก่อนหน้าได้บางส่วน', en: 'Your later answers partly built on the step before.' },
    high: { th: 'คำตอบขั้นถัดมาต่อยอดจากขั้นก่อนหน้าอย่างชัดเจน', en: 'Your later answers clearly built on the step before.' },
  },
  d5: {
    low: { th: 'รอบนี้ยังเห็นการชั่งน้ำหนักคำตอบจาก AI ไม่มากนัก', en: 'This play did not show much weighing of the AI\'s replies.' },
    mid: { th: 'รอบนี้เห็นการชั่งน้ำหนักคำตอบจาก AI อยู่บ้าง', en: 'This play showed some weighing of the AI\'s replies.' },
    high: { th: 'รอบนี้เห็นการชั่งน้ำหนักคำตอบจาก AI อย่างรอบคอบ', en: 'This play showed careful weighing of the AI\'s replies.' },
  },
  d6: {
    low: { th: 'คำตอบสามขั้นนี้ยังไม่ค่อยประกอบกันเป็นภาพรวมของเคส', en: 'Your three answers did not quite come together as one picture.' },
    mid: { th: 'คำตอบสามขั้นนี้ประกอบกันเป็นภาพรวมของเคสได้พอสมควร', en: 'Your three answers came together fairly well as one picture.' },
    high: { th: 'คำตอบสามขั้นนี้ประกอบกันเป็นภาพรวมของเคสได้ชัดเจน', en: 'Your three answers came together as one clear picture.' },
  },
  d7: {
    low: { th: 'รอบนี้ยังเห็นการใช้คำตอบจาก AI เป็นเครื่องมือไม่มากนัก', en: 'This play did not show much use of the AI\'s replies as a tool.' },
    mid: { th: 'รอบนี้เห็นการใช้คำตอบจาก AI เป็นเครื่องมืออยู่บ้าง', en: 'This play showed some use of the AI\'s replies as a tool.' },
    high: { th: 'รอบนี้เห็นการใช้คำตอบจาก AI เป็นเครื่องมืออย่างเหมาะสม', en: 'This play showed appropriate use of the AI\'s replies as a tool.' },
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
