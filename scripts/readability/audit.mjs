#!/usr/bin/env node
/*
 * Readability audit — CONTRAST, Thai type floor, and text clipping (FIT), measured in a real browser.
 *
 * Why this exists alongside scripts/responsive/responsive-smoke.mjs rather than inside it: that smoke
 * ABORTS every external request, including Google Fonts, so its text renders in a fallback face. That
 * is fine for the overflow/tap-target checks it makes, and useless here — Thai metrics differ sharply
 * between Noto Sans Thai and whatever the system substitutes, so a FIT measurement taken without the
 * real webfont measures nothing. This script therefore lets the two font hosts through and blocks the
 * rest (no backend, no CDN scripts).
 *
 * It also runs each page in BOTH themes. Several tokens in this repo are identical across light and
 * dark (--destructive, --primary), which is exactly how a colour that passes in one and fails in the
 * other survives review.
 *
 * What it reports, per page × width × theme:
 *   1. CONTRAST  — every text-bearing element's computed colour against its painted background
 *                  (ancestors walked through transparents, alpha composited), as WCAG 2.1 ratio.
 *   2. THAI TYPE — any element containing Thai script rendered below the legibility floor. Thai is
 *                  not simply "small text": the loop (หัว) that distinguishes many letters closes up
 *                  before Latin becomes unreadable, and Thai stacks up to four levels vertically.
 *   3. CLIP      — text wider than the box that clips it (overflow hidden/clip, or a nowrap ancestor).
 *
 * Exits non-zero if any AA failure or clip is found, so it can gate CI later.
 *
 * Run:  node scripts/readability/audit.mjs
 *       DASH_URL=http://localhost:3002 node scripts/readability/audit.mjs   (adds the dashboard)
 *
 * Backend calls are answered from scripts/readability/fixtures.mjs — deliberately long Thai
 * content, never real data. Without it the dashboard renders its empty state and the audit
 * measures nothing: that is exactly how a dark-mode badge regression got past the first run.
 *       node scripts/readability/audit.mjs --json out.json
 */
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { fixtureFor } from './fixtures.mjs';

