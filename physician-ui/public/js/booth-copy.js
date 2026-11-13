export const DEMO_LABEL = Object.freeze({
  th: 'คะแนนสาธิต: ไม่ใช่หน่วยกิต CME',
  en: 'Demo score: not CME credit',
});

/** The kiosk's language looks (#377): the primary language, drawn first and larger, and whether the other one shows
 *  under it. The backend's LOOK_LANGUAGE (booth-dialogue.js) keys the same four; the harness checks they match. */
export const LOOKS = Object.freeze({
  'th+en': Object.freeze({ primary: 'th', both: true }),
  th: Object.freeze({ primary: 'th', both: false }),
  'en+th': Object.freeze({ primary: 'en', both: true }),
  en: Object.freeze({ primary: 'en', both: false }),
});
export const DEFAULT_LOOK = 'th+en';
export const lookOf = (primary, both) => Object.keys(LOOKS).find((k) => LOOKS[k].primary === primary && LOOKS[k].both === both);

/** The look control's own words. Each language is named in itself whatever the look, so a visitor finds theirs;
 *  "both" shows in the primary language only. */
export const LOOK_COPY = Object.freeze({
  group: { th: 'ภาษา', en: 'Language' },
  th: 'ไทย',
  en: 'English',
  both: { th: 'สองภาษา', en: 'Both' },
});

export const DOMAINS = Object.freeze([
  { key: 'd1', th: 'ปัญญาในการตั้งคำถามคลินิก', en: 'Clinical Question Intelligence' },
  { key: 'd2', th: 'ความลึกของการให้เหตุผล', en: 'Reasoning Depth' },
  { key: 'd3', th: 'การบูรณาการบริบท', en: 'Contextual Integration' },
  { key: 'd4', th: 'การสืบค้นแบบต่อยอด', en: 'Iterative Inquiry' },
  { key: 'd5', th: 'การประเมินอย่างมีวิจารณญาณ', en: 'Critical Appraisal' },
  { key: 'd6', th: 'การสังเคราะห์เชิงสะท้อนคิด', en: 'Reflective Synthesis' },
  { key: 'd7', th: 'ความรู้เท่าทัน AI และทักษะการพรอมต์', en: 'AI Literacy & Prompt Skill' },
]);

/** The radar's axis names. A table of its own: the dashboard's mirror test reads DOMAINS entries as written. */
export const DOMAIN_SHORT = Object.freeze({
  d1: { th: 'ตั้งคำถาม', en: 'Question' },
  d2: { th: 'เหตุผล', en: 'Reasoning' },
  d3: { th: 'บริบท', en: 'Context' },
  d4: { th: 'ต่อยอด', en: 'Iteration' },
  d5: { th: 'ประเมิน', en: 'Appraisal' },
  d6: { th: 'สังเคราะห์', en: 'Synthesis' },
  d7: { th: 'ใช้ AI', en: 'AI use' },
});

/** An answer's tier, best first, with the letter the result link's tier path spells it with (backend
 *  booth-cases/tree-schema.js TIERS). "Weaker" claims no safety: a typed answer the AI sorts as unsafe or unclear
 *  also lands there, and only the bank's options were reviewed safe (ADR 0005). */
export const TIERS = Object.freeze({
  best: Object.freeze({ letter: 'B', label: { th: 'ดีที่สุด', en: 'Best' } }),
  reasonable: Object.freeze({ letter: 'R', label: { th: 'สมเหตุสมผล', en: 'Reasonable' } }),
  weaker: Object.freeze({ letter: 'W', label: { th: 'ยังด้อยกว่า', en: 'Weaker' } }),
});

/** The AI reply's fields in the order the kiosk draws them, each under its reviewed heading. */
export const REPLY_FIELDS = Object.freeze([
  { key: 'strength', th: 'จุดแข็ง', en: 'Strength' },
  { key: 'weigh', th: 'ข้อควรคิด', en: 'Worth weighing' },
  { key: 'safety', th: 'ความปลอดภัย', en: 'Safety' },
]);

