const { Router } = require('express');
const { verifyJwt, requireRole } = require('../middleware/auth');
const boothAudits = require('../services/booth-audits');

const router = Router();
router.use(verifyJwt, requireRole('auditor'));

const REFUSAL = {
  not_found: [404, { error: 'Not found', code: 'booth_study_not_found' }],
  already_audited: [409, { error: 'Already audited', code: 'booth_already_audited' }],
};

// Express 4 does not catch a rejected async handler.
const route = (fn, ok, unavailable) => async (req, res) => {
  let result;
  try { result = await fn(req); } catch (err) { console.error('[booth-audits]', err.message); result = { refused: 'unavailable' }; }
  if ('body' in result) return res.status(ok).json(result.body);
  if (result.refused === 'bad_request') return res.status(400).json({ error: result.error });
  if (result.refused === 'unavailable') return res.status(502).json({ error: unavailable });
  const [status, body] = REFUSAL[result.refused];
  return res.status(status).json(body);
};

const LOAD_FAILED = 'Could not load the booth case studies — try again';
router.get('/', route((req) => boothAudits.queue(req.user.id), 200, LOAD_FAILED));
router.get('/:id', route((req) => boothAudits.study(req.params.id, req.user.id), 200, LOAD_FAILED));
router.post('/:id/audit', route((req) => boothAudits.submit(req.params.id, req.user.id, req.body),
  201, 'Could not save the audit — try again'));

module.exports = router;
