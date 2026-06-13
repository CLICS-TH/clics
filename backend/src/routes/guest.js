// Guest mode — ephemeral, incognito-style trial of the AI (max 2 prompts, one session).
// NO account, NO ples/messages/audit rows are ever written. The client holds the
// conversation history and replays it each turn; the only egress is the message text
// → RIMPL (PII-stripped) → cloud AI, exactly like a physician turn. See backend/src/lib/guest.js.
const { Router } = require('express');
const { z } = require('zod');
const { startGuestSession, verifyGuestToken, consumeGuestPrompt, MAX_PROMPTS } = require('../lib/guest');
const { rimplChat } = require('../services/rimpl-client');

const router = Router();

const GuestMessageSchema = z.object({
  message: z.string().min(1).max(5000),
  language: z.enum(['th', 'en']).default('th'),
  history: z.array(z.object({ role: z.string(), content: z.string() })).max(8).default([]),
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
    return res.status(502).json({ error: `RIMPL unavailable: ${err.message}` });
  }

  res.json({
    ...rimplResponse,
    prompts_used: reserve.used,
    prompts_remaining: reserve.remaining,
    session_ended: reserve.session_ended,
  });
});

module.exports = router;
