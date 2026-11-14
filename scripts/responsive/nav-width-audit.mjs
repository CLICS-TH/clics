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
 *                  reflow failure (WCAG 1.4.10). FAILS the run.
 *   WRAP           a control in the row (link, toggle, Return, Logout) laid out on more than one
 *                  line — "ออกจาก/ระบบ Logout". FAILS the run. A squeezed row used to WRAP its
 *                  buttons instead of overflowing, so neither check above or below could see it and
 *                  a threshold calibrated on overflow alone came out too eager. The row's controls
 *                  are whitespace-nowrap now, so a squeeze becomes overflow; this check stays as the
 *                  backstop for the next control added without it.
 *   PAD encroach   nav > div scrollWidth > clientWidth — a child eating into the nav's own px-6
 *                  padding without passing the viewport edge. Tightness, not a scroll; reported in
 *                  yellow so it is visible without being conflated with the failures above. The two
 *                  were conflated in the first version of this script and it cost an hour chasing
 *                  five "overflows" that were nothing of the kind.
 *
 * WHERE IT LOOKS. A fixed list of widths, plus BOTH SIDES OF EVERY THRESHOLD THE MODEL PRODUCES
 * (the last hamburger width and the first inline width), computed from the constants in
 * audit-dashboard/lib/client-store.ts, so the samples move when the constants do. A mis-calibration
 * is invisible anywhere except the band between "the model says inline" and "the row actually fits".
 *
 * Needs a BUILT dashboard on DASH_URL (default http://127.0.0.1:3002/audit, the base path included), built the
 * default way: NEXT_PUBLIC_API_URL unset, so its API is the relative /api on its own origin, basePath /audit:
 *     cd audit-dashboard && npm run build && npx next start -p 3002
 *     node scripts/responsive/nav-width-audit.mjs
 * Calls to DASH_URL's origin /api and to http://localhost:3001 are both answered from fixtures
 * (scripts/lib/gate-api.mjs). A build made with NEXT_PUBLIC_API_URL set needs that same value exported here.
 *
 * Every backend call is fulfilled from a fixture, so this needs no credentials and no live data.
 *
 * TO RE-DERIVE THE CONSTANTS, run with --calibrate. For each persona it forces the row INLINE (the
 * nav's own media query answers "not narrow"; the Viewport toggle keeps its real "Auto" label) and
 * finds the narrowest width from which the row fits — no wrap, no padding or page overflow — at
 * EVERY wider width. That is searched per breakpoint band, because "fits" is not monotonic across
 * the 640 / 768 breakpoints (labels and padding change) or the 1280 / 1600 / 1920 root-font steps
 * (every rem grows), and a single binary search across them answers the wrong question. It prints
 * (effective link count → px) pairs for NEEDED in audit-dashboard/__tests__/nav-width.test.ts.
 * Effective count = ROSTER length, plus one for the dual-role Return to Physician control; never
 * `nav a[href^="/"]`, which includes the CLICS wordmark and put the first fit ~100px under.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { gateApiBases, isGateApiCall } from '../lib/gate-api.mjs';

const DASH = process.env.DASH_URL || 'http://127.0.0.1:3002/audit';
const PATH = process.env.NAV_AUDIT_PATH || '/admin/integrity';
const CALIBRATE = process.argv.includes('--calibrate');
// The dashboard's own-origin /api (the default build) and :3001: scripts/lib/gate-api.mjs.
const API = gateApiBases({ dashUrl: DASH, apiUrl: process.env.NEXT_PUBLIC_API_URL });
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };

// Every persona that renders a nav row. `n` is the count the model sizes the row by: roster length,
// plus one for the dual-role physician's Return to Physician control (NavBar.tsx). It is asserted
// against the rendered row during calibration, so a roster change cannot drift past this table.
// analyst/ethics are one link each and prove the threshold never hamburgers a row that plainly fits.
const PERSONAS = [
  { key: 'auditor', user: { role: 'auditor' }, n: 2 },
  { key: 'dual-role', user: { role: 'physician', can_audit: true }, n: 3 },
  { key: 'analyst', user: { role: 'analyst' }, n: 1 },
  { key: 'ethics', user: { role: 'ethics' }, n: 1 },
  { key: 'admin', user: { role: 'admin' }, n: 9 },
  { key: 'superadmin', user: { role: 'superadmin' }, n: 14 },
];

// The model, read from the source it lives in rather than copied here, so the threshold samples
// below can never be stale.
const src = readFileSync(new URL('../../audit-dashboard/lib/client-store.ts', import.meta.url), 'utf8');
const CHROME = Number(/export const NAV_CHROME_PX = (\d+);/.exec(src)?.[1]);
const PER_LINK = Number(/export const NAV_PER_LINK_PX = (\d+);/.exec(src)?.[1]);
if (!CHROME || !PER_LINK) throw new Error('could not read NAV_CHROME_PX / NAV_PER_LINK_PX from lib/client-store.ts');
const threshold = (n) => CHROME + n * PER_LINK;   // inline at width >= this (navMq: max-width T-1)

const BASE_WIDTHS = [320, 390, 768, 1279, 1280, 1536, 1920, 2240, 2560, 3100, 3400];

// Breakpoint bands inside which "fits" is monotonic (see the header).
const BANDS = [[600, 639], [640, 767], [768, 1279], [1280, 1599], [1600, 1919], [1920, 3600]];

async function measure(browser, persona, width, { forceInline = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const u = { ...persona.user, name: 'A-1', council_id: 'c1',
    full_name_th: 'ผู้ดูแลระบบทดสอบ', specialty: 'อายุรศาสตร์', position: 'gp' };
  await ctx.route('**/*', (r) => {
    const url = r.request().url();
    if (isGateApiCall(url, API)) {
      const body = /integrity-queue/.test(url) ? { ples: [] }
        : { id: 'a1', ...persona.user, council_id: 'c1', full_name_th: 'ผู้ดูแลระบบทดสอบ', full_name_en: 'Test Admin' };
      return r.fulfill({ status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    }
    return r.continue();
  });
  await ctx.addInitScript(([user, force]) => {
    try {
      localStorage.setItem('clics_token', 'nav-audit');
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('clics_user', JSON.stringify(user));
    } catch { /* storage unavailable */ }
    if (!force) return;
    // Calibration only: answer the NAV's own max-width query "no", so the row renders inline at a
    // width the shipped threshold would hamburger. The app's two other max-width queries (767 phone,
    // 1024 table) are left alone. Not clics_view=desktop: that relabels the Viewport toggle "Desktop",
    // which is wider than the "Auto" a real user sees and would skew every measurement.
    const real = window.matchMedia.bind(window);
    const keep = new Set(['(max-width: 767px)', '(max-width: 1024px)']);
    window.matchMedia = (q) => (/^\(max-width: \d+px\)$/.test(q) && !keep.has(q))
      ? { matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {},
          addListener() {}, removeListener() {}, dispatchEvent() { return false; } }
      : real(q);
  }, [u, forceInline]);
  const page = await ctx.newPage();
  try {
    await page.goto(DASH + PATH, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForSelector('nav', { timeout: 15000 });
    // Thai renders at a different width once the webfont lands; measuring before it does is measuring
    // the fallback face.
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate(() => {
      const row = document.querySelector('nav > div');
      const burger = !!document.querySelector('nav button[aria-label="เมนู / Menu"]');
      // Line boxes of an element's text: rects that overlap vertically are one line, so a Thai label
      // beside its smaller English gloss is not miscounted as a wrap.
      const lines = (el) => {
        const rects = [];
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let t = w.nextNode(); t; t = w.nextNode()) {
          if (!t.textContent.trim()) continue;
          const r = document.createRange(); r.selectNodeContents(t);
          for (const b of r.getClientRects()) if (b.width > 1 && b.height > 1) rects.push(b);
        }
        rects.sort((a, b) => a.top - b.top);
        let n = 0, bottom = -Infinity;
        for (const b of rects) { if ((b.top + b.bottom) / 2 > bottom) { n++; bottom = b.bottom; } else bottom = Math.max(bottom, b.bottom); }
        return n;
      };
      const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const controls = row ? [...row.querySelectorAll('a, button')].filter(shown) : [];
      return {
        burger,
        // Links in the desktop row, plus the Return to Physician control: the model's `n`.
        n: row ? row.querySelectorAll('div.flex-1 > a').length
          + [...row.querySelectorAll('button')].filter((b) => /Return to Physician/.test(b.textContent)).length : 0,
        pad: row ? row.scrollWidth - row.clientWidth : 0,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        wrapped: controls.filter((el) => lines(el) > 1).map((el) => el.textContent.trim().slice(0, 28)),
      };
    });
  } finally {
    await ctx.close();
  }
}

const fits = (m) => m.pad <= 0 && m.page <= 0 && m.wrapped.length === 0;

const browser = await chromium.launch();
let failures = 0;

if (CALIBRATE) {
  console.log(`\ncalibrating against ${DASH}${PATH} — row forced inline; fits = no wrap, no padding or page overflow\n`);
  const pairs = [];
  for (const p of PERSONAS) {
    // The narrowest width in each band from which the row fits, or Infinity when it never does.
    const fitFrom = async ([lo, hi]) => {
      const top = await measure(browser, p, hi, { forceInline: true });
      if (top.burger) throw new Error(`${p.key}: row did not render inline at ${hi}px — the forcing broke`);
      if (top.n !== p.n) throw new Error(`${p.key}: rendered ${top.n} sized controls, the table says ${p.n}`);
      if (!fits(top)) return Infinity;
      if (fits(await measure(browser, p, lo, { forceInline: true }))) return lo;
      let a = lo + 1, b = hi, need = hi;
      while (a <= b) {
        const mid = Math.floor((a + b) / 2);
        if (fits(await measure(browser, p, mid, { forceInline: true }))) { need = mid; b = mid - 1; } else a = mid + 1;
      }
      return need;
    };
    // Walk down from the widest band: the threshold is the narrowest width from which EVERY wider
    // width fits, so the first band that does not fit all the way down to its floor decides it.
    let T = Infinity;
    const notes = [];
    for (const band of [...BANDS].reverse()) {
      const f = await fitFrom(band);
      notes.push(`${band[0]}–${band[1]}: ${f === Infinity ? 'never' : f === band[0] ? 'all' : 'from ' + f}`);
      if (f === Infinity) break;
      T = f;
      if (f > band[0]) break;
    }
    pairs.push([p.n, T, p.key]);
    console.log(`${p.key.padEnd(11)} n=${String(p.n).padEnd(3)} fits from ${T}px   ${C.d}${notes.join(' · ')}${C.x}`);
  }
  console.log(`\n${C.d}NEEDED pairs (n → px), for audit-dashboard/__tests__/nav-width.test.ts:${C.x}`);
  for (const [n, T, k] of pairs) console.log(`  [${n}, ${T}],   // ${k}`);
  const minChrome = Math.max(...pairs.map(([n, T]) => T - n * PER_LINK));
  console.log(`\n${C.d}At NAV_PER_LINK_PX ${PER_LINK}, the smallest NAV_CHROME_PX that is conservative for every row: ${minChrome}${C.x}\n`);
} else {
  const cols = [];
  for (const p of PERSONAS) {
    const T = threshold(p.n);
    const widths = [...new Set([...BASE_WIDTHS, T - 1, T])].sort((a, b) => a - b);
    const cells = [];
    for (const w of widths) {
      const m = await measure(browser, p, w);
      const bad = m.page > 0 || m.wrapped.length > 0;
      // The model's own edge: at T-1 the row must be the hamburger, at T it must be inline.
      const edge = (w === T - 1 && !m.burger) || (w === T && m.burger);
      if (bad || edge) failures++;
      const tag = w === T ? '▸' : '';
      cells.push(m.page > 0 ? `${C.r}${tag}${w}:PAGE+${m.page}${C.x}`
        : m.wrapped.length ? `${C.r}${tag}${w}:WRAP(${m.wrapped.join(' | ')})${C.x}`
        : edge ? `${C.r}${tag}${w}:${m.burger ? 'menu' : 'inline'}≠model${C.x}`
        : m.pad > 0 ? `${C.y}${tag}${w}:pad${m.pad}${C.x}`
        : `${tag}${w}:${m.burger ? '≡' : '·'}`);
    }
    cols.push(widths.length);
    console.log(`${p.key.padEnd(11)}T=${String(T).padEnd(5)} ` + cells.join(' '));
  }
  console.log(failures
    ? `\n${C.r}✗ ${failures} failure(s) — a page overflow, a wrapped nav control, or a row on the wrong side of the`
      + ` model's threshold.${C.x}\n  Re-derive the constants: node scripts/responsive/nav-width-audit.mjs --calibrate\n`
    : `\n${C.g}✓${C.x} no page overflow, no wrapped nav control, model edges correct — ${PERSONAS.length} personas,`
      + ` ${cols.reduce((a, b) => a + b, 0)} renders (${BASE_WIDTHS[0]}–${BASE_WIDTHS[BASE_WIDTHS.length - 1]}px plus every threshold)`
      + `\n  ≡ hamburger · inline  ▸ first inline width (model)  ${C.y}padN${C.x} = the row uses N px of the nav's own`
      + ` padding. Tightness, not a scroll.\n`);
}
await browser.close();
process.exit(failures ? 1 : 0);
