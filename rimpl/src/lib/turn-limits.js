'use strict';

// Per-reply output ceiling for the PLE dialogue (routes/chat.js). Lives here so the history cap below
// is derived from the SAME number and can never fall under a legitimate reply.
const CHAT_MAX_TOKENS = Math.max(1500, parseInt(process.env.RIMPL_CHAT_MAX_TOKENS || '4000', 10));

// Longest content one transcript / history turn may carry into /chat and /audit-discuss.
//
// Why a cap at all: guest history is held by an anonymous client and replayed each turn, and every
// turn runs through the PII filter. An oversize turn is a cheap way to pin the event loop (review of
// PR #114). The filter is linear again, so this is defence in depth, not the fix.
//
// Why this size: it must NEVER reject a real turn, because on the scored path a 400 here fails the
// physician's CLE. Physician turns are capped at 5000 chars by the backend (MessageSchema, guest.js).
// An assistant turn is one model reply, at most CHAT_MAX_TOKENS tokens (the stored content is that reply
// text, see routes/chat.js). Thai runs ~1-2 chars/token and English ~4, so 6 chars/token is a generous
// upper bound: 24000 chars at the default 4000 tokens. Raising RIMPL_CHAT_MAX_TOKENS raises the cap
// with it. The backend guest route uses the same 24000 (backend/src/routes/guest.js); keep them aligned.
const MAX_TURN_CHARS = Math.max(24000, CHAT_MAX_TOKENS * 6);

// The evidence marker's marker-ONLY retry (routes/chat.js) asks for one line, never a reply. Sized from
// the longest valid line (lib/prompts.js EVIDENCE_LEVELS, "…ความเห็นผู้เชี่ยวชาญ (Evidence for the main
// recommendation: expert opinion)"): 104 chars, 47 of them Thai. At a worst case of one token per Thai
// codepoint plus one per English word or punctuation mark that is ~63 tokens; 128 is twice that, so a
// line is never truncated, while a model that ignores "line only" is cut off after a sentence or two.
// Cost is the tokens actually written, not this ceiling.
const EVIDENCE_LINE_MAX_TOKENS = 128;

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

module.exports = { CHAT_MAX_TOKENS, MAX_TURN_CHARS, EVIDENCE_LINE_MAX_TOKENS, CHAT_OPTIONAL_RETRY_CUTOFF_MS };
