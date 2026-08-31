#!/usr/bin/env node
/*
 * Is the manual actually WIRED INTO each console — not merely present on disk?
 *
 * The other gates check the manual's CONTENT (prose parity, quoted labels) and its RENDERING
 * (contrast, the Thai type floor, overflow). Neither notices if the page is unreachable, the nav
 * link is missing from four of the five pages that need it, the language toggle hides itself, or a
 * figure 404s — a broken image still occupies layout and still exposes its alt text, so it passes
 * every measurement we have.
 *
 *   node scripts/manuals/embed-smoke.mjs                         # portal only, hermetic
 *   DASH_URL=http://localhost:3111 node scripts/manuals/embed-smoke.mjs   # + the dashboard
 *
 * The dashboard half needs a running Next dev server, which is why this is NOT in the `manuals` CI
 * job (that one is deliberately hermetic and browserless). Run it before shipping a manual change.
 *
 * TWO TRAPS THIS SCRIPT ITSELF FELL INTO, recorded so the next person does not re-learn them:
 *   - images are loading="lazy", so an unscrolled figure is legitimately unloaded — assert only on
 *     VISIBLE images, after forcing eager and letting the network settle;
 *   - the dashboard nav collapses to a hamburger below 1535px, so the link check must run wide.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

const PORTAL = '/Users/napat/Desktop/CLICS/physician-ui/public';
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const DASH = process.env.DASH_URL;
const out = [];
const ok = (n, c, d = '') => out.push([c ? 'PASS' : 'FAIL', n, d]);

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  let f = join(PORTAL, p.replace(/^\/+/, '')); if (!extname(f)) f += '.html';
  try { res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(await readFile(f)); }
  catch { res.writeHead(404).end('nf'); }
});
await new Promise((r) => server.listen(4611, '127.0.0.1', r));
const base = 'http://127.0.0.1:4611';
const b = await chromium.launch();

// ---- portal, signed OUT (data-public must let them in) -----------------------------------------
{
  const ctx = await b.newContext();
  const pg = await ctx.newPage();
  const resp = await pg.goto(`${base}/manual`, { waitUntil: 'networkidle' });
  ok('portal /manual serves 200 with no token', resp.status() === 200 && pg.url().endsWith('/manual'),
    `status ${resp.status()} url ${pg.url()}`);
  const secs = await pg.locator('section.guide-section[data-lang="th"]').count();
  ok('portal renders all 9 Thai sections', secs === 9, `${secs} sections`);
  const visible = await pg.locator('section.guide-section:visible').count();
  ok('only one language visible at a time', visible === 9, `${visible} visible`);
  const navText = await pg.locator('#navLinks').innerText();
  ok('signed-out nav swaps to Sign in (no Logout)', /Sign in/.test(navText) && !/Logout/.test(navText),
    navText.replace(/\n/g, ' '));
  // toggle
  await pg.locator('.lang-switch [data-set-lang="en"]').click();
  await pg.waitForTimeout(150);
  const enVisible = await pg.locator('section.guide-section[data-lang="en"]:visible').count();
  const thHidden = await pg.locator('section.guide-section[data-lang="th"]:visible').count();
  ok('toggle switches to English', enVisible === 9 && thHidden === 0, `en ${enVisible} / th still ${thHidden}`);
  ok('html lang follows the toggle', await pg.evaluate(() => document.documentElement.lang) === 'en');
  // persistence
  await pg.reload({ waitUntil: 'networkidle' });
  ok('choice persists across reload',
    await pg.evaluate(() => document.documentElement.getAttribute('data-manual-lang')) === 'en');
  // Images are loading="lazy", so a below-the-fold one is legitimately unloaded until scrolled to.
  // Scroll the page first, otherwise this reports every figure as broken.
  // Only VISIBLE images are asserted on. The hidden language copy sits in a display:none block, and
  // a browser correctly never fetches an image there — counting those as broken tests the browser's
  // lazy-loading, not the page. Eager + networkidle then removes the below-the-fold false negative.
  await pg.evaluate(() => { for (const i of document.images) i.loading = 'eager'; });
  await pg.waitForLoadState('networkidle');
  await pg.waitForTimeout(1500);  // networkidle can fire before a just-un-lazied image finishes
  const broken = await pg.evaluate(() => [...document.images]
    .filter((i) => i.offsetParent !== null || i.getClientRects().length)
    .filter((i) => !i.complete || i.naturalWidth === 0)
    .map((i) => i.src));
  ok('every screenshot loads', broken.length === 0, broken.join(', '));
  // anchors
  const ids = await pg.$$eval('.guide-toc[data-lang="th"] a', (as) => as.map((a) => a.getAttribute('href')));
  const missing = [];
  for (const h of ids) if (!(await pg.locator(h).count())) missing.push(h);
  ok('every contents link has a target', missing.length === 0, missing.join(', '));
  await ctx.close();
}

// ---- portal, signed IN (nav link present on the other pages) -----------------------------------
{
  const ctx = await b.newContext();
  await ctx.addInitScript(() => { localStorage.setItem('clics_token', 'x'); localStorage.setItem('clics_user', '{"role":"physician"}'); });
  const pg = await ctx.newPage();
  for (const page of ['dashboard', 'identity', 'payment', 'acceptability', 'cle-reflect']) {
    await pg.goto(`${base}/${page}`, { waitUntil: 'domcontentloaded' });
    const href = await pg.locator('nav a[href="/manual"]').count();
    ok(`nav link on /${page}`, href === 1, `${href} link(s)`);
  }
  await pg.goto(`${base}/manual`, { waitUntil: 'networkidle' });
  const navText = await pg.locator('#navLinks').innerText();
  ok('signed-in nav keeps the full row + Logout', /Logout/.test(navText) && /Manual/.test(navText));
  ok('current page marked for assistive tech',
    await pg.locator('nav a[aria-current="page"][href="/manual"]').count() === 1);
  await ctx.close();
}

// ---- dashboard ---------------------------------------------------------------------------------
if (DASH) {
  const ctx = await b.newContext();
  const pg = await ctx.newPage();
  const resp = await pg.goto(`${DASH}/manual`, { waitUntil: 'networkidle', timeout: 60000 });
  ok('dashboard /manual serves', resp.status() === 200, `status ${resp.status()}`);
  const h2 = await pg.locator('h2').count();
  ok('dashboard renders all 7 auditor sections', h2 === 7, `${h2} sections`);
  const back = await pg.locator('a[href="/auditor/queue"]').count();
  ok('back link present even signed out', back >= 1);
  await pg.locator('button', { hasText: 'English' }).click();
  await pg.waitForTimeout(200);
  ok('dashboard toggle switches to English',
    (await pg.locator('h1').innerText()).includes('Auditor manual'));
  await ctx.close();
} else {
  out.push(['SKIP', 'dashboard checks', 'set DASH_URL']);
}

await b.close(); server.close();
let bad = 0;
for (const [s, n, d] of out) { if (s === 'FAIL') bad++; console.log(`${s.padEnd(4)} ${n}${d ? `  — ${d}` : ''}`); }
console.log(bad ? `\n${bad} FAILURE(S)` : '\nall embed checks passed');
process.exit(bad ? 1 : 0);
