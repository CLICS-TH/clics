// Band descriptors for the booth result card (#250): one fixed Thai and English line for each PIS-7 domain and band.
// No imports, so the harness can load this file as a data: URL like booth-copy.js.
// Bands follow the rubric's own anchors (0 -> 3 -> 5, rimpl/src/lib/prompts.js PER-DOMAIN ANCHORS). Each line says what
// this one play showed (answers, choices, replies), whatever its number of steps, never a free chat or what the physician
// is: the rubric forbids reading a score as overall competence. Thai and English make the same strength of claim.
// The Thai lines here carry booth-copy.js BREAK marks where a narrow column may end a line, between words; the words are
// as reviewed (the harness reads them with the marks taken out).

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
    low: { th: 'คำตอบรอบนี้\u200bยังเชื่อม\u200bกับเคสนี้\u200bได้ไม่ชัด', en: 'Your answers did not yet connect clearly to this case.' },
    mid: { th: 'คำตอบรอบนี้\u200bเกี่ยวกับเคส แต่ยังกว้างอยู่', en: 'Your answers related to the case but stayed general.' },
    high: { th: 'คำตอบรอบนี้\u200bตรงประเด็นหลัก\u200bของเคส\u200bอย่างเจาะจง', en: 'Your answers were specific to the case\'s main issue.' },
  },
  d2: {
    low: { th: 'คำตอบรอบนี้\u200bยังไม่ค่อย\u200bแสดงเหตุผล\u200bเบื้องหลังคำตอบ', en: 'Your answers did not yet show much of the reasoning behind them.' },
    mid: { th: 'คำตอบรอบนี้\u200bมีเหตุผล\u200bที่เข้าใจได้ แต่ยังไม่ลงลึก', en: 'Your answers gave sensible reasons but did not yet go into depth.' },
    high: { th: 'คำตอบรอบนี้\u200bให้เหตุผล\u200bได้ชัดเจน\u200bและลงลึก', en: 'Your answers gave clear reasons that went into depth.' },
  },
  d3: {
    low: { th: 'คำตอบรอบนี้\u200bใช้รายละเอียด\u200bของผู้ป่วยรายนี้\u200bไม่มากนัก', en: 'Your answers did not draw much on this patient\'s details.' },
    mid: { th: 'คำตอบรอบนี้\u200bนำรายละเอียด\u200bผู้ป่วยรายนี้\u200bบางส่วน\u200bมาใช้ตัดสินใจ', en: 'Your answers let some of this patient\'s details shape decisions.' },
    high: { th: 'คำตอบรอบนี้\u200bนำรายละเอียด\u200bผู้ป่วยรายนี้\u200bมาใช้ตัดสินใจ\u200bหลายจุด', en: 'Your answers let this patient\'s details shape several decisions.' },
  },
  d4: {
    low: { th: 'คำตอบ\u200bในขั้นต่อมา\u200bยังต่อยอด\u200bจากขั้นก่อนหน้า\u200bไม่มากนัก', en: 'Your later answers did not yet build much on earlier steps.' },
    mid: { th: 'คำตอบ\u200bในขั้นต่อมา\u200bต่อยอด\u200bจากขั้นก่อนหน้า\u200bได้บางส่วน', en: 'Your later answers partly built on earlier steps.' },
    high: { th: 'คำตอบ\u200bในขั้นต่อมา\u200bต่อยอด\u200bจากขั้นก่อนหน้า\u200bอย่างชัดเจน', en: 'Your later answers clearly built on earlier steps.' },
  },
  d5: {
    low: { th: 'รอบนี้\u200bยังเห็น\u200bการชั่งน้ำหนัก\u200bคำตอบจาก AI ไม่มากนัก', en: 'This play did not yet show much weighing of the AI\'s replies.' },
    mid: { th: 'รอบนี้เห็น\u200bการชั่งน้ำหนัก\u200bคำตอบจาก AI อยู่บ้าง', en: 'This play showed some weighing of the AI\'s replies.' },
    high: { th: 'รอบนี้เห็น\u200bการชั่งน้ำหนัก\u200bคำตอบจาก AI อย่างรอบคอบ', en: 'This play showed careful weighing of the AI\'s replies.' },
  },
  d6: {
    low: { th: 'รอบนี้\u200bยังเห็น\u200bการสรุปภาพรวม\u200bของเคส\u200bไม่มากนัก', en: 'This play did not yet show much summing-up of the case.' },
    mid: { th: 'รอบนี้เห็น\u200bการสรุปภาพรวม\u200bของเคส\u200bอยู่บ้าง', en: 'This play showed some summing-up of the case.' },
    high: { th: 'รอบนี้เห็น\u200bการสรุปภาพรวม\u200bของเคส\u200bได้ชัดเจน', en: 'This play showed a clear summing-up of the case.' },
  },
  d7: {
    low: { th: 'รอบนี้\u200bยังเห็น\u200bการใช้คำตอบจาก AI เป็นเครื่องมือ\u200bไม่มากนัก', en: 'This play did not yet show much use of the AI\'s replies as a tool.' },
    mid: { th: 'รอบนี้เห็น\u200bการใช้คำตอบจาก AI เป็นเครื่องมือ\u200bอยู่บ้าง', en: 'This play showed some use of the AI\'s replies as a tool.' },
    high: { th: 'รอบนี้เห็น\u200bการใช้คำตอบจาก AI เป็นเครื่องมือ\u200bอย่างเหมาะสม', en: 'This play showed appropriate use of the AI\'s replies as a tool.' },
  },
});

