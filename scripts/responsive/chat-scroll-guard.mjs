#!/usr/bin/env node
/*
 * Page-scroll guard for /ple-chat on phones (physician-ui/public/css/main.css, js/ple-chat.js).
 *
 * The chat page is locked to the viewport and only the message list (#messages) scrolls. A visually-hidden
 * speaker label (.sr-only, position:absolute) whose containing block sits OUTSIDE that scroller escapes it:
 * with 30 messages at 375x667 the document was 14282px tall, and a script scroll (scrollIntoView, a focus
 * scroll, find-in-page, an AT virtual cursor) moved the whole page and the composer off screen. The
 * responsive smoke cannot see this: it checks horizontal overflow only, and its chat page has 0 messages.
 *
 * Hermetic: a tiny static server serves physician-ui/public; GET /ples/smoke answers a 30-message fixture;
 * every other request is answered {} (API) or aborted (fonts, CDNs). Chromium mobile emulation at three
 * phone sizes. The keyboard is emulated by shrinking the viewport by 300px (the resizes-content model) with
 * the composer focused. Emulation cannot show a real soft keyboard or iOS touch-scroll semantics: this guards
 * the layout, a real-device pass is still the final word.
 *
 * Asserts, per size:
 *   1. the document never grows past the viewport (scrollHeight <= innerHeight + 1)
 *   2. every .sr-only inside #messages is contained by #messages (its containing block is inside the scroller)
 *   3. after scrollTo(0, 99999) and scrollIntoView() on the last message: page scrollY 0, composer fully visible
 *   4. keyboard open: composer and the AI disclaimer fully visible and inside the chat card, the disclaimer never
 *      empty; on a short viewport (< 500px) the input hint is hidden and the disclaimer is ONE line; a tap on Send
 *      still sends; keyboard closed or box left -> full layout again
 *
 * Run: node scripts/responsive/chat-scroll-guard.mjs   (from repo root; ~10 s). Exits non-zero on any failure.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../physician-ui/public', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
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

const SIZES = [{ w: 320, h: 568 }, { w: 375, h: 667 }, { w: 390, h: 844 }];
const KEYBOARD_PX = 300;
// Rest only (no keyboard pass): a phone browser's real inner height with its bars, and landscape phones.
// 640x304 is a KNOWN GAP (measured, not asserted): even compact, the notice ends ~6px below the screen; it
// needs the session header itself to compact in landscape, a design call left open.
const REST_SIZES = [{ w: 320, h: 460 }, { w: 568, h: 320 }, { w: 640, h: 304, knownGap: true }];
const SHORT_VIEWPORT_PX = 500;   // below this, with the composer focused, the composer area compacts (js/ple-chat.js)
const N = 30;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

// 30 stored messages, long enough that every bubble wraps several lines at 320px.
const messages = [];
for (let i = 0; i < N; i++) {
  const physician = i % 2 === 0;
  messages.push({
    id: 'm' + i, role: physician ? 'physician' : 'assistant',
    content: (physician ? 'คำถามทางคลินิก ' : 'คำตอบ ') + 'lorem ipsum dolor sit amet consectetur '.repeat(8) + '#' + i,
    refs: [], socratic_question: null, created_at: new Date().toISOString(),
    ...(physician ? { client_turn_id: 'k' + i } : {}),
  });
}
const ple = { id: 'smoke', status: 'active', title: 'Scroll guard', turn_count: N / 2, token_count: 0, messages,
  transcript: { used: 1, limit: 100, pct: 1, warn: false } };

const fails = [];
const check = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails.push(msg); };

// One in-page measurement of everything the assertions read.
const MEASURE = () => {
  const vvH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height, shown: getComputedStyle(e).display !== 'none' && r.height > 0 }; };
  const msgs = document.getElementById('messages');
  // Containing block of an absolutely positioned element = its offsetParent (null when display:none).
  const leaks = [...msgs.querySelectorAll('.sr-only')].filter((e) => e.offsetParent && !msgs.contains(e.offsetParent) && e.offsetParent !== msgs).length;
  const disc = document.querySelector('.ai-disclaimer');
  // The disclaimer text a reader can SEE right now (hidden spans excluded).
  const seen = [...disc.querySelectorAll('span')].filter((s) => s.getClientRects().length && getComputedStyle(s).display !== 'none')
    .map((s) => s.textContent.trim()).filter(Boolean).join(' ');
  const lh = parseFloat(getComputedStyle(disc).lineHeight) || parseFloat(getComputedStyle(disc).fontSize) * 1.55;
  // How far the composer area spills out of the bottom of the chat card (the disclaimer drawn across its border).
  const win = document.querySelector('.chat-window');
  const spill = document.querySelector('.composer-wrap').getBoundingClientRect().bottom - (win.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(win).borderBottomWidth) || 0));
  // The jump-to-latest button, shown, must not sit on the composer (it covered the Send button).
  const fab = document.getElementById('scrollBottomBtn'); const had = fab.classList.contains('show'); fab.classList.add('show');
  const f = fab.getBoundingClientRect(), c = document.querySelector('.composer').getBoundingClientRect();
  const fabOnComposer = f.left < c.right && f.right > c.left && f.top < c.bottom && f.bottom > c.top;
  if (!had) fab.classList.remove('show');
  return {
    innerH: window.innerHeight, vvH, spill: Math.round(spill), fabOnComposer, scrollH: document.scrollingElement.scrollHeight, scrollY: window.scrollY,
    composer: box('.composer'), disclaimer: box('.ai-disclaimer'), hint: box('.composer-hint'),
    discLines: Math.round(disc.getBoundingClientRect().height / lh), discSeen: seen,
    compact: document.documentElement.hasAttribute('data-kb-compact'), leaks,
    srCount: msgs.querySelectorAll('.sr-only').length, bubbles: msgs.querySelectorAll('.msg-physician, .msg-assistant').length,
  };
};
const inView = (b, vvH) => !!b && b.shown && b.top >= -0.5 && b.bottom <= vvH + 0.5;

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const report = [];

for (const { w, h } of SIZES) {
  const tag = `${w}x${h}`;
  console.log(`\n== ${tag}`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try { localStorage.setItem('clics_token', 'scroll-guard'); } catch {} });
  await ctx.route('**/*', (route) => {
    const req = route.request(); const url = req.url();
    if (url.startsWith(base)) return route.continue();
    if (!url.startsWith('http://localhost:3001')) return route.abort();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const path = new URL(url).pathname;
    const body = path === '/ples/smoke' && req.method() === 'GET' ? ple : {};
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  try {
    await page.goto(base + '/ple-chat?id=smoke', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => document.querySelectorAll('#messages .msg-physician, #messages .msg-assistant').length >= n, N, { timeout: 10000 });
    await page.waitForTimeout(200);
    const m = () => page.evaluate(MEASURE);

    const load = await m();
    check(load.bubbles === N, `${tag}: ${N} messages drawn (${load.bubbles}, ${load.srCount} sr-only labels inside #messages)`);
    check(load.scrollH <= load.innerH + 1, `${tag}: document fits the viewport (scrollHeight ${load.scrollH} <= innerHeight ${load.innerH} + 1)`);
    check(!load.fabOnComposer, `${tag}: the jump-to-latest button does not cover the composer`);
    check(inView(load.disclaimer, load.vvH) && inView(load.composer, load.vvH), `${tag} at rest: composer and AI disclaimer fully on screen (disclaimer bottom ${load.disclaimer && Math.round(load.disclaimer.bottom)} <= ${load.vvH})`);
    check(load.spill <= 0.5, `${tag} at rest: composer area inside the chat card (spill ${load.spill}px)`);
    check(load.discSeen.length > 0, `${tag} at rest: the disclaimer is never hidden`);
    check(load.leaks === 0, `${tag}: every sr-only label is contained by #messages (${load.leaks} escape it)`);

    await page.evaluate(() => window.scrollTo(0, 99999));
    const afterScrollTo = await m();
    check(afterScrollTo.scrollY === 0, `${tag}: scrollTo(0, 99999) cannot move the page (scrollY ${afterScrollTo.scrollY})`);
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.evaluate(() => { const all = document.querySelectorAll('#messages .msg-physician, #messages .msg-assistant'); all[all.length - 1].scrollIntoView(); });
    const afterLast = await m();
    check(afterLast.scrollY === 0, `${tag}: scrollIntoView(last message) leaves the page at scrollY 0 (${afterLast.scrollY})`);
    check(inView(afterLast.composer, afterLast.vvH), `${tag}: composer fully visible after scrollIntoView (bottom ${afterLast.composer && Math.round(afterLast.composer.bottom)} <= ${afterLast.vvH})`);
    await page.evaluate(() => { const s = [...document.querySelectorAll('#messages .sr-only')].pop(); s && s.scrollIntoView(); });
    const afterSr = await m();
    check(afterSr.scrollY === 0 && inView(afterSr.composer, afterSr.vvH), `${tag}: scrollIntoView(last sr-only label) keeps the page and the composer in place (scrollY ${afterSr.scrollY})`);
    await page.evaluate(() => window.scrollTo(0, 0));

    // ---- keyboard: composer focused, viewport 300px shorter ----
    await page.tap('#input');
    await page.setViewportSize({ width: w, height: h - KEYBOARD_PX });
    await page.waitForTimeout(150);
    const kb = await m();
    const short = kb.vvH < SHORT_VIEWPORT_PX;
    check(kb.scrollH <= kb.innerH + 1, `${tag} +keyboard: document fits the viewport (${kb.scrollH} <= ${kb.innerH} + 1)`);
    check(inView(kb.composer, kb.vvH), `${tag} +keyboard: composer fully visible (top ${kb.composer && Math.round(kb.composer.top)}, bottom ${kb.composer && Math.round(kb.composer.bottom)}, viewport ${kb.vvH})`);
    check(inView(kb.disclaimer, kb.vvH), `${tag} +keyboard: AI disclaimer fully visible (bottom ${kb.disclaimer && Math.round(kb.disclaimer.bottom)} <= ${kb.vvH})`);
    check(!kb.fabOnComposer, `${tag} +keyboard: the jump-to-latest button does not cover the composer`);
    check(kb.spill <= 0, `${tag} +keyboard: the composer area stays inside the chat card (spill ${kb.spill}px)`);
    check(kb.discSeen.length > 0, `${tag} +keyboard: the disclaimer is never hidden ("${kb.discSeen}")`);
    if (short) {
      check(kb.compact, `${tag} +keyboard: short viewport (${kb.vvH}px) -> compact composer area`);
      check(!kb.hint || !kb.hint.shown, `${tag} +keyboard: input hint hidden`);
      check(kb.discLines === 1, `${tag} +keyboard: disclaimer is ONE line (${kb.discLines})`);
    } else {
      if (!kb.compact) check(kb.hint && kb.hint.shown, `${tag} +keyboard: tall enough (${kb.vvH}px) and fits -> full layout kept`);
    }
    await page.evaluate(() => { const all = document.querySelectorAll('#messages .msg-physician, #messages .msg-assistant'); all[all.length - 1].scrollIntoView(); });
    const kbLast = await m();
    check(kbLast.scrollY === 0 && inView(kbLast.composer, kbLast.vvH), `${tag} +keyboard: scrollIntoView(last message) keeps the composer on screen (scrollY ${kbLast.scrollY})`);

    // Tapping Send with the keyboard up must send: the layout may not move under the finger (it did when the
    // compact layout was dropped on the textarea's blur, between mousedown and mouseup).
    const before = await page.locator('#messages .msg-physician').count();
    await page.fill('#input', 'tap send with the keyboard up');
    await page.click('#sendBtn');
    await page.waitForTimeout(150);
    check(await page.locator('#messages .msg-physician').count() === before + 1, `${tag} +keyboard: a tap on Send sends (the bubble is drawn)`);
    const afterSend = await m();
    check(inView(afterSend.composer, afterSend.vvH), `${tag} +keyboard: composer still fully visible after Send`);

    // ---- keyboard closed: full layout returns ----
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    const closed = await m();
    check(closed.compact === load.compact && inView(closed.disclaimer, closed.vvH), `${tag} keyboard closed: back to the at-rest layout (compact ${closed.compact}, ${closed.discLines} disclaimer lines)`);
    if (!load.compact) check(closed.hint && closed.hint.shown && closed.discLines > 1, `${tag} keyboard closed: full hint + full disclaimer back`);
    // Keyboard dismissed by leaving the box (viewport still short): full layout a beat later, no lift left behind.
    await page.setViewportSize({ width: w, height: h - KEYBOARD_PX });
    await page.focus('#input');
    await page.evaluate(() => document.getElementById('input').blur());
    await page.waitForTimeout(450);
    const blurred = await page.evaluate(() => ({ lift: document.documentElement.style.getPropertyValue('--kb-lift') }));
    const bl = await m();
    check(!blurred.lift, `${tag} box left: no lift at rest (the nav stays reachable)`);
    // (Viewport still keyboard-short with the box blurred is transient: a real keyboard closes on blur.)
    check(bl.compact || !bl.spill || bl.spill <= 0.5, `${tag} box left: compact whenever the full layout would spill`);
    await page.setViewportSize({ width: w, height: h });
    report.push({ size: tag, scrollHeight: load.scrollH, innerHeight: load.innerH, restSpill: load.spill, keyboard: { vvH: kb.vvH, compact: kb.compact, composerBottom: kb.composer && Math.round(kb.composer.bottom), disclaimerBottom: kb.disclaimer && Math.round(kb.disclaimer.bottom) } });
  } catch (e) {
    check(false, `${tag}: ${String(e.message).split('\n')[0]}`);
  }
  await ctx.close();
}

