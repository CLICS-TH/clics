// CME credit conversion — turning a PIS-7 composite into a credit figure.
//
// SHIPS OFF (`credit_conversion_enabled = 0`). While off, a physician sees which band their score
// falls in as a PREVIEW and the existing "ยังไม่นับเป็นหน่วยกิต CME" wording stays exactly as it is.
// That is deliberate: awarding CME credit is a regulatory act for a licensing body, and the pilot's
// own credit gate (ICC >= 0.75) has never been measured against real human auditors. Shipping the
// capability now — dormant — means turning it on later is a setting change rather than a code change
// during a frozen pilot; shipping it ON would be claiming an authority the study has not yet earned.
//
// POLICY IS DATA, NOT CODE. The four cut points and five credit values live in app_settings so the
// licensing body can move them without a deploy. The defaults below apply pre-migration and are a
// starting proposal, not a decision.

const DEFAULTS = {
  // Four cut points over the 0–100 PIS-7 composite -> five bands.
  cuts: [50, 65, 75, 85],
  // Credit awarded in each band, lowest first. Multiplied by credit_base_unit.
  values: [0, 0.5, 1, 1.5, 2],
  baseUnit: 1,
};

// Bilingual band labels. Thai first — the physician-facing surface is Thai-primary.
const BAND_LABELS = [
  { th: 'ต่ำกว่าเกณฑ์', en: 'Below threshold' },
  { th: 'พอใช้', en: 'Adequate' },
  { th: 'ดี', en: 'Good' },
  { th: 'ดีมาก', en: 'Very good' },
  { th: 'ดีเยี่ยม', en: 'Excellent' },
];

/**
 * @param {number} composite  PIS-7 composite score (0–100)
 * @param {object} [settings] { enabled, cuts, values, baseUnit } — any subset; missing keys default
 * @returns {{ band, band_label, credits, enabled, cut_low, cut_high }|null}
 *
 * PURE. No database, no side effects, no clock — so it is unit-testable and so the same function can
 * be called from a route, a report, and a test without three different answers.
 */
function creditFor(composite, settings = {}) {
  const score = Number(composite);
  if (!Number.isFinite(score)) return null;

  const cuts = normaliseCuts(settings.cuts);
  const values = Array.isArray(settings.values) && settings.values.length === cuts.length + 1
    ? settings.values.map(Number)
    : DEFAULTS.values;
  const baseUnit = Number.isFinite(Number(settings.baseUnit)) ? Number(settings.baseUnit) : DEFAULTS.baseUnit;
  const enabled = settings.enabled === true;

  // Upper-exclusive against each cut, so a score exactly ON a boundary lands in the HIGHER band.
  // Stated because it is the kind of thing that gets silently flipped later: 75.0 is "Very good",
  // not "Good", and a physician on a boundary must not lose half a credit to a refactor.
  let band = 0;
  while (band < cuts.length && score >= cuts[band]) band++;

  const credits = Math.round(values[band] * baseUnit * 100) / 100;
  return {
    band: band + 1,                       // 1-indexed for display
    band_label: BAND_LABELS[band],
    credits,
    enabled,
    // Awarded only when the toggle is on. When off this is null and `credits` is the PREVIEW figure —
    // two separate fields, so a caller cannot accidentally render a preview as an award.
    awarded_credits: enabled ? credits : null,
    cut_low: band === 0 ? null : cuts[band - 1],
    cut_high: band === cuts.length ? null : cuts[band],
  };
}

// Cuts must be finite, ascending, and unique — an out-of-order pair silently makes a band
// unreachable, which looks like "nobody ever scores Very Good" rather than like a config error.
function normaliseCuts(input) {
  if (!Array.isArray(input) || !input.length) return DEFAULTS.cuts;
  const cleaned = [...new Set(
    input
      // Number(null) is 0 and Number('') is 0, both of which pass Number.isFinite. Left unguarded,
      // a config of [null] normalises to a single cut at 0 — which makes band 1 unreachable and
      // silently awards every physician a band too high. Reject anything that is not already a
      // number or a numeric string BEFORE coercing.
      .filter(v => typeof v === 'number' || (typeof v === 'string' && v.trim() !== ''))
      .map(Number)
      .filter(v => Number.isFinite(v) && v > 0 && v < 100),
  )].sort((a, b) => a - b);
  return cleaned.length ? cleaned : DEFAULTS.cuts;
}

// The whole table, for the physician preview and the admin screen. Rendering the band a score fell
// into without the surrounding table tells a physician their result but not what it would take to
// move up — which is the entire point of a formative system.
function creditTable(settings = {}) {
  const cuts = normaliseCuts(settings.cuts);
  const values = Array.isArray(settings.values) && settings.values.length === cuts.length + 1
    ? settings.values.map(Number)
    : DEFAULTS.values;
  const baseUnit = Number.isFinite(Number(settings.baseUnit)) ? Number(settings.baseUnit) : DEFAULTS.baseUnit;
  return values.map((v, i) => ({
    band: i + 1,
    band_label: BAND_LABELS[i] ?? { th: `ระดับ ${i + 1}`, en: `Band ${i + 1}` },
    min: i === 0 ? 0 : cuts[i - 1],
    max: i === cuts.length ? 100 : cuts[i],
    credits: Math.round(v * baseUnit * 100) / 100,
  }));
}

module.exports = { creditFor, creditTable, normaliseCuts, DEFAULTS, BAND_LABELS };