/** What each domain looks at, for the phone result page only (the kiosk card has no room): a plain reading of the
 *  rubric's domain definition (rimpl/src/lib/prompts.js DOMAINS AND WEIGHTS), never a claim about the physician. The
 *  d5-d7 rows say through their tag (COPY.littleRoom) that a booth play gives little room for them: no step lets a player
 *  question or prompt the AI or write a reflection, and a typed answer scores as the tier it is sorted into (ADR 0009).
 *  Their lines here once said it again; the panel read the repeat (round 7), so it went. */
export const MEASURES = Object.freeze({
  d1: { th: 'ดูว่า\u200bคำตอบของคุณ\u200bเจาะจง\u200bกับเคสนี้ และตรงกับ\u200bจุดตัดสินใจสำคัญ\u200bของเคส\u200bหรือไม่', en: 'Whether your answers are specific to this case and aim at its key decisions.' },
  d2: { th: 'ดูว่า\u200bคุณเลือก\u200bและเรียงลำดับ\u200bความเป็นไปได้\u200bพร้อมเหตุผล ชั่งประโยชน์\u200bกับความเสี่ยง และปรับความคิด\u200bเมื่อได้ข้อมูลใหม่\u200bหรือไม่', en: 'Whether you commit to ranked possibilities with reasons, weigh benefit against risk, and update when new facts arrive.' },
  d3: { th: 'ดูว่าอายุ โรคประจำตัว และบริบท\u200bของผู้ป่วยรายนี้ เปลี่ยน\u200bการตัดสินใจ\u200bของคุณ\u200bหรือไม่', en: 'Whether this patient\'s age, other conditions and setting change your decisions.' },
  d4: { th: 'ดูว่า\u200bแต่ละขั้น\u200bต่อยอด\u200bจากขั้นก่อนหน้า\u200bหรือไม่ ทั้งการซักต่อ การจำกัด\u200bความเป็นไปได้\u200bให้แคบลง และการทดสอบสมมติฐาน', en: 'Whether each step builds on the one before: probing further, narrowing the possibilities and testing them.' },
  d5: { th: 'ดูว่าคุณ\u200bตั้งคำถาม\u200bกับคำตอบของ AI ขอหลักฐาน หรือระบุ\u200bความไม่แน่นอน\u200bหรือไม่', en: 'Whether you question the AI\'s replies, ask for evidence or note uncertainty.' },
  d6: { th: 'ดูว่าคุณ\u200bสรุป\u200bสิ่งที่ได้\u200bจากเคสนี้\u200bด้วยคำพูด\u200bของตัวเอง\u200bหรือไม่', en: 'Whether you sum up what you took from this case in your own words.' },
  d7: { th: 'ดูว่าคุณ\u200bสั่งงาน AI ได้ชัดเจน ตรวจสอบ\u200bคำตอบของ AI และยังเป็น\u200bผู้ตัดสิน\u200bแผนการดูแลเอง\u200bหรือไม่', en: 'Whether you prompt the AI clearly, check its replies and keep the care plan your own decision.' },
});

