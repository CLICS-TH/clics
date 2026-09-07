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
// Each pool has TWO ceilings: $ (cloud spend) and tokens. The token ceiling exists because the on-prem
// model is priced at $0 (pricing.js) — with only a $ cap, local usage would be unbounded. Tokens have
// always been accumulated (inCol/outCol); the ceiling is a second comparison, not a second meter.
const POOLS = {
  physician: {
    cost: 'usage_cost_usd', limitCol: 'usage_limit_usd', stdKey: 'standard_usage_limit_usd',
    inCol: 'usage_input_tokens', outCol: 'usage_output_tokens',
    tokenLimitCol: 'usage_limit_tokens', tokenStdKey: 'standard_usage_limit_tokens',
    incRpc: 'increment_usage', resRpc: 'reserve_usage', sumRpc: 'total_usage_sum',
  },
  auditor: {
    cost: 'auditor_usage_cost_usd', limitCol: 'auditor_usage_limit_usd', stdKey: 'auditor_standard_usage_limit_usd',
    inCol: 'auditor_usage_input_tokens', outCol: 'auditor_usage_output_tokens',
    tokenLimitCol: 'auditor_usage_limit_tokens', tokenStdKey: 'auditor_standard_usage_limit_tokens',
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

// The org token ceiling for a pool, or null when none is configured. No code default on purpose: an
// absent OR zero setting must mean "no token cap", not silently cap every cloud user at some number.
// db/migration-local-ai-capacity.sql seeds 0; a superadmin sets the real ceiling from the capacity report.
const _tokCache = {}; // { [pool]: { v, t } }
async function standardTokenLimit(pool = 'physician', now = Date.now()) {
  const cfg = poolCfg(pool);
  const c = _tokCache[pool];
  if (c && now - c.t < STD_TTL_MS) return c.v;
  let limit = null;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', cfg.tokenStdKey).maybeSingle();
    const v = Number(data?.value);
    limit = Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  } catch { limit = null; }
  _tokCache[pool] = { v: limit, t: now };
  return limit;
}

// Per-user token override if set (0 = no cap for this user), else the org ceiling, else null.
async function effectiveTokenLimit(user, pool = 'physician') {
  const override = user?.[poolCfg(pool).tokenLimitCol];
  if (override != null) { const n = Number(override); return n > 0 ? n : null; }
  return standardTokenLimit(pool);
}

function tokensUsed(user, pool = 'physician') {
  const cfg = poolCfg(pool);
  return (Number(user?.[cfg.inCol]) || 0) + (Number(user?.[cfg.outCol]) || 0);
}

// One answer for "may this user make another paid call?" across both ceilings. `reason` names the
// ceiling that closed the door so the client can say tokens vs $ — the outcome is the same.
async function budgetState(user, pool = 'physician') {
  const [limit, tokenLimit] = await Promise.all([effectiveLimit(user, pool), effectiveTokenLimit(user, pool)]);
  const cost = Number(user?.[poolCfg(pool).cost] ?? 0);
  const tokens = tokensUsed(user, pool);
  const costOver = cost >= limit;
  const tokenOver = tokenLimit != null && tokens >= tokenLimit;
  return { over: costOver || tokenOver, reason: costOver ? 'cost' : (tokenOver ? 'tokens' : null), limit, tokenLimit, cost, tokens };
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
async function reserveUsage(userId, limit, estimate = RESERVE_ESTIMATE_USD, pool = 'physician', tokenLimit = null) {
  const cfg = poolCfg(pool);
  try {
    // p_token_limit only when a token ceiling applies: the pre-migration 3-arg RPC would reject an
    // unknown argument (→ fail-open), and the migrated 4-arg one defaults it to null.
    const args = { p_id: userId, p_estimate: estimate, p_limit: limit };
    if (tokenLimit != null) args.p_token_limit = Math.round(tokenLimit);
    const { data, error } = await supabase.rpc(cfg.resRpc, args);
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

// Test hook: the two 60s memos above make a settings change invisible to a suite that flips a value
// between cases. Production never calls this.
function _resetCaches() { for (const k of Object.keys(_stdCache)) delete _stdCache[k]; for (const k of Object.keys(_tokCache)) delete _tokCache[k]; }

// ---- Org-wide budget pool -----------------------------------------------------------------------
// app_settings.api_budget_pool_usd was stored, rendered on two admin screens, and consulted by
// nothing. An operator setting it to 12 believed spend stopped at $12; the only real ceiling was the
// Anthropic account balance. This is the reader that makes it mean something.
//
// 0 = no cap, matching the convention the token ceilings already use — so an untouched deployment
// behaves exactly as before rather than halting on a default.
//
// It measures the PHYSICIAN pool, which is where PIS-7 evaluation spend lands (services/
// ple-evaluation.js accrues the evaluation's cost to the physician's meter). Chat, criteria and
// discuss keep their own per-user ceilings; this is the org-wide backstop over the top of them.
async function budgetPool() {
  // Required lazily: lib/settings.js imports this module's siblings, and a top-level cycle here
  // would leave one of the two half-initialised depending on which loaded first.
  const { getSetting } = require('./settings');
  const cap = Number(await getSetting('api_budget_pool_usd', 0)) || 0;
  if (cap <= 0) return { cap: 0, spent: null, exhausted: false, uncapped: true };
  let spent = null;
  const { data, error } = await supabase.rpc('total_usage_sum');
  if (!error && data != null) spent = Number(data);
  else {
    // Fallback sum. `rows ?? []` would reduce a FAILED read to 0, and 0 against a real cap reads as
    // "plenty left" — the silent-success shape this whole function exists to remove. So an error or
    // a missing array stays null and is handled below; only an actual (possibly empty) array sums.
    const { data: rows, error: rowsErr } = await supabase.from('professionals').select('usage_cost_usd');
    if (!rowsErr && Array.isArray(rows)) spent = rows.reduce((acc, r) => acc + Number(r.usage_cost_usd ?? 0), 0);
  }
  // A read failure must not read as "plenty left". Unknown spend against a real cap is treated as
  // exhausted, because the alternative is spending real money on the strength of a failed query.
  if (spent == null || !Number.isFinite(spent)) return { cap, spent: null, exhausted: true, uncapped: false, reason: 'spend unreadable' };
  return { cap, spent, exhausted: spent >= cap, uncapped: false };
}

module.exports = {
  budgetPool,
  POOLS, STANDARD_LIMIT_KEY, DEFAULT_STANDARD_LIMIT_USD, RESERVE_ESTIMATE_USD,
  standardLimit, effectiveLimit, standardTokenLimit, effectiveTokenLimit, tokensUsed, budgetState,
  accrueUsage, reserveUsage, settleUsage, refundUsage, _resetCaches,
};
