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
 * Hermetic: a tiny built-in static server serves physician-ui/public; all external requests
 * (fonts / Chart.js CDN / backend API) are aborted; a fake token bypasses the auth redirect so the
 * authed shells render. No secrets, no live infra. Exits non-zero on any failure.
 *
 * Run: node scripts/responsive/responsive-smoke.mjs   (from repo root)
 * Override the dashboard target (optional, e.g. against a running dev server):  DASH_URL=http://localhost:3002/login
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../physician-ui/public', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

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
];

// Pages whose LAYOUT renders without a backend (token injected to pass the auth gate; content may be
// empty/loading, but the shell — nav, container, forms, chat composer — is what we overflow-check).
const PAGES = [
  { path: '/', token: false, label: 'login (index)' },
  { path: '/forgot', token: false, label: 'forgot' },
  { path: '/guest-chat', token: false, label: 'guest-chat' },
  { path: '/dashboard', token: true, label: 'dashboard' },
  { path: '/ple-new', token: true, label: 'ple-new' },
  { path: '/lpdp', token: true, label: 'lpdp' },
  { path: '/payment', token: true, label: 'payment' },
  { path: '/identity', token: true, label: 'identity' },
  { path: '/ple-reflect', token: true, label: 'ple-reflect' },
  { path: '/acceptability', token: true, label: 'acceptability' },
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

  for (const { w, h, coarse } of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: coarse, hasTouch: coarse });
    // Hermetic: drop every non-local request (fonts, Chart.js CDN, backend) so the run is offline + fast.
    await ctx.route('**/*', (route) => {
      route.request().url().startsWith(base) ? route.continue() : route.abort();
    });
    for (const pg of PAGES) {
      const page = await ctx.newPage();
      if (pg.token) await page.addInitScript(() => { try { localStorage.setItem('clics_token', 'responsive-smoke'); } catch {} });
      try {
        await page.goto(base + pg.path, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(600); // let boot.js apply data-mobile + the shell settle
        const r = await page.evaluate(`(${AUDIT_FN})()`);
        checks++;
        const where = `${pg.label} @ ${w}px`;
        if (r.overflow > 1) fails.push(`OVERFLOW  ${where}: scrollWidth +${r.overflow}px`);
        if (coarse && r.badTargets.length) fails.push(`TAP<44    ${where}: ${r.badTargets.slice(0, 6).join(', ')}`);
        if (coarse && r.badInputs.length) fails.push(`INPUT<16  ${where}: ${r.badInputs.slice(0, 6).join(', ')}`);
      } catch (e) {
        fails.push(`LOAD-ERR  ${pg.label} @ ${w}px: ${e.message}`);
      } finally {
        await page.close();
      }
    }
    await ctx.close();
  }

  await browser.close();
  server.close();

  console.log(`\nResponsive smoke: ${checks} page×width checks across ${PAGES.length} pages × ${WIDTHS.length} widths.`);
  if (fails.length) {
    console.error(`\n❌ ${fails.length} responsive regression(s):`);
    for (const f of fails) console.error('   ' + f);
    process.exit(1);
  }
  console.log('✅ 0 horizontal overflow · all touch targets ≥44px · all inputs ≥16px on touch.');
}

run().catch((e) => { console.error(e); process.exit(1); });
