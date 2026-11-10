import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRadar, checkRadar } from '../radar-check.mjs';
import { FIT_TEXT, atCut } from './play.mjs';

const REPLY_KEY = 'POST /booth/plays/:id/reply';
const SCORE_KEY = 'POST /booth/plays/:id/score';
const DRAW_KEY = 'POST /booth/draw';
const SIZES = [[1080, 1920], [2160, 3840]];
const TYPED = 'ไข้ ไอ และหอบ ตรวจเอกซเรย์ปอดก่อน';
const BOARD = {
  today: [7, 19, 42, 3, 25].map((tag, i) => ({ tag, score: 91.2 - i * 3.4, at: '2026-11-03T02:00:00.000Z' })),
  event: [101, 7, 88, 19, 42].map((tag, i) => ({ tag, score: 96.6 - i * 3.4, at: '2026-11-03T02:00:00.000Z' })),
};

const js = (name) => fileURLToPath(new URL(`../../../physician-ui/public/js/${name}`, import.meta.url));
const dataUrl = (text) => `data:text/javascript,${encodeURIComponent(text)}`;
const COPY_URL = dataUrl(await readFile(js('booth-copy.js'), 'utf8'));
const { parseResultFragment, resultFragment, RESULT_PATH } = await import(dataUrl((await readFile(js('booth-result-link.js'), 'utf8'))
  .replaceAll("'./booth-copy.js'", JSON.stringify(COPY_URL))));

const lookNow = (page) => page.evaluate(() => document.documentElement.dataset.look);
const settled = (page) => page.waitForFunction(() => document.getAnimations()
  .every((a) => a.effect?.getComputedTiming().iterations === Infinity || a.playState !== 'running'), null, { timeout: 10_000 });

/** Switch to `look` the way a visitor does: a tap on the primary segment and/or on "Both". */
async function switchTo(h, k, look) {
  const want = h.LOOKS[look];
  const now = h.LOOKS[await lookNow(k.page)];
  if (now.primary !== want.primary) await k.tap(`[data-look-control] [data-look-primary="${want.primary}"]`);
  if (now.both !== want.both) await k.tap('[data-look-control] [data-look-both]');
  await k.page.waitForFunction((l) => document.documentElement.dataset.look === l, look, { timeout: 5000 });
  await k.page.evaluate(() => document.fonts.ready);
  await settled(k.page);
}

/** Every bilingual text drawn: which language holds the main slot, whether the sub slot shows, and whether the main
 *  slot reads first (above it, or before it on a shared row) and no smaller. */
const readSlots = (page) => page.evaluate(() => {
  const shown = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'; };
  return [...document.querySelectorAll('.bi')].filter(shown).map((b) => {
    const main = b.querySelector(':scope > .bi-main');
    const sub = b.querySelector(':scope > .bi-sub');
    const m = main.getBoundingClientRect();
    const s = sub.getBoundingClientRect();
    const subShown = shown(sub);
    const size = (e) => parseFloat(getComputedStyle(e).fontSize);
    return {
      text: b.innerText.replace(/\s+/g, ' ').slice(0, 40), radar: !!b.closest('.radar-label'), demo: !!b.closest('[data-demo-label]'), html: document.documentElement.lang,
      main: main.lang, sub: sub.lang, subShown, first: !subShown || s.top >= m.bottom - 1 || (s.top < m.bottom && s.left >= m.right - 1),
      larger: !subShown || size(main) >= size(sub),
    };
  });
});

/** The slots read as `look` says: its primary in every main slot and on <html>, the sub slot shown exactly when the look
 *  shows both (never under a radar axis, always in the demo label), and the main slot first and no smaller. */
async function checkSlots(h, page, label, look) {
  const { primary, both } = h.LOOKS[look];
  const pairs = await readSlots(page);
  const bad = pairs.filter((p) => p.main !== primary || p.sub === primary || p.html !== primary
    || p.subShown !== (p.demo || (both && !p.radar)) || !p.first || !p.larger);
  h.check(pairs.length > 0 && bad.length === 0, `${label}: ${pairs.length} bilingual texts in the ${look} look, ${primary === 'th' ? 'Thai' : 'English'} first and no smaller`
    + `${both ? ', the other language under it' : ', the other hidden'}${bad.length ? ` (wrong: ${bad.slice(0, 3).map((p) => JSON.stringify(p)).join('; ')})` : ''}`);
}

