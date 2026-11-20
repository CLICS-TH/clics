// The forum's 50-inch monitor (2K-4K) may stand landscape: the kiosk is then a 9:16 column in the middle of the
// screen, scaled by the screen's height, and a portrait screen is that column filled. The overlays' scrims still cover
// the whole screen, a tap on a blank side acts as a tap on the scrim (or, on the loop, starts a play), and an
// on-screen keyboard, which only shortens the page, never shrinks the column.
const REPLY_KEY = 'POST /booth/plays/:id/reply';
const SCORE_KEY = 'POST /booth/plays/:id/score';
const SCREENS = [[1920, 1080], [2560, 1440], [3840, 2160], [1920, 1080, 'fine'], [1080, 1920]];

/** The column (#booth) and the screen, in px. */
const geometry = (page) => page.evaluate(() => {
  const b = document.getElementById('booth').getBoundingClientRect();
  return { left: b.left, width: b.width, right: b.right, screen: innerWidth, height: innerHeight };
});

/** The box of the first `selector` on screen, or null. */
const boxOf = (page, selector) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}, selector);

/** A tap (or a click, under a fine pointer) at a point of the screen. */
const tapAt = (k, pointer, x, y) => (pointer === 'fine' ? k.page.mouse.click(x, y) : k.page.touchscreen.tap(x, y));

/** The overlay `selector`: its scrim spans the whole screen, and its card `card` sits inside the column. */
async function checkScrim(h, k, label, selector, card) {
  const [o, c, g] = [await boxOf(k.page, selector), await boxOf(k.page, card), await geometry(k.page)];
  h.check(!!o && !!c && o.left <= 0.5 && o.top <= 0.5 && Math.abs(o.right - g.screen) <= 0.5 && Math.abs(o.bottom - g.height) <= 0.5
    && c.left >= g.left - 0.5 && c.right <= g.right + 0.5,
  `${label}: the scrim covers the whole screen (${o && `${Math.round(o.width)}x${Math.round(o.height)}`}) and its card stays in the column `
    + `(card x ${c && Math.round(c.left)}..${c && Math.round(c.right)}, column ${Math.round(g.left)}..${Math.round(g.right)})`);
}

