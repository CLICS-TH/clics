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

/** Where a Thai line may end inside a phrase (between two spaces): a zero-width space the copy places between two
 *  words, so a phrase too wide for its column breaks there and never inside a word or a compound ("ขั้นก่อน|หน้า",
 *  "ด้วยคำ|พูด"), which the browser's own Thai breaking does. booth-dom.js draws each mark as a <wbr> between pieces
 *  that never break, so the page's text is the copy's wording with the marks taken out (`unbroken`). A phrase that opens
 *  with และ or หรือ keeps it on the next word's line: the line breaks before it, at the space. */
export const BREAK = '\u200b';
export const unbroken = (text) => text.replaceAll(BREAK, '');

/** The Thai domain names as DOMAINS writes them, with BREAK at each place a narrow column may end a line. A table of
 *  its own, like DOMAIN_SHORT, so DOMAINS stays the rubric's wording; the harness checks each is its name unbroken. */
export const DOMAIN_BREAKS = Object.freeze({
  d1: 'ปัญญา\u200bในการ\u200bตั้งคำถาม\u200bคลินิก',
  d2: 'ความลึก\u200bของ\u200bการให้เหตุผล',
  d3: 'การบูรณาการ\u200bบริบท',
  d4: 'การสืบค้น\u200bแบบต่อยอด',
  d5: 'การประเมิน\u200bอย่างมีวิจารณญาณ',
  d6: 'การสังเคราะห์\u200bเชิงสะท้อนคิด',
  d7: 'ความรู้เท่าทัน AI และทักษะการพรอมต์',
});

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
  tapToStart: { th: 'แตะเพื่อลองตอบเคส', en: 'Tap to try a case' },
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
  scoring: { th: 'กำลังให้คะแนน 7 ด้านตามเกณฑ์ PIS-7', en: 'Scoring 7 domains on the PIS-7 rubric' },
  stillWorking: { th: 'ยังทำงานอยู่ รอสักครู่', en: 'Still working, please wait' },
  startOver: { th: 'เริ่มใหม่', en: 'Start over' },
  readCase: { th: 'อ่านเคสอีกครั้ง', en: 'Read the case again' },
  caseTitle: { th: 'เคสที่คุณกำลังเล่น', en: 'The case you are playing' },
  closeCase: { th: 'ปิด', en: 'Close' },
  leaveTitle: { th: 'ออกจากรอบนี้ แล้วเริ่มใหม่ไหม', en: 'Leave this play and start over?' },
  leaveLine: { th: 'รอบนี้จะไม่มีคะแนน', en: 'This play will not get a score.' },
  leave: { th: 'ออกจากรอบนี้', en: 'Leave' },
  keepPlaying: { th: 'เล่นต่อ', en: 'Keep playing' },
  overall: { th: 'คะแนนรวม', en: 'Overall score' },
  // Under a five-step play's number, which is the fixed 0-100 rescale of its stored score (ADR 0013).
  // A no-break space keeps "คะแนนเต็ม 100" on one line where the note wraps (the phone page).
  displayScale: { th: 'คะแนนสาธิต ปรับสเกลเป็นคะแนนเต็ม\u00a0100', en: 'Demo score, rescaled to 0–100' },
  practiseNext: { th: 'ด้านที่ควรฝึกเพิ่ม', en: 'Practise next' },
  // Practise next draws on d1-d4 alone, and d5-d7 rows carry the first clause of their reviewed MEASURES line. The
  // radar sets those four names in bold ink and the other three quieter (booth-radar.css), which the brackets point at.
  // All seven are scored and drawn; the line says only that the booth sees more of these four (MEASURES_REVIEW). It sits
  // on the kiosk card, where a Thai line longer than this one wraps and pushes the leaderboard button below the fold.
  practiseFrom: { th: 'จาก 4 ด้านที่บูทเห็นได้มากกว่า (ตัวเข้มบนกราฟ)', en: 'From the 4 domains this booth sees more of (bold on the chart)' },
  // The d5-d7 caveat as reviewed (booth-bands.js MEASURES_REVIEW), moved whole out of their MEASURES lines.
  littleRoom: { th: 'การเล่น\u200bที่บูท\u200bมีโอกาส\u200bแสดงด้านนี้น้อย คะแนนด้านนี้\u200bจึงบอกได้ไม่มาก', en: 'A booth play gives little room for this, so this score says little' },
  otherDomains: { th: 'ด้านอื่น ๆ', en: 'Other domains' },
  scrollMore: { th: 'เลื่อนดูต่อ', en: 'Scroll for more' },
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
  typedOwn: { th: 'คุณพิมพ์คำตอบเอง', en: 'You typed your own answer' },
  stepTiers: { th: 'คำตอบของคุณแต่ละขั้น', en: 'Your answer at each step' },
  tryClics: { th: 'ลองใช้ CLICS', en: 'Try CLICS' },
});

/** @param {'th' | 'en'} [lang] */
export const tagText = (tag, lang = 'en') => `${lang === 'th' ? 'ผู้เล่น' : 'Player'} #${String(tag).padStart(3, '0')}`;

export const scoreText = (composite) => String(Math.round(composite));

/** A domain score is 0-5: whole from a three-step case's table, one decimal from a five-step case's fitted table
 *  (spec #370). */
export const isDomainScore = (v) => Number.isFinite(v) && v >= 0 && v <= 5 && Math.round(v * 10) / 10 === v;

// A five-step case scores from a fitted table (spec #370).
const FITTED_STEPS = 5;
/** A five-step play shows each domain to one decimal ("4.0 / 5"), so its seven rows read alike; any other play as sent. */
export const domainText = (value, steps) => (steps === FITTED_STEPS ? value.toFixed(1) : String(value));
/** A five-step play's number is the fixed 0-100 rescale of its stored score (ADR 0013, backend display-score.js
 *  DISPLAY_SCALE.steps); any other play shows its score as stored. */
export const isRescaled = (steps) => steps === FITTED_STEPS;

export const fill = (bi, vars) => {
  const sub = (text) => text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));
  return { th: sub(bi.th), en: sub(bi.en) };
};

const freezeDeep = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') freezeDeep(v); }); return Object.freeze(o); };

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
    th: 'ไม่เก็บชื่อ หมายเลขผู้เล่น หรือเวลาที่เล่น คำตอบใช้ปรับปรุง CLICS เท่านั้น อย่าพิมพ์ชื่อหรือข้อมูลคนไข้ในช่องความเห็น',
    en: 'We keep no name, player number or time of play. Answers are used only to improve CLICS. Please do not type names or patient details in the comment.',
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
