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
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../physician-ui/public', import.meta.url));
const PORTAL = 'http://localhost:3000';
const API = 'http://localhost:3001';
const DASH = 'http://localhost:3002';
// Where the dashboard really serves. The browser always sees DASH, because the Portal's config.js
// hands staff to localhost:3002; a different upstream (a busy local port) is proxied.
const DASH_UPSTREAM = process.env.DASH_UPSTREAM || DASH;
const SUPABASE = 'https://rgwnnexokstctugwtwub.supabase.co';
const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2.49.4';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const USERS = {
  physician: { id: 'u-phys', email: 'phys@ci.test', role: 'physician', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'แพทย์ ทดสอบ', full_name_en: 'CI Physician' },
  admin: { id: 'u-admin', email: 'admin@ci.test', role: 'admin', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'ผู้ดูแล ทดสอบ', full_name_en: 'CI Admin', council_id: 'c1' },
};

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeJwt(user) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, email: user.email, clics_role: user.role, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 })}.ci-signature`;
}
function userOf(authHeader) {
  try {
    const p = JSON.parse(Buffer.from(authHeader.replace(/^Bearer /, '').split('.')[1], 'base64url'));
    return Object.values(USERS).find((u) => u.id === p.sub) || null;
  } catch { return null; }
}

function listen(server, port) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, 'localhost', () => resolve(server)); });
}

// Mirrors vercel.json cleanUrls: '/' -> index.html, '/x' -> x.html.
function portalServer() {
  return createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, PORTAL).pathname);
      if (p === '/') p = '/index.html';
      let file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      let s = await stat(file).catch(() => null);
      if (s?.isDirectory()) { file = join(file, 'index.html'); s = await stat(file).catch(() => null); }
      if (!s && !extname(file)) { file += '.html'; s = await stat(file).catch(() => null); }
      if (!s) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(500).end('err'); }
  });
}

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
    const session = (u) => json(200, { access_token: fakeJwt(u), user: u });

    if (path === '/auth/login') {
      const u = Object.values(USERS).find((x) => x.email === body.email);
      return u ? session(u) : json(401, { error: 'Invalid email or password' });
    }
    if (path === '/auth/oauth/google/complete') return session(USERS.physician);
    if (path === '/auth/me') {
      const u = userOf(req.headers.authorization || '');
      return u ? json(200, { user: u }) : json(401, { error: 'unauthenticated' });
    }
    if (path === '/auth/logout') return json(200, { ok: true });
    if (req.method === 'GET' && /^\/(ples|ples\/folders)$/.test(path)) return json(200, []);
    return json(200, {});
  });
}

// The UMD build is self-contained; the shim re-exports it under the ESM name the Portal imports.
async function supabaseModule() {
  const umd = await readFile(createRequire(import.meta.url).resolve('@supabase/supabase-js/dist/umd/supabase.js'), 'utf8');
  return `${umd}\nexport const createClient = self.supabase.createClient;\n`;
}

// GoTrue's endpoints, enough for setSession (GET /user), updateUser (PUT /user) and signOut.
function gotrue(route) {
  const req = route.request();
  const { pathname } = new URL(req.url());
  const user = { id: 'sb-user', aud: 'authenticated', role: 'authenticated', email: 'phys@ci.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
  const headers = { 'access-control-allow-origin': PORTAL, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
  if (pathname === '/auth/v1/user') return route.fulfill({ status: 200, headers, json: user });
  if (pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers });
  return route.fulfill({ status: 404, headers, json: { error: 'not stubbed' } });
}

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
  const url = new URL(page.url());
  const leaks = await storedTokens(ctx);
  t.check(leaks.length === 0, `${where}: storage holds ${leaks.join(', ')}`);
  t.check(!TOKEN_IN_URL.test(url.href), `${where}: token in address bar ${url.href}`);
  const signedInPage = url.origin === PORTAL ? !PORTAL_PUBLIC.has(url.pathname) : url.origin === DASH && url.pathname !== '/login';
  t.check(!signedInPage, `${where}: signed-in page shown ${url.href}`);
}

// Presses Back through the whole history, checking each step.
async function walkBack(t, page, ctx, label) {
  for (let i = 1; i <= 8; i++) {
    const before = page.url();
    await page.goBack({ waitUntil: 'commit' }).catch(() => null);
    await settle(page);
    if (page.url() === before || page.url() === 'about:blank') break;
    await assertSignedOut(t, page, ctx, `${label} Back #${i}`);
  }
}

async function emailSignIn(page, user) {
  await page.goto(`${PORTAL}/login`);
  await page.fill('#email', user.email);
  await page.fill('#password', 'ci-password-1');
  await page.click('#loginBtn');
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
      await page.evaluate(() => { localStorage.setItem('clics_token', 'x'); localStorage.setItem('clics_user', '{}'); localStorage.setItem('clics_theme', 'dark'); });
      await page.goto(`${PORTAL}/?logout=1`);
      await settle(page);
      const left = await page.evaluate(() => ({ token: localStorage.getItem('clics_token'), theme: localStorage.getItem('clics_theme') }));
      t.check(left.token === null, '/?logout=1 left clics_token');
      t.check(left.theme === 'dark', '/?logout=1 dropped the theme preference');
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
];

async function main() {
  const servers = [await listen(portalServer(), 3000), await listen(apiServer(), 3001)];
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
    // animation frame in headless Chromium and leaves no element "stable" enough to click.
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    if (DASH_UPSTREAM !== DASH) {
      await ctx.route((url) => url.href.startsWith(DASH), async (route) => {
        const response = await route.fetch({ url: DASH_UPSTREAM + route.request().url().slice(DASH.length) });
        await route.fulfill({ response });
      });
    }
    await ctx.route((url) => !url.href.startsWith(PORTAL) && !url.href.startsWith(API) && !url.href.startsWith(DASH), (route) => {
      const url = route.request().url();
      if (url.startsWith(SUPABASE_JS)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: supabaseJs, headers: { 'access-control-allow-origin': '*' } });
      if (url.startsWith(SUPABASE)) return gotrue(route);
      return route.abort();
    });
    await ctx.addInitScript(() => addEventListener('pageshow', (e) => { if (e.persisted) console.log('pw:bfcache-restore ' + location.href); }));
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.text().startsWith('pw:bfcache-restore')) bfcacheRestores++; });
    const problems = [];
    const t = { check: (ok, msg) => { if (!ok) problems.push(msg); } };
    try { await s.run(t, page, ctx); } catch (e) { problems.push(`threw: ${e.message.split('\n').slice(0, 12).join(' | ')}`); }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${s.name}`);
    for (const p of problems) console.log(`     - ${p}`);
    if (problems.length) failed++;
    await ctx.close();
  }
  await browser.close();
  for (const s of servers) s.close();
  console.log(`back/forward cache restores observed: ${bfcacheRestores}`);
  if (!only && bfcacheRestores === 0) { console.log('FAIL no Back was served from the back/forward cache, so the bfcache path went untested'); failed++; }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
