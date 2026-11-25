// Full screen (owner, 2026-11-25): staff start it from the loop's pill; a full-screen kiosk starts over in the page, so
// full screen holds from one visitor to the next; Exit shows only after a tap on the mark and then on the look control.
const STATUS = 'GET /booth/status';
const WAIT = { timeout: 10_000 };

const full = (page) => page.evaluate(() => Boolean(document.fullscreenElement));
const visible = (page, selector) => page.locator(selector).isVisible();
const lookNow = (page) => page.evaluate(() => document.documentElement.dataset.look ?? null);
/** A mark on the window that only a reload clears. */
const mark = (page) => page.evaluate(() => { window.fsSameDocument = true; });
const sameDocument = (page) => page.evaluate(() => window.fsSameDocument === true);
const box = (page, selector) => page.locator(selector).boundingBox();
const apart = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

async function goFull(h, k, label) {
  await k.shell('start');
  await k.tap('.fs-enter');
  await k.page.waitForFunction(() => Boolean(document.fullscreenElement), null, WAIT).catch(() => {});
  h.check(await full(k.page), `${label}: Full screen on the loop puts the page in full screen`);
  h.check(!(await visible(k.page, '.fs-enter')), `${label}: in full screen the Full screen pill is gone`);
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
    name: 'full screen: under the booth launcher (Chrome --kiosk, the page fills its screen) the loop shows no Full screen pill',
    async run(h) {
      const k = await h.kiosk({ label: 'full screen under --kiosk' });
      await k.shell('start');
      h.check(await k.page.locator('.fs-enter').count() === 1 && !(await visible(k.page, '.fs-enter')),
        'a page that fills its screen has the pill mounted but hidden');
      await k.close();
    },
  },
  {
    name: 'full screen: the loop offers Full screen beside the mark; a play\'s Finish and an idle reset start over in the page and stay full screen',
    async run(h) {
      for (const [width, height] of [[1080, 1920], [2160, 3840]]) {
        const label = `full screen ${width}x${height}`;
        // A windowed kiosk: the screen is taller than the page by a browser's toolbar.
        const k = await h.kiosk({ width, height, label, screen: { width, height: height + 120 } });
        const { page, stub } = k;
        await page.clock.install();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await k.shell('start');
        const [enter, brand, look] = await Promise.all(['.fs-enter', '[data-booth-brand]', '[data-look-control]'].map((s) => box(page, s)));
        const text = await page.locator('.fs-enter').innerText();
        h.check(Boolean(enter) && apart(enter, brand) && apart(enter, look) && enter.y < brand.y + brand.height,
          `${label}: the Full screen pill sits in the corner row between the mark and the look control (${JSON.stringify({ enter, brand, look })})`);
        h.check(text.includes('เต็มจอ'), `${label}: the pill reads เต็มจอ (${text})`);
        await h.screenCheck(page, `${label} loop with Full screen`);
        await h.shot(page, `fullscreen-enter-${width}`);
        await mark(page);
        await goFull(h, k, label);

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
        await k.close();
      }
    },
  },
  {
    name: 'full screen: Exit shows only after a tap on the mark then on the look control within 3 s, for 6 s',
    async run(h) {
      const label = 'full screen exit';
      const k = await h.kiosk({ label, screen: { width: 1080, height: 2040 } });
      const { page } = k;
      await page.clock.install();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await goFull(h, k, label);

      const before = await lookNow(page);
      await k.tap('[data-look-control] [data-look-both]');
      h.check(await lookNow(page) !== before && !(await visible(page, '.fs-exit')), 'the look control alone changes the look and shows no Exit');
      await k.tap('[data-look-control] [data-look-both]');

      await k.tap('[data-booth-brand]');
      h.check(await page.locator('#booth[data-shell="start"]').count() === 1, 'a tap on the mark starts no play');
      const armed = await lookNow(page);
      await k.tap('[data-look-control] [data-look-primary="en"]');
      h.check(await visible(page, '.fs-exit') && await lookNow(page) === armed, 'the mark, then the look control: Exit shows and the look is unchanged');
      const exitBox = await box(page, '.fs-exit');
      const lookBox = await box(page, '[data-look-control]');
      h.check(apart(exitBox, lookBox), `Exit sits clear of the look control (${JSON.stringify(exitBox)})`);
      await h.screenCheck(page, 'full screen with Exit');
      await h.shot(page, 'fullscreen-exit');
      await page.clock.fastForward(6_100);
      await h.sleep(100);
      h.check(!(await visible(page, '.fs-exit')), 'Exit hides again after 6 s');

      await k.tap('[data-booth-brand]');
      await page.clock.fastForward(3_500);
      await k.tap('[data-look-control] [data-look-primary="en"]');
      h.check(!(await visible(page, '.fs-exit')) && await lookNow(page) !== armed, 'more than 3 s after the mark, the look control only changes the look');

      await k.tap('[data-booth-brand]');
      await k.tap('[data-look-control] [data-look-primary="th"]');
      await k.tap('.fs-exit');
      await page.waitForFunction(() => !document.fullscreenElement, null, WAIT).catch(() => {});
      h.check(!(await full(page)) && await visible(page, '.fs-enter') && !(await visible(page, '.fs-exit')),
        'Exit leaves full screen and the Full screen pill is back');
      await k.close();
    },
  },
];
