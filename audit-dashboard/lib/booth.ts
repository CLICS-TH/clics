// Formatting for the Booth Mode page. The player tag and the score mirror what the kiosk shows
// (physician-ui/public/js/booth-copy.js tagText and scoreText), so a visitor's "Player #042, 87" reads the same
// on the booth screen and on the superadmin's leaderboard.

/** `ผู้เล่น #042` / `Player #042` — booth-copy.js tagText. */
export const playerTag = (tag: number, lang: 'th' | 'en') =>
  `${lang === 'th' ? 'ผู้เล่น' : 'Player'} #${String(tag).padStart(3, '0')}`;

/** The score the visitor saw: the display score, rounded as the kiosk rounds it (booth-copy.js scoreText). */
export const shownScore = (score: number) => String(Math.round(score));

/** The stored composite the board ranks on, to one decimal. */
export const rawScore = (raw: number) => (Number.isFinite(raw) ? raw.toFixed(1) : '—');

// Asia/Bangkok explicitly: the operator reads Thai wall-clock time whatever the machine's own zone.
const DAY_TIME = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const TIME = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const part = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';

/** `24 พ.ย. 14:05`, Bangkok time. Built from parts so the shape does not depend on the ICU build. */
export function bangkokDayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = DAY_TIME.formatToParts(d);
  return `${part(p, 'day')} ${part(p, 'month')} ${part(p, 'hour')}:${part(p, 'minute')}`;
}

/** `14:05`, Bangkok time. */
export function bangkokTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = TIME.formatToParts(d);
  return `${part(p, 'hour')}:${part(p, 'minute')}`;
}

/** The export's file name, as the backend's Content-Disposition names it (booth-monitor.js exportPlays). */
export function boothExportFilename(eventCode: string | null | undefined, now = new Date()): string {
  const day = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  return `clics-booth-${(eventCode ?? 'none').replace(/[^A-Za-z0-9-]/g, '_')}-${day}.json`;
}

/** The feedback export's file name, as the backend's Content-Disposition names it (booth-feedback.js exportFeedback). */
export function boothFeedbackFilename(eventCode: string): string {
  return `booth-feedback-${eventCode.replace(/[^A-Za-z0-9-]/g, '_')}.json`;
}
