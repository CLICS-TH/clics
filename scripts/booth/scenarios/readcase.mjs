// "Read the case again" (js/booth-case.js): on the step, typing, replying and reply screens a band button opens the
// dealt case's whole vignette over the play, in the current look; Close puts the focus back on the opener. It makes no
// request and leaves the play as it was.
const REPLY_KEY = 'POST /booth/plays/:id/reply';
const SIZES = [[1080, 1920], [2560, 1440]];

const lookIn = (page, look) => page.evaluate(async (l) => {
  (await import('/js/booth-dom.js')).setLook(l);
  await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(r));
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => {})));
}, look);

const focused = (page) => page.evaluate(() => document.activeElement?.dataset.action ?? document.activeElement?.className ?? null);

/** Open the case on this screen: what the overlay holds, where the focus went, and that no request was made. */
async function openCase(h, k, label) {
  const { page, stub } = k;
  const calls = stub.calls.length;
  h.check(await page.locator('[data-action="read-case"]').count() === 1, `${label}: Read the case again is in the band`);
  await k.tap('[data-action="read-case"]');
  await page.waitForSelector('[data-case-overlay]');
  await page.evaluate(() => document.fonts.ready);
  await h.sleep(400);
  const shown = await page.evaluate(() => {
    const o = document.querySelector('[data-case-overlay]');
    return { role: o.getAttribute('role'), modal: o.getAttribute('aria-modal'),
      th: o.querySelector('.case-read .bi-th').textContent, en: o.querySelector('.case-read .bi-en').textContent };
  });
  h.check(shown.role === 'dialog' && shown.modal === 'true' && shown.th === h.TREE.vignette.th && shown.en === h.TREE.vignette.en,
    `${label}: a modal dialog shows the dealt case's whole vignette, TH and EN word for word`);
  h.check(await focused(page) === 'close-case', `${label}: the focus moves to Close (${await focused(page)})`);
  h.check(stub.calls.length === calls, `${label}: opening it made no request`);
}

async function closeCase(h, k, label, screen) {
  const calls = k.stub.calls.length;
  await k.tap('[data-action="close-case"]');
  await h.sleep(300);
  h.check(await k.page.locator('[data-case-overlay]').count() === 0 && await k.screenNow() === screen && k.stub.calls.length === calls,
    `${label}: Close shuts it on the ${screen} screen, with no request`);
  h.check(await focused(k.page) === 'read-case', `${label}: the focus goes back to Read the case again (${await focused(k.page)})`);
}

/** The overlay open in every look passes the booth's screen checks. */
async function everyLook(h, k, label) {
  for (const look of Object.keys(h.LOOKS)) {
    await lookIn(k.page, look);
    await h.screenCheck(k.page, `${label}, ${look}`);
  }
  await lookIn(k.page, h.DEFAULT_LOOK);
}

export default SIZES.map(([width, height]) => ({
  name: `Read the case again at ${width}x${height}: on the step, typing, replying and reply screens, the whole vignette, no request, the play kept`,
  async run(h) {
    const k = await h.kiosk({ width, height });
    const { page, stub } = k;
    const at = `${width}x${height}`;
    await k.shell('start');
    await k.toVignette();
    h.check(await page.locator('[data-action="read-case"]').count() === 0, `${at} vignette: no Read the case again, the case is on screen in full`);
    await k.tap('[data-action="begin"]');
    await k.screen('step');
    await k.choose(2);
    await h.shot(page, `readcase-step-${at}`);

    await openCase(h, k, `${at} step`);
    await everyLook(h, k, `case overlay over the step, ${at}`);
    await h.shot(page, `readcase-open-${at}`);
    await closeCase(h, k, `${at} step`, 'step');
    const chosen = await page.$$eval('.options > [data-option]', (els) => els.map((e) => e.getAttribute('aria-pressed')));
    h.check(h.same(chosen, ['false', 'true', 'false']) && !(await page.locator('[data-action="send"]').isDisabled()),
      `${at} step: option B is still chosen and Send still enabled (${chosen})`);

    await k.tap('[data-action="type-own"]');
    await k.screen('typing');
    await page.keyboard.type('draft answer');
    await openCase(h, k, `${at} typing`);
    await h.screenCheck(page, `case overlay over typing, ${at}`);
    await closeCase(h, k, `${at} typing`, 'typing');
    h.check(await page.locator('.typing-box').inputValue() === 'draft answer', `${at} typing: the typed draft is still in the box`);

    await k.tap('[data-action="back"]');
    await k.screen('step');
    const release = stub.hold(REPLY_KEY);
    await k.answer(1);
    await k.screen('replying');
    await openCase(h, k, `${at} replying`);
    await h.screenCheck(page, `case overlay over replying, ${at}`);
    await closeCase(h, k, `${at} replying`, 'replying');
    await openCase(h, k, `${at} replying, again`);
    release();
    await k.page.waitForSelector('#booth [data-screen="reply"]');
    await h.sleep(400);
    h.check(await page.locator('[data-case-overlay]').count() === 1 && await k.screenNow() === 'reply',
      `${at}: the reply lands under the open case, which stays open`);
    await closeCase(h, k, `${at} reply landed`, 'reply');
    h.check(stub.of(REPLY_KEY).length === 1, `${at}: one reply request in all, the one Send made`);

    await openCase(h, k, `${at} reply`);
    await everyLook(h, k, `case overlay over the reply, ${at}`);
    await closeCase(h, k, `${at} reply`, 'reply');
    await h.screenCheck(page, `reply with Read the case again, ${at}`);

    const posts = stub.calls.filter((c) => c.key.startsWith('POST ')).length;
    await k.tap('[data-action="start-over"]');
    await page.waitForSelector('[data-leave-confirm]');
    await h.sleep(400);
    await k.tap('[data-action="leave"]');
    await k.shell('start');
    h.check(stub.calls.filter((c) => c.key.startsWith('POST ')).length === posts && stub.of('GET /booth/status').length === 2,
      `${at}: Start over still leaves the play, the page reloads to a fresh start with no POST`);
    await k.close();
  },
}));