/** The control: its box, its buttons, whether it is the topmost thing at its centre, and everything it overlaps. */
const readControl = (page) => page.evaluate(() => {
  const c = document.querySelector('[data-look-control]');
  if (!c) return null;
  const cr = c.getBoundingClientRect();
  const hit = (r) => r.width > 0 && r.height > 0 && r.left < cr.right && r.right > cr.left && r.top < cr.bottom && r.bottom > cr.top;
  /** `r` cut to what its scrolling ancestors let show: text scrolled out of a play body is not on screen. */
  const seen = (r, e) => {
    let { left, top, right, bottom } = r;
    for (let a = e.parentElement; a; a = a.parentElement) {
      if (getComputedStyle(a).overflow === 'visible') continue;
      const b = a.getBoundingClientRect();
      [left, top, right, bottom] = [Math.max(left, b.left), Math.max(top, b.top), Math.min(right, b.right), Math.min(bottom, b.bottom)];
    }
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };
  const visible = (e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && Number(cs.opacity) > 0; };
  const over = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.data.trim() || c.contains(n) || !visible(n.parentElement)) continue;
    range.selectNodeContents(n);
    if ([...range.getClientRects()].some((r) => hit(seen(r, n.parentElement)))) over.push(`text "${n.data.trim().slice(0, 30)}"`);
  }
  for (const e of document.querySelectorAll('button, [role="button"], textarea, input, a[href], [data-keep-qr] svg, [data-landing-qr] img')) {
    if (c.contains(e) || !visible(e)) continue;
    const r = e.getBoundingClientRect();
    // The loop's tap layer spans the whole screen: the control is drawn over it by design.
    const layer = r.left <= cr.left && r.right >= cr.right && r.top <= cr.top && r.bottom >= cr.bottom;
    if (hit(seen(r, e)) && !layer) over.push(`${e.tagName.toLowerCase()} ${e.dataset.action ?? e.className?.baseVal ?? e.className}`);
  }
  const top = document.elementFromPoint((cr.left + cr.right) / 2, (cr.top + cr.bottom) / 2);
  return {
    box: { top: cr.top, right: innerWidth - cr.right, width: cr.width, height: cr.height }, fixed: getComputedStyle(c).position === 'fixed',
    outside: !c.closest('#booth'), modal: !!document.querySelector('[aria-modal="true"]'), topmost: c.contains(top),
    buttons: [...c.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { w: r.width, h: r.height, key: b.dataset.lookPrimary ?? 'both', pressed: b.getAttribute('aria-pressed'),
        tick: getComputedStyle(b.querySelector('.look-tick')).visibility };
    }),
    over,
  };
});

/**
 * The control on this screen in this look: in the same fixed corner as on every screen before it, every button at
 * least 80 px x scale, its pressed state matching the look with a tick (not colour alone), topmost unless a modal
 * covers it, and, uncovered, overlapping no visible text, tap target or QR.
 */
async function checkControl(h, k, label, look) {
  const c = await readControl(k.page);
  if (!h.check(!!c, `${label}: the look control is on screen`)) return;
  const scale = await k.page.evaluate(() => innerWidth / 1080);
  const round = (b) => Object.fromEntries(Object.entries(b).map(([key, v]) => [key, Math.round(v)]));
  k.corner ??= round(c.box);
  const { primary, both } = h.LOOKS[look];
  const pressed = c.buttons.every((b) => (b.key === 'both' ? both : b.key === primary) === (b.pressed === 'true')
    && (b.pressed === 'true') === (b.tick === 'visible'));
  h.check(c.fixed && c.outside && h.same(round(c.box), k.corner) && Math.abs(c.box.top - 8 * scale) <= 1 && Math.abs(c.box.right - 8 * scale) <= 1,
    `${label}: the control is fixed top right, outside the play, in the same corner as on every screen (${JSON.stringify(round(c.box))})`);
  h.check(c.buttons.length === 3 && c.buttons.every((b) => b.w >= h.FLOOR.tapPx * scale - 0.01 && b.h >= h.FLOOR.tapPx * scale - 0.01) && pressed,
    `${label}: ไทย, English and Both are each >= ${Math.round(h.FLOOR.tapPx * scale)} px, the ${look} look pressed and ticked (${c.buttons.map((b) => `${b.key} ${Math.round(b.w)}x${Math.round(b.h)} ${b.pressed}`).join(', ')})`);
  h.check(c.topmost === !c.modal, `${label}: the control is ${c.modal ? 'under the open overlay' : 'on top, so a tap on it reaches it'}`);
  // Under an open overlay's scrim the control covers nothing; it is covered.
  if (!c.modal) h.check(c.over.length === 0, `${label}: the control covers no text, tap target or QR${c.over.length ? ` (covers ${c.over.slice(0, 4).join(', ')})` : ''}`);
}

