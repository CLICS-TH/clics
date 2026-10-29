/*
 * Pure: the counts summary scripts/booth/purge-event.mjs prints for CCME before it deletes an event's booth_plays.
 * Aggregates only: no id, tag or per-play row ever reaches the output.
 */
export const SAFE_EVENT_CODE = /^[A-Z0-9][A-Z0-9-]{0,31}$/;
export const DOMAIN_KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const STATUSES = ['scored', 'unavailable', 'abandoned', 'started'];
const BANGKOK_OFFSET_MS = 7 * 3_600_000;

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Linear interpolation between closest ranks (R type 7, Excel PERCENTILE.INC) on an ascending list. */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (at - lo);
}

/** Population SD: the event's scored plays are the whole population, not a sample of one. */
function sd(xs) {
  const m = mean(xs);
  return m == null ? null : Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function bangkokTime(iso) {
  if (!iso) return null;
  return `${new Date(Date.parse(iso) + BANGKOK_OFFSET_MS).toISOString().slice(0, 19)}+07:00`;
}

/**
 * @param {{ status: string, spend_usd: number|string, composite: number|string|null, ranked: boolean,
 *   created_at: string, d1..d7: number|null }[]} rows every booth_plays row of one event
 */
export function summarize(rows) {
  const count = (status) => rows.filter((r) => r.status === status).length;
  const scored = rows.filter((r) => r.status === 'scored' && r.composite != null);
  const composites = scored.map((r) => Number(r.composite)).sort((a, b) => a - b);
  const created = rows.map((r) => Date.parse(r.created_at)).filter(Number.isFinite).sort((a, b) => a - b);
  const at = (ms) => (ms == null ? null : bangkokTime(new Date(ms).toISOString()));
  return {
    plays: rows.length,
    ...Object.fromEntries(STATUSES.map((s) => [s, count(s)])),
    ranked_scored: scored.filter((r) => r.ranked === true).length,
    spend_usd: Math.round(rows.reduce((acc, r) => acc + Number(r.spend_usd ?? 0), 0) * 1e6) / 1e6,
    first_play: at(created[0] ?? null),
    last_play: at(created.at(-1) ?? null),
    spread: {
      min: round1(composites[0] ?? null),
      p25: round1(quantile(composites, 0.25)),
      median: round1(quantile(composites, 0.5)),
      p75: round1(quantile(composites, 0.75)),
      max: round1(composites.at(-1) ?? null),
      mean: round1(mean(composites)),
      sd: round1(sd(composites)),
    },
    domain_mean: Object.fromEntries(DOMAIN_KEYS.map((k) => {
      const xs = scored.map((r) => r[k]).filter((v) => v != null).map(Number);
      return [k, round1(mean(xs))];
    })),
  };
}

export function report(code, s) {
  const v = (x) => (x == null ? '-' : String(x));
  const sp = s.spread;
  return [
    `Booth event ${code}`,
    `plays ${s.plays}  scored ${s.scored}  unavailable ${s.unavailable}  abandoned ${s.abandoned}  started ${s.started}`,
    `ranked scored ${s.ranked_scored}`,
    `total spend USD ${s.spend_usd.toFixed(2)}`,
    `first play ${v(s.first_play)}  last play ${v(s.last_play)}`,
    `score spread (scored composites, 0-100): min ${v(sp.min)}  p25 ${v(sp.p25)}  median ${v(sp.median)}  p75 ${v(sp.p75)}  max ${v(sp.max)}  mean ${v(sp.mean)}  SD ${v(sp.sd)}`,
    `domain mean (0-5): ${DOMAIN_KEYS.map((k) => `${k} ${v(s.domain_mean[k])}`).join('  ')}`,
  ].join('\n');
}
