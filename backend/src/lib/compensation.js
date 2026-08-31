// Shared compensation math (CLICS §12). Single source for the ฿/PLE rate + cap and the owed formula
// so the report (/admin/compensation), the payout pipeline (/admin/payouts*) and the XLSX export
// (/admin/export.xlsx) can never drift. Also the canonical PIS-7 dimension keys + a per-dimension mean
// (reused by the auditor peer-calibration averages).
const { getSetting } = require('./settings');

const PIS7_DIMS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

// Configurable rate (฿ per completed PLE) + cap (in PLEs; 0 = no cap). Read together; defaults 500 / 3.
async function compRateCap() {
  const [rate, cap] = await Promise.all([getSetting('comp_rate_thb', 500), getSetting('comp_cap_cles', 3)]);
  return { rate, cap };
}

// PLEs that count toward pay = min(completed, cap), or all completed when cap is 0 (uncapped).
function cappedPles(completed, cap) {
  return cap > 0 ? Math.min(completed, cap) : completed;
}

// Per-dimension mean across a set of d1–d7 rows (e.g. all auditors on a PLE). null for an empty set.
function meanByDim(rows, dims = PIS7_DIMS) {
  if (!rows || !rows.length) return null;
  return Object.fromEntries(dims.map((d) => [d, rows.reduce((s, r) => s + Number(r[d] || 0), 0) / rows.length]));
}

module.exports = { PIS7_DIMS, compRateCap, cappedPles, meanByDim };
