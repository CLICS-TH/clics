#!/usr/bin/env node
/*
 * Responsive regression smoke (CI guard for the "automatic perfect fit" work).
 *
 * Renders the physician-ui portal — the touch-first pilot surface, fully static so it needs NO
 * backend — at four widths under coarse-pointer (mobile) emulation and asserts the three regressions
 * the shared primitive layer was built to prevent:
 *   1. ZERO horizontal overflow            (documentElement.scrollWidth <= innerWidth)
 *   2. Touch targets >= 44x44 (WCAG 2.5.5) (buttons / role=radio / .icon-btn / composer-send …)
 *   3. Form fields >= 16px on touch        (so iOS Safari never auto-zooms on focus)
 *
 * Hermetic: a tiny built-in static server serves physician-ui/public, self-hosted fonts included; all
 * external requests (Chart.js CDN / backend API) are aborted; a fake token bypasses the auth redirect so
 * the authed shells render. No secrets, no live infra. Exits non-zero on any failure, on a font that
 * fails to load, and on any request to a Google font host.
 *
 * Run: node scripts/responsive/responsive-smoke.mjs   (from repo root)
 * Override the dashboard target (optional, e.g. against a running dev server):  DASH_URL=http://localhost:3002/login
 */
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { watchPageHealth, resolvedTheme } from './page-health.mjs';