const ROOT = fileURLToPath(new URL('../../physician-ui/public', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

// AA for body text. 3.0 is the large-text bar; we apply it at >=24px, or >=18.66px when bold, per WCAG.
const AA_BODY = 4.5;
const AA_LARGE = 3.0;
// Thai floor. 12px is where the loop detail starts to close; the dashboard already bumped its
// text-xs to 13px for exactly this reason (audit-dashboard/app/globals.css).
const THAI_MIN_PX = 12;

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

const WIDTHS = [{ w: 320, h: 700 }, { w: 375, h: 800 }, { w: 768, h: 1024 }, { w: 1280, h: 900 }];
const THEMES = ['light', 'dark'];

// The three CREC pages first — they are the reason this script exists — then the rest of the portal,
// since the token changes this audit drives are app-wide and can regress any of them.
const PORTAL_PAGES = [
  { path: '/ple-reflect?id=00000000-0000-4000-8000-000000000000', token: true },
  { path: '/identity', token: true },
  { path: '/acceptability', token: true }, { path: '/dashboard', token: true },
  { path: '/ple-new', token: true }, { path: '/lpdp', token: true },
  { path: '/payment', token: true }, { path: '/', token: false },
  // Also carry class="sub" and were missed in the first pass — .sub is now a global rule,
  // so every page that uses it is in this audit's blast radius.
  { path: '/ple-result', token: true }, { path: '/guest-chat', token: false },
  { path: '/forgot', token: false },
  { path: '/ple-chat?id=00000000-0000-4000-8000-000000000000', token: true },
  // The manual: long-form Thai prose, the densest text on the portal, and the one page whose whole
  // job is to be read. Public, so no token.
  { path: '/manual', token: false },
];
const DASH_PAGES = ['/admin/privacy', '/admin/identity', '/admin/governance', '/auditor/queue',
  '/home', '/admin/compensation', '/admin/invites', '/admin/users', '/admin/overview',
  // The integrity queue. Its severity badges paint text on a TINT (`bg-primary/12`,
  // `bg-destructive/10`), which is where --link and --destructive both fail as text and where
  // --coral-on-tint / --danger exist — so it is exactly the kind of page this gate is for.
  '/admin/integrity'];

// ---- the in-page collector -------------------------------------------------------------------
// Returns raw records; all colour maths happens here so the page never ships a library.
function collect(thaiMinPx) {
  const parseRgb = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({          // composite fg over an opaque bg
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b, a: 1,
  });
  // Walk up until something actually paints, compositing every translucent layer on the way down.
  const paintedBg = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parseRgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    const root = parseRgb(getComputedStyle(document.documentElement).backgroundColor);
    if (root && root.a === 1) base = root;
    let out = stack.length && stack[stack.length - 1].a === 1 ? stack.pop() : base;
    while (stack.length) out = over(stack.pop(), out);
    return out;
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const hex = (c) => '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const THAI = /[฀-๿]/;

  // An element "owns" text if it has a direct non-empty text child — otherwise we'd score every
  // wrapper div against its descendants' text and drown in duplicates.
  const owns = (el) => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length);
  const sel = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  const contrast = [], thai = [], clips = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[disabled]')) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;

    // ---- clipping: is the text wider than the box that clips it?
    // text-overflow:ellipsis is deliberate truncation, not a clip — flagging it reports a design
    // decision as a defect. A hard overflow:hidden with no ellipsis still counts.
    const ellipsis = cs.textOverflow === 'ellipsis';
    const clipped = !ellipsis && (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1;
    if (clipped) clips.push({ sel: sel(el), text: el.textContent.trim().slice(0, 60), over: el.scrollWidth - el.clientWidth });

    if (!owns(el)) continue;
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!text) continue;

    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    if (THAI.test(text) && size < thaiMinPx) {
      thai.push({ sel: sel(el), size, text: text.slice(0, 40), font: cs.fontFamily.split(',')[0] });
    }

    let fg = parseRgb(cs.color); if (!fg) continue;
    const bg = paintedBg(el);
    // The element's own opacity multiplies its text toward whatever is behind it. This is how a
    // "secondary" fade quietly costs contrast, so it must be part of the measurement.
    let eff = 1;
    for (let n = el; n; n = n.parentElement) eff *= parseFloat(getComputedStyle(n).opacity);
    // Hidden by an ANCESTOR's opacity (hover-revealed actions, for one). Not visible, not a finding.
    if (eff === 0) continue;
    if (eff < 1) fg = over({ ...fg, a: fg.a * eff }, bg);
    else if (fg.a < 1) fg = over(fg, bg);

    const large = size >= 24 || (weight >= 700 && size >= 18.66);
    contrast.push({
      sel: sel(el), fg: hex(fg), bg: hex(bg), size, weight,
      ratio: Math.round(ratio(fg, bg) * 100) / 100,
      need: large ? 3.0 : 4.5,
      thai: THAI.test(text), text: text.slice(0, 40),
    });
  }
  return { contrast, thai, clips };
}

// ---- runner ----------------------------------------------------------------------------------
const dashUrl = process.env.DASH_URL || '';
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const jsonAt = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const findings = [];
let checked = 0;