/** The screen as it is, in `look`: the booth's screen checks, the slots and the control. */
async function checkLook(h, k, screen, look, opts = {}) {
  const label = `${k.label} ${screen}, ${look}`;
  await h.screenCheck(k.page, label, opts);
  await checkSlots(h, k.page, label, look);
  await checkControl(h, k, label, look);
  if (k.width === 1080) await h.shot(k.page, `look-${screen.replace(/[^a-z0-9]+/gi, '-')}-${look}`);
}

/** Each look on the screen as it stands, switched through the control. */
async function eachLook(h, k, screen, opts = {}) {
  for (const look of Object.keys(h.LOOKS)) {
    await switchTo(h, k, look);
    await checkLook(h, k, screen, look, opts);
  }
}

/** Each look on an overlay: the overlay covers the control, so the look is set first, then the overlay opened. */
async function eachLookUnder(h, k, screen, open, close, opts = {}) {
  for (const look of Object.keys(h.LOOKS)) {
    await switchTo(h, k, look);
    await open();
    await k.page.evaluate(() => document.fonts.ready);
    await h.sleep(400);
    await checkLook(h, k, screen, look, opts);
    await close();
  }
}

/** Tap a control that sends a reply or score request, noting the look on show as it was tapped. */
async function send(k, selector) {
  k.sentLooks.push(await lookNow(k.page));
  await k.tap(selector);
}

async function toVignette(k) {
  await k.tap('[data-action="start"]');
  await k.screen('teaser');
  await k.tap('[data-action="start-case"]');
  await k.screen('vignette');
}

/** Every reply and score request carried the look on show when its Send or See my score was tapped. */
function checkSent(h, k, label) {
  const calls = k.stub.calls.filter((c) => c.key === REPLY_KEY || c.key === SCORE_KEY);
  h.check(calls.length > 0 && calls.length === k.sentLooks.length && calls.every((c, i) => c.body?.look === k.sentLooks[i]),
    `${label}: each of ${calls.length} reply and score requests carries the look on show (${calls.map((c, i) => `${c.key.split('/').pop()} ${c.body?.look}${c.body?.look === k.sentLooks[i] ? '' : ` != ${k.sentLooks[i]}`}`).join(', ')})`);
}

