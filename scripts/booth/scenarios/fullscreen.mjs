// Full screen (owner, 2026-11-25): CCME's mark is the switch, a tap to go full screen and a tap to leave it. A full-screen
// kiosk starts over in the page, so full screen holds from one visitor to the next.
const STATUS = 'GET /booth/status';
const WAIT = { timeout: 10_000 };

const full = (page) => page.evaluate(() => Boolean(document.fullscreenElement));
const visible = (page, selector) => page.locator(selector).isVisible();
const lookNow = (page) => page.evaluate(() => document.documentElement.dataset.look ?? null);
/** A mark on the window that only a reload clears. */
const mark = (page) => page.evaluate(() => { window.fsSameDocument = true; });
const sameDocument = (page) => page.evaluate(() => window.fsSameDocument === true);

const brandLabel = (page) => page.locator('[data-booth-brand]').getAttribute('aria-label');

async function goFull(h, k, label) {
  await k.shell('start');
  h.check((await brandLabel(k.page))?.includes('Full screen'), `${label}: the mark is named as the Full screen switch`);
  await k.tap('[data-booth-brand]');
  await k.page.waitForFunction(() => Boolean(document.fullscreenElement), null, WAIT).catch(() => {});
  h.check(await full(k.page) && await k.page.locator('#booth[data-shell="start"]').count() === 1,
    `${label}: a tap on the mark puts the page in full screen and starts no play`);
}

async function toScored(k) {
  await k.tap('[data-action="start"]');
  await k.screen('teaser');
  await k.tap('[data-action="start-case"]');
  await k.screen('vignette');
  await k.tap('[data-action="begin"]');
  for (let i = 0; i < 3; i++) {
    await k.screen('step');
    await k.answer(1);
    await k.screen('reply');
    await k.tap(`[data-action="${i < 2 ? 'next' : 'see-score'}"]`);
  }
  await k.screen('scored');
}

export default [
  {
    name: 'full screen: under the booth launcher (Chrome --kiosk, the page fills its screen) the mark is no switch',
    async run(h) {
      const label = 'full screen under --kiosk';
      const k = await h.kiosk({ label });
      await k.shell('start');
      h.check(await k.page.locator('[data-booth-brand]').isDisabled(), 'a page that fills its screen leaves the mark disabled');
      await k.close();
    },
  },
  {
    name: 'full screen: a tap on the mark goes full screen; Finish and an idle reset start over in the page and stay full screen; a tap on the mark leaves',
    async run(h) {
      for (const [width, height] of [[1080, 1920], [2160, 3840]]) {
        const label = `full screen ${width}x${height}`;
        // A windowed kiosk: the screen is taller than the page by a browser's toolbar.
        const k = await h.kiosk({ width, height, label, screen: { width, height: height + 120 } });
        const { page, stub } = k;
        await page.clock.install();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await k.shell('start');
        await h.screenCheck(page, `${label} loop`);
        await mark(page);
        await goFull(h, k, label);
        h.check((await brandLabel(page))?.includes('Exit full screen'), `${label}: in full screen the mark is named as Exit full screen`);

        await toScored(k);
        await k.shell('done');
        await k.tap('[data-action="done"]');
        await k.shell('invite');
        await k.tap('[data-look-control] [data-look-primary="en"]');
        h.check(await lookNow(page) !== h.DEFAULT_LOOK, `${label}: the visitor picked another look`);
        const loads = stub.of(STATUS).length;
        await k.tap('[data-action="finish"]');
        await k.shell('start');
        h.check(await sameDocument(page) && await full(page), `${label}: Finish starts over in the page, still full screen`);
        h.check(await lookNow(page) === h.DEFAULT_LOOK && stub.of(STATUS).length === loads + 1,
          `${label}: the loop is back at ${h.DEFAULT_LOOK} and checks the booth status again, as a reload would`);
        h.check(await page.locator('#booth .booth-stage, #booth .invite-card').count() === 0, `${label}: nothing of the last play is left in #booth`);

        // An idle play: "Still there?" at 90 s, its 15 s countdown, then the loop, still full screen.
        await k.tap('[data-action="start"]');
        await k.screen('teaser');
        await k.tap('[data-action="start-case"]');
        await k.screen('vignette');
        h.check(!(await visible(page, '[data-booth-brand]')), `${label}: during a play the mark is hidden: no tap mid-play leaves full screen`);
        await page.clock.fastForward(91_000);
        await page.waitForSelector('.still-there', WAIT);
        await page.clock.fastForward(16_000);
        await k.shell('start');
        h.check(await sameDocument(page) && await full(page), `${label}: an idle reset starts over in the page, still full screen`);
        // The dead play's timers must not reach the next visitor.
        await page.clock.fastForward(200_000);
        await h.sleep(300);
        h.check(await page.locator('.still-there').count() === 0 && await page.locator('#booth[data-shell="start"]').count() === 1,
          `${label}: 200 s later the loop is still up, with no "Still there?" from the last play`);
        await h.shot(page, `fullscreen-loop-${width}`);

        await k.tap('[data-booth-brand]');
        await page.waitForFunction(() => !document.fullscreenElement, null, WAIT).catch(() => {});
        h.check(!(await full(page)) && await page.locator('#booth[data-shell="start"]').count() === 1,
          `${label}: a second tap on the mark leaves full screen and starts no play`);
        h.check(await page.locator('[data-booth-brand]').isEnabled() && (await brandLabel(page))?.includes('Full screen'),
          `${label}: out of full screen the mark is the Full screen switch again`);
        // The browser's toolbar comes back: the column follows the shorter page instead of keeping the full screen's.
        await page.setViewportSize({ width, height: height - 120 });
        await h.sleep(300);
        const col = await page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--col')));
        h.check(Math.abs(col - Math.min(width, (height - 120) * 9 / 16)) < 1,
          `${label}: after leaving full screen the column re-fits the shorter page (${col}px)`);
        await k.close();
      }
    },
  },
];
