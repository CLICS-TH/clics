// Formatting for the Booth Mode page. The participant number and the score mirror what the kiosk shows
// (physician-ui/public/js/booth-copy.js tagText and scoreText), so a visitor's "Participant #042, 87" reads the same
// on the booth screen and on the superadmin's leaderboard.

const tagDigits = (tag: number) => String(tag).padStart(3, '0');
/** The Thai name in its two line pieces, `หมายเลข` and `ผู้เข้าร่วม 042`: a line may break between them, never inside the
 *  second, where the number would fall away from its word onto the English half's line. */
export const playerTagTh = (tag: number): [string, string] => ['หมายเลข', `ผู้เข้าร่วม ${tagDigits(tag)}`];
/** `หมายเลขผู้เข้าร่วม 042` / `Participant #042` — booth-copy.js tagText. */
export const playerTag = (tag: number, lang: 'th' | 'en') =>
  (lang === 'th' ? playerTagTh(tag).join('') : `Participant #${tagDigits(tag)}`);

/** The score the visitor saw: the display score, rounded as the kiosk rounds it (booth-copy.js scoreText). */
export const shownScore = (score: number) => String(Math.round(score));

/** The stored composite that breaks a tie on the shown score, to one decimal. */
export const rawScore = (raw: number) => (Number.isFinite(raw) ? raw.toFixed(1) : '—');

/** tiers-v1 (ADR 0016), as backend/src/booth-cases/display-score.js TIER_SCALE scores a step of a five-step play. */
export const TIER_STEPS = 5;
export const TIER_POINTS: Readonly<Record<string, number>> = Object.freeze({ B: 20, R: 10, W: 0 });

/** A five-letter tier path's points, 0–100; null for any other path (display-score.js tierScore). */
export function tierScore(path: string | null | undefined): number | null {
  if (typeof path !== 'string' || path.length !== TIER_STEPS) return null;
  let sum = 0;
  for (const letter of path) {
    if (!Object.hasOwn(TIER_POINTS, letter)) return null;
    sum += TIER_POINTS[letter];
  }
  return sum;
}

/** The number a leaderboard row shows (display-score.js shownScore): in a five-step event its tier score, read from
 *  its tier path; otherwise, or for a row with no readable path, the score the server sent. */
export const rowScore = (row: { score: number; tier_path?: string | null }, steps: number) =>
  (steps === TIER_STEPS ? tierScore(row.tier_path) : null) ?? row.score;

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

const DAY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY_TH = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short' });
const DAY_EN = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short' });

/** The Bangkok calendar day of `iso`, `2026-11-24`; null for a time that does not parse. The kiosk's "today" board
 *  starts its day at Bangkok midnight too (backend services/booth.js bangkokDayStart). */
export function bangkokDayKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = DAY_KEY.formatToParts(d);
  return `${part(p, 'year')}-${part(p, 'month')}-${part(p, 'day')}`;
}

/** `อังคาร 24 พ.ย.` / `Tue 24 Nov` for a day key from bangkokDayKey. */
export function bangkokDayLabel(key: string, lang: 'th' | 'en'): string {
  const d = new Date(`${key}T12:00:00+07:00`);
  if (Number.isNaN(d.getTime())) return key;
  const p = (lang === 'th' ? DAY_TH : DAY_EN).formatToParts(d);
  return `${part(p, 'weekday')} ${part(p, 'day')} ${part(p, 'month')}`;
}

export interface BoothDay<R> { day: string; rows: R[] }

/** The event's rows split by Bangkok day, the newest day first. Each day keeps the server's order and ranks from 1, as
 *  the kiosk ranks its "today" board: the same rows, filtered by day, never re-sorted. A row whose time does not parse
 *  belongs to no day. */
export function boothDays<R extends { rank: number; scored_at: string }>(rows: R[]): BoothDay<R>[] {
  const days = new Map<string, R[]>();
  for (const r of rows) {
    const day = bangkokDayKey(r.scored_at);
    if (!day) continue;
    const list = days.get(day) ?? [];
    list.push({ ...r, rank: list.length + 1 });
    days.set(day, list);
  }
  return [...days].sort(([a], [b]) => b.localeCompare(a)).map(([day, list]) => ({ day, rows: list }));
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
