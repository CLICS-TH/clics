#!/usr/bin/env node
/*
 * The WIDE-width nav audit — the measurement behind NAV_CHROME_PX / NAV_PER_LINK_PX.
 *
 * WHY IT IS SEPARATE FROM responsive-smoke.mjs. That gate stops at 1280px, because it guards the
 * touch-first portal where every regression it was built for lives below that. The dashboard's
 * NavBar fails in the opposite direction: it collapses to a hamburger BELOW a threshold and renders
 * the full bilingual row above it, so its failure mode is only visible on a WIDE viewport. The row
 * outgrew a hardcoded 1535px threshold — 9 links for admin, 14 for superadmin, against a comment
 * still reading "8 bilingual links … needs ~1536px" — and pushed the identity cluster off-screen on
 * every monitor between 1536px and ~2976px. Nothing saw it: tsc, lint and jest cannot measure a
 * layout, and the one gate that can never looked above 1280px.
 *
 * WHAT IT MEASURES, and the distinction that matters:
 *   PAGE overflow  documentElement.scrollWidth > clientWidth — the page scrolls sideways. A real
 *                  reflow failure (WCAG 1.4.10). This is the only thing that FAILS the run.
 *   PAD encroach   nav > div scrollWidth > clientWidth — a child eating into the nav's own px-6
 *                  padding without passing the viewport edge. Tightness, not a scroll; reported in
 *                  yellow so it is visible without being conflated with the failure above. The two
 *                  were conflated in the first version of this script and it cost an hour chasing
 *                  five "overflows" that were nothing of the kind.
 *
 * Needs a BUILT dashboard on DASH_URL (default http://127.0.0.1:3002):
 *     cd audit-dashboard && npm run build && npx next start -p 3002
 *     node scripts/responsive/nav-width-audit.mjs
 *
 * Every backend call is fulfilled from a fixture, so this needs no credentials and no live data.
 *
 * TO RE-DERIVE THE CONSTANTS after a roster change, run with --calibrate: it binary-searches the
 * narrowest viewport at which each role's row fits, and prints the (roster length → px) pairs that
 * belong in MEASURED in audit-dashboard/__tests__/nav-width.test.ts. Count the ROSTER, not the
 * rendered anchors — `nav a[href^="/"]` includes the CLICS wordmark's link to /home, and counting it
 * put the first fit of these constants ~100px under.
 */
import { chromium } from 'playwright';

const DASH = process.env.DASH_URL || 'http://127.0.0.1:3002';
const PATH = process.env.NAV_AUDIT_PATH || '/admin/integrity';
const CALIBRATE = process.argv.includes('--calibrate');
const API = ['http://localhost:3001', 'http://127.0.0.1:3001'];
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };

// Every role that renders a nav row, widest roster last. analyst/ethics are one link each and are
// here to prove the threshold never hamburgers a row that plainly fits.
const ROLES = ['auditor', 'analyst', 'ethics', 'admin', 'superadmin'];

// Sampled around EVERY threshold the model produces — a mis-calibration is invisible except in the
// narrow band between "the model says inline" and "the row actually fits".
const WIDTHS = [320, 390, 768, 1280, 1536, 1920, 2240, 2330, 2440, 2560, 3100, 3280, 3400];

async function measure(browser, role, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (API.some((b) => u.startsWith(b))) {
      const body = /integrity-queue/.test(u) ? { cles: [] }
        : { id: 'a1', role, council_id: 'c1', full_name_th: 'ผู้ดูแลระบบทดสอบ', full_name_en: 'Test Admin' };
      return r.fulfill({ status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    }
    return r.continue();
  });
  await ctx.addInitScript((rr) => {
    try {
      const u = { role: rr, name: 'A-1', council_id: 'c1',
        full_name_th: 'ผู้ดูแลระบบทดสอบ', specialty: 'อายุรศาสตร์', position: 'gp' };
      localStorage.setItem('clics_token', 'nav-audit');
      localStorage.setItem('user', JSON.stringify(u));
      localStorage.setItem('clics_user', JSON.stringify(u));
    } catch { /* storage unavailable */ }
  }, role);
  const page = await ctx.newPage();
  try {
    await page.goto(DASH + PATH, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForSelector('nav', { timeout: 15000 });
    // Thai renders at a different width once the webfont lands; measuring before it does is measuring
    // the fallback face.
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate(() => {
      const row = document.querySelector('nav > div');
      return {
        pad: row ? row.scrollWidth - row.clientWidth : 0,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch();
let failures = 0;

if (CALIBRATE) {
  console.log(`\ncalibrating against ${DASH}${PATH} — narrowest viewport with no row overflow\n`);
  for (const role of ROLES) {
    let lo = 1100, hi = 3600, need = null;
    if ((await measure(browser, role, hi)).pad > 0) { console.log(`${role.padEnd(11)} still overflows at ${hi}px`); continue; }
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const m = await measure(browser, role, mid);
      if (m.pad > 0 || m.page > 0) lo = mid + 1; else { need = mid; hi = mid - 1; }
    }
    console.log(`${role.padEnd(11)} fits from ${need}px`);
  }
  console.log(`\n${C.d}Counting note: these are viewport widths for the row as RENDERED. Convert to roster`
    + `\nlength (exclude the CLICS wordmark) before writing them into nav-width.test.ts.${C.x}\n`);
} else {
  for (const role of ROLES) {
    const cells = [];
    for (const w of WIDTHS) {
      const m = await measure(browser, role, w);
      if (m.page > 0) failures++;
      cells.push(m.page > 0 ? `${C.r}${w}:PAGE+${m.page}${C.x}`
        : m.pad > 0 ? `${C.y}${w}:pad${m.pad}${C.x}` : `${w}:·`);
    }
    console.log(role.padEnd(11) + cells.join(' '));
  }
  console.log(failures
    ? `\n${C.r}✗ ${failures} PAGE overflow(s) — the nav row is wider than the viewport it renders in.${C.x}\n`
      + `  Re-derive the threshold: node scripts/responsive/nav-width-audit.mjs --calibrate\n`
    : `\n${C.g}✓${C.x} no page overflow, ${ROLES.length} roles × ${WIDTHS.length} widths `
      + `(${WIDTHS[0]}–${WIDTHS[WIDTHS.length - 1]}px)\n  ${C.y}padN${C.x} = the row uses N px of the nav's `
      + `own padding. Tightness, not a scroll.\n`);
}
await browser.close();
process.exit(failures ? 1 : 0);