async function playAllLooks(h, width, height) {
  const FIT_REPLY = Object.fromEntries(Object.entries(FIT_TEXT).map(([key, v]) => [key, atCut(v, h.FIELD_MAX_CHARS)]));
  let mode = 'play';
  const stub = h.makeStub({ routes: {
    [REPLY_KEY]: (call) => {
      if (mode === 'stop') return { status: 409, body: { error: 'The play is not started.', reason: 'not_started' } };
      return { status: 200, body: h.replyBody(call.body.answers, call.body.answers.length === 2 ? { reply: FIT_REPLY } : {}) };
    },
    [SCORE_KEY]: (call) => (mode === 'unavailable' ? { status: 200, body: { status: 'unavailable' } } : h.scoredFor(call, { rank_today: 3, rank_event: 5, board: BOARD })),
    'GET /booth/board': () => ({ status: 200, body: { board: BOARD } }),
  } });
  const k = await h.kiosk({ width, height, stub, label: `${width}x${height}` });
  Object.assign(k, { label: `${width}x${height}`, width, sentLooks: [] });
  const { page } = k;
  await page.clock.install();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await k.shell('start');
  h.check(await lookNow(page) === h.DEFAULT_LOOK, `${k.label}: a fresh kiosk starts in the ${h.DEFAULT_LOOK} look`);
  await eachLook(h, k, 'loop');

  const releaseDraw = stub.hold(DRAW_KEY);
  await k.tap('[data-action="start"]');
  await k.screen('drawing');
  await eachLook(h, k, 'drawing');
  releaseDraw();
  await k.screen('teaser');
  await eachLook(h, k, 'teaser');
  await k.tap('[data-action="start-case"]');
  await k.screen('vignette');
  await eachLook(h, k, 'vignette');
  await k.tap('[data-action="begin"]');
  await k.screen('step');
  await k.choose(2);
  await eachLook(h, k, 'step with B chosen');

  await switchTo(h, k, 'th+en');
  const chosen = await page.$$eval('.options > [data-option]', (els) => els.map((e) => e.getAttribute('aria-pressed')));
  const sheet = await page.evaluate(() => { window.__sheet = document.querySelector('.step-sheet'); return true; });
  await switchTo(h, k, 'en+th');
  const after = await page.evaluate(() => ({ same: document.querySelector('.step-sheet') === window.__sheet,
    chosen: [...document.querySelectorAll('.options > [data-option]')].map((e) => e.getAttribute('aria-pressed')),
    send: !document.querySelector('[data-action="send"]').disabled }));
  h.check(sheet && after.same && await k.screenNow() === 'step' && h.same(after.chosen, chosen) && h.same(chosen, ['false', 'true', 'false']) && after.send,
    `${k.label}: a switch to en+th on a step with B chosen keeps the same step drawn, B still chosen and Send ready (${JSON.stringify(after)})`);
  await checkSlots(h, page, `${k.label} step after the switch`, 'en+th');
  const releaseReply = stub.hold(REPLY_KEY);
  await send(k, '[data-action="send"]');
  await k.screen('replying');
  h.check(stub.of(REPLY_KEY)[0]?.body?.look === 'en+th', `${k.label}: Send after the switch posts the reply with the new look (${stub.of(REPLY_KEY)[0]?.body?.look})`);
  await page.clock.runFor(8_000);
  await page.waitForFunction((line) => document.querySelector('#booth [data-screen="replying"]')?.textContent.includes(line), h.COPY.stillWorking.en, { timeout: 5000 });
  await eachLook(h, k, 'replying, still working');
  releaseReply();
  await k.screen('reply');
  await eachLook(h, k, 'reply 1');

  const confirm = async () => {
    await k.tap('[data-action="start-over"]');
    await page.waitForSelector('[data-leave-confirm]', { timeout: 10_000 });
  };
  await eachLookUnder(h, k, 'Start over confirm', confirm, () => k.tap('[data-action="keep-playing"]'));

  await k.tap('[data-action="next"]');
  await k.screen('step');
  await k.tap('[data-action="type-own"]');
  await k.screen('typing');
  await page.keyboard.type(TYPED);
  await eachLook(h, k, 'typing with text typed');
  await switchTo(h, k, 'th');
  const typing = await page.evaluate(() => {
    const box = document.querySelector('.typing-box');
    return { value: box.value, lang: box.lang, send: !document.querySelector('[data-action="send"]').disabled };
  });
  h.check(await k.screenNow() === 'typing' && typing.value === TYPED && typing.lang === 'th' && typing.send,
    `${k.label}: a switch to th while typing keeps the typing sheet, its text and Send, and the box takes the primary language (${JSON.stringify(typing)})`);
  await switchTo(h, k, 'en');
  h.check(await page.evaluate(() => document.querySelector('.typing-box').lang) === 'en', `${k.label}: in the en look the typing box is lang en`);
  await checkSlots(h, page, `${k.label} typing after the switch`, 'en');
  await send(k, '[data-action="send"]');
  await k.screen('reply');
  h.check(stub.of(REPLY_KEY)[1]?.body?.look === 'en' && stub.of(REPLY_KEY)[1]?.body?.answers[1]?.text === TYPED,
    `${k.label}: Send on the typing sheet after the switch posts the typed text with the new look (${stub.of(REPLY_KEY)[1]?.body?.look})`);
  await eachLook(h, k, 'reply at the server cut');

  await k.tap('[data-action="next"]');
  await k.screen('step');
  await k.choose(1);
  await send(k, '[data-action="send"]');
  await k.screen('reply');
  const stillThere = async () => {
    await page.clock.fastForward(91_000);
    await page.waitForSelector('.still-there', { timeout: 10_000 });
  };
  await eachLookUnder(h, k, 'Still there', stillThere, async () => {
    await k.tap('[data-action="keep-going"]');
    await page.waitForFunction(() => !document.querySelector('.still-there'), null, { timeout: 5000 });
  });

  const releaseScore = stub.hold(SCORE_KEY);
  await send(k, '[data-action="see-score"]');
  await k.screen('scoring');
  await eachLook(h, k, 'scoring', { demo: true });
  releaseScore();
  await k.screen('scored');
  await page.evaluate(() => { window.__card = document.querySelector('.result-card'); });
  const domains = h.SCORED.domains;
  for (const look of Object.keys(h.LOOKS)) {
    await switchTo(h, k, look);
    await checkLook(h, k, 'result card', look, { demo: true });
    checkRadar(h, `${k.label} result card, ${look}`, await readRadar(page), domains, h.LOOKS[look].primary);
    const url = new URL(await page.locator('[data-keep-qr]').getAttribute('data-result-url'));
    const same = await page.evaluate(() => document.querySelector('.result-card') === window.__card);
    h.check(parseResultFragment(url.hash)?.look === look && same && await k.screenNow() === 'scored',
      `${k.label} result card, ${look}: the QR is drawn again with the look in its link, on the same card, not a redrawn screen (l=${parseResultFragment(url.hash)?.look})`);
    if (look === 'en+th' && width === 1080) k.keptUrl = url;
  }
  await eachLookUnder(h, k, 'See the answers', async () => {
    await k.tap('[data-action="see-answers"]');
    await page.waitForSelector('[data-reveal-overlay] .reveal-step');
  }, async () => {
    await page.locator('[data-reveal-overlay] [data-action="close-answers"]').scrollIntoViewIfNeeded();
    await k.tap('[data-reveal-overlay] [data-action="close-answers"]');
  }, { demo: 'auto' });
  await eachLookUnder(h, k, 'leaderboard', async () => {
    await k.tap('.result-card [data-action="leaderboard"]');
    await page.waitForSelector('[data-board-overlay] [data-board]');
  }, () => k.tap('[data-board-overlay] [data-action="close-board"]'), { demo: true });
  checkSent(h, k, `${k.label} play`);

  const before = await lookNow(page);
  await k.shell('done');
  await k.tap('[data-action="done"]');
  await k.shell('start');
  const fresh = await readControl(page);
  h.check(before !== h.DEFAULT_LOOK && await lookNow(page) === h.DEFAULT_LOOK && h.same(fresh?.buttons.map((b) => [b.key, b.pressed]), [['th', 'true'], ['en', 'false'], ['both', 'true']]),
    `${k.label}: after Done (a reload) the next visitor starts at ${h.DEFAULT_LOOK} with ไทย and Both pressed, whatever the last look was (${before})`);

  mode = 'unavailable';
  k.sentLooks = [];
  stub.calls.length = 0;
  await toVignette(k);
  await k.tap('[data-action="begin"]');
  for (let n = 1; n <= 3; n++) {
    await k.screen('step');
    await k.choose(1);
    await send(k, '[data-action="send"]');
    await k.screen('reply');
    if (n < 3) await k.tap('[data-action="next"]');
  }
  await send(k, '[data-action="see-score"]');
  await k.screen('unavailable');
  await eachLook(h, k, 'unavailable');
  checkSent(h, k, `${k.label} unavailable play`);

  mode = 'stop';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await k.shell('start');
  await toVignette(k);
  await k.tap('[data-action="begin"]');
  await k.screen('step');
  await k.choose(1);
  await k.tap('[data-action="send"]');
  await k.screen('stopped');
  // The stopped screen resets itself 6 s on; the clock holds while each look is checked.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
  await eachLook(h, k, 'stopped');
  await page.clock.resume();
  await k.shell('start', 15_000);
  h.check(await lookNow(page) === h.DEFAULT_LOOK, `${k.label}: the stopped screen's own reset also starts the next visitor at ${h.DEFAULT_LOOK}`);
  const keptUrl = k.keptUrl;
  await k.close();
  return keptUrl;
}

