const { Router } = require('express');
const { limit } = require('../lib/rate-limit');
const { UUID_RE } = require('../lib/turn-idempotency');
const booth = require('../services/booth');

const router = Router();

// Sized for one busy kiosk: a play is 1 start, 3 replies and 1 score over about 5 minutes. Each start opens a
// fresh spend ceiling, so the /plays budget is the per-IP spend brake.
const REQUESTS_PER_MIN = 40;
const PLAY_CALLS_PER_MIN = 12;

/** @type {Record<import('../services/booth').Refusal, [number, string]>} */
const REFUSAL = {
  bad_request: [400, 'That answer could not be read.'],
  closed: [403, 'The booth is closed.'],
  not_found: [404, 'No such booth play.'],
  not_started: [409, 'This booth play has already ended.'],
  ai_unavailable: [502, 'The AI reply is unavailable right now.'],
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
router.use(limit(60_000, REQUESTS_PER_MIN, 'The booth is busy. Slow down.'));
router.use('/plays', limit(60_000, PLAY_CALLS_PER_MIN, 'The booth is busy. Slow down.'));

router.param('id', (_req, res, next, id) => (UUID_RE.test(id) ? next() : send(res, { refused: 'not_found' })));

router.get('/status', route(() => booth.boothStatus()));
router.get('/board', route(() => booth.boardFor()));
router.post('/plays', route(() => booth.startPlay(), 201));
router.post('/plays/:id/reply', route((req) => booth.replyToStep(req.params.id, req.body)));
router.post('/plays/:id/score', route((req) => booth.scorePlay(req.params.id, req.body)));

module.exports = router;
