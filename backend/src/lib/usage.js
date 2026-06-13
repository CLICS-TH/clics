// Per-physician AI usage budget helpers.
//   * standardLimit()  — the org default ($), from app_settings with a code fallback.
//   * effectiveLimit(user) — the user's override if set, else the standard default.
//   * accrueUsage(...) — atomically add a call's cost + tokens to the physician's meter.
const { supabase } = require('./supabase');
const { costUsd } = require('./pricing');

const STANDARD_LIMIT_KEY = 'standard_usage_limit_usd';
const DEFAULT_STANDARD_LIMIT_USD = 0.5;

// Read the org standard limit from app_settings; fall back to the constant (mirrors accounts.capacityOf).
// Memoized for 60s: requireBudget runs this on EVERY chat turn for users without a per-user override,
// and the value changes only via the superadmin settings page — a per-turn DB read was pure waste.
let _stdCache = { v: null, t: 0 };
const STD_TTL_MS = 60_000;
async function standardLimit(now = Date.now()) {
  if (_stdCache.v != null && now - _stdCache.t < STD_TTL_MS) return _stdCache.v;
  const { data } = await supabase
    .from('app_settings').select('value').eq('key', STANDARD_LIMIT_KEY).single();
  const v = Number(data?.value);
  const limit = Number.isFinite(v) ? v : DEFAULT_STANDARD_LIMIT_USD;
  _stdCache = { v: limit, t: now };
  return limit;
}

// The limit that actually applies to a user: their per-user override, else the standard default.
async function effectiveLimit(user) {
  if (user?.usage_limit_usd != null) return Number(user.usage_limit_usd);
  return standardLimit();
}

// A conservative per-turn cost reservation (override via env). ~$0.012/turn typical, ~$0.03 worst
// case; reserving high means we may block a hair early, never late — then settle to the real cost.
const RESERVE_ESTIMATE_USD = parseFloat(process.env.USAGE_RESERVE_ESTIMATE_USD || '0.02');

// Add one Claude call's cost + tokens to the physician's running meter (atomic via RPC). A signed
// p_cost is allowed (used to reconcile/refund a reservation). Best-effort: a metering failure must
// not break the chat/eval flow (caller may ignore the result).
async function accrueUsage(physicianId, inputTokens = 0, outputTokens = 0, costOverride = null) {
  const cost = costOverride != null ? costOverride : costUsd(inputTokens, outputTokens);
  try {
    const { error } = await supabase.rpc('increment_usage', {
      p_id: physicianId,
      p_cost: cost,
      p_in: Math.round(Number(inputTokens) || 0),
      p_out: Math.round(Number(outputTokens) || 0),
    });
    if (error) console.error('[usage] increment_usage failed:', error.message);
    return { cost, error };
  } catch (e) {
    // Metering must never break the chat/eval flow.
    console.error('[usage] increment_usage threw:', e.message);
    return { cost, error: e };
  }
}

// ATOMICALLY reserve a turn's estimated cost iff the meter is still under the limit (closes the
// parallel-turn TOCTOU). Returns true if reserved (turn allowed), false if over budget. Fail-OPEN on
// an RPC error (e.g. pre-migration): never block a turn on a metering fault — requireBudget already
// gave a soft check, and settle/refund still reconcile the real cost.
async function reserveUsage(physicianId, limit, estimate = RESERVE_ESTIMATE_USD) {
  try {
    const { data, error } = await supabase.rpc('reserve_usage', {
      p_id: physicianId, p_estimate: estimate, p_limit: limit,
    });
    if (error) { console.error('[usage] reserve_usage failed (fail-open):', error.message); return true; }
    return data === true;
  } catch (e) {
    console.error('[usage] reserve_usage threw (fail-open):', e.message);
    return true;
  }
}

// Reconcile a reservation to the ACTUAL cost: the estimate was already added, so add (actual −
// estimate) to cost and the real token counts. Net effect on the meter = the true turn cost.
async function settleUsage(physicianId, estimate, inputTokens = 0, outputTokens = 0) {
  const actual = costUsd(inputTokens, outputTokens);
  return accrueUsage(physicianId, inputTokens, outputTokens, actual - estimate);
}

// Refund a reservation when the turn fails before any real cost is owed (RIMPL error / unsaved turn).
async function refundUsage(physicianId, estimate) {
  return accrueUsage(physicianId, 0, 0, -estimate);
}

module.exports = {
  STANDARD_LIMIT_KEY, DEFAULT_STANDARD_LIMIT_USD, RESERVE_ESTIMATE_USD,
  standardLimit, effectiveLimit, accrueUsage, reserveUsage, settleUsage, refundUsage,
};
