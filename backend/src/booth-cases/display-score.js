/**
 * The number a booth visitor sees for a play, and the order the boards rank plays in.
 *
 * booth_plays keeps the raw composite and d1–d7 the path score table gives (ADR 0009): the auditor reveal, the open
 * dataset and research read those. Only the kiosk result, the boards and the superadmin's leaderboard show the number
 * this file computes.
 *
 * tiers-v1 (ADR 0016, owner 2026-11-26): a five-step play shows the sum over its five steps of 20 for a best answer,
 * 10 for a reasonable one and 0 for a weaker one, read from its stored tier path (B/R/W). All best is 100, all weaker
 * 0. Plays that show the same number rank by the raw composite, so the reasoning the evaluator saw breaks the tie.
 *
 * display-v2 (ADR 0013, superseded for five-step events by ADR 0016) rescaled the raw composite, 26 → 0 and 61 → 100.
 * It stays only as the fallback for a five-step row whose tier path is not five tier letters, which ranks after every
 * row that has one. The database's check (tier_path ~ '^[BRW]{0,5}$') and the standings read (five characters) leave
 * no such row today. Changing a scale is a new version, recorded in an ADR.
 */
const DISPLAY_SCALE = Object.freeze({ version: 'display-v2', steps: 5, floor: 26, ceiling: 61 });
const TIER_SCALE = Object.freeze({ version: 'tiers-v1', steps: 5, points: Object.freeze({ B: 20, R: 10, W: 0 }) });

/** display-v2: whole number 0–100 for a five-step event's raw composite; any other step count shows it unchanged. */
function displayScore(raw, steps, scale = DISPLAY_SCALE) {
  if (steps !== scale.steps || !Number.isFinite(raw)) return raw;
  const t = (raw - scale.floor) / (scale.ceiling - scale.floor);
  return Math.round(Math.min(1, Math.max(0, t)) * 100);
}

/** tiers-v1: a five-letter tier path's points, 0–100; null for anything else. */
function tierScore(tierPath, scale = TIER_SCALE) {
  if (typeof tierPath !== 'string' || tierPath.length !== scale.steps) return null;
  let sum = 0;
  for (const letter of tierPath) {
    if (!Object.hasOwn(scale.points, letter)) return null;
    sum += scale.points[letter];
  }
  return sum;
}

/**
 * The number shown for a play of an event of `steps` steps, and whether it comes from the tier path. A five-step play
 * shows its tier score; one without a readable tier path falls back to display-v2 and is not `tiered`. Any other step
 * count shows the raw composite, `tiered` like a five-step one so the board keeps ranking it on the raw score alone.
 * @returns {{ score: number, tiered: boolean }}
 */
function shownScore(raw, tierPath, steps) {
  if (steps !== TIER_SCALE.steps) return { score: raw, tiered: true };
  const tiers = tierScore(tierPath);
  return tiers === null ? { score: displayScore(raw, steps), tiered: false } : { score: tiers, tiered: true };
}

/** Board order everywhere (kiosk today and event, rank_today, rank_event, the superadmin's leaderboard): a row with a
 *  tier score before one without, then the shown score, then the raw composite, high first; an equal pair ranks the
 *  earlier play first, then the lower tag.
 *  @param {{ tiered: boolean, score: number, composite: number, scored_at: string, tag: number }} a */
function byStanding(a, b) {
  return Number(b.tiered) - Number(a.tiered) || b.score - a.score || b.composite - a.composite
    || Date.parse(a.scored_at) - Date.parse(b.scored_at) || a.tag - b.tag;
}

module.exports = { DISPLAY_SCALE, TIER_SCALE, displayScore, tierScore, shownScore, byStanding };