export default [
  {
    name: 'look mirror: the kiosk\'s LOOKS are the looks the backend accepts (booth-dialogue.js LOOK_LANGUAGE)',
    async run(h) {
      const kiosk = Object.keys(h.LOOKS);
      h.check(h.same(h.SERVER_LOOKS && [...h.SERVER_LOOKS].sort(), [...kiosk].sort()),
        `mirror: LOOKS ${JSON.stringify(kiosk)} = LOOK_LANGUAGE ${JSON.stringify(h.SERVER_LOOKS)}`);
      h.check(h.LOOKS[h.DEFAULT_LOOK]?.primary === 'th' && h.LOOKS[h.DEFAULT_LOOK].both, `mirror: the default look ${h.DEFAULT_LOOK} is Thai first with English under it`);
    },
  },
  {
    name: 'four looks at 1080x1920 and 2160x3840: every booth screen in each look, switched through the control mid-play, '
      + 'every request carrying the look, and a fresh kiosk at ไทย+EN',
    async run(h) {
      const urls = await Promise.all(SIZES.map(([width, height]) => playAllLooks(h, width, height)));
      const kept = urls.find(Boolean);
      if (!h.check(!!kept, 'the 1080 play kept the result link it drew in the en+th look')) return;
      const p = await h.phone(`${kept.pathname}${kept.hash}`);
      await p.page.waitForSelector('.result-card');
      h.check(await lookNow(p.page) === 'en+th' && await p.page.evaluate(() => document.documentElement.lang) === 'en',
        `the kiosk's result QR, drawn in the en+th look, opens the phone page in the en+th look (${await lookNow(p.page)})`);
      await checkSlots(h, p.page, 'phone page from the kiosk QR', 'en+th');
      await p.close();
    },
  },
  {
    name: 'the shell\'s checking, closed and offline screens in each look, at 1080x1920 and 2160x3840',
    async run(h) {
      await Promise.all(SIZES.map(async ([width, height]) => {
        const stub = h.makeStub();
        const release = stub.hold('GET /booth/status');
        const k = await h.kiosk({ width, height, stub, label: `${width}x${height} checking` });
        Object.assign(k, { label: `${width}x${height}`, width });
        // The status check times out into offline after 8 s; the clock holds while each look is checked.
        await k.page.clock.install();
        await k.page.reload({ waitUntil: 'domcontentloaded' });
        await k.shell('checking');
        await k.page.clock.pauseAt(await k.page.evaluate(() => Date.now() + 50));
        await eachLook(h, k, 'checking');
        await k.page.clock.resume();
        release();
        await k.close();

        for (const [shell, status] of [['closed', () => ({ status: 200, body: { open: false, reason: 'off' } })], ['offline', () => 'abort']]) {
          const s = await h.kiosk({ width, height, stub: h.makeStub({ routes: { 'GET /booth/status': status } }), label: `${width}x${height} ${shell}` });
          Object.assign(s, { label: `${width}x${height}`, width });
          await s.shell(shell);
          await eachLook(h, s, shell);
          await s.close();
        }
      }));
    },
  },
  {
    name: 'the loop returns to ไทย+EN after 90 s with no touch or key, and a look switched then started plays in that look',
    async run(h) {
      const k = await h.kiosk({ label: 'loop look reset' });
      Object.assign(k, { label: 'loop look reset', width: 1080, sentLooks: [] });
      const { page, stub } = k;
      await page.clock.install();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await k.shell('start');
      const pressed = async () => (await readControl(page))?.buttons.map((b) => [b.key, b.pressed]);
      const idle = async (ms) => { await page.clock.fastForward(ms); await h.sleep(200); return lookNow(page); };

      await switchTo(h, k, 'en+th');
      h.check(await idle(89_000) === 'en+th', 'loop: en+th still shows 89 s after the switch');
      await page.keyboard.press('Shift');
      h.check(await idle(89_000) === 'en+th', 'loop: a key press restarts the wait, so en+th still shows 89 s after it');
      await page.clock.fastForward(2_000);
      await page.waitForFunction((l) => document.documentElement.dataset.look === l, h.DEFAULT_LOOK, { timeout: 5000 }).catch(() => {});
      await settled(page);
      h.check(await lookNow(page) === h.DEFAULT_LOOK && h.same(await pressed(), [['th', 'true'], ['en', 'false'], ['both', 'true']]),
        `loop: 91 s with no touch or key returns the look to ${h.DEFAULT_LOOK}, with ไทย and Both pressed (${await lookNow(page)}, ${JSON.stringify(await pressed())})`);
      await checkSlots(h, page, 'loop after the idle reset', h.DEFAULT_LOOK);

      await switchTo(h, k, 'en');
      await page.clock.fastForward(60_000);
      await k.tap('[data-action="start"]');
      await k.screen('teaser');
      await page.clock.fastForward(91_000);
      await h.sleep(200);
      h.check(await lookNow(page) === 'en', `play: a look switched on the loop and then started keeps past the loop's 90 s, Start clears that wait (${await lookNow(page)})`);
      if (await page.locator('.still-there').count()) {
        await h.sleep(400);
        await k.tap('[data-action="keep-going"]');
        await page.waitForFunction(() => !document.querySelector('.still-there'), null, { timeout: 5000 });
      }
      await k.tap('[data-action="start-case"]');
      await k.screen('vignette');
      await k.tap('[data-action="begin"]');
      await k.screen('step');
      await k.choose(1);
      await send(k, '[data-action="send"]');
      await k.screen('reply');
      checkSent(h, k, 'play started in the en look');
      h.check(stub.of(REPLY_KEY)[0]?.body?.look === 'en', `play: the first reply request carries the look switched on the loop (${stub.of(REPLY_KEY)[0]?.body?.look})`);
      await checkSlots(h, page, 'reply in the look switched on the loop', 'en');
      await k.close();
    },
  },
  ...[[375, 812], [320, 640]].map(([width, height]) => ({
    name: `result page at ${width}px in each look: the fragment's look, no look control, contrast and floors`,
    async run(h) {
      const r = { score: 64, domains: { d1: 1, d2: 3, d3: 5, d4: 0, d5: 2, d6: 4, d7: 3 }, tag: 7, date: '2026-11-03', teaser: h.TREE.teaser,
        tiers: ['reasonable', 'best', 'weaker'] };
      const p = await h.phone(`${RESULT_PATH}#${resultFragment(r)}`, { width, height });
      const { page } = p;
      await page.waitForSelector('.result-card');
      h.check(await lookNow(page) === h.DEFAULT_LOOK, `${width}: a link with no look reads as ${h.DEFAULT_LOOK}`);
      for (const look of Object.keys(h.LOOKS)) {
        await page.evaluate((f) => { location.hash = f; }, resultFragment({ ...r, look }));
        await page.waitForFunction((l) => document.documentElement.dataset.look === l && document.querySelector('.result-card'), look);
        await page.evaluate(() => document.fonts.ready);
        const label = `result page ${width}px, ${look}`;
        await h.screenCheck(page, label, { demo: 'auto' });
        await checkSlots(h, page, label, look);
        checkRadar(h, label, await readRadar(page), r.domains, h.LOOKS[look].primary);
        const seen = await page.evaluate(() => ({
          control: document.querySelectorAll('[data-look-control]').length, scrollX: document.documentElement.scrollWidth - innerWidth,
          smallest: Math.min(...[...document.querySelectorAll('.result-page *')].filter((e) => getComputedStyle(e).display !== 'none'
            && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => parseFloat(getComputedStyle(e).fontSize))),
        }));
        h.check(seen.control === 0 && seen.scrollX <= 0 && seen.smallest >= 16,
          `${label}: no look control, no sideways scroll, no text under 16 px (smallest ${seen.smallest} px)`);
        await h.shot(page, `look-result-page-${width}-${look}`, { fullPage: true });
      }
      await p.close();
    },
  })),
];
