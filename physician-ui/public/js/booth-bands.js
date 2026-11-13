// Band descriptors for the booth result card (#250): one fixed Thai and English line for each PIS-7 domain and band.
// No imports, so the harness can load this file as a data: URL like booth-copy.js.
// Bands follow the rubric's own anchors (0 -> 3 -> 5, rimpl/src/lib/prompts.js PER-DOMAIN ANCHORS). Each line says what
// this one play showed (answers, choices, replies), whatever its number of steps, never a free chat or what the physician
// is: the rubric forbids reading a score as overall competence. Thai and English make the same strength of claim.

/** Recorded like a case's admission.safety_review (ADR 0005): fresh AI reviewers read all 21 pairs; this record covers the text that ships. */
export const SAFETY_REVIEW = Object.freeze({
  model: 'claude-opus-5-5',
  date: '2026-11-11',
  findings: 'A fresh review (#380) of the six pairs reworded for five-step plays (d1 and d4, low, mid and high), with the other 15 read for any step count. None makes a clinical claim, judges the physician or shames; Thai and English make the same claim at the same strength; d1 still follows its anchor (relevant, then specific to the case) and d4 its anchor (building on what came before), leaving out the first answer and holding for three or five steps; no other pair assumes a step count. Nothing fixed. Before it, on 2026-11-03: three fresh reviews of the 21 pairs. No clinical claims, no judgment of the physician, nothing demeaning. Fixed: d2 drifted from depth of reasoning, d4 wrong for the first answer, d6 described answer coherence where the scorer reads a summing-up, d3 high counted details, Thai stronger than English (d1 mid), d7 low English harsher than the Thai, and the low-band English lines lacked the Thai yet (d2, d4, d5, d6, d7). Open, not changed here (issue 334): d3 low and mid still count details; d5, d6 and d7 mid and high describe engagement with the AI a tap-only play may not show; the domain names above the lines and the Practise next heading.',
});

/** 0-2 is the low band, 3 the middle, 4-5 the high. A five-step play's fitted score (one decimal) takes the band of its
 *  rounded value, so 2.6 is middle, not high. */
export const bandOf = (value) => {
  const whole = Math.round(value);
  return whole <= 2 ? 'low' : whole === 3 ? 'mid' : 'high';
};

export const BAND_LINES = Object.freeze({
  d1: {
    low: { th: 'คำตอบรอบนี้ยังเชื่อมกับเคสนี้ได้ไม่ชัด', en: 'Your answers did not yet connect clearly to this case.' },
    mid: { th: 'คำตอบรอบนี้เกี่ยวกับเคส แต่ยังกว้างอยู่', en: 'Your answers related to the case but stayed general.' },
    high: { th: 'คำตอบรอบนี้ตรงประเด็นหลักของเคสอย่างเจาะจง', en: 'Your answers were specific to the case\'s main issue.' },
  },
  d2: {
    low: { th: 'คำตอบรอบนี้ยังไม่ค่อยแสดงเหตุผลเบื้องหลังคำตอบ', en: 'Your answers did not yet show much of the reasoning behind them.' },
    mid: { th: 'คำตอบรอบนี้มีเหตุผลที่เข้าใจได้ แต่ยังไม่ลงลึก', en: 'Your answers gave sensible reasons but did not yet go into depth.' },
    high: { th: 'คำตอบรอบนี้ให้เหตุผลได้ชัดเจนและลงลึก', en: 'Your answers gave clear reasons that went into depth.' },
  },
  d3: {
    low: { th: 'คำตอบรอบนี้ใช้รายละเอียดของผู้ป่วยรายนี้ไม่มากนัก', en: 'Your answers did not draw much on this patient\'s details.' },
    mid: { th: 'คำตอบรอบนี้นำรายละเอียดผู้ป่วยรายนี้บางส่วนมาใช้ตัดสินใจ', en: 'Your answers let some of this patient\'s details shape decisions.' },
    high: { th: 'คำตอบรอบนี้นำรายละเอียดผู้ป่วยรายนี้มาใช้ตัดสินใจหลายจุด', en: 'Your answers let this patient\'s details shape several decisions.' },
  },
  d4: {
    low: { th: 'คำตอบในขั้นต่อมายังต่อยอดจากขั้นก่อนหน้าไม่มากนัก', en: 'Your later answers did not yet build much on earlier steps.' },
    mid: { th: 'คำตอบในขั้นต่อมาต่อยอดจากขั้นก่อนหน้าได้บางส่วน', en: 'Your later answers partly built on earlier steps.' },
    high: { th: 'คำตอบในขั้นต่อมาต่อยอดจากขั้นก่อนหน้าอย่างชัดเจน', en: 'Your later answers clearly built on earlier steps.' },
  },
  d5: {
    low: { th: 'รอบนี้ยังเห็นการชั่งน้ำหนักคำตอบจาก AI ไม่มากนัก', en: 'This play did not yet show much weighing of the AI\'s replies.' },
    mid: { th: 'รอบนี้เห็นการชั่งน้ำหนักคำตอบจาก AI อยู่บ้าง', en: 'This play showed some weighing of the AI\'s replies.' },
    high: { th: 'รอบนี้เห็นการชั่งน้ำหนักคำตอบจาก AI อย่างรอบคอบ', en: 'This play showed careful weighing of the AI\'s replies.' },
  },
  d6: {
    low: { th: 'รอบนี้ยังเห็นการสรุปภาพรวมของเคสไม่มากนัก', en: 'This play did not yet show much summing-up of the case.' },
    mid: { th: 'รอบนี้เห็นการสรุปภาพรวมของเคสอยู่บ้าง', en: 'This play showed some summing-up of the case.' },
    high: { th: 'รอบนี้เห็นการสรุปภาพรวมของเคสได้ชัดเจน', en: 'This play showed a clear summing-up of the case.' },
  },
  d7: {
    low: { th: 'รอบนี้ยังเห็นการใช้คำตอบจาก AI เป็นเครื่องมือไม่มากนัก', en: 'This play did not yet show much use of the AI\'s replies as a tool.' },
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
