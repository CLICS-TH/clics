/*
 * Labels for the reason a physician gave. The keys MIRROR REPORT_REASONS in backend/src/lib/schemas.js
 * (and the picker in physician-ui/public/js/ple-chat.js); __tests__/backend-mirrors.test.ts fails if
 * the lists drift. An unrecognised key is printed raw rather than hidden — a reason the API accepts
 * and this page cannot name is still a safety report someone must read.
 */
export const REPORT_REASON: Record<string, { th: string; en: string }> = {
  wrong_fact: { th: 'ข้อมูลทางการแพทย์ไม่ถูกต้อง', en: 'Incorrect medical fact' },
  unsafe_advice: { th: 'คำแนะนำที่อาจไม่ปลอดภัยต่อผู้ป่วย', en: 'Advice that could be unsafe for a patient' },
  fabricated_reference: { th: 'อ้างอิงที่ไม่มีอยู่จริงหรือไม่ตรงกับเนื้อหา', en: 'A reference that does not exist or does not match' },
  wrong_language: { th: 'ภาษาผิดหรือสื่อความหมายคลาดเคลื่อน', en: 'Wrong or misleading language' },
  other: { th: 'อื่น ๆ', en: 'Something else' },
};

/*
 * The integrity-flag signal the report endpoint writes. Mirrors REPORTED_REPLY_SIGNAL in
 * backend/src/services/integrity-scan.js; app/admin/integrity/page.tsx keys its label table on it.
 * It lives here, not in the page, because a Next.js page module may export nothing but the page.
 */
export const REPORTED_REPLY_SIGNAL = 'S1_PHYSICIAN_REPORTED_REPLY';
