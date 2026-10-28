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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };

const USERS = {
  physician: { id: 'u-phys', email: 'phys@ci.test', role: 'physician', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'แพทย์ ทดสอบ', full_name_en: 'CI Physician' },
  admin: { id: 'u-admin', email: 'admin@ci.test', role: 'admin', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'ผู้ดูแล ทดสอบ', full_name_en: 'CI Admin', council_id: 'c1' },
  alpha: { id: 'u-alpha', email: 'alpha@ci.test', role: 'physician', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'ALPHA', full_name_en: 'ALPHA' },
  bravo: { id: 'u-bravo', email: 'bravo@ci.test', role: 'physician', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'BRAVO', full_name_en: 'BRAVO' },
  invitee: { id: 'u-invitee', email: 'invitee@ci.test', role: 'admin', consented_at: '2026-01-01T00:00:00Z', full_name_th: 'ผู้รับเชิญ', full_name_en: 'CI Invitee', council_id: 'c1' },
  dualRole: { id: 'u-dual', email: 'dual@ci.test', role: 'physician', can_audit: true, consented_at: '2026-01-01T00:00:00Z', full_name_th: 'แพทย์ ผู้ตรวจ', full_name_en: 'CI Dual Role' },
};
// Bank details only their owner may see; the cross-user scenario looks for the marker on screen.
const PAYMENT_INFO = {
  'u-alpha': { account_name: 'ALPHA', bank: 'ALPHA-BANK', account_no: '1111111111', promptpay: '' },
  'u-bravo': { account_name: 'BRAVO', bank: 'BRAVO-BANK', account_no: '2222222222', promptpay: '' },
};

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeJwt(user) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, email: user.email, clics_role: user.role, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 })}.ci-signature`;
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
    if (path === '/auth/invite/CI-INVITE' && req.method === 'GET') return json(200, { email: USERS.invitee.email, role: 'admin', council: { name_th: 'สภาทดสอบ', name_en: 'CI Council' } });
    if (path === '/auth/invite/CI-INVITE/accept') {
      return body.otp ? json(201, { access_token: fakeJwt(USERS.invitee), user: USERS.invitee }) : json(202, { status: 'otp_sent', email: USERS.invitee.email });
    }
    if (path === '/auth/logout') {
      revoked.add((req.headers.authorization || '').replace(/^Bearer /, ''));
      return json(200, { ok: true });
    }
    const u = userOf(req.headers.authorization || '', path);
    if (!u) return json(401, { error: 'unauthenticated' });
    if (path === '/auth/me') return json(200, { user: u });
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
function gotrue(route) {
  const req = route.request();
  const { pathname } = new URL(req.url());
  const user = { id: 'sb-user', aud: 'authenticated', role: 'authenticated', email: 'phys@ci.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
  const headers = { 'access-control-allow-origin': PORTAL, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
  if (pathname === '/auth/v1/user' && req.method() === 'PUT') gotrueUpdates.push(req.postDataJSON());
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
const OVERCLAIM = /on-?premise|validated|ติดตั้งภายในองค์กร/i;

async function tabTo(page, selector) {
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((sel) => document.activeElement?.matches(sel), selector)) return true;
  }
  return false;
}

// Logs whether the Landing heading was on screen once the document finished parsing, from every
// document the tab loads; a forwarded visit never gets that far, so it logs nothing.
function watchLanding(ctx) {
  return ctx.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    const h = document.querySelector('.hero h1');
    if (!h) return;
    const shown = getComputedStyle(document.body).visibility !== 'hidden' && h.getBoundingClientRect().height > 0;
    console.log('pw:landing ' + location.pathname + ' ' + shown);
  }));
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
    name: 'signed-in physician at / forwards to /dashboard without showing the Landing page',
    async run(t, page, ctx) {
      await page.goto(`${PORTAL}/forgot`);
      await page.evaluate(([token, user]) => { localStorage.setItem('clics_token', token); localStorage.setItem('clics_user', user); },
        [fakeJwt(USERS.physician), JSON.stringify(USERS.physician)]);
      const seen = [];
      page.on('console', (m) => { if (m.text().startsWith('pw:landing ')) seen.push(m.text()); });
      await watchLanding(ctx);
      await page.goto(`${PORTAL}/`);
      await page.waitForURL(`${PORTAL}/dashboard`);
      await settle(page);
      t.check(!seen.some((l) => l.endsWith(' true')), `the Landing page was shown before the forward: ${seen.join(', ')}`);
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
      const seen = [];
      page.on('console', (m) => { if (m.text().startsWith('pw:landing ')) seen.push(m.text()); });
      await watchLanding(ctx);
      await page.goto(`${PORTAL}/`);
      await page.waitForURL(`${DASH}/home`);
      await settle(page);
      t.check(!TOKEN_IN_URL.test(page.url()), `handoff left a token in the address bar ${page.url()}`);
      t.check(!seen.some((l) => l.endsWith(' true')), `the Landing page was shown before the Handoff: ${seen.join(', ')}`);
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
    name: 'public copy on / (both languages) and /login makes no overclaim',
    async run(t, page) {
      for (const [path, lang] of [['/', 'th'], ['/', 'en'], ['/login', 'th']]) {
        await page.goto(`${PORTAL}/forgot`);
        await page.evaluate((l) => localStorage.setItem('clics_manual_lang', l), lang);
        await page.goto(`${PORTAL}${path}`);
        await settle(page);
        const hit = (await page.evaluate(() => document.body.innerText)).match(OVERCLAIM);
        t.check(!hit, `${path} [${lang}] says "${hit?.[0]}"`);
      }
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
    let privateRestores = 0;
    page.on('console', (m) => {
      const [tag, href] = m.text().split(' ');
      if (tag === 'pw:bfcache-restore' && isPrivate(href)) privateRestores++;
    });
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
