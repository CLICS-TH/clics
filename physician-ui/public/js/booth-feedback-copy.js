const freezeDeep = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') freezeDeep(v); }); return Object.freeze(o); };

// No imports, like booth-copy.js, so the harness and the kiosk can load it alone.
/** The anonymous feedback form (booth-feedback.js, spec 2026-11-24, form version fb-1): Thai first, English second.
 *  Every question's text, answers and ends are the spec's question table; `scale` labels the 1-5 sliders. */
export const FEEDBACK_COPY = freezeDeep({
  title: { th: 'ช่วยเราปรับปรุง CLICS', en: 'Help us improve CLICS' },
  progress: { th: 'ตอบแล้ว {n} จาก 7 ข้อ · ไม่ระบุตัวตน', en: 'Answered {n} of 7 · anonymous' },
  drag: { th: 'ลากเพื่อตอบ', en: 'Drag to answer' },
  unanswered: { th: 'ยังไม่ได้ตอบ', en: 'Not answered yet' },
  optional: { th: '(ไม่บังคับ)', en: '(optional)' },
  pickAny: { th: 'เลือกได้หลายข้อ', en: 'pick any' },
  privacy: {
    th: 'ไม่เก็บชื่อ หมายเลขผู้เล่น หรือเวลาที่เล่น เก็บเพียงวันที่ส่ง คำตอบใช้ปรับปรุง CLICS เท่านั้น อย่าพิมพ์ชื่อหรือข้อมูลคนไข้ในช่องความเห็น',
    en: 'We keep no name, player number or time of play, only the date you send this. Answers are used only to improve CLICS. Please do not type names or patient details in the comment.',
  },
  submit: { th: 'ส่งแบบประเมิน', en: 'Submit' },
  busy: { th: 'กำลังส่ง…', en: 'Sending…' },
  thanks: { th: 'ขอบคุณ', en: 'Thank you' },
  thanksLine: { th: 'คำตอบของคุณช่วยให้ CLICS ดีขึ้น', en: 'Your answers help CLICS get better.' },
  closed: { th: 'บูทปิดรับแบบประเมินแล้ว ขอบคุณที่ร่วมเล่น', en: 'The booth has stopped taking feedback. Thank you for playing.' },
  failed: { th: 'ส่งไม่สำเร็จ ลองอีกครั้ง', en: 'Could not send. Please try again.' },
  commentFailed: { th: 'ตรวจความเห็นของคุณไม่สำเร็จ ลองอีกครั้ง หรือส่งโดยไม่มีความเห็น', en: 'We could not check your comment. Try again, or send without it.' },
  retry: { th: 'ลองอีกครั้ง', en: 'Try again' },
  sendWithout: { th: 'ส่งโดยไม่มีความเห็น', en: 'Send without the comment' },
  questions: {
    role: { th: 'คุณคือ', en: 'You are' },
    mood: { th: 'ระหว่างเล่น คุณรู้สึกอย่างไร', en: 'How did you feel while playing?' },
    felt_like: { th: 'เล่นแล้วรู้สึกเหมือน…', en: 'It felt like…' },
    easy: { th: 'เล่นง่าย เข้าใจได้ทันที', en: 'Easy to play' },
    real: { th: 'เคสสมจริง เหมือนเจอในงานจริง', en: 'The case felt real' },
    fair: { th: 'คะแนนและคำอธิบายสมเหตุสมผล', en: 'The score and feedback were fair' },
    use: { th: 'อยากใช้ CLICS เก็บหน่วยกิต CME แทนการนั่งฟังบรรยาย', en: "I'd use CLICS for CME credit instead of lectures" },
    comment: { th: 'อยากบอกอะไรเราเพิ่มไหม', en: 'Anything else?' },
  },
  roles: {
    physician: { th: 'แพทย์', en: 'Physician' },
    resident: { th: 'แพทย์ประจำบ้าน', en: 'Resident' },
    student: { th: 'นักศึกษาแพทย์', en: 'Medical student' },
    other: { th: 'อื่น ๆ', en: 'Other' },
  },
  moods: {
    stressed: { th: 'เครียด', en: 'Stressed' },
    confused: { th: 'งง', en: 'Confused' },
    neutral: { th: 'เฉย ๆ', en: 'Neutral' },
    enjoyed: { th: 'สนุก', en: 'Enjoyed it' },
    excited: { th: 'ตื่นเต้น', en: 'Excited' },
  },
  feltLike: {
    exam: { th: 'ทำข้อสอบ', en: 'Taking an exam' },
    real_patient: { th: 'วินิจฉัยคนไข้จริง', en: 'Diagnosing a real patient' },
    ward_round: { th: 'ราวด์วอร์ดกับอาจารย์', en: 'A ward round with a teacher' },
    game: { th: 'เล่นเกม', en: 'Playing a game' },
    textbook: { th: 'อ่านตำรา', en: 'Reading a textbook' },
    other: { th: 'อย่างอื่น', en: 'Something else' },
  },
  /** The labels under a 1-5 slider, value 1 first. */
  scale: [
    { th: 'น้อยมาก', en: 'Very little' },
    { th: 'น้อย', en: 'Little' },
    { th: 'ปานกลาง', en: 'Moderate' },
    { th: 'มาก', en: 'Much' },
    { th: 'มากที่สุด', en: 'Very much' },
  ],
  /** The two ends of each slider, low end first. */
  ends: {
    easy: [{ th: 'ยากมาก', en: 'Very hard' }, { th: 'ง่ายมาก', en: 'Very easy' }],
    real: [{ th: 'ไม่เลย', en: 'Not at all' }, { th: 'มาก', en: 'Very' }],
    fair: [{ th: 'ไม่เลย', en: 'Not at all' }, { th: 'มาก', en: 'Very' }],
    use: [{ th: '0 ไม่เลย', en: '0 Not at all' }, { th: '10 แน่นอน', en: '10 Definitely' }],
  },
});
