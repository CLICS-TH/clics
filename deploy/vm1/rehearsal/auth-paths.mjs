// Replays every sign-in path that runs over HTTP against the self-hosted stack (#427), as the Portal and the
// backend drive it, and checks what the backend relies on. Runs in a one-off backend container on the
// rehearsal network (rehearsal/run.sh), so it has the backend's SUPABASE_URL and keys:
//
//   BACKEND_URL   the rehearsal backend                          default http://backend:3001
//   API_EXTERNAL_URL  the public origin: the reset link must be <it>/auth/v1/verify (run.sh passes gotrue.env's)
//   MAILPIT_URL   read GoTrue's mail from mailpit                 unset: codes come from GoTrue's admin API
//   OLD_PASSWORDS a file of `email<TAB>password` lines: accounts in the restored database whose password must
//                 still verify (the "Added 2026-11-11" check). Only their line numbers are printed.
//   HOSTED_SETTINGS  a file holding the hosted project's GET /auth/v1/settings, compared field by field
//   FAKE_GOOGLE   hermetic only: the Google stand-in (fake-google.mjs) answering as accounts.google.com. Set,
//                 the four Google paths run against GoTrue's real Google code; unset (vm1), they are skipped
//                 here and run by hand against the real Google (README.md).
//   SMTP_STANDIN  hermetic only: host:port of the Resend-shaped relay stand-in, for its refusal controls
//
// Every account this script creates is synthetic (@rehearsal.invalid) and is deleted at the end. Prints no
// token, key or password.
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';

const SB = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const BACKEND = process.env.BACKEND_URL || 'http://backend:3001';
const MAILPIT = process.env.MAILPIT_URL || '';
const AUTH = `${SB}/auth/v1`;
const REST = `${SB}/rest/v1`;
const RUN = randomBytes(4).toString('hex');
const pw = () => `Rh${randomBytes(9).toString('base64url')}7`;
const email = (tag) => `${tag}-${RUN}@rehearsal.invalid`;
const created = [];
let failed = 0;

