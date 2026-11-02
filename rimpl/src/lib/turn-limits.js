'use strict';

// Every ceiling here is read from env ONCE, at load. The CODE DEFAULTS and the env names are exported
// as well (CHAT_LIMIT_DEFAULTS, and resolveChatMaxTokens / resolveChatDeepMaxTokens take the env as an
// argument), so the model manifest (lib/manifest.js) records what the code ships with — resolve({}) —
// rather than whatever env the build machine happens to have. Package-free: no require() at all.

// Per-reply output ceiling for the PLE dialogue (routes/chat.js). Lives here so the history cap below
// is derived from the SAME number and can never fall under a legitimate reply.
// RIMPL_CHAT_MAX_TOKENS, default 4000, floor 1500. A value that does not parse falls back to the default:
// it used to be Math.max(1500, NaN) = NaN, i.e. `"max_tokens": null` on every chat turn (Anthropic 400s).
function resolveChatMaxTokens(env = process.env) {
  const n = parseInt(env?.RIMPL_CHAT_MAX_TOKENS || String(CHAT_FAST_DEFAULT), 10);
  return Number.isFinite(n) ? Math.max(CHAT_FAST_MIN, n) : CHAT_FAST_DEFAULT;
}
const CHAT_FAST_DEFAULT = 4000;
const CHAT_FAST_MIN = 1500;
const CHAT_MAX_TOKENS = resolveChatMaxTokens();

// Per-reply ceiling for the FIRST call of a DEEP turn of the fast/deep router (services/router.js), used
// only when the router is on AND the chat provider honours `thinking` (routes/chat.js). A corrective retry
// never thinks, so it runs at CHAT_MAX_TOKENS even after a deep first call. RIMPL_CHAT_DEEP_MAX_TOKENS.
//
// WHY LARGER THAN CHAT_MAX_TOKENS: on every OpenAI-compatible server the reasoning tokens count against
// max_tokens. A deep ceiling equal to the fast one would let the reasoning eat the reply: a model that
// thought for 3000 tokens would have 1000 left for an answer the fast tier gives 4000. So the default is
// the fast ceiling PLUS a reasoning allowance, and the ceiling is floored at the fast one — a deep turn
// never has less room for its reply than a fast turn.
//
// WHY THIS ALLOWANCE (4000, so 8000 by default): a clinical reasoning trace on the CCME tutor class of
// model runs ~1-3k tokens; 4000 covers that with headroom, while still stopping a runaway at twice the
// fast ceiling. On the measured on-prem decode rate (~21 tok/s, docs/ARCHITECTURE-MAPPING-CCME.md §2)
// the backend's chat deadline (RIMPL_CHAT_TIMEOUT_MS: 100 s, 150 s on the local stack) binds at ~2-3k
// generated tokens, i.e. BEFORE this ceiling: on that box the deadline, not the ceiling, ends a turn
// that reasons too long. A larger ceiling would buy nothing there; a smaller one would truncate replies
// on a faster box. Cost is the tokens actually generated, not the ceiling.
const DEEP_REASONING_ALLOWANCE = 4000;
function resolveChatDeepMaxTokens(env = process.env, fast = resolveChatMaxTokens(env)) {
  const deepEnv = parseInt(env?.RIMPL_CHAT_DEEP_MAX_TOKENS ?? '', 10);
  return Math.max(fast, Number.isFinite(deepEnv) ? deepEnv : fast + DEEP_REASONING_ALLOWANCE);
}
const CHAT_DEEP_MAX_TOKENS = resolveChatDeepMaxTokens(process.env, CHAT_MAX_TOKENS);

// Longest content one transcript / history turn may carry into /chat and /audit-discuss.
//
// Why a cap at all: guest history is held by an anonymous client and replayed each turn, and every
// turn runs through the PII filter. An oversize turn is a cheap way to pin the event loop (review of
// PR #114). The filter is linear again, so this is defence in depth, not the fix.
//
// Why this size: it must NEVER reject a real turn, because on the scored path a 400 here fails the
// physician's CLE. Physician turns are capped at 5000 chars by the backend (MessageSchema, guest.js).
// An assistant turn is one model reply, at most CHAT_MAX_TOKENS tokens — or CHAT_DEEP_MAX_TOKENS on a
// deep turn of the router (the stored content is that reply text, see routes/chat.js; reasoning is
// stripped, but a model that did not reason could fill the whole deep ceiling with reply). Thai runs
// ~1-2 chars/token and English ~4, so 6 chars/token is a generous upper bound: 48000 chars at the
// default 8000 deep tokens (24000 at the fast 4000). Sized from the LARGER ceiling whether or not the
// router is on now: chat_router_enabled is a live setting, and a deep reply stored while it was on stays
// in the history after it is switched off — a cap sized from the fast ceiling would then 400 every later
// turn of that PLE. Raising either env raises the cap with it. The backend guest route has its own copy
// (backend/src/routes/guest.js, 24000); it must be raised with this if guest turns can ever be routed deep.
const MAX_TURN_CHARS = Math.max(24000, Math.max(CHAT_MAX_TOKENS, CHAT_DEEP_MAX_TOKENS) * 6);

