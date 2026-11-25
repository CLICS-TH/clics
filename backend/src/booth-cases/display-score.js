/**
 * ADR 0013: the number a booth visitor sees is a display rescale of the stored demo score.
 *
 * booth_plays keeps the raw composite the path score table gives (ADR 0009): the auditor reveal, the open dataset and
 * research read that. Only the kiosk result and the board show this rescale. It is one fixed, strictly increasing map,
 * so the board order is the order of the raw scores.
 *
 * display-v2 anchors are the raw composite range over every path of the ten admitted NFCME-2026 five-step tables
 * (2,430 paths, 2026-11-25, after the reply format B rebuild): 26 is the floor and 61 the ceiling. A raw score outside
 * them clamps to 0 or 100. display-v1 (2026-11-18) was 26–65. Changing an anchor is a new version, recorded in ADR 0013.
 */
const DISPLAY_SCALE = Object.freeze({ version: 'display-v2', steps: 5, floor: 26, ceiling: 61 });

/** Whole number 0–100 for a five-step event's raw composite; any other step count shows the raw score unchanged. */
function displayScore(raw, steps, scale = DISPLAY_SCALE) {
  if (steps !== scale.steps || !Number.isFinite(raw)) return raw;
  const t = (raw - scale.floor) / (scale.ceiling - scale.floor);
  return Math.round(Math.min(1, Math.max(0, t)) * 100);
}

module.exports = { DISPLAY_SCALE, displayScore };
