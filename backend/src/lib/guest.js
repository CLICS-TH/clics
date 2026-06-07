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
  s.count += 1;
  // Keep the spent session (count === MAX) so a later attempt reports 'ended', not
  // 'expired'; the TTL sweep reclaims it. Guest data is still never persisted.
  const session_ended = s.count >= MAX_PROMPTS;
  return { ok: true, used: s.count, remaining: MAX_PROMPTS - s.count, session_ended };
}

module.exports = { MAX_PROMPTS, startGuestSession, verifyGuestToken, consumeGuestPrompt, _sessions: sessions };