export default [
  ...SCREENS.map(([width, height, pointer = 'coarse']) => ({
    name: `the column at ${width}x${height}${pointer === 'fine' ? ', fine pointer' : ''}: 9:16, centred, the sides start a play on the loop and close what a scrim tap closes`,
    async run(h) {
      const stub = h.makeStub();
      const k = await h.kiosk({ width, height, pointer, stub });
      const { page } = k;
      const at = `${width}x${height}${pointer === 'fine' ? ' fine' : ''}`;
      await page.clock.install();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await k.shell('start');
      const g = await geometry(page);
      const col = Math.min(width, Math.round(height * 9 / 16));
      const side = (width - g.width) / 2;
      h.check(Math.abs(g.width - col) <= 1 && Math.abs(g.left - side) <= 0.5 && Math.abs(width - g.right - side) <= 0.5,
        `${at}: the kiosk is a ${col}-px column (${g.width}), centred (${Math.round(g.left)} px each side)`);
      const loop = await boxOf(page, '.loop-stage');
      h.check(Math.abs(loop.width - g.width) <= 0.5 && Math.abs(loop.left - g.left) <= 0.5, `${at}: the attract loop fills the column (${Math.round(loop.width)} px)`);
      await h.screenCheck(page, `loop, ${at}`);

      if (side > 0) {
        await tapAt(k, pointer, side / 2, height / 2);
        await k.screen('teaser');
        h.check(stub.of('POST /booth/draw').length === 1, `${at}: a tap on the blank left side of the loop starts a play, as a tap on the loop does`);
        await k.tap('[data-action="start-case"]');
        await k.screen('vignette');
      } else {
        await k.toVignette();
      }
      await k.tap('[data-action="begin"]');
      await k.screen('step');
      await k.choose(1);
      await h.screenCheck(page, `step 1, ${at}`);
      const calls = stub.calls.length;

      await k.tap('[data-action="start-over"]');
      await page.waitForSelector('[data-leave-confirm]');
      await h.sleep(400);
      await checkScrim(h, k, `Start over confirm, ${at}`, '[data-leave-confirm]', '.leave-card');
      await h.screenCheck(page, `Start over confirm, ${at}`);
      if (side > 0) {
        await tapAt(k, pointer, width - side / 2, height / 2);
        await h.sleep(300);
        h.check(await page.locator('[data-leave-confirm]').count() === 0 && await k.screenNow() === 'step' && stub.calls.length === calls,
          `${at}: a tap on the blank right side closes the confirm as a tap on its scrim does; the play is as it was, with no request`);
      } else {
        await k.tap('[data-action="keep-playing"]');
        await h.sleep(300);
      }

      await k.tap('[data-action="type-own"]');
      await k.screen('typing');
      const typing = await page.evaluate(() => ({
        behind: getComputedStyle(document.querySelector('.case-card--behind')).display !== 'none',
        capped: getComputedStyle(document.querySelector('.typing-sheet')).maxHeight !== 'none',
      }));
      h.check(typing.behind && typing.capped, `${at}: typing shows the case card behind the sheet and caps the sheet, as the portrait 9:16 kiosk does (${JSON.stringify(typing)})`);
      await page.keyboard.type('draft');
      await page.setViewportSize({ width, height: Math.round(height * 0.55) });
      await h.sleep(300);
      const up = await geometry(page);
      const kb = await page.evaluate(() => ({
        behind: getComputedStyle(document.querySelector('.case-card--behind')).display,
        send: (() => { const r = document.querySelector('[data-action="send"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })(),
        value: document.querySelector('.typing-box').value,
      }));
      h.check(Math.abs(up.width - g.width) <= 0.5 && kb.behind === 'none' && kb.send && kb.value === 'draft',
        `${at}: an on-screen keyboard (the page ${up.height} px tall) leaves the column at ${up.width} px; the case card behind gives way, Send stays on screen, the draft stays`);
      await page.setViewportSize({ width, height });
      await h.sleep(300);

      await page.clock.fastForward(91_000);
      await page.waitForSelector('.still-there');
      await h.sleep(400);
      await checkScrim(h, k, `Still there?, ${at}`, '.still-there', '.still-card');
      if (side > 0) {
        await tapAt(k, pointer, side / 2, height / 3);
        await page.waitForFunction(() => !document.querySelector('.still-there'), null, { timeout: 5000 });
        h.check(await k.screenNow() === 'typing' && await page.locator('.typing-box').inputValue() === 'draft',
          `${at}: a tap on the blank side answers "Still there?" as a tap on its scrim does; the typing sheet keeps its draft`);
      } else {
        await k.tap('[data-action="keep-going"]');
      }

      await k.tap('[data-action="back"]');
      await k.screen('step');
      for (let n = 1; n <= 3; n++) {
        await k.answer(1);
        await k.screen('reply');
        await k.tap(`[data-action="${n === 3 ? 'see-score' : 'next'}"]`);
        if (n < 3) await k.screen('step');
      }
      await k.screen('scored');
      h.check(stub.of(SCORE_KEY).length === 1 && stub.of(REPLY_KEY).length === 3, `${at}: three replies and a score`);
      await h.screenCheck(page, `result card, ${at}`, { demo: true });
      await k.tap('[data-action="see-answers"]');
      await page.waitForSelector('[data-reveal-overlay] .reveal-step');
      await h.sleep(400);
      await checkScrim(h, k, `See the answers, ${at}`, '[data-reveal-overlay]', '.reveal-card');
      if (side > 0) {
        await tapAt(k, pointer, side / 2, height / 2);
        await h.sleep(300);
        h.check(await page.locator('[data-reveal-overlay]').count() === 1, `${at}: a tap on the blank side leaves See the answers open, as a tap on its scrim does`);
      }
      await k.tap('[data-action="close-answers"]');
      await h.sleep(300);
      await k.tap('[data-action="leaderboard"]');
      await page.waitForSelector('[data-board-overlay]');
      await h.sleep(400);
      await checkScrim(h, k, `the board, ${at}`, '[data-board-overlay]', '.board-card');
      await k.close();
    },
  })),
  {
    name: 'landscape scales with the height: at 3840x2160 every floor is x1.125 of portrait 1080x1920',
    async run(h) {
      const sizeOf = (k) => k.page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.opt-label .bi-th')).fontSize));
      const toStep = async (k) => { await k.shell('start'); await k.toVignette(); await k.tap('[data-action="begin"]'); await k.screen('step'); };
      const small = await h.kiosk({ label: '1080x1920' });
      await toStep(small);
      const at1080 = await sizeOf(small);
      await small.close();
      const big = await h.kiosk({ width: 3840, height: 2160 });
      await toStep(big);
      const r = await h.screenCheck(big.page, 'step 1 at 3840x2160');
      const at4k = await sizeOf(big);
      h.check(r.scale === 1.125 && Math.abs(at4k - at1080 * 1.125) < 0.01, `3840x2160: the floors are x${r.scale} and the option label is ${at4k}px (${at1080}px at 1080x1920)`);
      await big.close();
    },
  },
];