export const COPY = Object.freeze({
  tapToStart: { th: 'แตะเพื่อเริ่ม', en: 'Tap to start' },
  intro: { th: 'อ่านเคสสั้น ๆ ตอบห้าขั้น แล้วดูคะแนนสาธิต', en: 'Read a short case, answer five steps, then see a demo score' },
  checking: { th: 'กำลังเชื่อมต่อ', en: 'Connecting' },
  closed: { th: 'ขณะนี้บูทปิดอยู่', en: 'The booth is closed right now' },
  offline: { th: 'ขณะนี้เชื่อมต่อ CLICS ไม่ได้', en: 'CLICS is offline right now' },
  stillThere: { th: 'ยังอยู่ไหม', en: 'Still there?' },
  stillThereCount: { th: 'หน้าจอจะกลับไปหน้าแรกใน {n} วินาที', en: 'The screen goes back to the start in {n} seconds' },
  keepGoing: { th: 'ทำต่อ', en: 'Keep going' },
  drawing: { th: 'กำลังสุ่มเคส', en: 'Drawing a case' },
  startCase: { th: 'เริ่มเคสนี้', en: 'Start this case' },
  reroll: { th: 'สุ่มเคสใหม่', en: 'Draw another case' },
  starting: { th: 'กำลังเริ่ม', en: 'Starting' },
  begin: { th: 'เริ่มตอบ', en: 'Start answering' },
  stepOf: { th: 'ขั้นที่ {n} จาก {total}', en: 'Step {n} of {total}' },
  typeOwn: { th: 'พิมพ์คำตอบเอง', en: 'Type my own' },
  enterHint: { th: 'กด Enter เพื่อขึ้นบรรทัดใหม่', en: 'Enter starts a new line' },
  send: { th: 'ส่งคำตอบ', en: 'Send my answer' },
  backToChoices: { th: 'กลับไปที่ตัวเลือก', en: 'Back to the choices' },
  yourAnswer: { th: 'คำตอบของคุณ', en: 'Your answer' },
  replying: { th: 'AI กำลังตอบ', en: 'The AI is replying' },
  noReply: { th: 'ขั้นนี้ไม่มีคำตอบจาก AI ทำต่อได้เลย', en: 'No AI reply for this step. You can go on.' },
  next: { th: 'ขั้นต่อไป', en: 'Next step' },
  seeScore: { th: 'ดูคะแนน', en: 'See my score' },
  scoring: { th: 'กำลังให้คะแนนตามเกณฑ์ PIS-7', en: 'Scoring with the PIS-7 rubric' },
  stillWorking: { th: 'ยังทำงานอยู่ รอสักครู่', en: 'Still working, please wait' },
  startOver: { th: 'เริ่มใหม่', en: 'Start over' },
  leaveTitle: { th: 'ออกจากรอบนี้ แล้วเริ่มใหม่ไหม', en: 'Leave this play and start over?' },
  leaveLine: { th: 'รอบนี้จะไม่มีคะแนน', en: 'This play will not get a score.' },
  leave: { th: 'ออกจากรอบนี้', en: 'Leave' },
  keepPlaying: { th: 'เล่นต่อ', en: 'Keep playing' },
  overall: { th: 'คะแนนรวม', en: 'Overall score' },
  practiseNext: { th: 'ด้านที่ควรฝึกเพิ่ม', en: 'Practise next' },
  otherDomains: { th: 'ด้านอื่น ๆ', en: 'Other domains' },
  unavailable: { th: 'รอบนี้ให้คะแนนไม่ได้', en: 'Your score is unavailable this time' },
  thanks: { th: 'ขอบคุณที่ลองใช้ CLICS', en: 'Thank you for trying CLICS' },
  stopped: { th: 'รอบนี้หยุดแล้ว', en: 'This play has stopped' },
  stoppedOffline: { th: 'การเชื่อมต่อขาดหาย', en: 'The connection was lost' },
  restarting: { th: 'กำลังกลับไปหน้าแรก', en: 'Going back to the start' },
  done: { th: 'เสร็จแล้ว', en: 'Done' },
  keepResult: { th: 'สแกนเพื่อเก็บผลของคุณ', en: 'Scan to keep your result' },
  resultTitle: { th: 'ผลการเล่นที่บูท CLICS', en: 'Your CLICS booth result' },
  resultCase: { th: 'เคสที่คุณเล่น', en: 'The case you played' },
  resultMissing: { th: 'ลิงก์นี้ ไม่มีผลการเล่นที่อ่านได้', en: 'This link does not hold a readable booth result' },
  resultMissingHint: { th: 'สแกน QR บนหน้าจอบูทอีกครั้ง หรือเปิดลิงก์เดิม ให้ครบทั้งลิงก์', en: 'Scan the QR on the booth screen again, or open the whole saved link' },
  radar: { th: 'คะแนนรายด้าน', en: 'Score by domain' },
  seeAnswers: { th: 'ดูเฉลย', en: 'See the answers' },
  closeAnswers: { th: 'ปิดเฉลย', en: 'Close the answers' },
  answersTitle: { th: 'เฉลยทีละขั้น', en: 'The answers, step by step' },
  stepN: { th: 'ขั้นที่ {n}', en: 'Step {n}' },
  bestOffered: { th: 'ตัวเลือกที่ดีที่สุดในขั้นนี้', en: 'Best option offered' },
  stepTiers: { th: 'คำตอบของคุณแต่ละขั้น', en: 'Your answer at each step' },
  tryClics: { th: 'ลองใช้ CLICS', en: 'Try CLICS' },
});

/** @param {'th' | 'en'} [lang] */
export const tagText = (tag, lang = 'en') => `${lang === 'th' ? 'บูธ' : 'Booth'} #${String(tag).padStart(3, '0')}`;

export const scoreText = (composite) => String(Math.round(composite));

/** A domain score is 0-5: whole from a three-step case's table, one decimal from a five-step case's fitted table
 *  (spec #370). */
export const isDomainScore = (v) => Number.isFinite(v) && v >= 0 && v <= 5 && Math.round(v * 10) / 10 === v;

// A five-step case scores from a fitted table (spec #370).
const FITTED_STEPS = 5;
/** A five-step play shows each domain to one decimal ("4.0 / 5"), so its seven rows read alike; any other play as sent. */
export const domainText = (value, steps) => (steps === FITTED_STEPS ? value.toFixed(1) : String(value));

export const fill = (bi, vars) => {
  const sub = (text) => text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));
  return { th: sub(bi.th), en: sub(bi.en) };
};
