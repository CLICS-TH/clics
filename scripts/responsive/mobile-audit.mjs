#!/usr/bin/env node
/*
 * E2E mobile-friendliness audit for BOTH CLICS front-ends.
 *
 * Extends responsive-smoke.mjs from 3 checks → 5, and from 6 physician-ui pages → all 11 +
 * the auth-gated audit-dashboard across roles. For each (app, page, role, width) it reports:
 *   1. OVERFLOW   — documentElement.scrollWidth > innerWidth (whole-page horizontal scroll)
 *   2. TAP<44     — button-like control smaller than 44x44 (WCAG 2.5.5), coarse-pointer only
 *   3. INPUT<16   — form field < 16px (iOS Safari auto-zoom), coarse-pointer only
 *   4. OFFSCREEN  — a visible text element whose box spills past the viewport with NO scrollable
 *                   ancestor (clipped content — e.g. a cell/badge overflowing into the next column)
 *   5. CELLSPILL  — a table cell whose content is wider than the cell (the Role/Council overlap class)
 *
 * Two targets:
 *   - physician-ui : hermetic (built-in static server over physician-ui/public; external reqs aborted).
 *   - dashboard    : LIVE against a deployed origin (DASH_URL). Logs in per role via the backend
 *                    POST /auth/login (BACKEND_URL) to mint {access_token,user}, injects them as
 *                    clics_token / clics_user, then visits each role's routes. Skipped unless creds set.
 *
 * Env:
 *   DASH_URL      audit-dashboard origin (e.g. https://audit-dashboard-rouge.vercel.app)  [enables dashboard audit]
 *   BACKEND_URL   backend origin (e.g. https://backend-production-c12e4.up.railway.app)
 *   SUPER_EMAIL/SUPER_PW, AUDITOR_EMAIL/AUDITOR_PW   role creds (throwaway demo creds in docs/deployment.md)
 *   AUDIT_JSON    optional path to also write the findings as JSON
 *
 * Run (physician-ui only):  node scripts/responsive/mobile-audit.mjs
 * Run (full):               DASH_URL=… BACKEND_URL=… SUPER_EMAIL=… SUPER_PW=… AUDITOR_EMAIL=… AUDITOR_PW=… node scripts/responsive/mobile-audit.mjs
 * Exits non-zero if any finding is reported.
 */
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PUI_ROOT = fileURLToPath(new URL('../../physician-ui/public', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// Phone portrait widths (coarse/touch) + one landscape + a desktop baseline (fine pointer).
const WIDTHS = [
  { w: 320, h: 720, coarse: true },                      // iPhone SE
  { w: 375, h: 812, coarse: true },                      // iPhone X/11/12 mini
  { w: 390, h: 844, coarse: true },                      // iPhone 13/14/15
  { w: 430, h: 932, coarse: true },                      // iPhone 15 Pro Max
  { w: 768, h: 1024, coarse: true },                     // iPad portrait
  { w: 812, h: 375, coarse: true, tag: 'landscape' },    // phone landscape
  { w: 1280, h: 900, coarse: false },                    // desktop baseline
];

// The in-page assertion battery. Returns the 5 finding-arrays for the current viewport.
const AUDIT_FN = `() => {
  const vw = window.innerWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const hasScrollableAncestor = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
    }
    return false;
  };
  const sel = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className) ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
    return (el.tagName.toLowerCase() + id + cls).slice(0, 60);
  };

  // 1. whole-page horizontal overflow
  const overflow = Math.round(document.documentElement.scrollWidth - vw);

  // 2. touch targets (button-like) < 44
  const TARGET_SEL = 'button, [role=button], [role=radio], a.btn, .btn, .btn-sm, .icon-btn, .composer-send, .msg-act-btn, .toggle-btn, .artifact-icon-btn, .pw-toggle, summary';
  const badTargets = [];
  for (const el of document.querySelectorAll(TARGET_SEL)) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5) badTargets.push(sel(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }

  // 3. inputs < 16px
  const badInputs = [];
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select')) {
    if (!visible(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 15.5) badInputs.push((el.name || el.id || sel(el)) + ' ' + fs + 'px');
  }

  // 4. visible text elements whose box spills past the viewport with no scrollable ancestor (clipped)
  const offscreen = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (offscreen.length >= 8) break;
    if (!el.textContent || !el.textContent.trim()) continue;
    if (el.children.length > 0) continue; // leaf-ish text nodes only (reduces dup ancestors)
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !hasScrollableAncestor(el)) {
      const k = sel(el) + Math.round(r.right);
      if (seen.has(k)) continue; seen.add(k);
      offscreen.push(sel(el) + ' right=' + Math.round(r.right) + ' (vw=' + vw + ') "' + el.textContent.trim().slice(0,24) + '"');
    }
  }

  // 5. table cells whose content overflows the cell box (overlap into the neighbour column)
  const cellSpill = [];
  for (const td of document.querySelectorAll('td, th')) {
    if (!visible(td)) continue;
    const inner = td.firstElementChild;
    const cw = inner ? inner.scrollWidth : td.scrollWidth;
    if (cw > td.clientWidth + 2) cellSpill.push('col' + ([...td.parentElement.children].indexOf(td)) + ' +' + Math.round(cw - td.clientWidth) + 'px "' + td.textContent.trim().slice(0,20) + '"');
    if (cellSpill.length >= 8) break;
  }

  // 6. tables that force horizontal scroll on touch (i.e. no mobile card fallback rendered)
  const tableScroll = [];
  for (const t of document.querySelectorAll('table')) {
    if (!visible(t)) continue;
    let wrap = t.parentElement;
    while (wrap && wrap !== document.body) { const ox = getComputedStyle(wrap).overflowX; if (ox === 'auto' || ox === 'scroll') break; wrap = wrap.parentElement; }
    if (wrap && wrap.scrollWidth > wrap.clientWidth + 2) tableScroll.push(sel(wrap) + ' +' + Math.round(wrap.scrollWidth - wrap.clientWidth) + 'px');
    if (tableScroll.length >= 6) break;
  }

  // 7. form controls + ICONS that spill out of their box. OFFSCREEN (#4) only inspects leaf TEXT nodes,
  //    so an overflowing <input>/<select>/<svg>/<img> (no textContent) is invisible to it — and a parent
  //    with overflow:hidden clips it so the page never scrolls. Catches "text box / icon out of layout":
  //    'vp' = past the viewport edge (clipped at the screen); 'box' = poking out of its parent container.
  const ctrlSpill = [];
  for (const el of document.querySelectorAll('input:not([type=hidden]), textarea, select, button, [role=button], svg, img')) {
    if (ctrlSpill.length >= 10) break;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) continue;
    if ((r.right > vw + 1 || r.left < -1) && !hasScrollableAncestor(el)) {
      ctrlSpill.push('vp ' + sel(el) + ' x=[' + Math.round(r.left) + ',' + Math.round(r.right) + '] vw=' + vw);
      continue;
    }
    // box-spill: text boxes + icons only (buttons legitimately size to content); skip scrollable parents.
    if (!el.matches('input, textarea, select, svg, img')) continue;
    const p = el.parentElement;
    if (!p) continue;
    const cs = getComputedStyle(p);
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
    const pr = p.getBoundingClientRect();
    const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    if (r.right > pr.right - padR + 4 || r.left < pr.left + padL - 4) {
      ctrlSpill.push('box ' + sel(el) + ' r=' + Math.round(r.right) + ' p.r=' + Math.round(pr.right - padR));
    }
  }

  return { overflow, badTargets, badInputs, offscreen, cellSpill, tableScroll, ctrlSpill };
}`;

// ---- tiny static server for physician-ui (mirrors the Vercel extensionless rewrite) ----
function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      let file = normalize(join(PUI_ROOT, p));
      if (!file.startsWith(PUI_ROOT)) { res.writeHead(403).end(); return; }
      let s = await stat(file).catch(() => null);
      if (!s && !extname(file)) { file += '.html'; s = await stat(file).catch(() => null); }
      if (!s) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(500).end('err'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// physician-ui pages. token:true injects a fake clics_token so the auth-gated shell renders (content
// stays empty/loading — the layout is what we overflow-check). /ple-chat needs a real ?id + backend so
// it can't render hermetically (it redirects to /dashboard); it's audited live separately.
const PUI_PAGES = [
  { path: '/login', label: 'login' },
  { path: '/forgot', label: 'forgot' },
  { path: '/reset', label: 'reset' },
  { path: '/invite', label: 'invite' },
  { path: '/guest-chat', label: 'guest-chat' },
  { path: '/auth/callback', label: 'oauth-callback' },
  { path: '/dashboard', token: true, label: 'dashboard' },
  { path: '/ple-new', token: true, label: 'ple-new' },
  { path: '/lpdp', token: true, label: 'lpdp' },
  { path: '/ple-result', token: true, label: 'ple-result' },
];

const findings = [];
function record(app, label, role, w, tag, r) {
  const where = `${app}:${label}${role ? '/' + role : ''} @ ${w}px${tag ? ' ' + tag : ''}`;
  if (r.overflow > 1) findings.push(`OVERFLOW  ${where}: +${r.overflow}px`);
  if (r.coarse && r.badTargets?.length) findings.push(`TAP<44    ${where}: ${r.badTargets.slice(0,5).join(', ')}`);
  if (r.coarse && r.badInputs?.length) findings.push(`INPUT<16  ${where}: ${r.badInputs.slice(0,5).join(', ')}`);
  if (r.offscreen?.length) findings.push(`OFFSCREEN ${where}: ${r.offscreen.slice(0,5).join(' | ')}`);
  if (r.cellSpill?.length) findings.push(`CELLSPILL ${where}: ${r.cellSpill.slice(0,5).join(' | ')}`);
  if (r.coarse && r.tableScroll?.length) findings.push(`TABLESCROLL ${where}: ${r.tableScroll.slice(0,5).join(' | ')} (no mobile card fallback)`);
  if (r.ctrlSpill?.length) findings.push(`CTRLSPILL ${where}: ${r.ctrlSpill.slice(0,6).join(' | ')}`);
}

async function auditAt(ctx, page, app, label, role, width) {
  await page.waitForTimeout(700); // let SPA hydrate / boot.js apply data-mobile
  const r = await page.evaluate(`(${AUDIT_FN})()`);
  r.coarse = width.coarse;
  record(app, label, role, width.w, width.tag, r);
}

async function run() {
  const browser = await chromium.launch();
  let checks = 0;

  // ---------- physician-ui (hermetic) ----------
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: width.w, height: width.h }, isMobile: width.coarse, hasTouch: width.coarse });
    await ctx.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
    for (const pg of PUI_PAGES) {
      const page = await ctx.newPage();
      if (pg.token) await page.addInitScript(() => { try { localStorage.setItem('clics_token', 'mobile-audit'); } catch {} });
      try {
        await page.goto(base + pg.path, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await auditAt(ctx, page, 'pui', pg.label, '', width);
        checks++;
      } catch (e) { findings.push(`LOAD-ERR  pui:${pg.label} @ ${width.w}px: ${e.message.split('\\n')[0]}`); }
      finally { await page.close(); }
    }
    await ctx.close();
  }
  server.close();

  // ---------- audit-dashboard (live; only if configured) ----------
  const DASH = process.env.DASH_URL, BACKEND = process.env.BACKEND_URL;
  const roleCfg = [
    { role: 'superadmin', email: process.env.SUPER_EMAIL, pw: process.env.SUPER_PW,
      paths: ['/home','/admin/overview','/admin/ples','/admin/users','/admin/invites','/admin/flagged','/admin/compensation','/admin/stats','/admin/icc','/ethics','/analyst'] },
    { role: 'auditor', email: process.env.AUDITOR_EMAIL, pw: process.env.AUDITOR_PW,
      paths: ['/home','/auditor/queue'] },
  ].filter(r => r.email && r.pw);

  if (DASH && BACKEND && roleCfg.length) {
    for (const rc of roleCfg) {
      // mint {access_token,user} via the backend login (the access_token IS the CLICS token)
      let auth;
      try {
        const resp = await fetch(BACKEND + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: rc.email, password: rc.pw }) });
        auth = await resp.json();
        if (!auth.access_token) throw new Error('no access_token: ' + JSON.stringify(auth).slice(0,120));
      } catch (e) { findings.push(`LOGIN-ERR dashboard/${rc.role}: ${e.message}`); continue; }
      const token = auth.access_token, user = JSON.stringify(auth.user);
      for (const width of WIDTHS) {
        const ctx = await browser.newContext({ viewport: { width: width.w, height: width.h }, isMobile: width.coarse, hasTouch: width.coarse });
        await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('clics_token', t); localStorage.setItem('clics_user', u); } catch {} }, [token, user]);
        for (const path of rc.paths) {
          const page = await ctx.newPage();
          try {
            await page.goto(DASH + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await auditAt(ctx, page, 'dash', path, rc.role, width);
            checks++;
          } catch (e) { findings.push(`LOAD-ERR  dash:${path}/${rc.role} @ ${width.w}px: ${e.message.split('\\n')[0]}`); }
          finally { await page.close(); }
        }
        await ctx.close();
      }
    }
  } else {
    console.log('ℹ︎ dashboard audit skipped (set DASH_URL, BACKEND_URL, *_EMAIL, *_PW to enable).');
  }

  await browser.close();

  console.log(`\\nMobile audit: ${checks} page×width checks. ${findings.length} finding(s).`);
  if (process.env.AUDIT_JSON) await writeFile(process.env.AUDIT_JSON, JSON.stringify(findings, null, 2));
  if (findings.length) {
    for (const f of findings) console.error('   ' + f);
    process.exit(1);
  }
  console.log('✅ 0 findings across both apps.');
}

run().catch((e) => { console.error(e); process.exit(1); });
