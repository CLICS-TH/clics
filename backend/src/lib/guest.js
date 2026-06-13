// Guest mode: a fully ephemeral, incognito-style trial of the AI.
//
// Boundary guarantees (see docs/constraints.md):
//  - NO auth.users row, NO professionals row, NO ples/messages/audit rows — EVER.
//  - The only egress is the message text -> RIMPL PII-strip -> cloud AI (same boundary
//    as a physician). The guest token carries only a random session id, no identity.
//  - The 2-prompt cap is enforced by an in-memory TTL counter keyed by session id.
//    On backend restart or TTL expiry the session simply vanishes (guest is single-session
//    by definition); nothing is carried across sessions.
const crypto = require('crypto');

const MAX_PROMPTS = 2;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

// AGGREGATE guest AI-spend brake. The per-session 2-prompt cap bounds ONE session, but /start is free
// and unauthenticated, so an attacker can mint unlimited fresh sessions (bounded only by the per-IP
// rate limit, trivially multiplied across IPs) and run unbounded paid Claude calls on the org's
// prepaid budget. This hourly ceiling on total guest prompts is the missing global bound. In-memory
// (resets on restart) matches guest mode's ephemeral design and is sufficient for the single-instance
// pilot; tune via GUEST_HOURLY_PROMPT_CAP. Each prompt = up to 2 Claude calls, so 300/hr ≈ a few $/hr.
const GUEST_HOURLY_PROMPT_CAP = parseInt(process.env.GUEST_HOURLY_PROMPT_CAP || '300', 10);
let _budgetWindow = { hourStart: 0, count: 0 };
function reserveGlobalGuestBudget(now) {
  const hourStart = now - (now % 3_600_000);
  if (_budgetWindow.hourStart !== hourStart) _budgetWindow = { hourStart, count: 0 };
  if (_budgetWindow.count >= GUEST_HOURLY_PROMPT_CAP) return false;
  _budgetWindow.count += 1;
  return true;
}

// In-memory source of truth for the prompt cap: sessionId -> { count, expiresAt }.
const sessions = new Map();

function secret() {
  const s = process.env.GUEST_TOKEN_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('GUEST_TOKEN_SECRET is required in production');
    }
    return 'clics-dev-guest-secret-do-not-use-in-prod';
  }
  return s;
}

function sign(sessionId, expiresAt) {
  return crypto.createHmac('sha256', secret()).update(`${sessionId}.${expiresAt}`).digest('base64url');
}

// Drop expired sessions (called opportunistically).
function sweep(now) {
  for (const [id, s] of sessions) if (s.expiresAt <= now) sessions.delete(id);
}

// Start a new guest session -> { token, session_id, max_prompts }.
function startGuestSession(now = Date.now()) {
  sweep(now);
  const sessionId = crypto.randomUUID();
  const expiresAt = now + TTL_MS;
  sessions.set(sessionId, { count: 0, expiresAt });
  const token = `${sessionId}.${expiresAt}.${sign(sessionId, expiresAt)}`;
  return { token, session_id: sessionId, max_prompts: MAX_PROMPTS };
}

// Verify a guest token -> { sessionId } or null.
function verifyGuestToken(token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [sessionId, expiresStr, sig] = parts;
  const expiresAt = Number(expiresStr);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  const expected = sign(sessionId, expiresAt);
  // constant-time compare
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return { sessionId };
}

// Reserve one prompt for a session. Returns:
//  { ok: true, used, remaining, session_ended } on success,
//  { ok: false, reason } when the session is gone/expired or the cap is reached.
function consumeGuestPrompt(sessionId, now = Date.now()) {
  sweep(now);
  const s = sessions.get(sessionId);
  if (!s) return { ok: false, reason: 'expired' };
  if (s.count >= MAX_PROMPTS) return { ok: false, reason: 'ended' };
  // Aggregate brake BEFORE spending the session prompt: when the hourly guest ceiling is hit, reject
  // without consuming the session's own quota (so a legit guest can retry after the window rolls).
  if (!reserveGlobalGuestBudget(now)) return { ok: false, reason: 'global_cap' };
  s.count += 1;
  // Keep the spent session (count === MAX) so a later attempt reports 'ended', not
  // 'expired'; the TTL sweep reclaims it. Guest data is still never persisted.
  const session_ended = s.count >= MAX_PROMPTS;
  return { ok: true, used: s.count, remaining: MAX_PROMPTS - s.count, session_ended };
}

module.exports = {
  MAX_PROMPTS, GUEST_HOURLY_PROMPT_CAP,
  startGuestSession, verifyGuestToken, consumeGuestPrompt,
  _sessions: sessions,
  _resetGuestBudget: () => { _budgetWindow = { hourStart: 0, count: 0 }; },
};
