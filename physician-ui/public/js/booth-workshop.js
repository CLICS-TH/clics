// The workshop invitation: a card with a link on the phone result page (booth-result.js), and on the kiosk a screen of
// its own after Done (booth-invite.js) with a QR instead of a link, which on a touch screen would go nowhere (owner,
// 2026-11-21: a visitor who played saw no invitation). The kiosk loads it, so it is a promo capture input
// (scripts/booth/promo/capture-files.json): a change here needs `bash scripts/booth/promo/render.sh`. No imports: the
// harness loads it as a data: URL.

/** The Portal's own invitation page; it links on to the registration form. */
export const WORKSHOP_PATH = '/workshop.html';

/** The title and the button draw English first in a two-language look, Thai under it (owner, 2026-11-19): see
 *  booth-result.css .workshop-title, .workshop-open. The other lines stay Thai first. */
export const WORKSHOP_COPY = Object.freeze({
  title: { th: 'Calibration Workshop รุ่นแรกของโลก', en: 'CLICS Calibration Workshop — World’s First Cohort' },
  line: {
    th: 'แพทย์ให้คะแนนเคสชุดเดียวกัน ตามเกณฑ์ 7 ด้าน (PIS-7) แล้วนำมาเทียบกัน',
    en: 'Physicians score the same cases on the 7 domains of the PIS-7 rubric, then compare.',
  },
  // No-break spaces keep "soon" off a line of its own on a phone, and ๆ from starting a line in Thai.
  when: { th: 'วันและสถานที่ จะประกาศเร็ว\u00a0ๆ นี้', en: 'Date and venue to be announced soon' },
  // As the workshop page says it; a no-break space keeps "Specialty Audit" on one line in English.
  alongside: { th: 'จัดควบคู่กับ Specialty Audit ของสาขาท่าน', en: 'Held alongside your specialty’s Specialty\u00a0Audit' },
  // One action, one line per language: the page it opens shows the details before its registration link.
  open: { th: 'ลงทะเบียนความสนใจ', en: 'Register interest' },
  // The kiosk's screen after Done.
  scan: { th: 'สแกนเพื่อลงทะเบียนความสนใจเข้าร่วม', en: 'Scan to register your interest' },
  finish: { th: 'จบการเล่น', en: 'Finish' },
});

/** Seconds the kiosk holds the invitation before it starts over for the next visitor. */
export const INVITE_SECONDS = 30;
