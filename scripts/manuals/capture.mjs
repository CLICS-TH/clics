#!/usr/bin/env node
/*
 * Captures the manual's screenshots — credential-free, PII-gated, fail-closed.
 *
 * WHAT THIS REPLACES. scripts/manuals/generate.mjs captured two frames against LIVE PRODUCTION and
 * was non-fatal on every failure ("⚠ skipped"), so a missing frame was a warning nobody read. Its
 * two PNGs are the only ones the manual has ever had, and they are from 2026-06-29 — before the
 * identity gate, the reflection step and the privacy-report path all shipped.
 *
 * THREE PROPERTIES IT HAS AND THAT ONE DID NOT:
 *
 * 1. NO CREDENTIALS, EVER. Both consoles gate on localStorage, and every backend call is FULFILLED
 *    from lib/capture-fixtures.mjs rather than forwarded. So this runs on any machine, in CI, with
 *    no sandbox account and no live data — and it cannot accidentally photograph a real physician.
 *    The pattern is lifted from scripts/readability/audit.mjs, which already does exactly this.
 *
 * 2. ASSERT BEFORE WRITE. The frame is captured to a Buffer, its DOM text is put through
 *    lib/pii-gate.mjs, and only a clean frame reaches the disk. A written frame is a frame someone
 *    can `git add`; a PNG is the one artifact here that code review cannot read.
 *
 * 3. FAIL CLOSED. Any frame that errors, renders empty, or trips the gate exits non-zero. The old
 *    script's warn-and-continue is what let the manual ship stale.
 *
 *   node scripts/manuals/capture.mjs                       # portal frames
 *   DASH_URL=http://127.0.0.1:3002 node scripts/manuals/capture.mjs   # + auditor frames
 *   node scripts/manuals/capture.mjs --check               # verify committed frames, write nothing
 *   node scripts/manuals/capture.mjs --set landing         # only the landing set (or --set manual)
 *
 * After capturing, run `npm run manuals` — build.mjs copies these into physician-ui/public/img/
 * and fails if the manual references a frame that does not exist.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { captureFixtureFor, ACTIVE_PLE } from './lib/capture-fixtures.mjs';
import { scanText, describe } from './lib/pii-gate.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORTAL = join(ROOT, 'physician-ui/public');
const OUT = join(ROOT, 'docs/manuals/source/img');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const DASH = process.env.DASH_URL;
// Both consoles talk to the backend on :3001 — the portal via window.CLICS_API_URL, the dashboard
// via NEXT_PUBLIC_API_URL. Matching the API by its BASE rather than by a path pattern is what
// scripts/readability/audit.mjs does, and it is the robust version: a path regex missed
// `/auditor/queue` (the `\baudit\b` boundary fails inside "auditor"), so that call fell through to
// a dead backend and the page rendered its empty state — which then got photographed.
const API_BASES = ['http://localhost:3001', 'http://127.0.0.1:3001'];
const CHECK = process.argv.includes('--check');
const SET = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : null;
if (SET && SET !== 'manual' && SET !== 'landing') { console.error(`--set must be manual or landing, not ${SET}`); process.exit(2); }

// 1120x840 at deviceScaleFactor 2 is what generate.mjs used and it is the right contract: the frame
// is printed at A4 width, and a 1x capture is unreadable there.
const VIEW = { width: 1120, height: 840 };

// The landing page shows each of its frames at two widths in both themes. 390 is below the portal's
// 767px breakpoint, so the page itself switches to its data-mobile layout. WebP because these are
// served on the public landing page, where a 2x PNG of a chat is several hundred KB.
const LANDING = {
  dir: join(ROOT, 'physician-ui/public/img/landing'),
  views: { desktop: { width: 1120, height: 840 }, mobile: { width: 390, height: 844 } },
  themes: ['light', 'dark'],
};
const PLE_ID = '00000000-0000-4000-8000-000000000001';

/*
 * `wait`  a selector that must be VISIBLE before the shot — never a timeout. A fixed sleep is how
 *         the old script produced frames of a half-rendered page.
 * `clip`  the element to photograph. Without it a frame is mostly empty canvas, and printed at A4
 *         the actual UI ends up too small to read — which is the only reason the frame exists.
 * `expect` a string the rendered page MUST contain. This exists because the first auditor-queue
 *         capture photographed "No PLEs assigned yet" — a fixture whose shape did not match, so the
 *         page rendered its EMPTY state. The frame had plenty of text, so a length check passed it.
 *         An empty state is the one screenshot worse than no screenshot: it teaches the reader that
 *         the feature has nothing in it.
 * `fixture` [re, body] pairs checked before the shared table, for this frame only. /identity
 *         renders EITHER a status card or the submission form depending on what the API returns, and
 *         the manual's §3 is about submitting, so that frame asks for the state the reader is taught.
 * `clip`  may also be [from, to]: the shot is the union box of the two elements.
 * `chart` a canvas that must hold a drawn Chart.js chart before the shot.
 * `set`   'landing' frames are written once per LANDING view and theme as WebP; the rest are the
 *         manual's single PNG at VIEW.
 */