async function call(base, path, { method = 'GET', token, key = SERVICE, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      apikey: key,
      ...(token || key ? { Authorization: `Bearer ${token || key}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text, location: res.headers.get('location') };
}
const backend = (path, opts = {}) => call(BACKEND, path, { key: null, ...opts });
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
function expect(cond, msg) { if (!cond) throw new Error(msg); }
// The reason only, never the body: a body can hold a token.
const reason = (r) => JSON.stringify(r.json?.error ?? r.json?.msg ?? r.json?.code ?? (r.json ? 'no error field' : r.text.slice(0, 160)));
function want(r, status, what) { expect(r.status === status, `${what}: HTTP ${r.status}, want ${status} (${reason(r)})`); return r; }

async function step(name, fn) {
  try { const note = await fn(); console.log(`  ok   ${name}${note ? `: ${note}` : ''}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name}: ${e.message}`); }
}

// GoTrue's mail, from mailpit: the newest message to `to` whose subject matches.
async function mailTo(to, subject) {
  for (let i = 0; i < 40; i += 1) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json();
    const hit = (list.messages || []).find((m) => subject.test(m.Subject));
    if (hit) return (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no mail to ${to} matching ${subject}`);
}

async function adminCreate(tag, extra = {}) {
  const r = want(await call(AUTH, '/admin/users', { method: 'POST', body: { email: email(tag), password: pw(), email_confirm: true, ...extra } }), 200, `create ${tag}`);
  created.push(r.json.id);
  return r.json;
}
async function insertProfessional(row) {
  want(await call(REST, '/professionals', { method: 'POST', body: row, headers: { Prefer: 'return=minimal' } }), 201, 'insert professionals');
}
async function login(addr, password) { return backend('/auth/login', { method: 'POST', body: { email: addr, password } }); }

console.log(`sign-in replay ${RUN} against ${SB} and ${BACKEND}`);

let health = null;
await step('GoTrue answers and names its version', async () => {
  health = want(await call(AUTH, '/health', { key: ANON }), 200, '/health').json;
  return `${health.name} ${health.version}`;
});

await step('GoTrue settings match what the sign-in paths need', async () => {
  const s = want(await call(AUTH, '/settings', { key: ANON }), 200, '/settings').json;
  const need = { 'external.email': true, 'external.google': true, 'external.phone': false, disable_signup: false, mailer_autoconfirm: false };
  const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
  for (const [p, v] of Object.entries(need)) expect(get(s, p) === v, `${p} is ${get(s, p)}, want ${v}`);
  if (process.env.HOSTED_SETTINGS) {
    const hosted = JSON.parse(readFileSync(process.env.HOSTED_SETTINGS, 'utf8'));
    const keys = ['external.email', 'external.google', 'external.phone', 'external.anonymous_users', 'disable_signup', 'mailer_autoconfirm', 'phone_autoconfirm', 'sms_provider', 'saml_enabled'];
    const diff = keys.filter((k) => JSON.stringify(get(hosted, k)) !== JSON.stringify(get(s, k)));
    expect(!diff.length, `differs from the hosted project on ${diff.join(', ')}`);
    return 'equal to the hosted project on every compared field';
  }
  return 'no HOSTED_SETTINGS given: required values only';
});

// A council with its first specialty: what an invite and a superadmin-created physician need.
let council = null;
let specialty = null;
await step('PostgREST serves the backend (service_role) through supabase-gw', async () => {
  council = want(await call(REST, '/councils?select=id&limit=1'), 200, 'councils').json?.[0];
  expect(council, 'no council row');
  specialty = want(await call(REST, `/specialties?select=id&council_id=eq.${council.id}&limit=1`), 200, 'specialties').json?.[0] ?? null;
});

await step('ADR 0007: postgrest_exposure() lists nothing, and anon reads nothing', async () => {
  const r = want(await call(REST, '/rpc/postgrest_exposure', { method: 'POST', body: {} }), 200, 'postgrest_exposure');
  expect(Array.isArray(r.json) && r.json.length === 0, `postgrest_exposure lists ${JSON.stringify(r.json).slice(0, 200)}`);
  // Any refusal will do: today the professionals policy recurses (42P17, a 500) before the privilege check.
  const a = await call(REST, '/professionals?select=id&limit=1', { key: ANON });
  expect(a.status >= 400, `anon read of professionals answered ${a.status}`);
  return `anon refused with ${a.status} ${a.json?.code ?? ''}`.trim();
});

// A superadmin to drive the admin routes, made the way db/set-superadmin-password.js expects one to exist.
const superPw = pw();
let superToken = null;
// professionals_single_superadmin allows one superadmin, and a restored copy already has it: the replay
// demotes that row to analyst (a role with no council, like superadmin) on the copy for the run, and the clean-up step puts it back.
let heldSuperadmin = null;
await step('email + password: the backend signs a superadmin in, and verifyJwt accepts the token', async () => {
  const u = await adminCreate('super', { password: superPw });
  const existing = want(await call(REST, '/professionals?select=id&role=eq.superadmin'), 200, 'read the superadmin').json;
  if (existing.length) {
    heldSuperadmin = existing[0].id;
    want(await call(REST, `/professionals?id=eq.${heldSuperadmin}`, { method: 'PATCH', body: { role: 'analyst' }, headers: { Prefer: 'return=minimal' } }), 204, 'hold the restored superadmin');
  }
  await insertProfessional({ id: u.id, role: 'superadmin', full_name_th: 'ซ้อมระบบ', full_name_en: `Rehearsal Super ${RUN}`, status: 'active' });
  const r = want(await login(email('super'), superPw), 200, 'POST /auth/login');
  superToken = r.json.access_token;
  want(await backend('/auth/me', { token: superToken }), 200, 'GET /auth/me');
  const c = claims(superToken);
  expect(c.aud === 'authenticated' && c.role === 'authenticated' && c.sub === u.id, `claims aud=${c.aud} role=${c.role}`);
  expect(Array.isArray(c.app_metadata?.providers) && c.app_metadata.providers.includes('email'), `app_metadata.providers is ${JSON.stringify(c.app_metadata?.providers)}`);
  return `token lifetime ${c.exp - c.iat} s`;
});

await step('isGoogleSession reads app_metadata.providers from GET /user in the shape it expects', async () => {
  const u = want(await call(AUTH, '/user', { token: superToken, key: ANON }), 200, 'GET /user').json;
  expect(Array.isArray(u.app_metadata?.providers), 'app_metadata.providers is not an array');
  expect(u.app_metadata.provider === 'email', `app_metadata.provider is ${u.app_metadata.provider}`);
  const g = want(await call(AUTH, '/admin/users', { method: 'POST', body: { email: email('google-shape'), email_confirm: true, app_metadata: { provider: 'google', providers: ['google'] } } }), 200, 'create google-shaped');
  created.push(g.json.id);
  expect(g.json.app_metadata?.providers?.includes('google'), 'a Google-provider user does not carry google in app_metadata.providers');
  return 'email session -> providers [email]; a google-provider user -> providers incl. google';
});

await step('superadmin create, then delete: the professionals row goes with the auth user', async () => {
  const body = { email: email('created'), password: pw(), role: 'physician', council_id: council.id, full_name_th: 'แพทย์ซ้อม', full_name_en: `Rehearsal Created ${RUN}`, position: 'staff', ...(specialty ? { specialty_id: specialty.id } : {}) };
  const c = want(await backend('/admin/users', { method: 'POST', token: superToken, body }), 201, 'POST /admin/users');
  created.push(c.json.id);
  want(await call(AUTH, `/admin/users/${c.json.id}`), 200, 'GoTrue has the created user');
  want(await backend(`/admin/users/${c.json.id}/status`, { method: 'PATCH', token: superToken, body: { status: 'deactivated' } }), 200, 'deactivate');
  want(await backend(`/admin/users/${c.json.id}/purge`, { method: 'DELETE', token: superToken, body: { confirm_name: body.full_name_en } }), 200, 'purge');
  expect((await call(AUTH, `/admin/users/${c.json.id}`)).status === 404, 'GoTrue still has the purged user');
  // The cascade itself, without the route's own clean-up: delete in GoTrue, the row must go.
  const u = await adminCreate('cascade');
  await insertProfessional({ id: u.id, role: 'physician', council_id: council.id, full_name_th: 'ลบต่อ', full_name_en: `Rehearsal Cascade ${RUN}`, status: 'active' });
  want(await call(AUTH, `/admin/users/${u.id}`, { method: 'DELETE' }), 200, 'GoTrue delete');
  const left = want(await call(REST, `/professionals?select=id&id=eq.${u.id}`), 200, 'read back').json;
  expect(left.length === 0, 'professionals row survived the auth.users delete');
});

async function otpFor(addr, subject) {
  if (MAILPIT) {
    const m = await mailTo(addr, subject);
    const code = /\b(\d{6,10})\b/.exec(m.Text || '')?.[1];
    expect(code, `no code in the mail "${m.Subject}"`);
    return code;
  }
  const r = want(await call(AUTH, '/admin/generate_link', { method: 'POST', body: { type: 'magiclink', email: addr } }), 200, 'generate_link');
  return r.json.email_otp;
}

// The OTP and reset mails below reach mailpit only through GoTrue's SMTP client. In the hermetic run mailpit is
// the Resend-shaped relay: smtp.resend.com:465, implicit TLS with a certificate GoTrue must verify, and SMTP
// AUTH as `resend`. This shows the relay refuses anything less, so the mails that do arrive came that way.
if (process.env.SMTP_STANDIN) {
  await step('the relay stand-in takes only implicit TLS with SMTP AUTH (controls for the mail steps)', async () => {
    const [host, port] = process.env.SMTP_STANDIN.split(':');
    // A reply line from the relay, or the way the connection ended.
    const talk = (sock, lines) => new Promise((resolve) => {
      let buf = '';
      const out = [];
      sock.setTimeout(5000, () => { sock.destroy(); resolve([...out, 'timeout']); });
      sock.on('data', (d) => {
        buf += d.toString();
        const done = buf.split('\r\n');
        buf = done.pop();
        for (const l of done) {
          if (/^\d{3} /.test(l)) {
            out.push(l.slice(0, 3));
            const nextLine = lines.shift();
            if (nextLine === undefined) { sock.end(); resolve(out); return; }
            sock.write(`${nextLine}\r\n`);
          }
        }
      });
      sock.on('error', (e) => resolve([...out, e.code || 'error']));
      sock.on('close', () => resolve([...out, 'closed']));
    });
    // Plain SMTP to the TLS port: no greeting is ever read in clear text.
    const plain = await talk(netConnect(Number(port), host), ['EHLO rehearsal.invalid', 'QUIT']);
    expect(!plain.includes('220'), `a clear-text client got a greeting: ${plain.join(' ')}`);
    // TLS, verified against the rehearsal CA, but no AUTH: the relay refuses the sender.
    const tls = tlsConnect({ host, port: Number(port), servername: host });
    const noAuth = await talk(tls, ['EHLO rehearsal.invalid', 'MAIL FROM:<noreply@rehearsal.invalid>', 'QUIT']);
    expect(noAuth[0] === '220', `the TLS greeting was ${noAuth[0]}`);
    expect(/^5/.test(noAuth[2] || ''), `MAIL FROM without AUTH answered ${noAuth[2]}`);
    return `clear text: ${plain.join(' ')}; TLS without AUTH: MAIL FROM ${noAuth[2]}`;
  });
}

await step('invite accepted with a password: OTP mail from GoTrue, then the token', async () => {
  const addr = email('invitee');
  const inv = want(await backend('/admin/invites', { method: 'POST', token: superToken, body: { email: addr, role: 'physician', council_id: council.id, position: 'staff', ...(specialty ? { specialty_id: specialty.id } : {}) } }), 201, 'POST /admin/invites');
  const token = new URL(inv.json.accept_url).searchParams.get('token');
  const password = pw();
  const names = { full_name_th: 'ผู้รับเชิญ', full_name_en: `Rehearsal Invitee ${RUN}` };
  want(await backend(`/auth/invite/${token}/accept`, { method: 'POST', body: { method: 'password', password, ...names } }), 202, 'accept, step 1');
  const otp = await otpFor(addr, /confirm|sign ?up|magic|ยืนยัน/i);
  const done = want(await backend(`/auth/invite/${token}/accept`, { method: 'POST', body: { method: 'password', otp, password, ...names } }), 201, 'accept, step 2');
  created.push(claims(done.json.access_token).sub);
  want(await login(addr, password), 200, 'sign in with the new password');
  return MAILPIT ? 'code read from the mail GoTrue sent' : 'code from the admin API';
});

await step('forgot password: recovery link, new password, old one refused', async () => {
  const u = await adminCreate('forgot');
  await insertProfessional({ id: u.id, role: 'physician', council_id: council.id, full_name_th: 'ลืมรหัส', full_name_en: `Rehearsal Forgot ${RUN}`, status: 'active' });
  const old = pw();
  want(await call(AUTH, `/admin/users/${u.id}`, { method: 'PUT', body: { password: old } }), 200, 'set the old password');
  want(await backend('/auth/forgot-password', { method: 'POST', body: { email: email('forgot') } }), 200, 'POST /auth/forgot-password');
  let link;
  if (MAILPIT) {
    const m = await mailTo(email('forgot'), /reset|recover|รหัส/i);
    link = /(https?:\/\/[^\s"<>]+\/verify\?[^\s"<>]+)/.exec(m.Text || m.HTML || '')?.[1]?.replace(/&amp;/g, '&');
    expect(link, 'no /verify link in the reset mail');
  } else {
    link = want(await call(AUTH, '/admin/generate_link', { method: 'POST', body: { type: 'recovery', email: email('forgot') } }), 200, 'generate_link').json.action_link;
  }
  // The link a user clicks must be GoTrue's public /verify, which nginx serves at <origin>/auth/v1. From inside
  // the network that origin is reached through supabase-gw, so the same path and query are followed there.
  const ext = process.env.API_EXTERNAL_URL;
  expect(ext && link.startsWith(`${ext}/auth/v1/verify?`), `the reset link is not ${ext}/auth/v1/verify?...: ${new URL(link).origin}${new URL(link).pathname}`);
  const v = new URL(link);
  const r = await call(AUTH, `/verify${v.search}`, { key: ANON });
  expect(r.status === 303 || r.status === 302, `GET /verify answered ${r.status}`);
  const hash = new URLSearchParams(new URL(r.location).hash.slice(1));
  expect(hash.get('type') === 'recovery' && hash.get('access_token'), `redirect to ${new URL(r.location).pathname} without a recovery session`);
  const fresh = pw();
  want(await call(AUTH, '/user', { method: 'PUT', token: hash.get('access_token'), key: ANON, body: { password: fresh } }), 200, 'PUT /user');
  want(await login(email('forgot'), fresh), 200, 'sign in with the new password');
  expect((await login(email('forgot'), old)).status === 401, 'the old password still signs in');
  return `redirected to ${new URL(r.location).origin}${new URL(r.location).pathname}`;
});

await step('global sign-out revokes the token: the next request is 401', async () => {
  const t = want(await login(email('super'), superPw), 200, 'sign in').json.access_token;
  want(await backend('/auth/me', { token: t }), 200, 'before sign-out');
  want(await backend('/auth/logout', { method: 'POST', token: t }), 200, 'POST /auth/logout');
  want(await backend('/auth/me', { token: t }), 401, 'after sign-out');
});

// ---- Google (hermetic: the stand-in; vm1: by hand against the real Google, README.md) ----
// The Portal's two ways in, as google-signin.js and oauth-callback.js drive them:
//   in-page  Google Identity Services hands the Portal an id_token whose nonce is SHA-256(raw); the Portal
//            calls signInWithIdToken({ provider: 'google', token, nonce: raw }), which is this POST.
//   redirect signInWithOAuth: /authorize -> Google -> GoTrue's /callback -> the Portal's /auth/callback#tokens.
// Either session then goes to the same backend route as in the Portal.
const G = process.env.FAKE_GOOGLE;
const sha256hex = (v) => createHash('sha256').update(v).digest('hex');
async function google(path, body) {
  const r = await fetch(`${G}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.status === 204 ? null : r.json();
}
// What google-signin.js sends GoTrue: the raw nonce, with Google's token carrying its hash.
async function inPage(addr, { nonce = randomBytes(32).toString('hex'), sentNonce = nonce, ...mint } = {}) {
  const { id_token } = await google('/__mint', { email: addr, name: `Rehearsal ${addr.split('@')[0]}`, nonce_hash: sha256hex(nonce), ...mint });
  return call(AUTH, '/token?grant_type=id_token', { method: 'POST', key: ANON, body: { provider: 'google', id_token, ...(sentNonce === null ? {} : { nonce: sentNonce }) } });
}
async function googleSession(addr, what) {
  const r = want(await inPage(addr), 200, what);
  const c = claims(r.json.access_token);
  expect(c.app_metadata?.providers?.includes('google'), `${what}: app_metadata.providers is ${JSON.stringify(c.app_metadata?.providers)}`);
  return r.json.access_token;
}
// onboarding is what oauth-callback.js posts once the council (and, for a council with specialties, the
// training level and specialty) has been picked.
const onboarding = () => ({ council_id: council.id, ...(specialty ? { specialty_id: specialty.id, position: 'staff' } : {}) });

if (G) {
  await step('Google in-page: id_token with nonce signs up through /auth/oauth/google/complete', async () => {
    const t = await googleSession(email('g-inpage'), 'id_token grant');
    created.push(claims(t).sub);
    want(await backend('/auth/oauth/google/complete', { method: 'POST', body: { access_token: t } }), 400, 'complete without a council');
    want(await backend('/auth/oauth/google/complete', { method: 'POST', body: { access_token: t, ...onboarding() } }), 201, 'complete with a council');
    const me = want(await backend('/auth/me', { token: t }), 200, 'GET /auth/me').json.user;
    expect(me.role === 'physician' && me.status === 'active', `the new account is ${me.role}/${me.status}`);
    return 'GoTrue session providers incl. google; the backend provisioned an active physician';
  });

  await step('Google in-page controls: GoTrue refuses a wrong or missing nonce, a foreign key and another audience', async () => {
    const addr = email('g-refused');
    const cases = {
      'wrong nonce': await inPage(addr, { sentNonce: randomBytes(32).toString('hex') }),
      'nonce withheld': await inPage(addr, { sentNonce: null }),
      'signed by a key not in /certs': await inPage(addr, { foreign_key: true }),
      'audience of another client': await inPage(addr, { aud: 'someone-else.apps.googleusercontent.com' }),
    };
    const got = Object.entries(cases).map(([k, r]) => `${k} ${r.status}`);
    expect(Object.values(cases).every((r) => r.status >= 400 && r.status < 500 && !r.json?.access_token), `not all refused: ${got.join(', ')}`);
    const left = want(await call(AUTH, '/admin/users?per_page=1000'), 200, 'list auth users').json.users;
    expect(Array.isArray(left) && !left.some((u) => u.email === addr), 'a refused id_token still created an auth user');
    return got.join(', ');
  });

  await step('Google redirect fallback: /authorize, Google, /callback, a session in the Portal callback hash', async () => {
    const addr = email('g-redirect');
    const portalCallback = 'http://portal.rehearsal.invalid/auth/callback';
    const a = await call(AUTH, `/authorize?provider=google&redirect_to=${encodeURIComponent(portalCallback)}`, { key: null });
    expect(a.status === 302 && a.location?.startsWith(`${G}/`), `/authorize answered ${a.status} to ${a.location && new URL(a.location).origin}`);
    await google('/__next', { email: addr, name: 'Rehearsal Redirect' });
    const consent = await fetch(a.location, { redirect: 'manual' });
    const back = new URL(consent.headers.get('location'));
    // Google sends the browser to GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI; inside the network that is supabase-gw.
    const cb = await call(AUTH, `/callback${back.search}`, { key: null });
    expect(cb.status === 302 || cb.status === 303, `/callback answered ${cb.status} (${reason(cb)})`);
    const land = new URL(cb.location);
    expect(`${land.origin}${land.pathname}` === portalCallback, `/callback sent the browser to ${land.origin}${land.pathname}`);
    const hash = new URLSearchParams(land.hash.slice(1));
    const t = hash.get('access_token');
    expect(t && hash.get('refresh_token'), `no session in the callback hash (${hash.get('error_description') || 'no error'})`);
    created.push(claims(t).sub);
    expect(claims(t).app_metadata?.providers?.includes('google'), 'the redirect session is not a Google session');
    want(await backend('/auth/oauth/google/complete', { method: 'POST', body: { access_token: t, ...onboarding() } }), 201, 'complete with a council');
    return `landed on ${land.origin}${land.pathname} with a session`;
  });

  await step('invite accepted with Google: the invited email only', async () => {
    const addr = email('g-invitee');
    // The global sign-out step above revoked superToken: sign the superadmin in again.
    const admin = want(await login(email('super'), superPw), 200, 'superadmin sign-in').json.access_token;
    const inv = want(await backend('/admin/invites', { method: 'POST', token: admin, body: { email: addr, role: 'physician', council_id: council.id, position: 'staff', ...(specialty ? { specialty_id: specialty.id } : {}) } }), 201, 'POST /admin/invites');
    const token = new URL(inv.json.accept_url).searchParams.get('token');
    const other = await googleSession(email('g-not-invited'), 'id_token grant (other address)');
    created.push(claims(other).sub);
    want(await backend(`/auth/invite/${token}/accept`, { method: 'POST', body: { method: 'google', access_token: other } }), 403, 'accept with another Google account');
    const t = await googleSession(addr, 'id_token grant (invited address)');
    created.push(claims(t).sub);
    const done = want(await backend(`/auth/invite/${token}/accept`, { method: 'POST', body: { method: 'google', access_token: t } }), 201, 'accept with the invited Google account');
    expect(done.json.user?.role === 'physician' && done.json.status === 'active', `accepted as ${done.json.user?.role}/${done.json.status}`);
    return 'another Google account 403, the invited one 201 as an active physician';
  });

  await step('Link Google: same-email linking puts Google on the password account, not a second account', async () => {
    const addr = email('g-link');
    const password = pw();
    const u = await adminCreate('g-link', { password });
    await insertProfessional({ id: u.id, role: 'physician', council_id: council.id, full_name_th: 'เชื่อมกูเกิล', full_name_en: `Rehearsal Link ${RUN}`, status: 'active' });
    const clics = want(await login(addr, password), 200, 'password sign-in').json.access_token;
    const before = want(await backend('/auth/me', { token: clics }), 200, 'GET /auth/me').json.user.linked_providers || [];
    expect(!before.includes('google'), `linked_providers before linking is ${JSON.stringify(before)}`);
    // Control: a Google account with another address resolves to another auth user, and the backend refuses it.
    const stranger = await googleSession(email('g-stranger'), 'id_token grant (other address)');
    created.push(claims(stranger).sub);
    want(await backend('/auth/link-google', { method: 'POST', token: clics, body: { access_token: stranger } }), 409, 'link another Google account');
    const g = await googleSession(addr, 'id_token grant (same address)');
    expect(claims(g).sub === u.id, 'GoTrue made a second account instead of linking Google to the password account');
    const linked = want(await backend('/auth/link-google', { method: 'POST', token: clics, body: { access_token: g } }), 200, 'POST /auth/link-google');
    expect(linked.json.linked_providers?.includes('google'), `linked_providers is ${JSON.stringify(linked.json.linked_providers)}`);
    const ids = want(await call(AUTH, `/admin/users/${u.id}`), 200, 'read the auth user').json.identities.map((i) => i.provider).sort();
    expect(ids.join() === 'email,google', `the auth user's identities are ${ids.join()}`);
    want(await login(addr, password), 200, 'the password still signs in after linking');
    return 'one auth user with identities email and google; the password still signs in';
  });
}

