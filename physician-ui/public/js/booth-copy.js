export const DEMO_LABEL = Object.freeze({
  th: 'คะแนนสาธิต: ไม่ใช่หน่วยกิต CME และยังไม่ผ่านการตรวจสอบความแม่นยำ',
  en: 'Demo score: not CME credit, not validated',
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

export const COPY = Object.freeze({
  tapToTry: { th: 'แตะเพื่อลอง CLICS', en: 'Tap to try CLICS' },
  intro: { th: 'อ่านเคสสั้น ๆ ตอบสามขั้น แล้วดูคะแนนสาธิต', en: 'Read a short case, answer three steps, then see a demo score' },
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
  stepOf: { th: 'ขั้นที่ {n} จาก 3', en: 'Step {n} of 3' },
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
  scoringWait: { th: 'ใช้เวลาประมาณ 30 วินาที', en: 'This takes about 30 seconds' },
  overall: { th: 'คะแนนรวม', en: 'Overall score' },
  practiseNext: { th: 'ด้านที่ควรฝึกเพิ่ม', en: 'Practise next' },
  otherDomains: { th: 'ด้านอื่น ๆ', en: 'Other domains' },
  unavailable: { th: 'รอบนี้ให้คะแนนไม่ได้', en: 'Your score is unavailable this time' },
  thanks: { th: 'ขอบคุณที่ลองใช้ CLICS', en: 'Thank you for trying CLICS' },
  stopped: { th: 'รอบนี้หยุดแล้ว', en: 'This play has stopped' },
  stoppedOffline: { th: 'การเชื่อมต่อขาดหาย', en: 'The connection was lost' },
  restarting: { th: 'กำลังกลับไปหน้าแรก', en: 'Going back to the start' },
  done: { th: 'เสร็จแล้ว', en: 'Done' },
});

export const tagText = (tag) => `Booth #${String(tag).padStart(3, '0')}`;

export const scoreText = (composite) => String(Math.round(composite));

export const fill = (bi, vars) => {
  const sub = (text) => text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));
  return { th: sub(bi.th), en: sub(bi.en) };
};
