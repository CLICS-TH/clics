// THE shared-secret check for the RIMPL layer. One definition, because a second copy is a second
// place the PII boundary can be widened by accident.
//
// The dev carve-out is load-bearing and easy to lose in a copy: with no INTERNAL_TOKEN set the check
// is skipped, which is what lets a local stack run without one. src/index.js refuses to BOOT without
// a token in production, so "no token" can only ever mean development. A hand-rolled copy of this
// check that omits the carve-out 401s every local request instead — and one did.
function internalAuth(req, res, next) {
  const token = process.env.INTERNAL_TOKEN;
  if (!token) return next();
  if (req.headers['x-internal-token'] !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

module.exports = { internalAuth };
