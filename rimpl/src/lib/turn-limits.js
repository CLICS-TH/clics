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

module.exports = { CHAT_MAX_TOKENS, MAX_TURN_CHARS };
