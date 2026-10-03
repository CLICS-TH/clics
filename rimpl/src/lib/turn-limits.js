'use strict';

// Per-reply output ceiling for the PLE dialogue (routes/chat.js). Lives here so the history cap below
// is derived from the SAME number and can never fall under a legitimate reply.
// 5200, was 4000: claude-sonnet-5-5's tokenizer counts ~30% more tokens for the same text (official
// migration guide), so 4000 x 1.3 keeps the same reply LENGTH in characters. Chat runs `between_tools`
// (no thinking; lib/anthropic-request.js), so none of it goes to thinking. It is a ceiling: replies
// rarely approach it, and the backend's 100s chat timeout bounds the turn whatever this says. The
// SPEND is bounded too: when the backend hangs up at 100s, the request's abort signal now cancels the
// in-flight Anthropic call (providers/anthropic.js), so a turn nobody will read stops generating.
// Tokens produced before the abort are still billed, and no response reports them.
const CHAT_MAX_TOKENS = Math.max(1500, parseInt(process.env.RIMPL_CHAT_MAX_TOKENS || '5200', 10));

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
// upper bound: 31200 chars at the default 5200 tokens (24000 at the old 4000). Sonnet 5.5's tokenizer
// gives FEWER chars per token than 4-6's, so 6 stays a generous bound. Raising RIMPL_CHAT_MAX_TOKENS
// raises the cap with it. The backend guest route uses the same 31200 (backend/src/routes/guest.js);
// keep them aligned.
const MAX_TURN_CHARS = Math.max(24000, CHAT_MAX_TOKENS * 6);

module.exports = { CHAT_MAX_TOKENS, MAX_TURN_CHARS };
