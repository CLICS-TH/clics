'use strict';

// The CLINICAL CONTINUATION ALLOWLIST (#224, owner ruling 2026-10-29: "Mask any word after a name").
// A Thai word directly after (or before) a masked Thai given name is taken for the surname UNLESS all of it
// splits into words from this list plus the small hand lists in pii-filter.js (isClinicalRun). Anything not
// covered is masked — over-masking "นายสมชาย แข็งแรงดี" is the accepted price of never sending a surname.
//
// HAND-REVIEWED and kept SHORT on purpose: every entry is a word that can open or continue a clinical
// statement after a patient's name. Before adding one, check that it is not a surname component
// (TH_SURNAME_MORPHEMES), a given name (TH_GIVEN_NAMES) or a word Thai surnames are built from (สุข, ทอง,
// ภัย, ยืน, ยาว, มาก, ถาวร…): a surname made wholly of list words passes in clear. A compound whose part is a
// surname component is listed whole (ไข้หวัดใหญ่, ตัวเหลือง, ดีขึ้น), never the part.
// tests/pii-leak-adversarial.test.js checks no entry is a surname component or a given name.
const TH_CLINICAL_CONTINUATIONS = Object.freeze([
  // symptoms and signs
  'แพ้', 'ชัก', 'ชักเกร็ง', 'หมด', 'หมดสติ', 'หายใจ', 'เวียน', 'แน่น', 'ซึม', 'ตัว', 'หก', 'ไอ', 'ไข้', 'หวัด',
  'ไข้หวัด', 'ไข้หวัดใหญ่', 'ปวด', 'เจ็บ', 'บวม', 'ถ่าย', 'อาเจียน', 'คลื่นไส้', 'ท้อง', 'เหนื่อย', 'หอบ', 'ซีด',
  'อ่อนเพลีย', 'อ่อนแรง', 'จุก', 'เบื่อ', 'อาหาร', 'ล้ม', 'หน้ามืด', 'ใจสั่น', 'ชา', 'คัน', 'ผื่น', 'ไข้สูง',
  'หนาวสั่น', 'เสมหะ', 'ปัสสาวะ', 'อุจจาระ', 'เลือด', 'น้ำหนัก', 'ผอม', 'นอนไม่หลับ', 'สับสน', 'กระสับกระส่าย',
  'ตาเหลือง', 'ตัวเหลือง', 'ตามัว', 'หูอื้อ', 'กลืน', 'สำลัก', 'แสบ', 'ขัด', 'ร้อน', 'หนาว', 'เกร็ง', 'กระตุก',
  'มึน', 'งง', 'บ่น', 'ตัวแดง', 'แดงทั้งตัว', 'ผื่นแดง', 'ดีขึ้น', 'แย่ลง', 'คงที่', 'ลง', 'ขึ้น',
  // body
  'ศีรษะ', 'หัว', 'หน้าอก', 'ปาก', 'คอ', 'แขน', 'ขา', 'หลัง', 'เข่า', 'ตา', 'หู', 'ไต', 'ตับ', 'หัวใจ', 'ปอด',
  'จิตใจ',
  // history and context
  'ความ', 'ประวัติ', 'เคย', 'เป็น', 'มี', 'ไม่', 'ได้', 'ได้รับ', 'ญาติ', 'มารดา', 'บิดา', 'สามี', 'ภรรยา', 'ลูก',
  'ครอบครัว', 'โรค', 'เบาหวาน', 'ความดัน', 'ความดันสูง', 'สูง', 'ไขมัน', 'มะเร็ง', 'หอบหืด', 'ผ่าตัด', 'ตั้งครรภ์',
  'คลอด', 'ประจำเดือน', 'สูบ', 'บุหรี่', 'ซอง', 'ดื่ม', 'สุรา', 'เหล้า', 'เสพ', 'ยา', 'ใช้ยา', 'วัคซีน', 'เข้า',
  'นอน', 'โรงพยาบาล', 'บ้าน', 'ห้องน้ำ', 'อาศัย', 'ทำงาน', 'อาชีพ', 'เล่า', 'ว่า', 'ฟอก', 'ฟอกไต', 'ประจำตัว',
  'สม่ำเสมอ', 'พา', 'มา', 'ไป', 'ทั้ง', 'ใน', 'จะ', 'ขอ', 'คน', 'ทำ', 'รอ', 'ดู', 'นะ', 'พอ', 'ละ', 'วันนี้',
  'วันละ', 'วันที่', 'ทุกวัน', 'ปี', 'ครั้ง', 'ตาม', 'ต่อ', 'ต่อมา',
  'เพนนิซิลลิน', 'เพนิซิลลิน', 'ซัลฟา', 'แอสไพริน', 'พาราเซตามอล', 'ไอบูโพรเฟน', 'อะม็อกซีซิลลิน',
  // exam, investigation, plan
  'ตรวจ', 'วัด', 'ฟัง', 'คลำ', 'เคาะ', 'ผล', 'ค่า', 'เอกซเรย์', 'อัลตราซาวด์', 'เจาะ', 'ส่ง', 'สัญญาณชีพ', 'ชีพจร',
  'อุณหภูมิ', 'ระดับ', 'แนะนำ', 'สั่ง', 'สั่งยา', 'ให้', 'นัด', 'ติดตาม', 'รักษา', 'การรักษา', 'การ', 'วินิจฉัย',
  'ส่งต่อ', 'รับไว้', 'จำหน่าย', 'พัก', 'งด', 'หยุด', 'เพิ่ม', 'ลด', 'ปรับ', 'เปลี่ยน', 'เริ่ม', 'ประเมิน', 'สังเกต',
  'เฝ้าระวัง', 'อธิบาย', 'เห็น',
]);

module.exports = { TH_CLINICAL_CONTINUATIONS };
