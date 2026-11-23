// The workshop invitation: a card with a link on the phone result page (booth-result.js), and on the kiosk a screen of
// its own after Done (booth-invite.js) with a QR instead of a link, which on a touch screen would go nowhere (owner,
// 2026-11-21: a visitor who played saw no invitation). Kept out of booth-copy.js, which the promo video captures (scripts/booth/promo/capture-files.json), so
// a change here needs no re-render. No imports: the harness loads it as a data: URL.

/** The Portal's own invitation page; it links on to the registration form. */
export const WORKSHOP_PATH = '/workshop.html';

/** The title and the button draw English first in a two-language look, Thai under it (owner, 2026-11-19): see
 *  booth-result.css .workshop-title, .workshop-open. The line and the date stay Thai first. */
export const WORKSHOP_COPY = Object.freeze({
  title: { th: 'Calibration Workshop รุ่นแรกของโลก', en: 'CLICS Calibration Workshop — World’s First Cohort' },
  line: {
    th: 'แพทย์ให้คะแนนเคสชุดเดียวกัน ตามเกณฑ์ PIS-7 แล้วนำมาเทียบกัน',
    en: 'Physicians score the same cases on the PIS-7 rubric, then compare.',
  },
  when: { th: 'วันและสถานที่ จะประกาศเร็วๆ นี้', en: 'Date and venue to be announced soon' },
  open: { th: 'ลงทะเบียน Workshop และดูรายละเอียด', en: 'Register / Details' },
  // The kiosk's screen after Done.
  scan: { th: 'สแกนเพื่อลงทะเบียนความสนใจเข้าร่วม', en: 'Scan to register your interest' },
  finish: { th: 'จบการเล่น', en: 'Finish' },
});

/** Seconds the kiosk holds the invitation before it starts over for the next visitor. */
export const INVITE_SECONDS = 30;
