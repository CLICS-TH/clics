#!/usr/bin/env node
/*
 * Portal browser gate: signing out and pressing Back never restores a session, and no sign-in
 * token survives in the address bar or in Back history.
 *
 * Hermetic. A built-in static server serves physician-ui/public on :3000, a stub backend answers
 * on :3001, and the built audit-dashboard is expected on :3002 (built with
 * NEXT_PUBLIC_API_URL=http://localhost:3001 and NEXT_PUBLIC_PORTAL_URL=http://localhost:3000).
 * Supabase and the esm.sh copy of supabase-js are served from the pinned local package; every
 * other external request is aborted. Tokens are fake JWTs. Needs no network and no secrets.
 *
 * Chromium runs WITH the back/forward cache, because real browsers restore a signed-in page from it
 * without running a single script. Playwright turns it off by default, and its headless shell has none.
 *
 * Run: node scripts/auth/portal-browser.mjs [name filter | --serve]   (from repo root, dashboard on :3002)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../physician-ui/public', import.meta.url));
const PORTAL = 'http://localhost:3000';
// A Portal origin that is not on the Google sign-in allow-list in config.js.
const PORTAL_OFF_LIST = 'http://localhost:3010';
const API = 'http://localhost:3001';
const DASH = 'http://localhost:3002';
// Where the dashboard really serves. The browser always sees DASH, because the Portal's config.js
// hands staff to localhost:3002; a different upstream (a busy local port) is proxied.
const DASH_UPSTREAM = process.env.DASH_UPSTREAM || DASH;
const SUPABASE = 'https://rgwnnexokstctugwtwub.supabase.co';
const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2.49.4';
const GSI = 'https://accounts.google.com/gsi/client';
// The harness pins its own client ID after google-config.js, and a scenario can append more config lines
// through `configTail`.
const CI_GOOGLE_CLIENT_ID = 'ci-client.apps.googleusercontent.com';
let configTail = '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };

const USERS = {
  physician: { id: 'u-phys', email: 'phys@ci.test', role: 'physician', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'แพทย์ ทดสอบ', full_name_en: 'CI Physician' },
  admin: { id: 'u-admin', email: 'admin@ci.test', role: 'admin', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'ผู้ดูแล ทดสอบ', full_name_en: 'CI Admin', council_id: 'c1' },
  alpha: { id: 'u-alpha', email: 'alpha@ci.test', role: 'physician', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'ALPHA', full_name_en: 'ALPHA' },
  bravo: { id: 'u-bravo', email: 'bravo@ci.test', role: 'physician', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'BRAVO', full_name_en: 'BRAVO' },
  invitee: { id: 'u-invitee', email: 'invitee@ci.test', role: 'admin', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'ผู้รับเชิญ', full_name_en: 'CI Invitee', council_id: 'c1' },
  auditor: { id: 'u-auditor', email: 'auditor@ci.test', role: 'auditor', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'ผู้ตรวจ ทดสอบ', full_name_en: 'CI Auditor', council_id: 'c1' },
  superadmin: { id: 'u-super', email: 'super@ci.test', role: 'superadmin', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'ซูเปอร์ ทดสอบ', full_name_en: 'CI Superadmin' },
  dualRole: { id: 'u-dual', email: 'dual@ci.test', role: 'physician', can_audit: true, consented_at: '2026-01-01T00:00:00Z', full_name_th: 'แพทย์ ผู้ตรวจ', full_name_en: 'CI Dual Role' },
};
// Bank details only their owner may see; the cross-user scenario looks for the marker on screen.
const PAYMENT_INFO = {
  'u-alpha': { account_name: 'ALPHA', bank: 'ALPHA-BANK', account_no: '1111111111', promptpay: '' },
  'u-bravo': { account_name: 'BRAVO', bank: 'BRAVO-BANK', account_no: '2222222222', promptpay: '' },
};

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeJwt(user, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, email: user.email, clics_role: user.role, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600, ...extra })}.ci-signature`;
}
// Tokens revoked by POST /auth/logout answer 401 afterwards, as the real backend's revoke does.
// A request arriving with one means a page ran under a signed-out session.
const revoked = new Set();
const revokedUse = [];
function userOf(authHeader, path) {
  if (revoked.has(authHeader.replace(/^Bearer /, ''))) { revokedUse.push(path); return null; }
  try {
    const p = JSON.parse(Buffer.from(authHeader.replace(/^Bearer /, '').split('.')[1], 'base64url'));
    return Object.values(USERS).find((u) => u.id === p.sub) || null;
  } catch { return null; }
}

function listen(server, port) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, 'localhost', () => resolve(server)); });
}

// Mirrors vercel.json cleanUrls: '/' -> index.html, '/x' -> x.html.
function portalServer(origin = PORTAL) {
  return createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, origin).pathname);
      if (p === '/') p = '/index.html';
      let file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      let s = await stat(file).catch(() => null);
      if (s?.isDirectory()) { file = join(file, 'index.html'); s = await stat(file).catch(() => null); }
      if (!s && !extname(file)) { file += '.html'; s = await stat(file).catch(() => null); }
      if (!s) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      const body = await readFile(file);
      res.end(p === '/js/google-config.js' ? `${body}\nwindow.CLICS_GOOGLE_CLIENT_ID = '${CI_GOOGLE_CLIENT_ID}';\n${configTail}\n` : body);
    } catch { res.writeHead(500).end('err'); }
  });
}

// What POST /auth/oauth/google/complete answers: a scenario swaps `googleComplete`, which gets the request
// body and returns [status, json]. `completeCalls` keeps every body; `lastIssued` is the CLICS token last handed out.
const completeCalls = [];
let googleComplete = null;
let lastIssued = null;
// What POST /auth/link-google received (body + Authorization header), and what it answers: a scenario swaps
// `linkGoogle`, which returns [status, json].
const linkCalls = [];
let linkGoogle = null;

// What POST /auth/invite/CI-INVITE/accept answers to method 'google': a scenario swaps `inviteGoogle`
// (body in, [status, json] out). `inviteCalls` keeps every body.
const inviteCalls = [];
let inviteGoogle = null;

// The backend keeps accepting a token after sign-out, as a not-yet-revoked JWT would: every
// assertion below is about what the browser keeps, not about server-side revocation.
function apiServer() {
  return createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url, API).pathname;
    const json = (status, data) => { res.writeHead(status, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const session = (u, status = 200) => { lastIssued = fakeJwt(u); json(status, { access_token: lastIssued, user: u }); };

    if (path === '/auth/login') {
      const u = Object.values(USERS).find((x) => x.email === body.email);
      return u ? session(u) : json(401, { error: 'Invalid email or password' });
    }
    if (path === '/auth/oauth/google/complete') {
      completeCalls.push(body);
      const [status, data] = googleComplete ? googleComplete(body) : [200, USERS.physician];
      return data?.role ? session(data, status) : json(status, data);
    }
    if (path === '/auth/councils') return json(200, [{ id: 'c1', name_th: 'สภาทดสอบ', name_en: 'CI Council' }]);
    if (path === '/auth/specialties') return json(200, [{ id: 's1', name_th: 'อายุรศาสตร์', name_en: 'Internal Medicine' }]);
    if (path === '/auth/invite/CI-INVITE' && req.method === 'GET') return json(200, { email: USERS.invitee.email, role: 'admin', council: { name_th: 'สภาทดสอบ', name_en: 'CI Council' } });
    if (path === '/auth/invite/CI-INVITE/accept') {
      if (body.method === 'google') {
        inviteCalls.push(body);
        const [status, data] = inviteGoogle ? inviteGoogle(body) : [201, USERS.invitee];
        return data?.role ? session(data, status) : json(status, data);
      }
      return body.otp ? json(201, { access_token: fakeJwt(USERS.invitee), user: USERS.invitee }) : json(202, { status: 'otp_sent', email: USERS.invitee.email });
    }
    if (path === '/auth/logout') {
      revoked.add((req.headers.authorization || '').replace(/^Bearer /, ''));
      return json(200, { ok: true });
    }
    const u = userOf(req.headers.authorization || '', path);
    if (!u) return json(401, { error: 'unauthenticated' });
    if (path === '/auth/me') return json(200, { user: u });
    if (path === '/auth/link-google') {
      linkCalls.push({ body, authorization: req.headers.authorization });
      const [status, data] = linkGoogle ? linkGoogle() : [200, { ok: true, linked_providers: ['google'] }];
      return json(status, data);
    }
    if (path === '/auth/payment-info') return json(200, { payment_info: PAYMENT_INFO[u.id] || null });
    if (path === '/auth/request-auditor') return json(200, { can_audit: !!u.can_audit });
    if (req.method === 'GET' && /^\/(ples|ples\/folders|auditor\/queue)$/.test(path)) return json(200, []);
    return json(200, {});
  });
}

// The UMD build is self-contained; the shim re-exports it under the ESM name the Portal imports.
async function supabaseModule() {
  const umd = await readFile(createRequire(import.meta.url).resolve('@supabase/supabase-js/dist/umd/supabase.js'), 'utf8');
  return `${umd}\nexport const createClient = self.supabase.createClient;\n`;
}

// GoTrue's endpoints, enough for setSession (GET /user), updateUser (PUT /user) and signOut.
// Each PUT /user body is kept, so a scenario can check what the page actually sent.
const gotrueUpdates = [];
// The ID-token grant: bodies kept for the nonce check; `idTokenRejected` makes GoTrue refuse it.
const idTokenGrants = [];
const authorizeRequests = [];
let idTokenRejected = false;
let lastGoogleAccessToken = null;
let gotrueLogouts = 0;
function gotrue(route) {
  const req = route.request();
  const { pathname } = new URL(req.url());
  const user = { id: 'sb-user', aud: 'authenticated', role: 'authenticated', email: 'phys@ci.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
  const headers = { 'access-control-allow-origin': req.headers().origin || PORTAL, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
  if (pathname === '/auth/v1/authorize') authorizeRequests.push(req.url());
  if (pathname === '/auth/v1/token' && new URL(req.url()).searchParams.get('grant_type') === 'id_token') {
    idTokenGrants.push(req.postDataJSON());
    if (idTokenRejected) return route.fulfill({ status: 400, headers, json: { error: 'invalid_grant', error_description: 'Nonces mismatch' } });
    const access_token = fakeJwt(USERS.physician, { gid: idTokenGrants.length });
    lastGoogleAccessToken = access_token;
    return route.fulfill({ status: 200, headers, json: { access_token, refresh_token: 'ci-refresh', expires_in: 3600, token_type: 'bearer', user: { ...user, app_metadata: { provider: 'google' } } } });
  }
  if (pathname === '/auth/v1/logout') gotrueLogouts++;
  if (pathname === '/auth/v1/user' && req.method() === 'PUT') gotrueUpdates.push(req.postDataJSON());
  if (pathname === '/auth/v1/user') return route.fulfill({ status: 200, headers, json: user });
  if (pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers });
  if (pathname === '/auth/v1/authorize') return route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'text/html' }, body: 'authorize stub' });
  return route.fulfill({ status: 404, headers, json: { error: 'not stubbed' } });
}

// Stands in for Google's sign-in script. Its button hands the page whatever a scenario put in
// window.__gisNext, as Google's callback would. The page's own calls are logged for the node side.
const FAKE_GSI = `
window.google = { accounts: { id: {
  initialize(cfg) {
    window.__gisCfg = cfg;
    console.log('pw:gis-init ' + JSON.stringify({ client_id: cfg.client_id, nonce: cfg.nonce, ux_mode: cfg.ux_mode, auto_select: cfg.auto_select }));
  },
  renderButton(el, opts) {
    const b = document.createElement('button');
    b.id = 'fakeGoogleBtn'; b.type = 'button'; b.textContent = 'Google';
    b.style.minWidth = opts.width + 'px';
    console.log('pw:gis-width ' + opts.width);
    b.onclick = () => window.__gisCfg.callback(window.__gisNext || {});
    el.appendChild(b);
  },
  prompt() { console.log('pw:gis-prompt'); },
} } };
`;
let gsiBlocked = false;

const PORTAL_PUBLIC = new Set(['/', '/login', '/auth/callback', '/reset', '/forgot', '/manual', '/guest-chat', '/invite']);
const TOKEN_IN_URL = /access_token|refresh_token|[?&]token=/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits until the URL has not changed for 600 ms, so guard redirects have finished.
async function settle(page) {
  let last = page.url();
  for (let quiet = 0; quiet < 6;) {
    await sleep(100);
    const now = page.url();
    if (now === last) quiet++; else { quiet = 0; last = now; }
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function storedTokens(ctx) {
  const { origins } = await ctx.storageState();
  return origins.flatMap((o) => o.localStorage
    .filter((e) => e.name === 'clics_token' || e.name === 'clics_user' || e.name.startsWith('sb-'))
    .map((e) => `${o.origin} ${e.name}`));
}

// The state every Back step after Sign out must be in.
async function assertSignedOut(t, page, ctx, where) {
  const url = page.url();
  const leaks = await storedTokens(ctx);
  t.check(leaks.length === 0, `${where}: storage holds ${leaks.join(', ')}`);
  t.check(!TOKEN_IN_URL.test(url), `${where}: token in address bar ${url}`);
  t.check(!isPrivate(url), `${where}: signed-in page shown ${url}`);
}

function isPrivate(href) {
  const url = new URL(href);
  if (url.origin === PORTAL) return !PORTAL_PUBLIC.has(url.pathname);
  return url.origin === DASH && url.pathname !== '/login';
}

async function dashboardTokens(ctx) {
  return (await storedTokens(ctx)).filter((e) => e.startsWith(DASH));
}

async function dualRoleToConsole(page) {
  await page.goto(`${PORTAL}/forgot`);
  await emailSignIn(page, USERS.dualRole);
  await page.waitForURL(`${PORTAL}/dashboard`);
  await settle(page);
  await page.getByRole('link', { name: /Auditor console/ }).click();
  await page.waitForURL(`${DASH}/auditor/queue`);
  await settle(page);
}

// Whether the page shows the marker as text or as a form value.
function shows(page, marker) {
  return page.evaluate((m) => document.body.innerText.includes(m)
    || [...document.querySelectorAll('input, select, textarea')].some((el) => el.value.includes(m)), marker).catch(() => false);
}

// Presses Back once per entry behind the current one, checking every step. A working guard
// bounces a restored private page back to /login, so the URL alone cannot end the walk.
async function walkBack(t, page, ctx, label) {
  await walk(page, 'Back', (step) => assertSignedOut(t, page, ctx, `${label} ${step}`));
}

async function walk(page, direction, check) {
  const entries = await page.evaluate(() => history.length);
  for (let i = 1; i < entries; i++) {
    await (direction === 'Back' ? page.goBack({ waitUntil: 'commit' }) : page.goForward({ waitUntil: 'commit' })).catch(() => null);
    await settle(page);
    if (page.url() === 'about:blank') { if (direction === 'Back') break; continue; }
    await check(`${direction} #${i}`);
  }
}

async function emailSignIn(page, user, { open = true } = {}) {
  if (open) await page.goto(`${PORTAL}/login`);
  await page.fill('#email', user.email);
  await page.fill('#password', 'ci-password-1');
  await page.click('#loginBtn');
}


// Every string a reader sees or hears: the tab title, visible text, and the accessible names and
// image alts of visible elements. The only text left out is an element whose own `lang` differs from
// the page's, which is how the language switch names each language in that language.
function pageStrings(page) {
  return page.evaluate(() => {
    const lang = document.documentElement.lang;
    const foreign = [...document.querySelectorAll('body [lang]')].filter((el) => el.lang !== lang);
    const inForeign = (el) => foreign.some((f) => f.contains(el));
    foreign.forEach((el) => { el.dataset.pwDisplay = el.style.display; el.style.display = 'none'; });
    const text = document.body.innerText;
    foreign.forEach((el) => { el.style.display = el.dataset.pwDisplay; });
    const named = [...document.querySelectorAll('[aria-label], img[alt]')]
      .filter((el) => !inForeign(el) && el.checkVisibility())
      .map((el) => el.getAttribute('aria-label') ?? el.alt);
    return [document.title, ...text.split('\n'), ...named].filter((s) => s.trim());
  });
}
const THAI = /[฀-๿]/;
// A Thai half, then ' / ', then an English half with real words in it (the brand name alone does not count).
const bilingual = (msg) => { const [th, en] = msg.split(' / '); return THAI.test(th) && /[A-Za-z]{4}/.test((en || '').replace(/Google/g, '')); };
// Each phrase claims more than the code does: the PII filter (rimpl stripPii) misses some names, so no
// copy may promise the AI never sees a name or gets only de-identified text.
// A code replaces only the name on the account: a name typed into the conversation can reach the
// auditor's de-identified transcript, so no copy may say auditors see a code in place of "your name".
const OVERCLAIM = /on-?premise|validated|ติดตั้งภายในองค์กร|never your name|ไม่ได้รับชื่อหรืออีเมลของคุณ|only (de-identified|case) text|ได้รับเฉพาะข้อความ|de-identified before AI|never see your name|ไม่เห็นชื่อของคุณ|(code|pseudonym) (in place of|instead of) your name|only (by|as) a code|รหัสแทนชื่อ(?!ในบัญชี)|เห็นคุณเป็นรหัส/i;
const OVERCLAIM_SAMPLES = {
  caught: [
    'Auditors and the research data export see only a code in place of your name',
    'they see a code in place of your name.',
    'Auditors know you only by a code',
    'ผู้ตรวจและข้อมูลวิจัยที่ส่งออกเห็นคุณเป็นรหัสแทนชื่อเท่านั้น',
    'โดยเห็นรหัสแทนชื่อของคุณ',
  ],
  passed: ['Auditors see a code in place of the name on your account', 'ผู้ตรวจเห็นรหัสแทนชื่อในบัญชีของคุณ'],
};
// The audit log does not record admin transcript reads or the account purge (admin.js /ples/:id/transcript,
// superadmin.js /users/:id/purge), so no copy may say it records who did what to every record.
// logEvent is fire-and-forget and logs only some settings (superadmin.js PATCH /usage-settings), so any
// "records every/each/all …" not qualified by "tries to", and any unqualified "settings changes", overclaims.
const AUDIT_OVERCLAIM = new RegExp([
  /who did what to which record|ใครทำอะไรกับข้อมูลใดเมื่อใด/.source,
  /(?<!(?:tries to|not) )\brecords? (?:every|each|all)\b[^.]{0,60}?\b(?:access|view|action|read|reveal|export)/.source,
  /(?<!พยายาม)บันทึก(?:(?!ไม่)\S){0,20}?ทุก(?:ครั้ง|การ|รายการ)/.source,
  /(?<!some )\bsettings changes/.source,
  /การเปลี่ยนการตั้งค่า(?!บางรายการ)/.source,
  // logEventStrict undoes the evaluator lock or unlock when its write fails, so "the action still goes
  // ahead" is false as a blanket rule (lib/audit.js, superadmin.js).
  /\bthe action still goes ahead|การกระทำนั้นก็ยังดำเนินต่อไป/.source,
].join('|'), 'i');
const AUDIT_OVERCLAIM_SAMPLES = {
  caught: [
    'The audit log records who did what to which record, and when.',
    'และบันทึกว่าใครทำอะไรกับข้อมูลใดเมื่อใดในบันทึกการตรวจสอบ',
    'The system records every access to your data.',
    'and the system records each view and export in the audit log.',
    'ระบบบันทึกการเปิดดูทุกครั้งไว้ในบันทึกการตรวจสอบ',
    "auditors' scores, and settings changes.",
    'Recording is best effort, so if writing the log fails, the action still goes ahead.',
    'และถ้าระบบบันทึกไม่สำเร็จ การกระทำนั้นก็ยังดำเนินต่อไป',
    'การให้คะแนนของผู้ตรวจ และการเปลี่ยนการตั้งค่า',
  ],
  passed: [
    'and the system tries to record each reveal in the audit log.',
    'The log does not record every action: an administrator opening a conversation is not recorded.',
    'ระบบพยายามบันทึกการเปิดดูทุกครั้งไว้ในบันทึกการตรวจสอบ',
    'บันทึกนี้ไม่ได้เก็บทุกการกระทำ',
    "auditors' scores, and some settings changes, such as the AI provider",
    'และการเปลี่ยนการตั้งค่าบางรายการ เช่น ผู้ให้บริการ AI',
  ],
};
// The controller and lawful basis are still pending, so no trust chip may read as a compliance claim.
const COMPLIANCE_CHIP = /PDPA|GDPR|complian|\bISO\b|HIPAA|ได้มาตรฐาน|สอดคล้อง/i;
// Who can read a transcript with the physician's name (backend/src/routes/admin.js /ples/:id/transcript).
const NAMED_READERS = { th: /ผู้ดูแลสภา/, en: /administrators of your council/i };

async function tabTo(page, selector) {
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((sel) => document.activeElement?.matches(sel), selector)) return true;
  }
  return false;
}

// Logs `pw:landing-visible <path>` on the first animation frame in which the Landing heading would
// paint, in every document the tab loads and again after a back/forward-cache restore (suffix
// ` restored`). Pair it with slowDown() on the forward's destination, so the Landing document lives
// long enough to paint if nothing hides it.
function watchLanding(ctx) {
  return ctx.addInitScript(() => {
    let restored = false;
    const look = () => {
      const h = document.querySelector('.hero h1');
      if (h && h.checkVisibility({ visibilityProperty: true }) && h.getBoundingClientRect().height > 0) {
        console.log('pw:landing-visible ' + location.pathname + (restored ? ' restored' : ''));
        return;
      }
      if (h || document.readyState !== 'complete') requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
    addEventListener('pageshow', (e) => { if (e.persisted) { restored = true; requestAnimationFrame(look); } });
  });
}
function landingSightings(page) {
  const seen = [];
  page.on('console', (m) => { if (m.text().startsWith('pw:landing-visible ')) seen.push(m.text()); });
  return seen;
}

// What the Google sign-in page did: requests for Google's script, each GIS initialisation (with
// the hashed nonce Google was given), any One Tap prompt, and every main-frame URL.
function watchGoogle(page, ctx) {
  const log = { gsi: [], inits: [], prompts: 0, urls: [] };
  ctx.on('request', (r) => { if (r.url().startsWith(GSI)) log.gsi.push(r.url()); });
  page.on('console', (m) => {
    const text = m.text();
    if (text.startsWith('pw:gis-init ')) log.inits.push(JSON.parse(text.slice('pw:gis-init '.length)));
    if (text === 'pw:gis-prompt') log.prompts++;
  });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) log.urls.push(f.url()); });
  return log;
}

async function until(cond, what, ms = 8000) {
  for (let waited = 0; waited < ms; waited += 100) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sha256hex = (v) => createHash('sha256').update(v).digest('hex');

function resetGoogleStubs() {
  completeCalls.length = 0;
  googleComplete = null;
  inviteCalls.length = 0;
  inviteGoogle = null;
  lastIssued = null;
  linkCalls.length = 0;
  linkGoogle = null;
  idTokenGrants.length = 0;
  authorizeRequests.length = 0;
  gotrueLogouts = 0;
  idTokenRejected = false;
  gsiBlocked = false;
}

// From a page with a Google button to Google's credential reaching the page: press ours, then Google's button.
async function pressThroughGis(page, ctx, path = '/login') {
  const g = watchGoogle(page, ctx);
  await page.goto(`${PORTAL}${path}`);
  await page.locator('#googleBtn').waitFor({ state: 'visible', timeout: 10000 });
  await page.click('#googleBtn');
  await page.locator('#fakeGoogleBtn').waitFor({ state: 'visible', timeout: 10000 });
  await page.evaluate(() => { window.__gisNext = { credential: 'ci-google-id-token' }; });
  await page.click('#fakeGoogleBtn');
  return g;
}

// What the Callback page must leave behind after any Google sign-in that ends signed in.
async function checkSignedInClean(t, ctx, where) {
  const stored = await storedTokens(ctx);
  t.check(stored.includes(`${PORTAL} clics_token`), `${where}: no clics_token stored`);
  t.check(!stored.some((e) => e.includes(' sb-')), `${where}: Supabase session keys left: ${stored.join(', ')}`);
  t.check(gotrueLogouts === 0, `${where}: sign-in called GoTrue /logout`);
  const { origins } = await ctx.storageState();
  const token = origins.find((o) => o.origin === PORTAL)?.localStorage.find((e) => e.name === 'clics_token')?.value;
  t.check(token === lastIssued, `${where}: the stored clics_token is not the one the backend issued`);
}

// A press that must reach Supabase's authorize endpoint and never ask Google directly. `signedIn` presses
// Link Google on the dashboard of a signed-in physician instead of the page's own button.
async function checkRedirectPress(t, page, ctx, origin, where, { path = '/login', marker = { kind: 'signup' }, signedIn = false } = {}) {
  const g = watchGoogle(page, ctx);
  await page.goto(`${origin}${path}`);
  if (signedIn) {
    await emailSignIn(page, USERS.physician, { open: false });
    await page.waitForURL(`${origin}/dashboard`);
    await settle(page);
  }
  const button = signedIn ? '#linkGoogleBtn' : '#googleBtn';
  await page.locator(button).waitFor({ state: 'visible', timeout: 10000 });
  await page.click(button);
  await until(() => authorizeRequests.length > 0, `${where}: a request to Supabase's authorize endpoint`);
  const url = new URL(authorizeRequests[0]);
  t.check(url.searchParams.get('provider') === 'google', `${where}: authorize provider is ${url.searchParams.get('provider')}`);
  t.check(url.searchParams.get('redirect_to') === `${origin}/auth/callback`, `${where}: redirect_to is ${url.searchParams.get('redirect_to')}`);
  t.check(g.gsi.length === 0, `${where}: Google's script was requested (${g.gsi.length}x)`);
  t.check(idTokenGrants.length === 0, `${where}: the ID-token grant ran`);
  const { origins } = await ctx.storageState();
  const flow = origins.find((o) => o.origin === origin)?.localStorage.find((e) => e.name === 'clics_oauth_flow')?.value;
  t.check(flow && JSON.stringify(JSON.parse(flow)) === JSON.stringify(marker), `${where}: the flow marker is ${flow}, not ${JSON.stringify(marker)}`);
  if (signedIn) t.check(!!(await clicsToken(ctx, origin)), `${where}: the press dropped clics_token`);
}

const clicsToken = async (ctx, origin = PORTAL) => (await ctx.storageState()).origins.find((o) => o.origin === origin)?.localStorage.find((e) => e.name === 'clics_token')?.value;

// Link Google from the dashboard of a signed-in physician: sign in by email, then open the dashboard.
// Returns the CLICS token the physician holds before linking.
async function signedInDashboard(page) {
  await page.goto(`${PORTAL}/login`);
  await emailSignIn(page, USERS.physician, { open: false });
  await page.waitForURL(`${PORTAL}/dashboard`);
  await settle(page);
  return page.evaluate(() => localStorage.getItem('clics_token'));
}

// From the dashboard to Google's credential reaching the page: press Link Google, then Google's button.
async function pressLinkThroughGis(page, credential = 'ci-google-id-token') {
  await page.locator('#linkGoogleBtn').waitFor({ state: 'visible', timeout: 10000 });
  await page.click('#linkGoogleBtn');
  await page.locator('#fakeGoogleBtn').waitFor({ state: 'visible', timeout: 10000 });
  await page.evaluate((c) => { window.__gisNext = c ? { credential: c } : {}; }, credential);
  await page.click('#fakeGoogleBtn');
}


// Holds every response under `prefix` for a while, as a slow network would.
function slowDown(ctx, prefix, ms = 1500) {
  return ctx.route((url) => url.href.startsWith(prefix), async (route) => { await sleep(ms); await route.fallback(); });
}

const SCENARIOS = [
  {
    name: 'email sign-in, Sign out, Back',
    async run(t, page, ctx) {
      await page.goto(`${PORTAL}/forgot`);
      await emailSignIn(page, USERS.physician);
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      await page.click('#logoutBtn');
      await page.waitForURL(`${PORTAL}/login`);
      await settle(page);
      await assertSignedOut(t, page, ctx, 'after Sign out');
      await walkBack(t, page, ctx, 'email');
    },
  },
  {
    // #203: the route now answers 502 when the server-side revoke fails. Sign out must not change.
    name: 'email sign-in, Sign out while the revoke fails, Back',
    async run(t, page, ctx) {
      let revokeCalls = 0;
      await ctx.route(`${API}/auth/logout`, (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        revokeCalls++;
        return route.fulfill({
          status: 502, contentType: 'application/json',
          headers: { 'access-control-allow-origin': PORTAL },
          body: JSON.stringify({ error: 'Could not end the session on the server.', code: 'revoke_failed' }),
        });
      });
      await page.goto(`${PORTAL}/forgot`);
      await emailSignIn(page, USERS.physician);
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      await page.click('#logoutBtn');
      await page.waitForURL(`${PORTAL}/login`);
      await settle(page);
      t.check(revokeCalls === 1, `revoke called ${revokeCalls} times`);
      t.check(!(await page.locator('#error').isVisible()), `login shows a notice: ${await page.locator('#error').textContent()}`);
      await assertSignedOut(t, page, ctx, 'after Sign out');
      await walkBack(t, page, ctx, 'email');
    },
  },
  {
    name: 'email sign-in, two private pages, Sign out, Back',
    privateRestore: true,
    async run(t, page, ctx) {
      await page.goto(`${PORTAL}/forgot`);
      await emailSignIn(page, USERS.physician);
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      await page.goto(`${PORTAL}/payment`);
      await settle(page);
      await page.click('#logoutBtn');
      await page.waitForURL(`${PORTAL}/login`);
      await settle(page);
      await assertSignedOut(t, page, ctx, 'after Sign out');
      await walkBack(t, page, ctx, 'deep');
    },
  },
  {
    name: 'physician A signs out, B signs in on the same tab, Back and Forward never show A',
    privateRestore: true,
    async run(t, page) {
      await page.goto(`${PORTAL}/forgot`);
      await emailSignIn(page, USERS.alpha);
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      await page.goto(`${PORTAL}/payment`);
      await settle(page);
      t.check(await shows(page, 'ALPHA-BANK'), 'setup: A\'s payment page never showed A\'s bank');
      await page.goBack({ waitUntil: 'commit' });
      await settle(page);
      await page.click('#logoutBtn');
      await page.waitForURL(`${PORTAL}/login`);
      await settle(page);
      await emailSignIn(page, USERS.bravo, { open: false });
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      const noAlpha = async (step) => {
        await sleep(500);
        t.check(!(await shows(page, 'ALPHA')), `${step}: A's data shown to B at ${page.url()}`);
      };
      await walk(page, 'Back', noAlpha);
      await walk(page, 'Forward', noAlpha);
    },
  },
  {
    name: 'dual-role Handoff, Return to Physician, Portal Sign out, Back',
    async run(t, page, ctx) {
      await page.goto(`${PORTAL}/forgot`);
      await emailSignIn(page, USERS.dualRole);
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      await page.getByRole('link', { name: /Auditor console/ }).click();
      await page.waitForURL(`${DASH}/auditor/queue`);
      await settle(page);
      const menu = page.getByRole('button', { name: 'เมนู / Menu' });
      if (await menu.isVisible()) await menu.click();
      await page.getByRole('button', { name: /กลับสู่หน้าแพทย์/ }).click();
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      await page.click('#logoutBtn');
      await page.waitForURL(`${PORTAL}/login`);
      await settle(page);
      await assertSignedOut(t, page, ctx, 'after Sign out');
      await walkBack(t, page, ctx, 'dual-role');
    },
  },
  {
    name: 'dual-role Handoff, browser Back, Portal Sign out, Forward',
    async run(t, page, ctx) {
      await dualRoleToConsole(page);
      await page.goBack({ waitUntil: 'commit' });
      await settle(page);
      await page.click('#logoutBtn');
      await page.waitForURL(`${PORTAL}/login`);
      await settle(page);
      await assertSignedOut(t, page, ctx, 'after Sign out');
      revokedUse.length = 0;
      await walk(page, 'Forward', async (step) => {
        await assertSignedOut(t, page, ctx, `dual-role ${step}`);
        t.check(revokedUse.length === 0, `dual-role ${step}: a page called ${revokedUse.join(', ')} with the signed-out token`);
      });
    },
  },
  {
    name: 'dual-role Handoff, browser Back, Portal Sign out, B signs in, Forward',
    async run(t, page, ctx) {
      await dualRoleToConsole(page);
      await page.goBack({ waitUntil: 'commit' });
      await settle(page);
      await page.click('#logoutBtn');
      await page.waitForURL(`${PORTAL}/login`);
      await settle(page);
      await emailSignIn(page, USERS.bravo, { open: false });
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      revokedUse.length = 0;
      await walk(page, 'Forward', async (step) => {
        t.check(revokedUse.length === 0, `${step}: a page called ${revokedUse.join(', ')} with the signed-out token`);
        const left = await dashboardTokens(ctx);
        t.check(left.length === 0, `${step}: dashboard storage holds ${left.join(', ')}`);
        t.check(!isPrivate(page.url()) || new URL(page.url()).origin === PORTAL, `${step}: dashboard page shown ${page.url()}`);
        t.check(!(await shows(page, 'CI Dual Role')), `${step}: the signed-out user's console shown to B at ${page.url()}`);
      });
    },
  },
  {
    name: 'invite, Go to console, dashboard Sign out, Back, invite link opens no session',
    async run(t, page, ctx) {
      await page.goto(`${PORTAL}/forgot`);
      await page.goto(`${PORTAL}/invite?token=CI-INVITE`);
      await page.locator('#acceptCard').waitFor({ state: 'visible', timeout: 10000 });
      await page.fill('#th', 'ผู้รับเชิญ');
      await page.fill('#en', 'CI Invitee');
      await page.fill('#password', 'Passw0rd1234');
      await page.click('#passwordBtn');
      await page.locator('#otpCard').waitFor({ state: 'visible', timeout: 10000 });
      await page.fill('#otp', '123456');
      await page.click('#verifyBtn');
      await page.locator('#doneCard').waitFor({ state: 'visible', timeout: 10000 });
      t.check(!TOKEN_IN_URL.test(await page.locator('#doneCta').getAttribute('href') || ''), 'the invite CTA carries a token in its href');
      const inviteToken = await page.evaluate(() => localStorage.getItem('clics_token'));
      await page.click('#doneCta');
      await page.waitForURL(`${DASH}/home`);
      await settle(page);
      const menu = page.getByRole('button', { name: 'เมนู / Menu' });
      if (await menu.isVisible()) await menu.click();
      await page.getByRole('button', { name: /ออกจากระบบ/ }).click();
      await page.waitForURL(`${PORTAL}/login`);
      await settle(page);
      t.check(revoked.has(inviteToken), 'dashboard Sign out did not revoke the session at /auth/logout');
      await assertSignedOut(t, page, ctx, 'after Sign out');
      let ctaSeen = false;
      await walk(page, 'Back', async (step) => {
        const cta = page.locator('#doneCta');
        if (new URL(page.url()).pathname === '/invite' && await cta.isVisible()) {
          ctaSeen = true;
          await cta.click();
          await settle(page);
        }
        await assertSignedOut(t, page, ctx, `invite ${step}`);
      });
      t.check(ctaSeen, 'Back never reached the invite page with its link, so the link went untested');
    },
  },
  {
    name: 'Google sign-in, then Back from /dashboard skips /auth/callback',
    async run(t, page) {
      await page.goto(`${PORTAL}/forgot`);
      await page.goto(`${PORTAL}/auth/callback#access_token=${fakeJwt(USERS.physician)}&refresh_token=ci-refresh&expires_in=3600&token_type=bearer`);
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      await page.goBack({ waitUntil: 'commit' });
      await settle(page);
      t.check(new URL(page.url()).pathname !== '/auth/callback', `Back after Google sign-in landed on ${page.url()}`);
      t.check(await page.evaluate(() => !!localStorage.getItem('clics_token')), 'Back after Google sign-in dropped clics_token');
    },
  },
  {
    name: 'Login Google sign-in in-page: no Google request before the press, hashed nonce, lands on the Callback page',
    async run(t, page, ctx) {
      resetGoogleStubs();
      const g = watchGoogle(page, ctx);
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(`${PORTAL}/login`);
      await page.locator('#googleBtn').waitFor({ state: 'visible', timeout: 10000 });
      await settle(page);
      t.check(g.gsi.length === 0, `Google's script was requested before the press: ${g.gsi.join(', ')}`);
      await page.click('#googleBtn');
      await page.locator('#fakeGoogleBtn').waitFor({ state: 'visible', timeout: 10000 });
      t.check(g.gsi.length === 1, `Google's script was requested ${g.gsi.length}x after the press`);
      t.check(!(await page.locator('#googleBtn').isVisible()), 'our button still shows beside Google\'s');
      t.check(g.prompts === 0, 'the page called One Tap prompt()');
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      t.check(fits, 'Google\'s button, at the width the page asked for, makes the 320px page scroll sideways');
      t.check(await page.evaluate(() => document.activeElement?.classList.contains('google-gis-slot')), 'focus did not move to Google\'s button area after the press');
      t.check(g.inits.length === 1 && g.inits[0].client_id === CI_GOOGLE_CLIENT_ID, `GIS initialised with ${JSON.stringify(g.inits)}`);
      t.check(g.inits[0]?.ux_mode === 'popup' && g.inits[0]?.auto_select === false, `GIS ux_mode/auto_select are ${g.inits[0]?.ux_mode}/${g.inits[0]?.auto_select}`);
      await page.evaluate(() => { window.__gisNext = { credential: 'ci-google-id-token' }; });
      await page.click('#fakeGoogleBtn');
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      const grant = idTokenGrants[0];
      t.check(grant?.provider === 'google' && grant?.id_token === 'ci-google-id-token', `GoTrue got ${JSON.stringify(grant)}`);
      t.check(!!grant?.nonce && sha256hex(grant.nonce) === g.inits[0]?.nonce, 'the nonce given to Google is not the SHA-256 hex of the nonce given to Supabase');
      t.check(g.urls.some((u) => new URL(u).pathname === '/auth/callback'), `the page never reached /auth/callback: ${g.urls.join(' -> ')}`);
      t.check(authorizeRequests.length === 0, 'the page also went through Supabase\'s authorize endpoint');
      t.check(gotrueLogouts === 0, 'sign-in called GoTrue /logout');
      const stored = await storedTokens(ctx);
      t.check(stored.includes(`${PORTAL} clics_token`), 'no clics_token stored after Google sign-in');
      t.check(!stored.some((e) => e.includes(' sb-')), `Supabase session keys left: ${stored.join(', ')}`);
      t.check(!TOKEN_IN_URL.test(page.url()), `token in the address bar ${page.url()}`);
      t.check(completeCalls.length === 1 && completeCalls[0].access_token === lastGoogleAccessToken && !('council_id' in completeCalls[0]),
        `signup completion was called ${completeCalls.length}x with ${JSON.stringify(completeCalls[0])}, not once with the Supabase session token and no council`);
      t.check(await page.evaluate(() => JSON.parse(localStorage.getItem('clics_user') || '{}').role) === 'physician', 'the stored user is not the physician the backend returned');
      await checkSignedInClean(t, ctx, 'active physician');
    },
  },
  {
    name: 'Login Google sign-in in-page: a new physician gets the council picker, then one complete call with council, level and specialty',
    async run(t, page, ctx) {
      resetGoogleStubs();
      googleComplete = (body) => (body.council_id === undefined
        ? [400, { error: { code: 'council_required' } }]
        : [201, USERS.physician]);
      await pressThroughGis(page, ctx);
      await page.locator('#councilCard').waitFor({ state: 'visible', timeout: 10000 });
      t.check(new URL(page.url()).pathname === '/auth/callback', `the picker is not on the Callback page: ${page.url()}`);
      t.check(completeCalls.length === 1 && completeCalls[0].access_token === lastGoogleAccessToken && !('council_id' in completeCalls[0]),
        `the first complete call was ${JSON.stringify(completeCalls)}, not the token alone`);
      t.check(!(await storedTokens(ctx)).includes(`${PORTAL} clics_token`), 'a clics_token was stored before the council was picked');
      await page.locator('#council option[value="c1"]').waitFor({ state: 'attached', timeout: 10000 });
      await page.selectOption('#council', 'c1');
      await page.locator('#specialtyGroup').waitFor({ state: 'visible', timeout: 10000 });
      await page.selectOption('#trainingLevel', 'resident');
      await page.selectOption('#specialty', 's1');
      await page.click('#councilBtn');
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      t.check(completeCalls.length === 2, `${completeCalls.length} complete calls in all, not two`);
      const second = completeCalls[1] || {};
      t.check(second.access_token === lastGoogleAccessToken && second.council_id === 'c1' && second.specialty_id === 's1' && second.position === 'resident',
        `the second complete call was ${JSON.stringify(second)}`);
      await checkSignedInClean(t, ctx, 'council picker');
    },
  },
  ...['admin', 'auditor', 'superadmin'].map((role) => ({
    name: `Login Google sign-in in-page: the ${role} role is handed to the dashboard with the CLICS token`,
    async run(t, page, ctx) {
      resetGoogleStubs();
      googleComplete = () => [200, USERS[role]];
      const handoffs = [];
      ctx.on('request', (r) => { if (r.url().startsWith(`${DASH}/login?token=`)) handoffs.push(r.url()); });
      await pressThroughGis(page, ctx);
      await until(() => handoffs.length > 0, `the ${role} Handoff to ${DASH}/login`);
      t.check(new URL(handoffs[0]).searchParams.get('token') === lastIssued, `the ${role} Handoff carried a token other than the one the backend issued`);
      t.check(completeCalls.length === 1 && completeCalls[0].access_token === lastGoogleAccessToken, `the ${role} complete call was ${JSON.stringify(completeCalls)}`);
      await checkSignedInClean(t, ctx, `${role} Handoff`);
    },
  })),
  {
    name: 'Login Google sign-in in-page: a blocked script, a Google error and a Supabase rejection keep the user on /login, each render has a new nonce',
    async run(t, page, ctx) {
      resetGoogleStubs();
      const g = watchGoogle(page, ctx);
      const errShown = () => page.evaluate(() => { const e = document.getElementById('error'); return e.style.display !== 'none' ? e.textContent : ''; });
      const clearErr = () => page.evaluate(() => { document.getElementById('error').style.display = 'none'; });
      await page.goto(`${PORTAL}/login`);
      await page.locator('#googleBtn').waitFor({ state: 'visible', timeout: 10000 });
      gsiBlocked = true;
      await page.click('#googleBtn');
      await until(async () => !!(await errShown()), 'the blocked-script message');
      t.check(bilingual(await errShown()), `blocked script message is not bilingual: "${await errShown()}"`);
      t.check(await page.locator('#googleBtn').isEnabled() && await page.locator('#googleBtn').isVisible(), 'our button is not usable after the script failed to load');
      gsiBlocked = false;
      await clearErr();
      await page.click('#googleBtn');
      await page.locator('#fakeGoogleBtn').waitFor({ state: 'visible', timeout: 10000 });
      await page.evaluate(() => { window.__gisNext = {}; });
      await page.click('#fakeGoogleBtn');
      await until(async () => (await errShown()) && g.inits.length === 2, 'the Google-error message and a new render');
      t.check(bilingual(await errShown()), `Google error message is not bilingual: "${await errShown()}"`);
      t.check(new URL(page.url()).pathname === '/login', `a Google error ended on ${page.url()}`);
      t.check(g.inits[0].nonce !== g.inits[1].nonce, 'the second render reused the first nonce');
      await clearErr();
      idTokenRejected = true;
      await page.evaluate(() => { localStorage.setItem('sb-ci-auth-token', '{}'); window.__gisNext = { credential: 'ci-google-id-token' }; });
      await page.locator('#fakeGoogleBtn').waitFor({ state: 'visible' });
      await page.click('#fakeGoogleBtn');
      await until(async () => (await errShown()) && g.inits.length === 3, 'the Supabase-rejection message and a new render');
      t.check(bilingual(await errShown()), `Supabase rejection message is not bilingual: "${await errShown()}"`);
      t.check(new URL(page.url()).pathname === '/login', `a Supabase rejection ended on ${page.url()}`);
      t.check(sha256hex(idTokenGrants[0].nonce) === g.inits[1].nonce, 'the rejected grant did not carry the nonce Google was given');
      t.check(new Set(g.inits.map((i) => i.nonce)).size === 3, 'two renders shared a nonce');
      const left = (await storedTokens(ctx)).filter((e) => e.includes(' sb-') || e.endsWith('clics_token'));
      t.check(left.length === 0, `a failed attempt left ${left.join(', ')}`);
      idTokenRejected = false;
      await page.locator('#fakeGoogleBtn').waitFor({ state: 'visible' });
      await page.click('#fakeGoogleBtn');
      await page.waitForURL(`${PORTAL}/dashboard`);
      t.check(sha256hex(idTokenGrants.at(-1).nonce) === g.inits[2].nonce, 'the retry did not carry the latest nonce');
      t.check(gotrueLogouts === 0, 'a failed attempt called GoTrue /logout');
    },
  },
  {
    name: 'Login Google sign-in on an origin off the allow-list goes through Supabase\'s authorize endpoint',
    async run(t, page, ctx) {
      resetGoogleStubs();
      await checkRedirectPress(t, page, ctx, PORTAL_OFF_LIST, 'off-list origin');
    },
  },
  {
    name: 'Login Google sign-in with the mode set to redirect goes through Supabase\'s authorize endpoint',
    config: "window.CLICS_GOOGLE_SIGNIN.login = 'redirect';",
    async run(t, page, ctx) {
      resetGoogleStubs();
      await checkRedirectPress(t, page, ctx, PORTAL, 'redirect mode');
    },
  },
  {
    name: 'Link Google in-page: no Google request before the press, hashed nonce, same account, link message, sign-out never called',
    config: "window.CLICS_GOOGLE_SIGNIN.link = 'gis';",
    async run(t, page, ctx) {
      resetGoogleStubs();
      const g = watchGoogle(page, ctx);
      const before = await signedInDashboard(page);
      await page.locator('#linkGoogleBtn').waitFor({ state: 'visible', timeout: 10000 });
      t.check(g.gsi.length === 0, `Google's script was requested before the press: ${g.gsi.join(', ')}`);
      await page.click('#linkGoogleBtn');
      await page.locator('#fakeGoogleBtn').waitFor({ state: 'visible', timeout: 10000 });
      t.check(g.gsi.length === 1, `Google's script was requested ${g.gsi.length}x after the press`);
      t.check(g.prompts === 0, 'the page called One Tap prompt()');
      await page.evaluate(() => { window.__gisNext = { credential: 'ci-google-id-token' }; });
      await page.click('#fakeGoogleBtn');
      await until(() => g.urls.some((u) => new URL(u).pathname === '/auth/callback') && linkCalls.length === 1, 'the Callback page and one link-google call');
      await page.waitForURL(`${PORTAL}/dashboard`);
      await page.locator('.toast-success').filter({ hasText: /เชื่อมบัญชี Google สำเร็จ/ }).waitFor({ state: 'visible', timeout: 5000 })
        .catch(() => t.check(false, 'the dashboard did not show the link message'));
      await settle(page);
      const grant = idTokenGrants[0];
      t.check(grant?.provider === 'google' && grant?.id_token === 'ci-google-id-token', `GoTrue got ${JSON.stringify(grant)}`);
      t.check(!!grant?.nonce && sha256hex(grant.nonce) === g.inits[0]?.nonce, 'the nonce given to Google is not the SHA-256 hex of the nonce given to Supabase');
      t.check(authorizeRequests.length === 0, 'the page also went through Supabase\'s authorize endpoint');
      t.check(before && lastGoogleAccessToken && before !== lastGoogleAccessToken, 'the CLICS token and the Google session token are the same string, so this scenario cannot tell them apart');
      t.check(linkCalls[0].body.access_token === lastGoogleAccessToken, 'link-google did not get the Google session access token');
      t.check(linkCalls[0].authorization === `Bearer ${before}`, `link-google was called with "${linkCalls[0].authorization}", not the physician's existing CLICS token`);
      t.check(await clicsToken(ctx) === before, 'the CLICS token changed or went missing: the physician is not the same signed-in account');
      t.check(!(await storedTokens(ctx)).some((e) => e.includes(' sb-')), 'Supabase session keys left after linking');
      t.check(gotrueLogouts === 0, 'linking called GoTrue /logout');
      t.check(!TOKEN_IN_URL.test(page.url()), `token in the address bar ${page.url()}`);
    },
  },
  {
    name: 'Link Google in-page: a mismatch (backend 409) shows the backend\'s error on the Callback page and keeps the CLICS token',
    config: "window.CLICS_GOOGLE_SIGNIN.link = 'gis';",
    async run(t, page, ctx) {
      resetGoogleStubs();
      const reason = 'This Google account is registered separately and cannot be linked.';
      linkGoogle = () => [409, { error: reason }];
      const before = await signedInDashboard(page);
      await pressLinkThroughGis(page);
      await page.locator('#errorCard').waitFor({ state: 'visible', timeout: 10000 });
      t.check((await page.locator('#errorMsg').innerText()).includes(reason), `the Callback page shows "${await page.locator('#errorMsg').innerText()}", not the backend's error`);
      t.check(new URL(page.url()).pathname === '/auth/callback', `a refused link ended on ${page.url()}`);
      t.check(linkCalls.length === 1, `${linkCalls.length} link-google calls, not one`);
      t.check(await clicsToken(ctx) === before, 'a refused link changed or dropped the CLICS token');
      t.check(!(await storedTokens(ctx)).some((e) => e.includes(' sb-')), 'Supabase session keys left after a refused link');
      t.check(gotrueLogouts === 0, 'a refused link called GoTrue /logout');
    },
  },
  {
    name: 'Link Google in-page: a blocked script, a Google error and a Supabase rejection keep the user on /dashboard, each render has a new nonce',
    config: "window.CLICS_GOOGLE_SIGNIN.link = 'gis';",
    async run(t, page, ctx) {
      resetGoogleStubs();
      const g = watchGoogle(page, ctx);
      const before = await signedInDashboard(page);
      const shown = () => page.locator('#linkGoogleMsg').innerText();
      const button = page.locator('#linkGoogleBtn');
      await button.waitFor({ state: 'visible', timeout: 10000 });
      gsiBlocked = true;
      await button.click();
      await until(async () => !!(await shown()), 'the blocked-script message');
      t.check(bilingual(await shown()), `blocked script message is not bilingual: "${await shown()}"`);
      t.check(!/อีเมล|email/i.test(await shown()), `blocked script message sends a signed-in user to email sign-in: "${await shown()}"`);
      await page.setViewportSize({ width: 320, height: 700 });
      const msgBox = await page.locator('#linkGoogleMsg').evaluate((el) => ({ px: parseFloat(getComputedStyle(el).fontSize), role: el.getAttribute('role'), wide: el.scrollWidth > el.clientWidth || el.getBoundingClientRect().right > innerWidth}));
      t.check(msgBox.px >= 15.33, `the link failure message is ${msgBox.px}px, below the 15.33px Thai floor`);
      t.check(msgBox.role === 'alert', `the link failure message has role=${msgBox.role}, so a screen reader says nothing`);
      t.check(!msgBox.wide, 'the link failure message overflows its box or the 320px screen');
      t.check(await button.isEnabled() && await button.isVisible(), 'Link Google is not usable after the script failed to load');
      gsiBlocked = false;
      await page.evaluate(() => { document.getElementById('linkGoogleMsg').textContent = ''; });
      await pressLinkThroughGis(page, null);
      await until(async () => (await shown()) && g.inits.length === 2, 'the Google-error message and a new render');
      t.check(bilingual(await shown()), `Google error message is not bilingual: "${await shown()}"`);
      await page.evaluate(() => { document.getElementById('linkGoogleMsg').textContent = ''; localStorage.setItem('sb-ci-auth-token', '{}'); window.__gisNext = { credential: 'ci-google-id-token' }; });
      idTokenRejected = true;
      await page.click('#fakeGoogleBtn');
      await until(async () => (await shown()) && g.inits.length === 3, 'the Supabase-rejection message and a new render');
      t.check(bilingual(await shown()), `Supabase rejection message is not bilingual: "${await shown()}"`);
      t.check(/เชื่อม/.test(await shown()) && /link/i.test(await shown()), `Supabase rejection message does not talk about linking: "${await shown()}"`);
      t.check(sha256hex(idTokenGrants[0].nonce) === g.inits[1].nonce, 'the rejected grant did not carry the nonce Google was given');
      t.check(new Set(g.inits.map((i) => i.nonce)).size === 3, 'two renders shared a nonce');
      t.check(new URL(page.url()).pathname === '/dashboard', `a failed attempt ended on ${page.url()}`);
      t.check(!g.urls.some((u) => new URL(u).pathname === '/auth/callback'), 'a failed attempt reached the Callback page');
      t.check(!(await storedTokens(ctx)).some((e) => e.includes(' sb-')), 'a failed attempt left Supabase session keys');
      t.check(await clicsToken(ctx) === before && linkCalls.length === 0 && gotrueLogouts === 0, 'a failed attempt touched the CLICS session or called link-google');
      idTokenRejected = false;
      await page.click('#fakeGoogleBtn');
      await until(() => linkCalls.length === 1, 'the retry reaching link-google');
      t.check(sha256hex(idTokenGrants.at(-1).nonce) === g.inits[2].nonce, 'the retry did not carry the latest nonce');
    },
  },
  {
    name: 'Link Google with the mode set to redirect goes through Supabase\'s authorize endpoint',
    config: "window.CLICS_GOOGLE_SIGNIN.link = 'redirect';",
    async run(t, page, ctx) {
      resetGoogleStubs();
      await checkRedirectPress(t, page, ctx, PORTAL, 'redirect link mode', { marker: { kind: 'link' }, signedIn: true });
    },
  },
  {
    name: 'Link Google on an origin off the allow-list goes through Supabase\'s authorize endpoint',
    config: "window.CLICS_GOOGLE_SIGNIN.link = 'gis';",
    async run(t, page, ctx) {
      resetGoogleStubs();
      await checkRedirectPress(t, page, ctx, PORTAL_OFF_LIST, 'off-list origin link', { marker: { kind: 'link' }, signedIn: true });
    },
  },
  {
    name: 'Invite Google sign-in in-page: no Google request before the press, hashed nonce, the accept call carries the Supabase token, the admin is handed to the dashboard',
    async run(t, page, ctx) {
      resetGoogleStubs();
      const g = watchGoogle(page, ctx);
      const handoffs = [];
      ctx.on('request', (r) => { if (r.url().startsWith(`${DASH}/login?token=`)) handoffs.push(r.url()); });
      await page.goto(`${PORTAL}/invite?token=CI-INVITE`);
      await page.locator('#googleBtn').waitFor({ state: 'visible', timeout: 10000 });
      await settle(page);
      t.check(g.gsi.length === 0, `Google's script was requested before the press: ${g.gsi.join(', ')}`);
      await page.click('#googleBtn');
      await page.locator('#fakeGoogleBtn').waitFor({ state: 'visible', timeout: 10000 });
      t.check(g.gsi.length === 1, `Google's script was requested ${g.gsi.length}x after the press`);
      t.check(!(await page.locator('#googleBtn').isVisible()), 'our button still shows beside Google\'s');
      t.check(g.prompts === 0, 'the page called One Tap prompt()');
      t.check(g.inits.length === 1 && g.inits[0].client_id === CI_GOOGLE_CLIENT_ID, `GIS initialised with ${JSON.stringify(g.inits)}`);
      t.check(g.inits[0]?.ux_mode === 'popup' && g.inits[0]?.auto_select === false, `GIS ux_mode/auto_select are ${g.inits[0]?.ux_mode}/${g.inits[0]?.auto_select}`);
      await page.evaluate(() => { window.__gisNext = { credential: 'ci-google-id-token' }; });
      await page.click('#fakeGoogleBtn');
      await until(() => handoffs.length > 0, `the invitee's Handoff to ${DASH}/login`);
      const grant = idTokenGrants[0];
      t.check(grant?.provider === 'google' && grant?.id_token === 'ci-google-id-token', `GoTrue got ${JSON.stringify(grant)}`);
      t.check(!!grant?.nonce && sha256hex(grant.nonce) === g.inits[0]?.nonce, 'the nonce given to Google is not the SHA-256 hex of the nonce given to Supabase');
      t.check(g.urls.some((u) => new URL(u).pathname === '/auth/callback'), `the page never reached /auth/callback: ${g.urls.join(' -> ')}`);
      t.check(authorizeRequests.length === 0, 'the page also went through Supabase\'s authorize endpoint');
      t.check(inviteCalls.length === 1 && inviteCalls[0].method === 'google' && inviteCalls[0].access_token === lastGoogleAccessToken,
        `the accept call was ${JSON.stringify(inviteCalls)}, not one google call with the Supabase session token`);
      t.check(completeCalls.length === 0, `the normal signup completion ran ${completeCalls.length}x`);
      t.check(new URL(handoffs[0]).searchParams.get('token') === lastIssued, 'the Handoff carried a token other than the one the backend issued');
      await checkSignedInClean(t, ctx, 'invitee Handoff');
    },
  },
  {
    name: 'Invite Google sign-in in-page: a Google email other than the invited one ends on the Callback error card with no session left',
    async run(t, page, ctx) {
      resetGoogleStubs();
      const message = 'Your Google email must match the invited email.';
      inviteGoogle = () => [403, { error: message }];
      await pressThroughGis(page, ctx, '/invite?token=CI-INVITE');
      await page.locator('#errorCard').waitFor({ state: 'visible', timeout: 10000 });
      t.check(new URL(page.url()).pathname === '/auth/callback', `the error is not on the Callback page: ${page.url()}`);
      t.check((await page.locator('#errorMsg').innerText()).includes(message), `the error card says "${await page.locator('#errorMsg').innerText()}"`);
      t.check(inviteCalls.length === 1, `${inviteCalls.length} accept calls, not one`);
      const left = (await storedTokens(ctx)).filter((e) => e.includes(' sb-') || e.endsWith('clics_token') || e.endsWith('clics_user'));
      t.check(left.length === 0, `a rejected invite left ${left.join(', ')}`);
      t.check(gotrueLogouts === 0, 'a rejected invite called GoTrue /logout');
    },
  },
  {
    name: 'Invite Google sign-in on an origin off the allow-list goes through Supabase\'s authorize endpoint with the invite marker',
    async run(t, page, ctx) {
      resetGoogleStubs();
      await checkRedirectPress(t, page, ctx, PORTAL_OFF_LIST, 'off-list origin', { path: '/invite?token=CI-INVITE', marker: { kind: 'invite', token: 'CI-INVITE' } });
    },
  },
  {
    name: 'Invite Google sign-in with the mode set to redirect goes through Supabase\'s authorize endpoint with the invite marker',
    config: "window.CLICS_GOOGLE_SIGNIN.invite = 'redirect';",
    async run(t, page, ctx) {
      resetGoogleStubs();
      await checkRedirectPress(t, page, ctx, PORTAL, 'redirect mode', { path: '/invite?token=CI-INVITE', marker: { kind: 'invite', token: 'CI-INVITE' } });
    },
  },
  {
    name: 'Invite Google sign-in in-page: a blocked script, a Google error and a Supabase rejection keep the user on /invite with a bilingual message',
    async run(t, page, ctx) {
      resetGoogleStubs();
      const g = watchGoogle(page, ctx);
      const errShown = () => page.evaluate(() => { const e = document.getElementById('acceptErr'); return e.style.display !== 'none' ? e.textContent : ''; });
      const bilingual = (msg) => { const [th, en] = msg.split(' / '); return THAI.test(th) && /[A-Za-z]{4}/.test((en || '').replace(/Google/g, '')); };
      await page.goto(`${PORTAL}/invite?token=CI-INVITE`);
      await page.locator('#googleBtn').waitFor({ state: 'visible', timeout: 10000 });
      gsiBlocked = true;
      await page.click('#googleBtn');
      await until(async () => !!(await errShown()), 'the blocked-script message');
      t.check(bilingual(await errShown()), `blocked script message is not bilingual: "${await errShown()}"`);
      t.check(await page.locator('#googleBtn').isEnabled() && await page.locator('#googleBtn').isVisible(), 'our button is not usable after the script failed to load');
      gsiBlocked = false;
      await page.click('#googleBtn');
      t.check(!(await errShown()), 'pressing the button again left the old message on screen');
      await page.locator('#fakeGoogleBtn').waitFor({ state: 'visible', timeout: 10000 });
      await page.evaluate(() => { window.__gisNext = {}; });
      await page.click('#fakeGoogleBtn');
      await until(async () => (await errShown()) && g.inits.length === 2, 'the Google-error message and a new render');
      t.check(bilingual(await errShown()), `Google error message is not bilingual: "${await errShown()}"`);
      idTokenRejected = true;
      await page.evaluate(() => { document.getElementById('acceptErr').style.display = 'none'; localStorage.setItem('sb-ci-auth-token', '{}'); window.__gisNext = { credential: 'ci-google-id-token' }; });
      await page.click('#fakeGoogleBtn');
      await until(async () => (await errShown()) && g.inits.length === 3, 'the Supabase-rejection message and a new render');
      t.check(bilingual(await errShown()), `Supabase rejection message is not bilingual: "${await errShown()}"`);
      t.check(new URL(page.url()).pathname === '/invite', `a failed attempt ended on ${page.url()}`);
      t.check(inviteCalls.length === 0, `${inviteCalls.length} accept calls after attempts that never got a session`);
      const left = (await storedTokens(ctx)).filter((e) => e.includes(' sb-') || e.endsWith('clics_token'));
      t.check(left.length === 0, `a failed attempt left ${left.join(', ')}`);
      t.check(gotrueLogouts === 0, 'a failed attempt called GoTrue /logout');
    },
  },
  {
    name: 'Google callback, Sign out, Back',
    async run(t, page, ctx) {
      await page.goto(`${PORTAL}/login`);
      const at = fakeJwt(USERS.physician);
      await page.goto(`${PORTAL}/auth/callback#access_token=${at}&refresh_token=ci-refresh&expires_in=3600&token_type=bearer&provider_token=g`);
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      await page.click('#logoutBtn');
      await page.waitForURL(`${PORTAL}/login`);
      await settle(page);
      await assertSignedOut(t, page, ctx, 'after Sign out');
      await walkBack(t, page, ctx, 'google');
    },
  },
  {
    name: 'staff Handoff, dashboard Sign out, Back',
    async run(t, page, ctx) {
      await page.goto(`${PORTAL}/forgot`);
      await emailSignIn(page, USERS.admin);
      await page.waitForURL(`${DASH}/home`);
      await settle(page);
      t.check(!TOKEN_IN_URL.test(page.url()), `handoff left a token in the address bar ${page.url()}`);
      const menu = page.getByRole('button', { name: 'เมนู / Menu' });
      if (await menu.isVisible()) await menu.click();
      await page.getByRole('button', { name: /ออกจากระบบ/ }).click();
      await page.waitForURL(`${PORTAL}/login`);
      await settle(page);
      await assertSignedOut(t, page, ctx, 'after Sign out');
      await walkBack(t, page, ctx, 'handoff');
    },
  },
  {
    name: 'signed-in physician: Back from /dashboard skips /login (#176)',
    async run(t, page) {
      await page.goto(`${PORTAL}/forgot`);
      await emailSignIn(page, USERS.physician);
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      await page.goBack({ waitUntil: 'commit' });
      await settle(page);
      t.check(new URL(page.url()).pathname !== '/login' && new URL(page.url()).pathname !== '/dashboard', `Back after sign-in landed on ${page.url()}`);
      await page.goto(`${PORTAL}/login`);
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      await page.goBack({ waitUntil: 'commit' });
      await settle(page);
      const path = new URL(page.url()).pathname;
      t.check(path !== '/login' && path !== '/dashboard', `Back after the signed-in forward landed on ${page.url()}`);
    },
  },
  {
    name: 'root keeps the ?logout=1 handler and the OAuth rescue (ADR 0003)',
    async run(t, page, ctx) {
      await page.goto(`${PORTAL}/forgot`);
      // A live session that /login would forward on, plus a supabase-js key /login never touches:
      // only the root handler clears all of it.
      await page.evaluate(([token, user]) => {
        localStorage.setItem('clics_token', token);
        localStorage.setItem('clics_user', user);
        localStorage.setItem('sb-rgwnnexokstctugwtwub-auth-token', '{}');
        localStorage.setItem('clics_theme', 'dark');
      }, [fakeJwt(USERS.physician), JSON.stringify(USERS.physician)]);
      await page.goto(`${PORTAL}/?logout=1`);
      await settle(page);
      const left = await page.evaluate(() => Object.keys(localStorage));
      t.check(left.every((k) => k === 'clics_theme' || k === 'clics_view'), `/?logout=1 left ${left.join(', ')}`);
      t.check(left.includes('clics_theme'), '/?logout=1 dropped the theme preference');
      t.check(new URL(page.url()).pathname === '/login', `/?logout=1 ended on ${page.url()}`);
      const seen = [];
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) seen.push(f.url()); });
      await page.goto(`${PORTAL}/#access_token=${fakeJwt(USERS.physician)}&refresh_token=ci-refresh&expires_in=3600&token_type=bearer`);
      await settle(page);
      t.check(seen.some((u) => new URL(u).pathname === '/auth/callback'), `/#access_token never reached /auth/callback: ${seen.join(' -> ')}`);
    },
  },
  {
    name: '/reset: recovery token leaves the address bar and Back history; reset works',
    async run(t, page, ctx) {
      await page.goto(`${PORTAL}/forgot`);
      const at = fakeJwt(USERS.physician);
      await page.goto(`${PORTAL}/reset#access_token=${at}&refresh_token=ci-refresh&expires_in=3600&token_type=bearer&type=recovery`);
      await page.locator('#formCard').waitFor({ state: 'visible', timeout: 10000 });
      t.check(!TOKEN_IN_URL.test(page.url()), `recovery token in the address bar ${page.url()}`);
      await page.fill('#password', 'NewPassw0rd99');
      await page.fill('#confirm', 'NewPassw0rd99');
      await page.click('#saveBtn');
      await page.locator('#successCard').waitFor({ state: 'visible', timeout: 10000 });
      t.check(gotrueUpdates.at(-1)?.password === 'NewPassw0rd99', `GoTrue got ${JSON.stringify(gotrueUpdates.at(-1))}, not the new password`);
      await page.click('#successCard a[href="/login"]');
      await page.waitForURL(`${PORTAL}/login`);
      await settle(page);
      for (let i = 1; i <= 4; i++) {
        const before = page.url();
        await page.goBack({ waitUntil: 'commit' }).catch(() => null);
        await settle(page);
        t.check(!TOKEN_IN_URL.test(page.url()), `recovery token in Back history #${i}: ${page.url()}`);
        if (page.url() === before) break;
      }
      t.check((await storedTokens(ctx)).length === 0, `storage after reset: ${(await storedTokens(ctx)).join(', ')}`);
    },
  },
  {
    name: 'signed-out / shows the Landing page and stays on /',
    async run(t, page) {
      await page.goto(`${PORTAL}/`);
      await settle(page);
      t.check(new URL(page.url()).pathname === '/', `signed-out / ended on ${page.url()}`);
      t.check(await page.getByRole('main').getByRole('heading', { level: 1 }).isVisible(), 'no Landing heading on signed-out /');
      t.check(await page.getByRole('main').getByRole('link', { name: 'เข้าสู่ระบบ' }).first().isVisible(), 'no sign-in link in the Landing main');
      t.check(await page.locator('main a[href="/login"]').count() > 0, 'the sign-in call to action does not lead to /login');
      t.check(await page.locator('footer a[href="/privacy"]').isVisible(), 'no Privacy link in the Landing footer');
    },
  },
  {
    name: 'signed-out /privacy renders in Thai, shares the language choice with /, and marks the PI fields pending',
    async run(t, page) {
      await page.goto(`${PORTAL}/login`);
      await settle(page);
      t.check(await page.locator('footer a[href="/privacy"]').isVisible(), 'no Privacy link in the Login footer');
      await page.goto(`${PORTAL}/privacy`);
      await settle(page);
      t.check(new URL(page.url()).pathname === '/privacy', `signed-out /privacy ended on ${page.url()}`);
      t.check(await page.getByRole('main').getByRole('heading', { level: 1 }).isVisible(), 'no heading on /privacy');
      t.check(await page.evaluate(() => document.documentElement.lang) === 'th', '/privacy does not start in Thai');
      t.check(THAI.test(await page.title()), `the Thai Privacy page's title is not Thai: ${await page.title()}`);
      for (const lang of ['th', 'en']) {
        await page.click(`.lang-switch [data-set-lang="${lang}"]`);
        const fields = await page.locator('section[aria-labelledby="who-h"] .policy-facts > div').evaluateAll((rows) => rows.map((r) => [
          r.querySelector('dt').innerText.trim(),
          [...r.querySelectorAll('dd .pending')].some((e) => e.checkVisibility()),
        ]));
        t.check(fields.length === 4, `[${lang}] /privacy lists ${fields.length} PI fields, not the 4 (controller, contact, lawful basis, retention)`);
        for (const [name, marked] of fields) t.check(marked, `[${lang}] PI field "${name}" has no visible pending marker`);
        const readers = await page.locator('section[aria-labelledby="see-h"] li').evaluateAll((lis) => lis.filter((li) => li.checkVisibility()).map((li) => li.innerText));
        const th = lang === 'th';
        const line = (re) => readers.find((r) => re.test(r)) ?? '';
        const ethics = line(th ? /จริยธรรม/ : /ethics/i);
        t.check(ethics, `[${lang}] the /privacy readers list does not name the ethics role`);
        t.check((th ? /คำตอบของ AI/ : /AI reply/i).test(ethics) && (th ? /บันทึกการตรวจสอบ/ : /audit log/i).test(ethics), `[${lang}] the ethics line does not say the audit log can hold AI reply text`);
        // #281 closed the PostgREST surface that let an assigned auditor read ples.chief_complaint and ples.title (#242).
        const auditor = line(th ? /ผู้ตรวจที่เป็นผู้เชี่ยวชาญ/ : /Expert auditors/);
        t.check((th ? /ผ่านตัวกรองแล้ว/ : /after the filter/).test(auditor), `[${lang}] the auditor line does not say auditors see the filtered conversation: "${auditor}"`);
        t.check(!(th ? /ฐานข้อมูลยังไม่ได้กัน|อาการสำคัญ/ : /does not yet stop|chief complaint/i).test(readers.join('\n')), `[${lang}] the readers list still describes the #242 auditor gap`);
        // admin.js /identity-queue serves admins (own council) and the superadmin (every council).
        const identity = line(th ? /เลขใบอนุญาต/ : /licence number/i);
        // A superadmin can also store professionals.license_number on create or edit (lib/provisioning.js),
        // so the licence number is not collected only at identity verification.
        const idPara = await page.locator('section[aria-labelledby="collect-h"] li').filter({ hasText: th ? 'เลขประจำตัวประชาชน' : 'national ID' }).first().innerText();
        t.check((th ? /ผู้ดูแลระบบ CLICS ใส่ไว้ในบัญชี/ : /administrator enters it on your account/i).test(idPara), `[${lang}] the identity paragraph does not say a system administrator can store the licence number on your account`);
        // The browser talks to *.supabase.co directly, and Supabase Auth keeps the IP with the session.
        const supabase = await page.locator('section[aria-labelledby="proc-h"] .policy-facts > div').filter({ hasText: 'Supabase' }).locator('dd').innerText();
        t.check(/\bIP\b/.test(supabase), `[${lang}] the Supabase line does not say it receives your IP address`);
        // logEventStrict's rollback is the exception to "most actions still go ahead".
        const logPara = await page.locator('section[aria-labelledby="collect-h"] li').filter({ hasText: th ? 'บันทึกการตรวจสอบเก็บ' : 'The audit log records' }).first().innerText();
        t.check((th ? /ถูกยกเลิก/ : /undone/).test(logPara), `[${lang}] the log-failure sentence has no lock exception`);
        // Choosing Google loads Google's script from Google (ADR 0008): the entry says so, and keeps its "only if you choose" line.
        const googleRow = await page.locator('section[aria-labelledby="proc-h"] .policy-facts > div').filter({ has: page.locator('dt', { hasText: /^Google$/ }) }).locator('dd').innerText();
        t.check((th ? /เฉพาะเมื่อคุณเลือกเข้าสู่ระบบด้วย Google/ : /Only if you choose to sign in with Google/).test(googleRow), `[${lang}] the Google line lost its "only if you choose" wording: "${googleRow}"`);
        t.check((th ? /โหลดโค้ดเข้าสู่ระบบจาก Google/ : /loads Google's sign-in code from Google/).test(googleRow) && /\bIP\b/.test(googleRow) && (th ? /ข้อมูลเบราว์เซอร์/ : /browser details/).test(googleRow), `[${lang}] the Google line does not say Google's code is loaded from Google and Google receives the IP address and browser details: "${googleRow}"`);
        t.check((th ? /ผู้ดูแลระบบ CLICS/ : /CLICS system administrators/i).test(identity), `[${lang}] no readers line says the CLICS system administrators see the licence number and last four digits`);
      }
      await page.click('.lang-switch [data-set-lang="th"]');
      await page.click('.lang-switch [data-set-lang="en"]');
      await page.goto(`${PORTAL}/`);
      await settle(page);
      t.check(await page.evaluate(() => document.documentElement.lang) === 'en', 'English chosen on /privacy did not carry to /');
      await page.click('.lang-switch [data-set-lang="th"]');
      await page.goto(`${PORTAL}/privacy`);
      await settle(page);
      t.check(await page.evaluate(() => document.documentElement.lang) === 'th', 'Thai chosen on / did not carry to /privacy');
      await page.click('.lang-switch [data-set-lang="en"]');
      const thai = (await pageStrings(page)).filter((l) => THAI.test(l));
      t.check(thai.length === 0, `English /privacy still shows Thai: ${thai.slice(0, 4).join(' | ')}`);
      t.check(!THAI.test(await page.title()), `the English Privacy page's title is ${await page.title()}`);
    },
  },
  {
    name: 'signed-in physician at / forwards to /dashboard without showing the Landing page',
    async run(t, page, ctx) {
      await page.goto(`${PORTAL}/forgot`);
      await page.evaluate(([token, user]) => { localStorage.setItem('clics_token', token); localStorage.setItem('clics_user', user); },
        [fakeJwt(USERS.physician), JSON.stringify(USERS.physician)]);
      const seen = landingSightings(page);
      await watchLanding(ctx);
      await slowDown(ctx, `${PORTAL}/dashboard`);
      await page.goto(`${PORTAL}/`, { waitUntil: 'commit' });
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      t.check(seen.length === 0, `the Landing page was shown before the forward: ${seen.join(', ')}`);
      await page.goBack({ waitUntil: 'commit' });
      await settle(page);
      t.check(new URL(page.url()).pathname !== '/', `Back from /dashboard landed on the Landing page ${page.url()}`);
    },
  },
  {
    name: 'signed-in staff at / reaches the dashboard Handoff',
    async run(t, page, ctx) {
      await page.goto(`${PORTAL}/forgot`);
      await page.evaluate(([token, user]) => { localStorage.setItem('clics_token', token); localStorage.setItem('clics_user', user); },
        [fakeJwt(USERS.admin), JSON.stringify(USERS.admin)]);
      const seen = landingSightings(page);
      await watchLanding(ctx);
      await slowDown(ctx, `${DASH}/login`);
      await page.goto(`${PORTAL}/`, { waitUntil: 'commit' });
      await page.waitForURL(`${DASH}/home`);
      await settle(page);
      t.check(!TOKEN_IN_URL.test(page.url()), `handoff left a token in the address bar ${page.url()}`);
      t.check(seen.length === 0, `the Landing page was shown before the Handoff: ${seen.join(', ')}`);
    },
  },
  {
    name: 'signed-out /, Sign in, Back: the restored Landing page forwards without showing',
    async run(t, page, ctx) {
      const seen = landingSightings(page);
      const restores = [];
      page.on('console', (m) => { if (m.text() === `pw:bfcache-restore ${PORTAL}/`) restores.push(m.text()); });
      await watchLanding(ctx);
      await page.goto(`${PORTAL}/forgot`);
      await page.goto(`${PORTAL}/`);
      await settle(page);
      t.check(seen.includes('pw:landing-visible /'), `the signed-out Landing page never showed: ${seen.join(', ')}`);
      await page.locator('.hero-actions a[href="/login"]').click();
      await page.waitForURL(`${PORTAL}/login`);
      await emailSignIn(page, USERS.physician, { open: false });
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      await slowDown(ctx, `${PORTAL}/dashboard`);
      await page.goBack({ waitUntil: 'commit' });
      await settle(page);
      t.check(restores.length > 0, 'Back did not restore / from the back/forward cache, so the restore went untested');
      t.check(new URL(page.url()).pathname === '/dashboard', `Back from /dashboard ended on ${page.url()}`);
      const restoredSightings = seen.filter((l) => l.endsWith(' restored'));
      t.check(restoredSightings.length === 0, `the restored Landing page was shown: ${restoredSightings.join(', ')}`);
      await page.goBack({ waitUntil: 'commit' }).catch(() => null);
      await settle(page);
      t.check(new URL(page.url()).pathname === '/forgot', `a second Back did not leave /dashboard for the page before /: ${page.url()}`);
    },
  },
  {
    name: 'Landing TH/EN switch flips every string, persists, and works by keyboard',
    async run(t, page) {
      await page.goto(`${PORTAL}/`);
      await settle(page);
      t.check(await page.evaluate(() => document.documentElement.lang) === 'th', 'the Landing page does not start in Thai');
      t.check(THAI.test((await pageStrings(page)).join('\n')), 'the Thai Landing page shows no Thai');
      t.check(THAI.test(await page.title()), `the Thai Landing page's title is not Thai: ${await page.title()}`);
      const group = page.getByRole('group', { name: /Choose language|เลือกภาษา/ });
      t.check(await group.getByRole('button', { name: 'ไทย', pressed: true }).isVisible(), 'the Thai button is not pressed by default');
      t.check(await tabTo(page, '[data-set-lang="en"]'), 'Tab never reached the English button');
      await page.keyboard.press('Enter');
      const checkEnglish = async (where) => {
        t.check(await page.evaluate(() => document.documentElement.lang) === 'en', `${where}: html[lang] is not en`);
        const thai = (await pageStrings(page)).filter((l) => THAI.test(l));
        t.check(thai.length === 0, `${where}: Thai still seen or heard: ${thai.slice(0, 4).join(' | ')}`);
        t.check(await group.getByRole('button', { name: 'English', pressed: true }).isVisible(), `${where}: English is not pressed`);
        t.check(await group.getByRole('button', { name: 'ไทย', pressed: false }).isVisible(), `${where}: Thai is still pressed`);
        const alts = await page.locator('img[data-alt-en]').evaluateAll((imgs) => imgs.map((i) => [i.alt, i.dataset.altEn]));
        t.check(alts.length > 0 && alts.every(([a, en]) => a === en && !/[฀-๿]/.test(a)), `${where}: image alts did not switch to English`);
      };
      await checkEnglish('after Enter');
      await page.reload();
      await settle(page);
      await checkEnglish('after reload');
      t.check(await tabTo(page, '[data-set-lang="th"]'), 'Tab never reached the Thai button');
      await page.keyboard.press('Space');
      t.check(await page.evaluate(() => document.documentElement.lang) === 'th', 'Space on ไทย did not switch back');
      t.check(THAI.test(await page.title()), `the title did not switch back to Thai: ${await page.title()}`);
      const alts = await page.locator('img[data-alt-th]').evaluateAll((imgs) => imgs.map((i) => [i.alt, i.dataset.altTh]));
      t.check(alts.every(([a, th]) => a === th), 'image alts did not switch back to Thai');
    },
  },
  {
    // ui-gates gate 11: every control on / shows hover, pressed and keyboard focus, each as a computed
    // style change (pressed is compared with hover, which a mouse press always sits on top of).
    name: 'every interactive control on / and /privacy has a hover, pressed and focus-visible state (both themes, both languages)',
    async run(t, page) {
      const PROPS = ['color', 'backgroundColor', 'borderTopColor', 'outlineStyle', 'outlineColor', 'boxShadow', 'textDecorationLine', 'opacity', 'transform', 'filter'];
      const snap = (i) => page.evaluate(([i, props]) => { const cs = getComputedStyle(window.__els[i]); return props.map((k) => cs[k]); }, [i, PROPS]);
      const changed = (a, b) => PROPS.filter((_, k) => a[k] !== b[k]);
      for (const [path, least] of [['/', 15], ['/privacy', 6]]) for (const scheme of ['light', 'dark']) for (const lang of ['th', 'en']) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(`${PORTAL}/forgot`);
        await page.evaluate((l) => localStorage.setItem('clics_manual_lang', l), lang);
        await page.goto(`${PORTAL}${path}`);
        await settle(page);
        const labels = await page.evaluate(() => {
          window.__els = [...document.querySelectorAll('a[href], button, summary, input, select, textarea, [tabindex]')].filter((e) => e.checkVisibility());
          return window.__els.map((e) => `${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).split(' ').join('.') : ''} «${e.innerText.trim().slice(0, 20)}»`);
        });
        const where = `${path} ${scheme} ${lang}`;
        t.check(labels.length >= least, `${where}: only ${labels.length} controls found, so this check tested little`);
        await page.mouse.move(0, 0);
        const rest = [];
        for (let i = 0; i < labels.length; i++) rest.push(await snap(i));
        const focused = new Set();
        for (let k = 0; k < labels.length + 3; k++) {
          await page.keyboard.press('Tab');
          const i = await page.evaluate(() => window.__els.indexOf(document.activeElement));
          if (i < 0 || focused.has(i)) continue;
          if (await page.evaluate(() => document.activeElement.matches(':focus-visible')) && changed(rest[i], await snap(i)).length) focused.add(i);
        }
        for (let i = 0; i < labels.length; i++) {
          await page.evaluate(() => document.activeElement?.blur());
          // The skip link sits above the viewport until it has focus; a pointer can only reach it then.
          await page.evaluate((i) => window.__els[i].classList.contains('skip-link') && window.__els[i].focus(), i);
          await page.evaluate((i) => window.__els[i].scrollIntoView({ block: 'center' }), i);
          await page.mouse.move(0, 0);
          const before = await snap(i);
          const box = await page.evaluate((i) => { const r = window.__els[i].getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, i);
          await page.mouse.move(...box);
          const hover = await snap(i);
          await page.mouse.down();
          const pressed = await snap(i);
          // Release off the control, so nothing is activated.
          await page.mouse.move(0, 0);
          await page.mouse.up();
          const missing = [!changed(before, hover).length && 'hover', !changed(hover, pressed).length && 'pressed', !focused.has(i) && 'focus-visible'].filter(Boolean);
          t.check(!missing.length, `${where}: ${labels[i]} has no ${missing.join(', ')} state`);
        }
      }
    },
  },
  {
    name: 'manual TH/EN switch flips the title and the theme and view toggles',
    async run(t, page) {
      await page.goto(`${PORTAL}/manual`);
      await settle(page);
      const toggles = () => page.locator('.toggle-cluster .toggle-btn').evaluateAll((bs) => bs.flatMap((b) => [b.innerText, b.getAttribute('aria-label')]));
      t.check(THAI.test(await page.title()), `the Thai manual's title is not Thai: ${await page.title()}`);
      t.check((await toggles()).every((s) => THAI.test(s)), `Thai manual toggles: ${(await toggles()).join(' | ')}`);
      await page.click('.lang-switch [data-set-lang="en"]');
      for (const where of ['after the switch', 'after reload']) {
        t.check(!THAI.test(await page.title()), `${where}: the English manual's title is ${await page.title()}`);
        const thai = (await toggles()).filter((s) => THAI.test(s));
        t.check(thai.length === 0, `${where}: English manual toggles say ${thai.join(' | ')}`);
        await page.reload();
        await settle(page);
      }
    },
  },
  {
    name: 'the ECG logo stops moving within 5 seconds on /, /login and /manual (WCAG 2.2.2)',
    motion: true,
    async run(t, page) {
      for (const path of ['/', '/login', '/manual']) {
        await page.goto(`${PORTAL}${path}`, { waitUntil: 'domcontentloaded' });
        const anims = await page.evaluate(() => [...document.querySelectorAll('.logo-ecg *')].flatMap((el) => el.getAnimations())
          .map((a) => ({ name: a.animationName, iterations: a.effect.getTiming().iterations, end: a.effect.getComputedTiming().endTime })));
        t.check(anims.some((a) => a.name === 'ecg-beat'), `${path}: the ECG beat does not animate, so this check tested nothing`);
        for (const a of anims) {
          t.check(Number.isFinite(a.iterations), `${path}: ${a.name} repeats forever`);
          t.check(a.end <= 5000, `${path}: ${a.name} moves until ${a.end} ms`);
        }
      }
    },
  },
  {
    name: 'dark colour scheme: signed-out / paints dark from the first frame',
    async run(t, page, ctx) {
      await page.emulateMedia({ colorScheme: 'dark' });
      await ctx.addInitScript(() => {
        new MutationObserver((_, obs) => {
          if (!document.body) return;
          obs.disconnect();
          console.log('pw:theme-at-body ' + document.documentElement.getAttribute('data-theme'));
        }).observe(document, { childList: true, subtree: true });
      });
      const seen = [];
      page.on('console', (m) => { if (m.text().startsWith('pw:theme-at-body')) seen.push(m.text()); });
      await page.goto(`${PORTAL}/`);
      await settle(page);
      t.check(seen[0] === 'pw:theme-at-body dark', `data-theme when the body began: ${seen.join(', ') || 'never logged'}`);
    },
  },
  {
    name: 'public copy on / and /privacy (both languages) and /login makes no overclaim',
    async run(t, page) {
      for (const line of OVERCLAIM_SAMPLES.caught) t.check(OVERCLAIM.test(line), `OVERCLAIM misses "${line}"`);
      for (const line of OVERCLAIM_SAMPLES.passed) t.check(!OVERCLAIM.test(line), `OVERCLAIM rejects the accurate "${line}"`);
      for (const line of AUDIT_OVERCLAIM_SAMPLES.caught) t.check(AUDIT_OVERCLAIM.test(line), `AUDIT_OVERCLAIM misses "${line}"`);
      for (const line of AUDIT_OVERCLAIM_SAMPLES.passed) t.check(!AUDIT_OVERCLAIM.test(line), `AUDIT_OVERCLAIM rejects the accurate "${line}"`);
      for (const [path, lang] of [['/', 'th'], ['/', 'en'], ['/privacy', 'th'], ['/privacy', 'en'], ['/login', 'th'], ['/login', 'en']]) {
        await page.goto(`${PORTAL}/forgot`);
        await page.evaluate((l) => localStorage.setItem('clics_manual_lang', l), lang);
        await page.goto(`${PORTAL}${path}`);
        await settle(page);
        const text = await page.evaluate(() => { document.querySelectorAll('details').forEach((d) => { d.open = true; }); return document.body.innerText; });
        const hit = text.match(OVERCLAIM) || text.match(AUDIT_OVERCLAIM);
        t.check(!hit, `${path} [${lang}] says "${hit?.[0]}"`);
        if (path !== '/login') t.check(NAMED_READERS[lang].test(text), `${path} [${lang}] does not say council administrators can read a named transcript`);
        for (const chip of await page.locator('.trust-chip').allInnerTexts()) {
          t.check(!COMPLIANCE_CHIP.test(chip), `${path} [${lang}] trust chip reads as a compliance claim: "${chip}"`);
        }
      }
    },
  },
];

async function main() {
  const servers = [await listen(portalServer(), 3000), await listen(portalServer(PORTAL_OFF_LIST), 3010), await listen(apiServer(), 3001)];
  const dashUp = await fetch(`${DASH_UPSTREAM}/login`).then((r) => r.ok).catch(() => false);
  if (!dashUp) { console.error(`audit-dashboard is not serving at ${DASH_UPSTREAM}`); process.exit(1); }
  if (process.argv[2] === '--serve') { console.log(`Portal ${PORTAL}, stub backend ${API}; Ctrl-C to stop`); return; }
  const supabaseJs = await supabaseModule();

  // A proxied page has no address space, so Chromium's Local Network Access check would block its
  // calls to the loopback backend. Served directly (as in CI), the check stays on.
  const args = DASH_UPSTREAM === DASH ? [] : ['--disable-features=LocalNetworkAccessChecks'];
  // Full Chromium in new headless mode: the default headless shell never restores from bfcache.
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args, ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  const only = process.argv[2];
  let failed = 0;
  let bfcacheRestores = 0;
  for (const s of SCENARIOS.filter((x) => !only || x.name.includes(only))) {
    // Reduced motion turns off the Portal's cross-document view transition, which stalls every
    // animation frame in headless Chromium and leaves no element "stable" enough to click. A `motion`
    // scenario clicks nothing and reads the animations a reader with no motion preference gets.
    const ctx = await browser.newContext({ reducedMotion: s.motion ? 'no-preference' : 'reduce' });
    if (DASH_UPSTREAM !== DASH) {
      await ctx.route((url) => url.href.startsWith(DASH), async (route) => {
        const response = await route.fetch({ url: DASH_UPSTREAM + route.request().url().slice(DASH.length) });
        await route.fulfill({ response });
      });
    }
    await ctx.route((url) => !url.href.startsWith(PORTAL) && !url.href.startsWith(PORTAL_OFF_LIST) && !url.href.startsWith(API) && !url.href.startsWith(DASH), (route) => {
      const url = route.request().url();
      if (url.startsWith(GSI)) return gsiBlocked ? route.abort() : route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_GSI });
      if (url.startsWith(SUPABASE_JS)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: supabaseJs, headers: { 'access-control-allow-origin': '*' } });
      if (url.startsWith(SUPABASE)) return gotrue(route);
      return route.abort();
    });
    await ctx.addInitScript(() => addEventListener('pageshow', (e) => { if (e.persisted) console.log('pw:bfcache-restore ' + location.href); }));
    const page = await ctx.newPage();
    let privateRestores = 0;
    page.on('console', (m) => {
      const [tag, href] = m.text().split(' ');
      if (tag === 'pw:bfcache-restore' && isPrivate(href)) privateRestores++;
    });
    configTail = s.config || '';
    const problems = [];
    const t = { check: (ok, msg) => { if (!ok) problems.push(msg); } };
    try {
      await s.run(t, page, ctx);
      // Without a restore of a private page, the bfcache guards went untested in this scenario.
      if (s.privateRestore) t.check(privateRestores > 0, 'no private page was restored from the back/forward cache');
    } catch (e) { problems.push(`threw: ${e.message.split('\n').slice(0, 12).join(' | ')}`); }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${s.name}`);
    for (const p of problems) console.log(`     - ${p}`);
    if (problems.length) failed++;
    bfcacheRestores += privateRestores;
    await ctx.close();
  }
  await browser.close();
  for (const s of servers) s.close();
  console.log(`private pages restored from the back/forward cache: ${bfcacheRestores}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