if (process.env.OLD_PASSWORDS) {
  await step('old passwords from the restored database still verify', async () => {
    const lines = readFileSync(process.env.OLD_PASSWORDS, 'utf8').split('\n').filter((l) => l.includes('\t'));
    expect(lines.length, 'OLD_PASSWORDS holds no email<TAB>password line');
    const bad = [];
    for (const [i, l] of lines.entries()) {
      const [addr, password] = l.split('\t');
      const r = await call(AUTH, '/token?grant_type=password', { method: 'POST', key: ANON, body: { email: addr.trim(), password } });
      if (r.status !== 200) bad.push(`line ${i + 1}: HTTP ${r.status} ${r.json?.error_code ?? r.json?.error ?? ''}`);
    }
    expect(!bad.length, `${bad.length} of ${lines.length} did not verify (${bad.join('; ')})`);
    return `${lines.length} of ${lines.length} verify`;
  });
}

await step('clean up the synthetic accounts', async () => {
  // invites.created_by holds the superadmin without a cascade, so its invites go first.
  want(await call(REST, `/invites?email=like.*${RUN}@rehearsal.invalid`, { method: 'DELETE' }), 204, 'delete the rehearsal invites');
  for (const id of created.reverse()) {
    const r = await call(AUTH, `/admin/users/${id}`, { method: 'DELETE' });
    expect(r.status === 200 || r.status === 404, `delete ${id}: ${r.status}`);
  }
  if (heldSuperadmin) {
    want(await call(REST, `/professionals?id=eq.${heldSuperadmin}`, { method: 'PATCH', body: { role: 'superadmin' }, headers: { Prefer: 'return=minimal' } }), 204, 'restore the superadmin');
  }
  return `${created.length} removed${heldSuperadmin ? ', the restored superadmin put back' : ''}`;
});

console.log(failed ? `SIGN-IN REPLAY: ${failed} FAILED` : 'SIGN-IN REPLAY: all passed');
process.exit(failed ? 1 : 0);
