// AES-256-GCM encryption for the on-prem OAuth-identity vault (oauth_identities).
// The real OAuth identity (name/email/provider id) is encrypted here and never leaves
// on-premise; only professionals.pseudonym is ever externally visible. See docs/constraints.md.
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

// Derive a stable 32-byte key from the env secret (any length input works).
// In production IDENTITY_ENC_KEY MUST be set (a long random string). In dev we fall
// back to a fixed key so the local stack runs without the secret — with a loud warning.
function key() {
  let secret = process.env.IDENTITY_ENC_KEY;
  if (!secret) {
    // Match the app-wide production definition (index.js / supabase.js): Railway sets
    // RAILWAY_ENVIRONMENT but not necessarily NODE_ENV, so keying on NODE_ENV alone would let the
    // insecure dev key slip through on a Railway box if this ran outside the boot env-check.
    if (!!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production') {
      throw new Error('IDENTITY_ENC_KEY is required in production (identity vault encryption key)');
    }
    console.warn('[crypto] IDENTITY_ENC_KEY unset — using an INSECURE dev key. Set it in prod.');
    secret = 'clics-dev-identity-key-do-not-use-in-prod';
  }
  return crypto.createHash('sha256').update(secret).digest(); // 32 bytes
}

// Encrypt a JSON-serializable value -> compact base64 string (iv | tag | ciphertext).
function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

// Decrypt a string produced by encryptJson back into the original value.
function decryptJson(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = { encryptJson, decryptJson };