/** The line above the domains on the result page: how to read a 0-5 value (the rubric's SCALE, 0 = no evidence).
 *  Four lines ("\n"), so "0 คือ…" and "5 คือ…" each start a line, the number held to its clause by a no-break space. */
export const SCALE_NOTE = Object.freeze({
  th: 'แต่ละด้าน\u200bมีคะแนน 0–5 ตามสิ่งที่เห็น\u200bจากการเล่น\u200bรอบนี้\n0\u00a0คือ\u200bยังไม่เห็น\u200bหลักฐาน\n5\u00a0คือ\u200bเห็นชัดเจน\u200bและลึกซึ้ง\nคะแนนนี้\u200bไม่ใช่\u200bการประเมิน\u200bความสามารถของคุณ',
  en: 'Each domain is scored 0–5 from what this play showed:\n0\u00a0is no evidence yet,\n5\u00a0is clear and deep.\nIt does not rate your ability.',
});

/** The AI safety review of MEASURES, SCALE_NOTE and the two lines that frame them on the result page (COPY.practiseFrom,
 *  COPY.littleRoom), recorded like SAFETY_REVIEW (ADR 0005). The latest review comes first in findings. */
export const MEASURES_REVIEW = Object.freeze({
  model: 'claude-opus-5-5',
  date: '2026-11-23',
  findings: '2026-11-23: a fresh review of every MEASURES, BAND_LINES and SCALE_NOTE line and of COPY.littleRoom and COPY.practiseFrom as they ship, in Thai and English. A script confirmed every Thai and English line matches the 2026-11-19 wording once the break marks (U+200B, and in SCALE_NOTE line breaks and no-break spaces) are taken out. The d5-d7 caveat moved whole out of their MEASURES lines into COPY.littleRoom, shown once under each of d5-d7, so every d5-d7 row still says its score says little. Fixed: practiseFrom said the four were the domains "this booth can show", implying d5-d7 go unscored when all seven are scored and drawn; it now says the booth sees more of these four (Thai "เห็นได้มากกว่า"), a comparative that matches COPY.littleRoom. 2026-11-19: a fresh review of the seven MEASURES pairs and SCALE_NOTE against the PIS-7 rubric (prompts.js DOMAINS AND WEIGHTS, SCALE, PER-DOMAIN ANCHORS) and ADR 0009. None makes a clinical claim, judges the physician or demeans; each follows its domain definition, and SCALE_NOTE matches the 0-5 scale with 0 as no evidence and says a score does not rate ability. Fixed: d1 named the player\'s questions, which a booth play has none of; d4 Thai lacked หรือไม่ and so claimed more than the English; the d5-d7 caveat said tapping alone shows little, implying a typed answer would show more, when every score is read from the tier path (ADR 0009), so it now says a booth play gives little room for these domains; SCALE_NOTE and d2, d5 Thai wording.',
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

/** The domains Practise next may name. A booth play gives d5-d7 little room (MEASURES), so a low score there says
 *  little about what to practise. */
export const PRACTISE_KEYS = Object.freeze(['d1', 'd2', 'd3', 'd4']);

/**
 * The two domains under Practise next: the weakest of PRACTISE_KEYS, a tie in the rubric's order.
 * @param {Record<string, number>} domains
 */
export const practiseNext = (domains) => weakestFirst(domains).filter((key) => PRACTISE_KEYS.includes(key)).slice(0, 2);