async function run(url, label, token, manualLang) {
  for (const { w, h } of WIDTHS) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
      // Fonts through, everything else blocked. This is the one deliberate difference from
      // responsive-smoke.mjs and the whole reason the numbers here can be trusted for Thai.
      await ctx.route('**/*', (route) => {
        const u = route.request().url();
        // Backend calls are FULFILLED, not forwarded: populated rows are the whole point, and a
        // real backend would put real transcripts in the audit.
        if (u.startsWith(API_BASE)) {
          return route.fulfill({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(fixtureFor(u)),
          });
        }
        if (u.startsWith(base) || u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1')) return route.continue();
        if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return route.continue();
        return route.abort();
      });
      await ctx.addInitScript(([t, tok, ml]) => {
        try {
          localStorage.setItem('clics_theme', t);
          localStorage.setItem('theme', t);
          // The manual holds both languages in the document and hides one. The hidden copy is
          // display:none, so an audit that only ever renders the default measures half the page —
          // and English runs longer than Thai, so it is the half more likely to overflow.
          if (ml) localStorage.setItem('clics_manual_lang', ml);
          if (tok) {
            localStorage.setItem('clics_token', 'audit');
            const u = { role: 'physician', name: 'Audit', can_audit: true };
            localStorage.setItem('clics_user', JSON.stringify(u));
            localStorage.setItem('user', JSON.stringify({ ...u, role: 'auditor' }));
          }
        } catch { /* storage unavailable */ }
      }, [theme, token, manualLang ?? null]);

      const page = await ctx.newPage();
      try {
        // 45s: the font CDN throttles once the run has issued a few hundred requests, and a
        // slow stylesheet stalls domcontentloaded. Retried once before it counts as an error.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
          .catch(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }));
        // The dashboard sets dark via a class, the portal via data-theme. Force both, then let the
        // webfonts actually arrive — measuring before they land measures the fallback face.
        await page.evaluate((t) => {
          document.documentElement.setAttribute('data-theme', t);
          document.documentElement.classList.toggle('dark', t === 'dark');
        }, theme);
        // Freeze motion BEFORE measuring: a fade-in samples a half-composited colour, which
        // reports as a contrast failure that does not exist once the page settles.
        await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
        await page.evaluate(() => document.fonts && document.fonts.ready);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(300);
        const r = await page.evaluate(collect, THAI_MIN_PX);
        checked++;
        const where = `${label} @${w}px ${theme}`;
        for (const c of r.contrast) if (c.ratio < c.need) findings.push({ kind: 'CONTRAST', where, ...c });
        for (const t of r.thai) findings.push({ kind: 'THAI', where, ...t });
        for (const c of r.clips) findings.push({ kind: 'CLIP', where, ...c });
      } catch (e) {
        findings.push({ kind: 'ERROR', where: `${label} @${w}px ${theme}`, text: String(e.message || e) });
      }
      await ctx.close();
    }
  }
}

for (const p of PORTAL_PAGES) await run(base + p.path, `portal${p.path}`, p.token);
// The manual again, in English. Same widths, same themes — a second full pass, because a
// translation is new text in the same boxes and the boxes are what fail.
await run(base + '/manual', 'portal/manual[en]', false, 'en');
if (dashUrl) for (const p of DASH_PAGES) await run(dashUrl.replace(/\/$/, '') + p, `dash${p}`, true);

await browser.close();
server.close();

// ---- report ----------------------------------------------------------------------------------
// Collapse by (selector, fg, bg) — the same token failure repeats across widths and pages, and a
// list of 400 duplicates hides how few distinct problems there actually are.
const key = (f) => f.kind === 'CONTRAST' ? `${f.kind}|${f.sel}|${f.fg}|${f.bg}` : `${f.kind}|${f.sel}|${f.text}`;
const grouped = new Map();
for (const f of findings) {
  const k = key(f);
  if (!grouped.has(k)) grouped.set(k, { ...f, seen: [] });
  grouped.get(k).seen.push(f.where);
}
const rows = [...grouped.values()].sort((a, b) => (a.ratio ?? 99) - (b.ratio ?? 99));

console.log(`\nReadability audit: ${checked} page×width×theme renders`
  + `${dashUrl ? '' : '  (dashboard skipped — set DASH_URL to include it)'}\n`);
for (const r of rows) {
  if (r.kind === 'CONTRAST') {
    console.log(`CONTRAST  ${r.fg} on ${r.bg} → ${r.ratio}:1  (needs ${r.need})  ${r.size}px/${r.weight}${r.thai ? ' TH' : ''}`);
    console.log(`          ${r.sel}  "${r.text}"`);
  } else if (r.kind === 'THAI') {
    console.log(`THAI      ${r.size}px < ${THAI_MIN_PX}px floor  ${r.sel}  "${r.text}"  [${r.font}]`);
  } else if (r.kind === 'CLIP') {
    console.log(`CLIP      +${r.over}px past its clip box  ${r.sel}  "${r.text}"`);
  } else {
    console.log(`ERROR     ${r.where}: ${r.text}`);
  }
  console.log(`          ${r.seen.length}× — e.g. ${r.seen.slice(0, 3).join(', ')}`);
}
if (!rows.length) console.log('✅ no contrast failures, no Thai below the type floor, no clipped text.');
if (jsonAt) { await writeFile(jsonAt, JSON.stringify(rows, null, 2)); console.log(`\njson → ${jsonAt}`); }
process.exit(rows.length ? 1 : 0);
