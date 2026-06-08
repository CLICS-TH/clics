// Per-physician AI usage budget helpers.
//   * standardLimit()  — the org default ($), from app_settings with a code fallback.
//   * effectiveLimit(user) — the user's override if set, else the standard default.
//   * accrueUsage(...) — atomically add a call's cost + tokens to the physician's meter.
const { supabase } = require('./supabase');
const { costUsd } = require('./pricing');

const STANDARD_LIMIT_KEY = 'standard_usage_limit_usd';
const DEFAULT_STANDARD_LIMIT_USD = 0.5;

// Read the org standard limit from app_settings; fall back to the constant (mirrors accounts.capacityOf).
async function standardLimit() {
  const { data } = await supabase
    .from('app_settings').select('value').eq('key', STANDARD_LIMIT_KEY).single();
  const v = Number(data?.value);
  return Number.isFinite(v) ? v : DEFAULT_STANDARD_LIMIT_USD;
}

// The limit that actually applies to a user: their per-user override, else the standard default.
async function effectiveLimit(user) {
  if (user?.usage_limit_usd != null) return Number(user.usage_limit_usd);
  return standardLimit();
}

// Add one Claude call's cost + tokens to the physician's running meter (atomic via RPC).
// Best-effort: a metering failure must not break the chat/eval flow (caller may ignore the result).
async function accrueUsage(physicianId, inputTokens = 0, outputTokens = 0) {
  const cost = costUsd(inputTokens, outputTokens);
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

module.exports = { STANDARD_LIMIT_KEY, DEFAULT_STANDARD_LIMIT_USD, standardLimit, effectiveLimit, accrueUsage };