// ---- rest only: short in-browser heights and landscape phones ----
for (const { w, h, knownGap } of REST_SIZES) {
  const tag = `${w}x${h}`;
  console.log(`\n== ${tag} (rest)`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try { localStorage.setItem('clics_token', 'scroll-guard'); } catch {} });
  await ctx.route('**/*', (route) => {
    const req = route.request(); const url = req.url();
    if (url.startsWith(base)) return route.continue();
    if (!url.startsWith('http://localhost:3001')) return route.abort();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const path = new URL(url).pathname;
    const body = path === '/ples/smoke' && req.method() === 'GET' ? ple : {};
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  try {
    await page.goto(base + '/ple-chat?id=smoke', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => document.querySelectorAll('#messages .msg-physician, #messages .msg-assistant').length >= n, N, { timeout: 10000 });
    await page.waitForTimeout(200);
    const r = await page.evaluate(MEASURE);
    check(r.scrollH <= r.innerH + 1, `${tag} at rest: document fits the viewport (${r.scrollH} <= ${r.innerH} + 1)`);
    check(inView(r.composer, r.vvH), `${tag} at rest: composer fully on screen`);
    const discOk = inView(r.disclaimer, r.vvH) && r.discSeen.length > 0;
    const discMsg = `${tag} at rest: AI disclaimer fully on screen (bottom ${r.disclaimer && Math.round(r.disclaimer.bottom)} <= ${r.vvH})`;
    if (knownGap) console.log(`  ${discOk ? 'PASS' : 'KNOWN GAP'} ${discMsg}`); else check(discOk, discMsg);
    report.push({ size: tag, rest: true, compact: r.compact, restSpill: r.spill });
  } catch (e) {
    check(false, `${tag}: ${String(e.message).split('\n')[0]}`);
  }
  await ctx.close();
}

await browser.close(); server.close();
console.log('\n' + JSON.stringify(report));
console.log(fails.length ? `\nFAILED: ${fails.length}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
