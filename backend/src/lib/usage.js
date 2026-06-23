// AI usage budget helpers — now POOL-AWARE. Two isolated budgets share identical mechanics on
// different columns / settings keys / RPCs:
//   * physician — chat turns + PIS-7 eval + C4–C6 criteria (the original $0.50 cap).
//   * auditor   — the auditor AI discussion chat, so a dual-role "Special" user (physician + can_audit,
//                 ONE professionals row) never has their auditing spend drawn from their physician budget.
// Every function takes an optional `pool` (default 'physician') so all existing physician callers are
// unchanged. Helpers:
//   * standardLimit(pool) — the org default ($), from app_settings with a code fallback.
//   * effectiveLimit(user, pool) — the user's override for that pool if set, else the standard default.
//   * reserve/settle/refund/accrueUsage — atomic meter operations against the pool's columns (via RPC).
const { supabase } = require('./supabase');
const { costUsd } = require('./pricing');

const DEFAULT_STANDARD_LIMIT_USD = 0.5;

// Per-pool wiring. Add a pool here + its mirror RPCs/columns in a migration to introduce another budget.
const POOLS = {
  physician: {
    cost: 'usage_cost_usd', limitCol: 'usage_limit_usd', stdKey: 'standard_usage_limit_usd',
    incRpc: 'increment_usage', resRpc: 'reserve_usage', sumRpc: 'total_usage_sum',
  },
  auditor: {
    cost: 'auditor_usage_cost_usd', limitCol: 'auditor_usage_limit_usd', stdKey: 'auditor_standard_usage_limit_usd',
    incRpc: 'increment_auditor_usage', resRpc: 'reserve_auditor_usage', sumRpc: 'total_auditor_usage_sum',
  },
};
const poolCfg = (pool) => POOLS[pool] || POOLS.physician;

// Back-compat export (was the physician standard key).
const STANDARD_LIMIT_KEY = POOLS.physician.stdKey;

// Read a pool's org standard limit from app_settings; fall back to the constant. Memoized per pool for
// 60s: requireBudget runs this on EVERY turn for users without a per-user override, and the value
// changes only via the superadmin settings page — a per-turn DB read was pure waste.
const STD_TTL_MS = 60_000;
const _stdCache = {}; // { [pool]: { v, t } }
async function standardLimit(pool = 'physician', now = Date.now()) {
  const cfg = poolCfg(pool);
  const c = _stdCache[pool];
  if (c && c.v != null && now - c.t < STD_TTL_MS) return c.v;
  const { data } = await supabase
    .from('app_settings').select('value').eq('key', cfg.stdKey).single();
  const v = Number(data?.value);
  const limit = Number.isFinite(v) ? v : DEFAULT_STANDARD_LIMIT_USD;
  _stdCache[pool] = { v: limit, t: now };
  return limit;
}

// The limit that actually applies to a user in a pool: their per-user override, else the standard default.
async function effectiveLimit(user, pool = 'physician') {
  const override = user?.[poolCfg(pool).limitCol];
  if (override != null) return Number(override);
  return standardLimit(pool);
}

// A conservative per-turn cost reservation (override via env). ~$0.012/turn typical, ~$0.03 worst
// case; reserving high means we may block a hair early, never late — then settle to the real cost.
const RESERVE_ESTIMATE_USD = parseFloat(process.env.USAGE_RESERVE_ESTIMATE_USD || '0.02');

// Add one Claude call's cost + tokens to a user's running meter for `pool` (atomic via RPC). A signed
// p_cost is allowed (used to reconcile/refund a reservation). Best-effort: a metering failure must
// not break the chat/eval flow (caller may ignore the result).
async function accrueUsage(userId, inputTokens = 0, outputTokens = 0, costOverride = null, pool = 'physician') {
  const cfg = poolCfg(pool);
  const cost = costOverride != null ? costOverride : costUsd(inputTokens, outputTokens);
  try {
    const { error } = await supabase.rpc(cfg.incRpc, {
      p_id: userId,
      p_cost: cost,
      p_in: Math.round(Number(inputTokens) || 0),
      p_out: Math.round(Number(outputTokens) || 0),
    });
    if (error) console.error(`[usage:${pool}] ${cfg.incRpc} failed:`, error.message);
    return { cost, error };
  } catch (e) {
    // Metering must never break the chat/eval flow.
    console.error(`[usage:${pool}] ${cfg.incRpc} threw:`, e.message);
    return { cost, error: e };
  }
}

// ATOMICALLY reserve a turn's estimated cost iff the meter is still under the limit (closes the
// parallel-turn TOCTOU). Returns { ok, applied }:
//   ok      — the turn is allowed (under budget, or fail-open on an RPC fault).
//   applied — the estimate was ACTUALLY added to the meter. settle/refund MUST honor this: if the
//             RPC is absent (pre-migration) we fail OPEN but add nothing, so a later settle that
//             subtracts the estimate would drive the meter NEGATIVE every turn (cap defeated, meter
//             runs backwards). applied:false tells settle to add the full actual and refund to no-op.
async function reserveUsage(userId, limit, estimate = RESERVE_ESTIMATE_USD, pool = 'physician') {
  const cfg = poolCfg(pool);
  try {
    const { data, error } = await supabase.rpc(cfg.resRpc, {
      p_id: userId, p_estimate: estimate, p_limit: limit,
    });
    // Fail-OPEN on an RPC fault: never block a turn on a metering fault — requireBudget already gave
    // a soft check — but report applied:false so settle/refund don't subtract an unreserved estimate.
    if (error) { console.error(`[usage:${pool}] ${cfg.resRpc} failed (fail-open, estimate NOT applied):`, error.message); return { ok: true, applied: false }; }
    // The RPC adds the estimate ONLY when under the limit (returns true). Over limit → false, nothing added.
    return { ok: data === true, applied: data === true };
  } catch (e) {
    console.error(`[usage:${pool}] ${cfg.resRpc} threw (fail-open, estimate NOT applied):`, e.message);
    return { ok: true, applied: false };
  }
}

// Reconcile a reservation to the ACTUAL cost. When the estimate WAS applied by reserveUsage, the net
// add is (actual − estimate). When it was NOT applied (fail-open / pre-migration), add the FULL actual
// so the meter reflects real spend instead of running backwards.
async function settleUsage(userId, estimate, inputTokens = 0, outputTokens = 0, applied = true, pool = 'physician') {
  const actual = costUsd(inputTokens, outputTokens);
  const delta = applied ? actual - estimate : actual;
  return accrueUsage(userId, inputTokens, outputTokens, delta, pool);
}

// Release a reservation when the turn fails before any real cost is owed (RIMPL error / unsaved turn).
// A no-op when the estimate was never applied — otherwise we'd subtract an amount never added.
async function refundUsage(userId, estimate, applied = true, pool = 'physician') {
  if (!applied) return { cost: 0, error: null };
  return accrueUsage(userId, 0, 0, -estimate, pool);
}

module.exports = {
  POOLS, STANDARD_LIMIT_KEY, DEFAULT_STANDARD_LIMIT_USD, RESERVE_ESTIMATE_USD,
  standardLimit, effectiveLimit, accrueUsage, reserveUsage, settleUsage, refundUsage,
};
