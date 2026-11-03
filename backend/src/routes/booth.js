const { Router } = require('express');
const { limit } = require('../lib/rate-limit');
const { UUID_RE } = require('../lib/turn-idempotency');
const booth = require('../services/booth');

const router = Router();

// Sized for one busy kiosk: a play is 1 start, 3 replies and 1 score over about 5 minutes. Each start opens a
// fresh spend ceiling, so the /plays budget is the per-IP spend brake.
const REQUESTS_PER_MIN = 40;
const PLAY_CALLS_PER_MIN = 12;
// A reroll is one tap and spends nothing, and the ghost-tap guard plus the round trip cap a hand at about 80 a
// minute. The limit sits above that, so it stops a script and never a visitor, and draws stay out of the general
// budget that the status poll, the replies and the score call share.
const DRAW_CALLS_PER_MIN = 240;

/** @type {Record<import('../services/booth').Refusal, [number, string]>} */
const REFUSAL = {
  bad_request: [400, 'That answer could not be read.'],
  case_off: [409, 'That case is not available.'],
  closed: [403, 'The booth is closed.'],
  not_found: [404, 'No such booth play.'],
  not_started: [409, 'This booth play has already ended.'],
  unavailable: [503, 'The booth is unavailable right now.'],
};

function send(res, result, ok = 200) {
  if ('body' in result) return res.status(ok).json(result.body);
  const [status, error] = REFUSAL[result.refused];
  return res.status(status).json({ error, reason: result.refused });
}

// Express 4 does not catch a rejected async handler.
const route = (fn, ok) => async (req, res) => {
  let result;
  try { result = await fn(req); } catch (err) { console.error('[booth]', err.message); result = { refused: 'unavailable' }; }
  send(res, result, ok);
};

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const general = limit(60_000, REQUESTS_PER_MIN, 'The booth is busy. Slow down.');
router.use((req, res, next) => (req.path === '/draw' ? next() : general(req, res, next)));
router.use('/plays', limit(60_000, PLAY_CALLS_PER_MIN, 'The booth is busy. Slow down.'));
router.use('/draw', limit(60_000, DRAW_CALLS_PER_MIN, 'The booth is busy. Slow down.'));

router.param('id', (_req, res, next, id) => (UUID_RE.test(id) ? next() : send(res, { refused: 'not_found' })));

router.get('/status', route(() => booth.boothStatus()));
router.get('/board', route(() => booth.boardFor()));
router.post('/draw', route((req) => booth.drawCase(req.body)));
router.post('/plays', route((req) => booth.startPlay(req.body), 201));
router.post('/plays/:id/reply', route((req) => booth.replyToStep(req.params.id, req.body)));
router.post('/plays/:id/score', route((req) => booth.scorePlay(req.params.id, req.body)));

module.exports = router;