const FRAMES = [
  { name: 'login', app: 'portal', url: '/login', wait: 'form, .login-box',
    why: 'physician §2 first-login' },
  { name: 'guest-composer', app: 'portal', url: '/guest-chat', wait: 'textarea',
    fill: ['textarea', 'ผู้ป่วยชายอายุ 62 ปี เบาหวานชนิดที่ 2 มาด้วยอาการเหนื่อยง่ายขณะออกแรง 3 สัปดาห์'],
    why: 'physician §5 run-a-ple — pre-filled and NEVER SENT, so no AI spend' },
  { name: 'dashboard', app: 'portal', url: '/dashboard', token: true, wait: '.page-intro',
    clip: '.container', expect: 'ประเมินแล้ว',
    why: 'physician §4 dashboard' },
  // Found while capturing the dashboard: the consent panel opens over it on a first visit. The
  // manual's §2 walks through this panel and had no picture of it, so it becomes its own frame.
  { name: 'consent', app: 'portal', url: '/dashboard', token: true, unconsented: true,
    wait: '.consent-point', clip: '.modal, [class*="modal"], .consent-modal',
    expect: 'ก่อนเริ่ม', why: 'physician §2 first-login — the consent panel' },
  { name: 'identity', app: 'portal', url: '/identity', token: true, wait: 'form', clip: '.container',
    // 'none' = never submitted, which is the state that renders the FORM. The manual's §3 walks
    // through filling it in; a screenshot of the already-verified badge teaches nothing.
    fixture: [[/\/auth\/identity\/status/, { status: 'none' }]], expect: 'ยืนยันตัวตน',
    why: 'physician §3 identity — the section with no screenshot at all' },
  { name: 'progress', app: 'portal', url: '/lpdp', token: true, wait: 'canvas', clip: '.container', expect: 'คะแนนล่าสุด',
    why: 'physician §8 progress-payment' },
  { name: 'auditor-queue', app: 'dash', url: '/auditor/queue', token: true, wait: '[class*="max-w-2xl"]', clip: '[class*="max-w-2xl"]', expect: 'เหลือ',
    why: 'auditor §3 queue — the auditor manual has no screenshots at all' },
  // /ple-chat bounces to /ple-result unless the PLE is 'active', so this frame asks for one in progress.
  { name: 'ple-chat', set: 'landing', app: 'portal', url: `/ple-chat?id=${PLE_ID}`, token: true,
    wait: '#messages .msg-assistant', clip: '.chat-page', expect: 'ภาวะเลือดเป็นกรดจากคีโตน',
    fixture: [[/\/ples\/[0-9a-f-]{8,}$/, ACTIVE_PLE]], why: 'landing — a PLE in progress' },
  { name: 'pis7-radar', set: 'landing', app: 'portal', url: `/ple-result?id=${PLE_ID}`, token: true,
    wait: '#radarChart', clip: ['#content > .card:first-child', '#content > .card:has(.chart-box)'],
    chart: '#radarChart', expect: 'คะแนน PIS-7', why: 'landing — the PIS-7 composite and radar' },
  { name: 'ple-result', set: 'landing', app: 'portal', url: `/ple-result?id=${PLE_ID}`, token: true,
    wait: '#content > .card:has(h3)', clip: '#content > .card:has(h3)', expect: 'ผลรายโดเมน',
    why: 'landing — per-domain scores and rationale' },
];

