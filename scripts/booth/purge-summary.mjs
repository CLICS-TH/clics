/*
 * Pure: formats the summary booth_event_summary() returns (db/migration-booth-purge.sql) into the counts report
 * scripts/booth/purge-event.mjs prints for CCME. The math lives in SQL, next to the rows it describes.
 * Aggregates only: no id, tag or per-play row ever reaches the output.
 */
export const SAFE_EVENT_CODE = /^[A-Z0-9][A-Z0-9-]{0,31}$/;
const DOMAIN_KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const SPREAD_KEYS = ['min', 'p25', 'median', 'p75', 'max', 'mean', 'sd'];
const BANGKOK_OFFSET_MS = 7 * 3_600_000;

const round1 = (x) => (x == null ? null : Math.round(Number(x) * 10) / 10);

export function bangkokTime(iso) {
  if (!iso) return null;
  return `${new Date(Date.parse(iso) + BANGKOK_OFFSET_MS).toISOString().slice(0, 19)}+07:00`;
}

/**
 * @param {string} code
 * @param {{ plays: number, scored: number, unavailable: number, abandoned: number, started: number, ranked: number,
 *   spend_usd: number, first_play_at: string|null, last_play_at: string|null,
 *   spread: Record<string, number|null>, domain_mean: Record<string, number|null> }} s
 */
export function report(code, s) {
  const v = (x) => (x == null ? '-' : String(x));
  const spread = SPREAD_KEYS.map((k) => `${k === 'sd' ? 'SD' : k} ${v(round1(s.spread[k]))}`).join('  ');
  return [
    `Booth event ${code}`,
    `plays ${s.plays}  scored ${s.scored}  unavailable ${s.unavailable}  abandoned ${s.abandoned}  started ${s.started}`,
    `ranked scored ${s.ranked}`,
    `total spend USD ${Number(s.spend_usd).toFixed(2)}`,
    `first play ${v(bangkokTime(s.first_play_at))}  last play ${v(bangkokTime(s.last_play_at))}`,
    `score spread (scored composites, 0-100): ${spread}`,
    `domain mean (0-5): ${DOMAIN_KEYS.map((k) => `${k} ${v(round1(s.domain_mean[k]))}`).join('  ')}`,
  ].join('\n');
}