// The Portal self-hosts its fonts (#193) so a visitor's IP is not sent to Google just for viewing a page.
const GOOGLE_FONT_HOST = /^https?:\/\/fonts\.(googleapis|gstatic)\.com\//;
const GOOGLE_FONT_REF = /fonts\.(googleapis|gstatic)\.com/;
const ROOT = fileURLToPath(new URL('../../physician-ui/public', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp' };

// ---- tiny static server: '/' -> index.html, extensionless -> .html (mirrors the Vercel rewrites) ----
function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      let file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      let s = await stat(file).catch(() => null);
      if (!s && !extname(file)) { file += '.html'; s = await stat(file).catch(() => null); }
      if (!s) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(500).end('err'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Widths to test. <1280 run under coarse/mobile emulation (so the @media(pointer:coarse) tap + input
// floors apply, as they would on a real phone/tablet); 1280 is the fine-pointer desktop check.
const WIDTHS = [
  { w: 320, h: 700, coarse: true },
  { w: 375, h: 800, coarse: true },
  { w: 768, h: 1024, coarse: true },
  { w: 1280, h: 900, coarse: false },
  { w: 1440, h: 900, coarse: false },
];
// Pages marked `dark` render again under a dark system colour scheme at these widths.
const DARK_WIDTHS = new Set([320, 768, 1440]);

// Pages whose LAYOUT renders without a backend (token injected to pass the auth gate; content may be
// empty/loading, but the shell — nav, container, forms, chat composer — is what we overflow-check).
// A signed-out page must also render with no page error, console error or failed request. A token
// page runs on a fake token with its backend aborted, so its errors are not checked.
const PAGES = [
  // The public Landing page; signed out, so it renders instead of forwarding.
  { path: '/', token: false, label: 'landing', dark: true },
  { path: '/login', token: false, label: 'login' },
  { path: '/forgot', token: false, label: 'forgot' },
  { path: '/guest-chat', token: false, label: 'guest-chat' },
  { path: '/dashboard', token: true, label: 'dashboard' },
  { path: '/ple-new', token: true, label: 'ple-new' },
  { path: '/lpdp', token: true, label: 'lpdp' },
  { path: '/payment', token: true, label: 'payment' },
  { path: '/identity', token: true, label: 'identity' },
  { path: '/ple-reflect', token: true, label: 'ple-reflect' },
  { path: '/acceptability', token: true, label: 'acceptability' },
  // The two pages a physician spends the session on. The id is a placeholder: the backend is blocked in this
  // run, so each renders its error/empty shell, which is still the composer, header and result frame.
  { path: '/ple-chat?id=smoke', token: true, label: 'ple-chat' },
  { path: '/ple-result?id=smoke', token: true, label: 'ple-result' },
  // Public: /manual carries data-public so a reader stuck at sign-in can still read how to sign in.
  { path: '/manual', token: false, label: 'manual' },
];

// The DOM assertions run in the page. Returns { overflow, badTargets[], badInputs[] }.
const AUDIT_FN = `() => {
  const vw = window.innerWidth;
  const overflow = document.documentElement.scrollWidth - vw;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  // Button-like controls only — inline text links are WCAG-exempt from the 44px target.
  const TARGET_SEL = 'button, [role=radio], .btn, .btn-sm, .icon-btn, .composer-send, .msg-act-btn, .toggle-btn, .artifact-icon-btn, .pw-toggle, .session-progress .ch-prog';
  const badTargets = [];
  for (const el of document.querySelectorAll(TARGET_SEL)) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5) {
      badTargets.push((el.className || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  }
  const badInputs = [];
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select')) {
    if (!visible(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 15.5) badInputs.push((el.name || el.id || el.tagName) + ' ' + fs + 'px');
  }
  return { overflow, badTargets, badInputs };
}`;

async function run() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const fails = [];
  let checks = 0;

  // The browser pass below loads only PAGES; this catches a Google font link on a page it never visits.
  for (const rel of await readdir(ROOT, { recursive: true })) {
    if (!['.html', '.css', '.js'].includes(extname(rel))) continue;
    const hit = (await readFile(join(ROOT, rel), 'utf8')).match(GOOGLE_FONT_REF);
    if (hit) fails.push(`GOOGLE-FONT in physician-ui/public/${rel}: ${hit[0]}`);
  }

  const runs = WIDTHS.flatMap((width) => [{ ...width, scheme: 'light', pages: PAGES },
    ...(DARK_WIDTHS.has(width.w) ? [{ ...width, scheme: 'dark', pages: PAGES.filter((p) => p.dark) }] : [])]);
  for (const { w, h, coarse, scheme, pages } of runs) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: coarse, hasTouch: coarse, colorScheme: scheme });
    // Hermetic: drop every non-local request (Chart.js CDN, backend) so the run is offline + fast.
    const googleFontRequests = new Set();
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (GOOGLE_FONT_HOST.test(u)) googleFontRequests.add(u);
      u.startsWith(base) ? route.continue() : route.abort();
    });
    for (const pg of pages) {
      const page = await ctx.newPage();
      const health = watchPageHealth(page, (u) => u.startsWith(base));
      if (pg.token) await page.addInitScript(() => { try { localStorage.setItem('clics_token', 'responsive-smoke'); } catch {} });
      try {
        await page.goto(base + pg.path, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(600); // let boot.js apply data-mobile + the shell settle
        const failedFonts = await page.evaluate(async () => {
          await document.fonts.ready;
          return [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family);
        });
        const r = await page.evaluate(`(${AUDIT_FN})()`);
        checks++;
        const where = `${pg.label} @ ${w}px ${scheme}`;
        const theme = await resolvedTheme(page);
        if (theme !== scheme) fails.push(`THEME     ${where}: rendered ${theme}`);
        if (!pg.token) for (const p of health) fails.push(`${p.split(' ')[0].padEnd(9)} ${where}: ${p.slice(p.indexOf(' ') + 1).trim()}`);
        if (failedFonts.length) fails.push(`FONT-ERR  ${where}: ${failedFonts.join(', ')} failed to load`);
        if (r.overflow > 1) fails.push(`OVERFLOW  ${where}: scrollWidth +${r.overflow}px`);
        if (coarse && r.badTargets.length) fails.push(`TAP<44    ${where}: ${r.badTargets.slice(0, 6).join(', ')}`);
        if (coarse && r.badInputs.length) fails.push(`INPUT<16  ${where}: ${r.badInputs.slice(0, 6).join(', ')}`);
      } catch (e) {
        fails.push(`LOAD-ERR  ${pg.label} @ ${w}px ${scheme}: ${e.message}`);
      } finally {
        await page.close();
      }
    }
    await ctx.close();
    for (const u of googleFontRequests) fails.push(`GOOGLE-FONT @ ${w}px ${scheme}: ${u}`);
  }

  await browser.close();
  server.close();

  console.log(`\nResponsive smoke: ${checks} page×width×scheme checks across ${PAGES.length} pages × ${WIDTHS.length} widths, dark for ${PAGES.filter((p) => p.dark).map((p) => p.path).join(', ')} at ${[...DARK_WIDTHS].join('/')} px.`);
  if (fails.length) {
    console.error(`\n❌ ${fails.length} responsive regression(s):`);
    for (const f of fails) console.error('   ' + f);
    process.exit(1);
  }
  console.log('✅ 0 horizontal overflow · all touch targets ≥44px · all inputs ≥16px on touch · 0 Google font requests · 0 page errors, console errors or failed requests.');
}

run().catch((e) => { console.error(e); process.exit(1); });