function serve() {
  const s = createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    let f = join(PORTAL, p.replace(/^\/+/, '')); if (!extname(f)) f += '.html';
    try { res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(await readFile(f)); }
    catch { res.writeHead(404).end('nf'); }
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

const problems = [];
const wrote = [];

// The two encoders a landing frame needs are already in the browser, so WebP costs no dependency.
async function toWebp(page, png) {
  const b64 = await page.evaluate(async (src) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${src}`)).blob());
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }, png.toString('base64'));
  const out = Buffer.from(b64, 'base64');
  // convertToBlob silently falls back to PNG for a type it cannot encode.
  if (out.toString('ascii', 0, 4) !== 'RIFF' || out.toString('ascii', 8, 12) !== 'WEBP') throw new Error('the browser did not encode WebP');
  return out;
}

async function capture(browser, base, frame, variant = { view: VIEW, file: join(OUT, `${frame.name}.png`) }) {
  const label = variant.theme ? `${frame.name}-${variant.key}` : frame.name;
  const origin = frame.app === 'dash' ? DASH : base;
  const ctx = await browser.newContext({ viewport: variant.view, deviceScaleFactor: 2,
    ...(variant.theme && { colorScheme: variant.theme }) });

  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    // Backend calls are FULFILLED from fixtures — never forwarded. This is what makes the run
    // credential-free AND guarantees no real transcript can reach a PNG.
    if (API_BASES.some((b) => u.startsWith(b))) {
      const own = (frame.fixture ?? []).find(([re]) => re.test(u));
      return route.fulfill({
        status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(own ? own[1] : captureFixtureFor(u)),
      });
    }
    if (u.startsWith(base) || u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) return route.continue();
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return route.continue();
    // Chart.js, marked and DOMPurify. Aborted, the radar is a blank card and the chat is raw text.
    if (u.startsWith('https://cdn.jsdelivr.net/')) return route.continue();
    return route.abort();
  });

  if (variant.theme) await ctx.addInitScript((t) => { try { localStorage.setItem('clics_theme', t); } catch { /* storage unavailable */ } }, variant.theme);
  if (frame.unconsented) await ctx.addInitScript(() => { window.__CAPTURE_UNCONSENTED = true; });
  if (frame.token) {
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('clics_token', 'manual-capture');
        const u = { role: 'physician', name: 'P-014', pseudonym: 'P-014', can_audit: true,
          full_name_th: 'P-014', full_name_en: 'P-014',
          // js/dashboard.js:58 opens the consent dialog over the page unless this is set. The
          // dialog is worth its own frame (see 'consent' below), not an accident on every other.
          consented_at: window.__CAPTURE_UNCONSENTED ? null : '2026-07-01T00:00:00Z' };
        localStorage.setItem('clics_user', JSON.stringify(u));
        localStorage.setItem('user', JSON.stringify({ ...u, role: 'auditor' }));
      } catch { /* storage unavailable */ }
    });
  }

  const page = await ctx.newPage();
  try {
    await page.goto(origin + frame.url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForSelector(frame.wait, { state: 'visible', timeout: 15000 });
    if (frame.fill) await page.locator(frame.fill[0]).first().fill(frame.fill[1]);
    if (frame.chart) {
      // getChart() exists from the first animation frame; stop() + update('none') draws the final
      // state now, and the pixel check proves it is not a blank canvas.
      await page.waitForFunction((sel) => window.Chart && Chart.getChart(document.querySelector(sel)), frame.chart, { timeout: 15000 });
      const drawn = await page.evaluate((sel) => {
        const c = document.querySelector(sel); const ch = Chart.getChart(c); ch.stop(); ch.update('none');
        // Grid lines alone paint pixels, so an empty dataset must be refused separately.
        const data = ch.data.datasets[0]?.data ?? [];
        if (!data.length || !data.every(Number.isFinite)) return false;
        const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < px.length; i += 4) if (px[i]) return true;
        return false;
      }, frame.chart);
      if (!drawn) { problems.push(`${label}: the chart canvas is blank`); return; }
    }
    // Thai renders as tofu if the shot beats the webfont — the same line pdf.mjs calls its most
    // important. Motion is frozen so a mid-animation frame is not what gets committed.
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });

    const text = await page.evaluate(() => document.body.innerText);
    if (!text || text.trim().length < 40) {
      problems.push(`${label}: the page rendered almost no text (${(text || '').trim().length} chars) — `
        + 'a screenshot of an empty state is worse than none.');
      return;
    }

    if (frame.expect && !text.includes(frame.expect)) {
      problems.push(`${label}: rendered without ${JSON.stringify(frame.expect)} — this is `
        + 'almost certainly the page\'s empty or error state, which must never be published as a '
        + 'screenshot of a working feature. Check the fixture shape against what the page reads.');
      return;
    }

    const findings = scanText(text);
    if (findings.length) { problems.push(describe(label, findings)); return; }

    // Photograph the content, not the empty canvas around it.
    let buf;
    if (Array.isArray(frame.clip)) {
      const clip = await page.evaluate((sels) => {
        const r = sels.map((s) => document.querySelector(s)?.getBoundingClientRect());
        if (r.some((b) => !b)) return null;
        const x = Math.min(r[0].left, r[1].left), y = Math.min(r[0].top, r[1].top);
        return { x: x + scrollX, y: y + scrollY,
          width: Math.max(r[0].right, r[1].right) - x, height: Math.max(r[0].bottom, r[1].bottom) - y };
      }, frame.clip);
      if (!clip) { problems.push(`${label}: clip ${frame.clip.join(' .. ')} matched nothing`); return; }
      buf = await page.screenshot({ clip, fullPage: true });
    } else {
      const target = frame.clip ? page.locator(frame.clip).first() : null;
      buf = target && await target.count()
        ? await target.screenshot()
        : await page.screenshot({ fullPage: false });
    }
    if (variant.theme) buf = await toWebp(page, buf);
    const file = basename(variant.file);
    if (CHECK) { wrote.push(`${file} (checked, not written)`); return; }
    await mkdir(dirname(variant.file), { recursive: true });
    await writeFile(variant.file, buf);
    wrote.push(`${file}  ${(buf.length / 1024).toFixed(0)} KB  — ${frame.why}`);
  } catch (e) {
    problems.push(`${label}: ${e.message.split('\n')[0]}`);
  } finally {
    await ctx.close();
  }
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const skipped = [];
for (const f of FRAMES) {
  if (SET && (f.set ?? 'manual') !== SET) continue;
  if (f.app === 'dash' && !DASH) { skipped.push(f.name); continue; }
  if (f.set !== 'landing') { await capture(browser, base, f); continue; }
  for (const [view, size] of Object.entries(LANDING.views)) {
    for (const theme of LANDING.themes) {
      await capture(browser, base, f, { view: size, theme, key: `${view}-${theme}`,
        file: join(LANDING.dir, `${f.name}-${view}-${theme}.webp`) });
    }
  }
}
await browser.close(); server.close();

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };
for (const w of wrote) console.log(`  ${C.g}✓${C.x} ${w}`);
// Never silent about what was not done — a skipped frame is how the manual went stale before.
for (const s of skipped) console.log(`  ${C.y}·${C.x} ${s} SKIPPED — set DASH_URL to a running dashboard`);

if (problems.length) {
  console.error(`\n${C.r}${C.b}${problems.length} frame(s) refused:${C.x}`);
  for (const p of problems) console.error(`  ${C.r}✗${C.x} ${p}`);
  console.error('');
  process.exit(1);
}
console.log(`\n${C.g}✓${C.x} ${wrote.length} frame(s) ${CHECK ? 'verified' : 'captured'}, 0 refused`
  + `${skipped.length ? `, ${skipped.length} skipped` : ''}\n`);
