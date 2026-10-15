// Per-turn middleware flags from rimpl's chat reply, and the sticky deep-mode latch they drive.
//
// WHAT. rimpl answers every chat turn with `middleware_flags`: which router tier served it (fast | deep,
// null with the router off), why, whether the model was given thinking time and how much, the reply's
// evidence level, and the provider a failed-over call left. It is provenance, like messages.provider: kept
// on the ASSISTANT row (messages.middleware_flags, db/migration-chat-turn-flags.sql) and never sent to the
// physician — the /message response is a whitelist, and every transcript reader selects explicit columns.
//
// A WHITELIST, never rimpl's JSON as it came. Exactly the keys below, and every string value ENUMERATED:
// a value not on its list is stored as NULL — free text never reaches the column, whatever rimpl sends.
// A new key, reason, level or provider needs a line here, deliberately. The lists mirror rimpl (the two
// packages share no code), so a value rimpl adds before this file learns it is recorded as NULL:
//   router_version  rimpl services/router.js ROUTER_VERSION, now `router-vN+<12 hex of the rules sha>`;
//                   the bare `router-vN` of an older rimpl is still accepted (mid-deploy)
//   reason          rimpl services/router.js REASONS: rescue, sticky, the categories of
//                   rimpl/src/lib/router-keywords.json, default
//   evidence_level  rimpl services/post-filter.js EVIDENCE_LEVELS keys
//   failed_over_from  a provider that may serve chat: lib/ai-providers.js AI_PROVIDER_CHOICES.chat, the
//                   backend's one list of which provider may serve which purpose
//
// DEEP MODE. The first turn of a session that the router serves as `deep` WITH thinking applied
// (`thinking: true`; routed deep on a provider that cannot think does not count) stamps ples.deep_mode_at, once
// (`.is('deep_mode_at', null)`: a later deep turn, or a concurrent one, matches no row). The route sends
// `deep_mode: true` on every later turn, so a session that needed depth is not dropped back to fast.
//
// ORDER: either order is safe (db/migration-chat-turn-flags.sql; migration first is preferred). If this
// code runs before the migration, both columns are missing; each write here is then logged (throttled) and
// skipped, and the turn is unaffected — it is already stored and answered.
const { supabase } = require('../lib/supabase');
const { AI_PROVIDER_CHOICES } = require('../lib/ai-providers');

const ROUTER_VERSION_RE = [/^router-v\d+\+[0-9a-f]{12}$/, /^router-v\d+$/];
const TIERS = new Set(['fast', 'deep']);
const REASONS = new Set(['rescue', 'sticky', 'dosing', 'interaction', 'pregnancy', 'paediatric', 'differential', 'explicit', 'default']);
const EVIDENCE_LEVELS = new Set(['high', 'moderate', 'low', 'expert', 'not_graded']);
const CHAT_PROVIDERS = new Set(AI_PROVIDER_CHOICES.chat);
const oneOf = (set) => (v) => (typeof v === 'string' && set.has(v) ? v : null);
const FLAG_FIELDS = {
  router_version: (v) => (typeof v === 'string' && ROUTER_VERSION_RE.some((re) => re.test(v)) ? v : null),
  tier: oneOf(TIERS),
  reason: oneOf(REASONS),
  thinking: (v) => (typeof v === 'boolean' ? v : null),
  thinking_budget: (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null),
  evidence_level: oneOf(EVIDENCE_LEVELS),
  failed_over_from: oneOf(CHAT_PROVIDERS),
};
const FLAG_KEYS = Object.keys(FLAG_FIELDS);

// rimpl's middleware_flags → exactly FLAG_KEYS, or null when there is nothing to keep (an older rimpl
// sends no flags; something that is not a plain object is not flags).
function sanitizeMiddlewareFlags(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const k of FLAG_KEYS) out[k] = Object.prototype.hasOwnProperty.call(raw, k) ? FLAG_FIELDS[k](raw[k]) : null;
  return out;
}

// Missing column (migration not applied): undefined column / not in PostgREST's schema cache, or either
// message shape naming the column. A CHECK or any other failure is NOT this.
const MISSING = new Set(['42703', 'PGRST204']);
function isMissingColumn(error, column) {
  if (!error) return false;
  if (MISSING.has(error.code)) return true;
  if (error.code) return false;
  return new RegExp(`column "?(?:[a-z_]+\\.)?${column}"? |'${column}' column`).test(error.message || '');
}

const lastLogAt = new Map();
function logThrottled(key, line) {
  const now = Date.now();
  if (now - (lastLogAt.get(key) || 0) < 60_000) return;
  lastLogAt.set(key, now);
  console.error(line);
}
function _resetLogThrottle() { lastLogAt.clear(); }

// The non-atomic write, for a turn stored WITHOUT the flags (the old store_chat_turn signature, or the
// two-insert fallback). Never throws; never fails the turn.
async function recordMiddlewareFlags(messageId, flags) {
  if (!flags) return 'skipped';
  try {
    const { error } = await supabase.from('messages').update({ middleware_flags: flags })
      .eq('id', messageId).eq('role', 'assistant');
    if (!error) return 'recorded';
    if (isMissingColumn(error, 'middleware_flags')) {
      logThrottled('middleware_flags', `[router] messages.middleware_flags missing — per-turn flags are NOT recorded until db/migration-chat-turn-flags.sql is applied: ${error.message}`);
      return 'unavailable';
    }
    console.error(`[router] failed to record middleware_flags on message ${messageId}: ${error.message}`);
    return 'error';
  } catch (e) {
    console.error(`[router] failed to record middleware_flags on message ${messageId}: ${e.message}`);
    return 'error';
  }
}

// Set ples.deep_mode_at once. A failed write is logged (throttled: before the migration it fails on every
// deep turn) and never fails the turn; the next deep turn simply tries again.
async function latchDeepMode(pleId) {
  try {
    const { error } = await supabase.from('ples').update({ deep_mode_at: new Date().toISOString() })
      .eq('id', pleId).is('deep_mode_at', null);
    if (!error) return 'latched';
    if (isMissingColumn(error, 'deep_mode_at')) {
      logThrottled('deep_mode_at', `[router] ples.deep_mode_at missing — deep mode is NOT sticky until db/migration-chat-turn-flags.sql is applied: ${error.message}`);
      return 'unavailable';
    }
    logThrottled('deep_mode_at:error', `[router] could not latch deep mode on PLE ${pleId}: ${error.message}`);
    return 'error';
  } catch (e) {
    logThrottled('deep_mode_at:error', `[router] could not latch deep mode on PLE ${pleId}: ${e.message}`);
    return 'error';
  }
}

module.exports = {
  sanitizeMiddlewareFlags, recordMiddlewareFlags, latchDeepMode, isMissingColumn, FLAG_KEYS, _resetLogThrottle,
  REASONS, EVIDENCE_LEVELS, CHAT_PROVIDERS,
};
