// Invite-link tokens. The raw token is high-entropy (256-bit) and appears ONLY in the accept
// link; the DB stores only its sha256 hash. Lookups hash the incoming token and match the hash,
// so a DB read never exposes a usable token.
const crypto = require('crypto');

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function newInviteToken() {
  const raw = crypto.randomBytes(32).toString('base64url'); // 256 bits, URL-safe
  return { raw, hash: hashToken(raw) };
}

module.exports = { newInviteToken, hashToken };
