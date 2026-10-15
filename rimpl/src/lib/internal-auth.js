// THE shared-secret check for the RIMPL layer. One definition, because a second copy is a second
// place the PII boundary can be widened by accident.
//
// The dev carve-out is load-bearing and easy to lose in a copy: with no INTERNAL_TOKEN set the check
// is skipped, which is what lets a local stack run without one. src/index.js refuses to BOOT without
// a token in production, so "no token" can only ever mean development. A hand-rolled copy of this
// check that omits the carve-out 401s every local request instead — and one did.
//
// CONSTANT-TIME. A `!==` on the secret returns at the first differing byte, so the response time leaks
// how much of a guess was right. Both sides are hashed to SHA-256 first, so crypto.timingSafeEqual always
// compares two equal-length (32-byte) buffers: a length mismatch cannot throw, and when the comparison
// stops says nothing about the secret's length. A missing, empty or non-string header (a repeated
// header can arrive as an array) is a reject. The 401 body is unchanged.
const crypto = require('crypto');

const digest = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();

function tokenMatches(given, expected) {
  if (typeof given !== 'string' || given.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function internalAuth(req, res, next) {
  const token = process.env.INTERNAL_TOKEN;
  if (!token) return next();
  if (!tokenMatches(req.headers['x-internal-token'], token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

module.exports = { internalAuth, tokenMatches };