// The evidence marker's marker-ONLY retry (routes/chat.js) asks for one line, never a reply. Sized from
// the longest valid line (lib/prompts.js EVIDENCE_LEVELS, "…ความเห็นผู้เชี่ยวชาญ (Evidence for the main
// recommendation: expert opinion)"): 104 chars, 47 of them Thai. At a worst case of one token per Thai
// codepoint plus one per English word or punctuation mark that is ~63 tokens; 128 is twice that, so a
// line is never truncated, while a model that ignores "line only" is cut off after a sentence or two.
// Cost is the tokens actually written, not this ceiling.
const EVIDENCE_LINE_MAX_TOKENS = 128;

// A booth turn (services/booth.js, #211) is at most three short sentences. Thai runs ~1-2 chars/token, so a
// compliant reply needs ~150-300 tokens; 400 never truncates one, stops a runaway after a few sentences,
// and keeps the turn fast. Fixed in code, no env. Cost is the tokens actually written, not this ceiling.
const BOOTH_MAX_TOKENS = 400;
// A booth turn that also picks from the bank (#246) wraps that reply in JSON with a one-sentence bridge
// (<= 120 chars, up to ~120 Thai tokens), a variant id, three option ids and the keys: ~460 tokens at
// the worst case. Truncated JSON loses the reply AND the pick, so the headroom is wider than for plain text.
const BOOTH_GRILL_MAX_TOKENS = 600;

// OPTIONAL-RETRY CUTOFF. The backend hangs up on a chat turn after RIMPL_CHAT_TIMEOUT_MS (default 100 s,
// backend/src/services/rimpl-client.js CHAT_TIMEOUT_MS) and fails it closed with a 502. RIMPL is not told
// that budget, so it assumes half of the default: an OPTIONAL retry — language-only or evidence-only, the
// two whose first reply was already deliverable — is skipped once the turn has run longer than this,
// because a retry as slow as the first call would push the turn past the backend's deadline and turn a
// deliverable reply into a lost turn. A required retry (missing citation/❓, rescue rules) still runs.
// Env-tunable; keep it at about half the backend's value if either moves.
const OPTIONAL_RETRY_CUTOFF_DEFAULT_MS = 50000;
const cutoffEnv = parseInt(process.env.RIMPL_CHAT_OPTIONAL_RETRY_CUTOFF_MS ?? '', 10);
const CHAT_OPTIONAL_RETRY_CUTOFF_MS = Number.isFinite(cutoffEnv) && cutoffEnv >= 0 ? cutoffEnv : OPTIONAL_RETRY_CUTOFF_DEFAULT_MS;

// The code defaults and env names, for the model manifest. The resolved values above are what runs.
const CHAT_LIMIT_DEFAULTS = Object.freeze({
  fast: Object.freeze({ maxTokens: CHAT_FAST_DEFAULT, min: CHAT_FAST_MIN, env: 'RIMPL_CHAT_MAX_TOKENS' }),
  deep: Object.freeze({
    maxTokens: resolveChatDeepMaxTokens({}), reasoningAllowance: DEEP_REASONING_ALLOWANCE,
    floor: 'the fast ceiling', env: 'RIMPL_CHAT_DEEP_MAX_TOKENS',
  }),
  evidenceLine: Object.freeze({ maxTokens: EVIDENCE_LINE_MAX_TOKENS }),
  booth: Object.freeze({ maxTokens: BOOTH_MAX_TOKENS }),
  boothGrill: Object.freeze({ maxTokens: BOOTH_GRILL_MAX_TOKENS }),
  optionalRetryCutoffMs: Object.freeze({ default: OPTIONAL_RETRY_CUTOFF_DEFAULT_MS, env: 'RIMPL_CHAT_OPTIONAL_RETRY_CUTOFF_MS' }),
});

// The fast/deep router's tiers (services/router.js) as routes/chat.js applies them to the FIRST call of a
// turn, when the router is on AND the chat provider honours `thinking`: whether thinking is asked for, and
// which ceiling. A corrective retry never thinks and always runs at the fast ceiling (the marker-only
// evidence retry at EVIDENCE_LINE_MAX_TOKENS): a deep first call plus a thinking retry would roughly
// double a deep turn against the backend's chat deadline. A DESCRIPTION of chat.js's wiring for the model
// manifest — chat.js keeps its own expressions, which the quality harness pins as text (scripts/quality/
// request.test.mjs) — and tests/manifest-chat-policy.test.js runs the route and holds the two equal.
const TIER_POLICY = Object.freeze({
  fast: Object.freeze({ thinking: false, maxTokens: CHAT_MAX_TOKENS }),
  deep: Object.freeze({ thinking: true, maxTokens: CHAT_DEEP_MAX_TOKENS }),
});
const RETRY_POLICY = Object.freeze({ thinking: false, maxTokens: CHAT_MAX_TOKENS });

module.exports = {
  CHAT_MAX_TOKENS, CHAT_DEEP_MAX_TOKENS, MAX_TURN_CHARS, EVIDENCE_LINE_MAX_TOKENS, CHAT_OPTIONAL_RETRY_CUTOFF_MS,
  BOOTH_MAX_TOKENS, BOOTH_GRILL_MAX_TOKENS, DEEP_REASONING_ALLOWANCE, CHAT_LIMIT_DEFAULTS, TIER_POLICY, RETRY_POLICY,
  resolveChatMaxTokens, resolveChatDeepMaxTokens,
};
