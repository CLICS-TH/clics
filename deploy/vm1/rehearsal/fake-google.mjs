// A stand-in for Google's OpenID provider, for the hermetic rehearsal only (#427). GoTrue (the pinned release) reaches
// Google through one issuer, https://accounts.google.com: it reads that issuer's discovery document, then
// takes the authorize, token and key endpoints from it (internal/api/provider/google.go). This server answers
// as that issuer on the rehearsal network (a network alias plus a certificate from a throwaway CA that only
// the rehearsal's GoTrue and replay trust), so GoTrue runs its real Google code: discovery, the signature and
// audience checks, the nonce check of the id_token grant, the code exchange of the redirect flow and
// same-email linking. Never part of a vm1 run: run.sh loads it only for `hermetic`.
//
// Endpoints, all on https://accounts.google.com:
//   GET  /.well-known/openid-configuration, GET /certs   discovery and the signing key
//   GET  /o/oauth2/v2/auth   the consent screen: answers at once for the identity queued by POST /__next,
//                            redirecting to redirect_uri with a one-time code and the caller's state
//   POST /token              the code exchange: client id and secret must match, returns an id_token
//   POST /__next             test control: { email, name } for the next consent
//   POST /__mint             test control: an id_token as Google Identity Services would hand the Portal,
//                            { email, name, nonce_hash, aud?, foreign_key? } (foreign_key signs with a key
//                            that is not in /certs, for the control)
// Holds nothing on disk; every identity is @rehearsal.invalid. Logs nothing.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createSign, generateKeyPairSync, randomBytes, createHash } from 'node:crypto';

const ISSUER = 'https://accounts.google.com';
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required');

const KID = randomBytes(8).toString('hex');
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, privateKey = key.privateKey) {
  const head = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const body = b64(claims);
  const s = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${s}`;
}
// A stable Google subject per address, as Google gives one account one `sub`.
const subOf = (email) => `1${BigInt(`0x${createHash('sha256').update(email).digest('hex').slice(0, 15)}`).toString().padStart(20, '0')}`;
function idToken({ email, name, nonce_hash, aud = CLIENT_ID }, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    iss: ISSUER, aud, azp: aud, sub: subOf(email), email, email_verified: true, name,
    iat: now, exp: now + 3600, ...(nonce_hash ? { nonce: nonce_hash } : {}),
  }, privateKey);
}

let next = null;
const codes = new Map();

function body(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => resolve(s));
  });
}
function send(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

createServer({ key: readFileSync(process.env.TLS_KEY), cert: readFileSync(process.env.TLS_CERT) }, async (req, res) => {
  const url = new URL(req.url, ISSUER);
  if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
    return send(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/certs`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    });
  }
  if (req.method === 'GET' && url.pathname === '/certs') return send(res, 200, { keys: [jwk] });
  if (req.method === 'POST' && url.pathname === '/__next') {
    next = JSON.parse(await body(req));
    return send(res, 204);
  }
  if (req.method === 'POST' && url.pathname === '/__mint') {
    const p = JSON.parse(await body(req));
    return send(res, 200, { id_token: idToken(p, p.foreign_key ? foreign.privateKey : undefined) });
  }
  if (req.method === 'GET' && url.pathname === '/o/oauth2/v2/auth') {
    const q = url.searchParams;
    if (q.get('client_id') !== CLIENT_ID || q.get('response_type') !== 'code' || !next) return send(res, 400, { error: 'invalid_request' });
    const code = randomBytes(16).toString('hex');
    codes.set(code, { identity: next, redirect_uri: q.get('redirect_uri') });
    next = null;
    const to = new URL(q.get('redirect_uri'));
    to.searchParams.set('code', code);
    to.searchParams.set('state', q.get('state') || '');
    return send(res, 302, undefined, { Location: to.toString() });
  }
  if (req.method === 'POST' && url.pathname === '/token') {
    const form = new URLSearchParams(await body(req));
    // The client authenticates with HTTP Basic or in the form, as golang.org/x/oauth2 chooses.
    const basic = /^Basic (.+)$/.exec(req.headers.authorization || '')?.[1];
    const [bid, bsecret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [];
    const id = bid ?? form.get('client_id');
    const secret = bsecret ?? form.get('client_secret');
    if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return send(res, 401, { error: 'invalid_client' });
    const grant = codes.get(form.get('code'));
    codes.delete(form.get('code'));
    if (!grant || grant.redirect_uri !== form.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant' });
    return send(res, 200, {
      access_token: randomBytes(24).toString('hex'), token_type: 'Bearer', expires_in: 3600,
      scope: 'openid email profile', id_token: idToken(grant.identity),
    });
  }
  return send(res, 404, { error: 'not_found' });
}).listen(443);
