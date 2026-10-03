// Guest mode — ephemeral, incognito-style trial of the AI (max 2 prompts, one session).
// NO account, NO ples/messages/audit rows are ever written. The client holds the
// conversation history and replays it each turn; the only egress is the message text
// → RIMPL (PII-stripped) → cloud AI, exactly like a physician turn. See backend/src/lib/guest.js.
const { Router } = require('express');
const { z } = require('zod');
const { startGuestSession, verifyGuestToken, consumeGuestPrompt, MAX_PROMPTS } = require('../lib/guest');
const { rimplChat } = require('../services/rimpl-client');
const { isRimplRefusal, AI_REFUSED_MESSAGE } = require('../lib/rimpl-refusal');

const router = Router();

// History is held by an anonymous client and replayed each turn, so every item is attacker-sized
// input to the RIMPL PII filter — cap it. 31200 chars, not 5000: an assistant reply in that history is
// one chat reply of up to RIMPL_CHAT_MAX_TOKENS (default 5200 since claude-sonnet-5-5; was 4000)
// tokens, which can legitimately run well past 5000 Thai/English chars (6 chars/token is a generous
// bound: 5200 x 6). Keep in step with MAX_TURN_CHARS in rimpl/src/lib/turn-limits.js; raise both if
// RIMPL_CHAT_MAX_TOKENS is raised above 5200.
const MAX_GUEST_TURN_CHARS = 31200;

const GuestMessageSchema = z.object({
  message: z.string().min(1).max(5000),
  language: z.enum(['th', 'en']).default('th'),
  history: z.array(z.object({ role: z.string(), content: z.string().max(MAX_GUEST_TURN_CHARS) })).max(8).default([]),
});

function guestToken(req) {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

// Begin a guest session → { token, session_id, max_prompts }.
router.post('/start', (_req, res) => {
  res.status(201).json(startGuestSession());
});

// One guest turn. The 2-prompt cap is reserved up-front (atomic) so it can never be
// exceeded; a RIMPL failure therefore still spends the prompt (acceptable for a trial).
router.post('/message', async (req, res) => {
  const verified = verifyGuestToken(guestToken(req));
  if (!verified) return res.status(401).json({ error: 'Guest session invalid or expired. Start a new one.', reason: 'expired' });

  const parsed = GuestMessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const reserve = consumeGuestPrompt(verified.sessionId);
  if (!reserve.ok) {
    // The aggregate hourly guest ceiling is a transient brake (try again later), not a per-session
    // terminal state — surface it as 503 so the client can retry, distinct from ended/expired (403).
    if (reserve.reason === 'global_cap') {
      return res.status(503).json({ error: 'Guest trial is busy right now — please try again later or request an account.', reason: 'global_cap' });
    }
    const msg = reserve.reason === 'ended'
      ? `Guest session ended (max ${MAX_PROMPTS} prompts). Request an account to continue.`
      : 'Guest session expired. Start a new one.';
    return res.status(403).json({ error: msg, reason: reserve.reason });
  }

  const { message, language, history } = parsed.data;
  let rimplResponse;
  try {
    rimplResponse = await rimplChat({ ple_id: verified.sessionId, history, message, language });
  } catch (err) {
    // Declined by the model's safeguards. Guests have no $ meter (the prompt count bounds them), so
    // there is nothing to settle. COPY PENDING (#136), as in routes/ples.js.
    if (isRimplRefusal(err)) {
      return res.status(422).json({ error: AI_REFUSED_MESSAGE, code: 'ai_refused' });
    }
    return res.status(502).json({ error: `RIMPL unavailable: ${err.message}` });
  }

  // Whitelisted for the same reason as routes/ples.js: rimpl's body carries provider / model /
  // prompt_version, which no client needs to see.
  res.json({
    content: rimplResponse.content,
    refs: rimplResponse.refs,
    socratic_question: rimplResponse.socratic_question,
    token_count: rimplResponse.token_count,
    prompts_used: reserve.used,
    prompts_remaining: reserve.remaining,
    session_ended: reserve.session_ended,
  });
});

module.exports = router;
