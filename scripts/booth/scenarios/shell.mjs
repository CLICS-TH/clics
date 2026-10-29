import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const SLIDE_A = '/booth-loop/slide-a.png';
const CLIP = '/booth-loop/clip.mp4';
// A staff file name with Thai and a space: the manifest lists it as named, the browser sends it encoded.
const SLIDE_B = new URL('/booth-loop/ผลฟอรั่ม 2026.png', 'http://x').pathname;
const ORDER = [SLIDE_A, CLIP, SLIDE_B];
const FILES = {
  '/booth-loop/manifest.json': fixture('manifest.json'),
  [SLIDE_A]: fixture('loop-slide.png'),
  [SLIDE_B]: fixture('loop-slide.png'),
  [CLIP]: fixture('loop-clip.mp4'),
};
const STATUS = 'GET /booth/status';
const START = 'POST /booth/plays';
const SCORE_KEY = 'POST /booth/plays/:id/score';
const WAIT = { timeout: 10_000 };

const barText = (page) => page.locator('.loop-bar').innerText({ timeout: 5000 });
const hasBoth = (text, pair) => text.includes(pair.th) && text.includes(pair.en);
const overlays = (page) => page.locator('.still-there').count();
const waitSrc = (page, src) => page.waitForFunction((s) => document.querySelector('.loop-media')?.dataset.loopSrc === s, src, WAIT);
const videoPlays = (page) => page.waitForFunction(() => {
  const v = document.querySelector('.loop-media video');
  return !!v && v.currentTime > 0 && !v.error;
}, null, WAIT).then(() => true, () => false);
const stored = (page) => page.evaluate(async () => ({
  local: localStorage.length, session: sessionStorage.length, idb: (await indexedDB.databases()).length,
}));

/** Install the fake clock, then reload so every timer the shell sets is on it. */
async function withClock(k) {
  await k.page.clock.install();
  await k.page.reload({ waitUntil: 'domcontentloaded' });
}

async function toVignette(k) {
  await k.shell('start');
  await k.tap('[data-action="start"]');
  await k.screen('vignette');
}

async function toLastReply(k) {
  await toVignette(k);
  await k.tap('[data-action="begin"]');
  for (let i = 0; i < 3; i++) {
    await k.screen('step');
    await k.tap('[data-option="a"]');
    await k.screen('reply');
    if (i < 2) await k.tap('[data-action="next"]');
  }
}

/** Records each data-loop-src the media layer shows, and marks the layer element itself. */
const recordLoop = (page) => page.evaluate(() => {
  const layer = document.querySelector('.loop-media');
  window.boothLayer = layer;
  window.boothSrcs = layer.dataset.loopSrc ? [layer.dataset.loopSrc] : [];
  new MutationObserver(() => {
    const s = layer.dataset.loopSrc;
    if (s && s !== window.boothSrcs.at(-1)) window.boothSrcs.push(s);
  }).observe(layer, { attributes: true, attributeFilter: ['data-loop-src'] });
});
const loopLog = (page) => page.evaluate(() => ({ same: document.querySelector('.loop-media') === window.boothLayer, srcs: window.boothSrcs }));
const inOrder = (srcs) => srcs.every((s, i) => i === 0 || ORDER.indexOf(s) === (ORDER.indexOf(srcs[i - 1]) + 1) % ORDER.length);

/** Wait until the service worker controls the page and its cache holds the page and every loop file. */
async function cached(k) {
  const want = ['/booth', '/booth-loop/manifest.json', ...ORDER];
  for (let i = 0; i < 60; i++) {
    const missing = await k.page.evaluate(async (urls) => {
      if (!navigator.serviceWorker.controller) return ['(no controller)'];
      const out = [];
      for (const u of urls) if (!(await caches.match(u))) out.push(u);
      return out;
    }, want);
    if (!missing.length) return [];
    if (i === 59) return missing;
    await new Promise((r) => setTimeout(r, 250));
  }
  return want;
}

export default [
  {
    name: 'loop: image, video, image under the Tap-to-try bar; a tap on the media starts one play',
    async run(h) {
      const k = await h.kiosk({ files: FILES, label: 'loop' });
      const { page, stub } = k;
      await k.shell('start');
      h.check(hasBoth(await barText(page), h.COPY.tapToTry), 'loop: the bar reads "แตะเพื่อลอง CLICS / Tap to try CLICS"');
      await waitSrc(page, SLIDE_A);
      h.check(await page.locator('.loop-media[data-loop-kind="image"] img[alt=""]').count() === 1, 'loop: the first item is the image, with alt=""');
      await h.screenCheck(page, 'loop, open');
      await h.shot(page, 'loop-open');
      await waitSrc(page, CLIP);
      h.check(await videoPlays(page), 'loop: the video plays (currentTime > 0, no error)');
      const attrs = await page.locator('.loop-media video').evaluate((v) => ({ muted: v.muted, inline: v.playsInline, autoplay: v.autoplay }));
      h.check(attrs.muted && attrs.inline && attrs.autoplay, `loop: the video is muted, playsinline, autoplay (${JSON.stringify(attrs)})`);
      await waitSrc(page, SLIDE_B);
      h.check(true, 'loop: after the video ends the loop moves on to the next image');
      await waitSrc(page, SLIDE_A);
      h.check(true, 'loop: invalid manifest items are skipped and the loop wraps to the first item');

      const stage = await page.locator('.loop-stage').boundingBox();
      const x = stage.x + stage.width / 2;
      const y = stage.y + stage.height * 0.3;
      h.check(await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('[data-action="start"]'), [x, y]),
        'loop: the media area is inside the start button');
      h.check(await page.evaluate(() => {
        const slot = document.querySelector('.loop-stage [data-booth-slot="loop-board"]');
        return !!slot && slot.closest('.loop-stage').compareDocumentPosition(document.querySelector('.shell-tap')) === Node.DOCUMENT_POSITION_FOLLOWING;
      }), 'loop: the loop-board slot sits in the stage, under the start button, so a tap on the board starts a play too');
      await page.touchscreen.tap(x, y);
      await k.screen('vignette');
      h.check(stub.of(START).length === 1, `loop: a tap on the media starts exactly one play (${stub.of(START).length})`);
      await k.close();
    },
  },
  {
    name: 'closed and offline bars keep the loop playing, and a later status check opens the booth',
    async run(h) {
      for (const mode of ['closed', 'offline']) {
        let down = true;
        const stub = h.makeStub({ routes: {
          [STATUS]: () => {
            if (!down) return { status: 200, body: { open: true } };
            return mode === 'closed' ? { status: 200, body: { open: false, reason: 'off' } } : 'abort';
          },
        } });
        const k = await h.kiosk({ stub, files: FILES, label: mode });
        const { page } = k;
        await withClock(k);
        await k.shell(mode);
        h.check(hasBoth(await barText(page), mode === 'closed' ? h.COPY.closed : h.COPY.offline), `${mode}: the bar says so, TH and EN`);
        h.check(await page.locator('button').count() === 0 && await page.locator('.loop-bar[role="status"]').count() === 1,
          `${mode}: no button, the bar is a status line`);
        await recordLoop(page);
        await page.waitForFunction(() => window.boothSrcs.length >= 3, null, WAIT);
        h.check(true, `${mode}: the loop keeps advancing items`);
        await h.screenCheck(page, `${mode} loop`);
        await h.shot(page, `loop-${mode}`);

        const before = stub.of(STATUS).length;
        down = false;
        await page.clock.fastForward(31_000);
        await k.shell('start');
        h.check(stub.of(STATUS).length === before + 1, `${mode}: the status is checked again after 30 s (${before} -> ${stub.of(STATUS).length} calls)`);
        h.check(hasBoth(await barText(page), h.COPY.tapToTry), `${mode} -> open: the Tap-to-try bar appears`);
        const log = await loopLog(page);
        h.check(log.same && inOrder(log.srcs), `${mode} -> open: the loop did not restart (same media layer, items in order: ${log.srcs.map((s) => s.split('/').pop()).join(' ')})`);
        await k.tap('[data-action="start"]');
        await k.screen('vignette');
        h.check(stub.of(START).length === 1, `${mode} -> open: a tap starts a play`);
        await k.close();
      }
    },
  },
  {
    name: '"Still there?" after 90 s idle: ghost taps ignored, a tap keeps going, 15 s more resets with nothing stored',
    async run(h) {
      const k = await h.kiosk({ label: 'still there' });
      const { page, stub } = k;
      await withClock(k);
      await toVignette(k);
      const loads = stub.of(STATUS).length;
      const begin = await page.locator('[data-action="begin"]').boundingBox();
      const at = [begin.x + begin.width / 2, begin.y + begin.height / 2];

      await page.clock.fastForward(89_000);
      await h.sleep(200);
      h.check(await overlays(page) === 0, 'idle 89 s: no overlay yet');
      await page.clock.fastForward(2_000);
      await page.waitForSelector('.still-there', WAIT);
      const a11y = await page.evaluate(() => ({ role: document.querySelector('.still-there').getAttribute('role'), focus: document.activeElement?.dataset.action }));
      await page.touchscreen.tap(...at);
      await h.sleep(150);
      h.check(await overlays(page) === 1 && await k.screenNow() === 'vignette', 'a tap within 350 ms of the overlay appearing does nothing');
      const shown = await page.locator('.still-there').innerText();
      h.check(hasBoth(shown, h.COPY.stillThere) && /1[45]/.test(shown)
        && shown.includes(h.COPY.stillThereCount.th.split('{n}')[0]) && shown.includes(h.COPY.stillThereCount.en.split('{n}')[0]),
        'idle 91 s: "Still there?" with a 15 s countdown, TH and EN');
      h.check(a11y.role === 'alertdialog' && a11y.focus === 'keep-going', `the overlay is an alertdialog with focus on "keep going" (${JSON.stringify(a11y)})`);
      await h.screenCheck(page, 'still there');
      await h.shot(page, 'still-there');

      await h.sleep(400);
      await page.touchscreen.tap(...at);
      await h.sleep(500);
      h.check(await overlays(page) === 0 && await k.screenNow() === 'vignette', 'a later tap on the scrim dismisses it and the play stays on the vignette');
      await page.clock.fastForward(89_000);
      await h.sleep(200);
      h.check(await overlays(page) === 0, 'dismissed: the 90 s idle timer starts again');
      await page.clock.fastForward(2_000);
      await page.waitForSelector('.still-there', WAIT);
      h.check(true, 'idle 91 s again: the overlay is back');
      await h.sleep(400);
      await page.clock.fastForward(1_000);
      const line = await page.locator('.still-count').boundingBox();
      await page.touchscreen.tap(line.x + line.width / 2, line.y + line.height / 2);
      await h.sleep(300);
      h.check(await overlays(page) === 0, 'a tap on the countdown line just after it ticks still dismisses the overlay');
      await page.clock.fastForward(91_000);
      await page.waitForSelector('.still-there', WAIT);
      await page.clock.fastForward(16_000);
      await k.shell('start');
      h.check(stub.of(STATUS).length === loads + 1, 'the countdown ends in a page reload to the loop');
      const s = await stored(page);
      h.check(s.local === 0 && s.session === 0 && s.idb === 0, `after the reset: localStorage, sessionStorage and IndexedDB are empty (${JSON.stringify(s)})`);
      await k.close();
    },
  },
  {
    name: 'scoring holds the idle timer; the result card returns to the loop after 45 s',
    async run(h) {
      const k = await h.kiosk({ label: 'holds' });
      const { page, stub } = k;
      await withClock(k);
      await toLastReply(k);
      const loads = stub.of(STATUS).length;
      const release = stub.hold(SCORE_KEY);
      await k.tap('[data-action="see-score"]');
      await k.screen('scoring');
      // booth-play's own 75 s score deadline runs on the same fake clock (Playwright fakes AbortSignal.timeout).
      await page.clock.fastForward(74_000);
      await h.sleep(300);
      h.check(await overlays(page) === 0 && await k.screenNow() === 'scoring', 'scoring + 74 s (under the play\'s 75 s deadline): no "Still there?", still scoring');
      release();
      await k.screen('scored');
      await page.clock.fastForward(44_000);
      await h.sleep(300);
      h.check(await k.screenNow() === 'scored' && stub.of(STATUS).length === loads, 'result + 44 s: still on the result card');
      await page.clock.fastForward(2_000);
      await k.shell('start');
      h.check(stub.of(STATUS).length === loads + 1, 'result + 46 s: the page reloads to the loop');
      await k.close();
    },
  },
  {
    name: 'offline: after one online load the loop plays with the network off',
    async run(h) {
      const k = await h.kiosk({ files: FILES, label: 'offline loop' });
      const { page } = k;
      await k.shell('start');
      const missing = await cached(k);
      if (!h.check(missing.length === 0, `the service worker controls the page and cached the page, manifest and loop files${missing.length ? ` (missing ${missing.join(', ')})` : ''}`)) return;
      await k.offline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await k.shell('offline');
      h.check(hasBoth(await barText(page), h.COPY.offline), 'offline reload: the page renders with the offline bar, TH and EN');
      await waitSrc(page, SLIDE_A);
      h.check(true, 'offline reload: the loop shows the image');
      await waitSrc(page, CLIP);
      h.check(await videoPlays(page), 'offline reload: the video plays from the cache');
      await h.screenCheck(page, 'offline loop');
      await k.close();
    },
  },
  {
    name: 'offline cache: a loop file replaced under the same name, and a file dropped from the manifest, reach a kiosk that cached them',
    async run(h) {
      const files = { ...FILES };
      const k = await h.kiosk({ files, label: 'same-name refresh' });
      const { page } = k;
      await k.shell('start');
      const missing = await cached(k);
      if (!h.check(missing.length === 0, `refresh: the first load cached the loop${missing.length ? ` (missing ${missing.join(', ')})` : ''}`)) return;
      files[SLIDE_A] = fixture('loop-slide-recut.png');
      files['/booth-loop/manifest.json'] = fixture('manifest-trimmed.json');
      const recut = statSync(files[SLIDE_A]).size;
      const state = () => page.evaluate(async ([a, b]) => ({
        bytes: (await (await caches.match(a))?.arrayBuffer())?.byteLength ?? 0,
        dropped: !(await caches.match(b)),
      }), [SLIDE_A, SLIDE_B]);
      let now = await state();
      for (let i = 0; i < 60 && !(now.bytes === recut && now.dropped); i++) { await h.sleep(250); now = await state(); }
      h.check(now.bytes === recut, `refresh: the cache now holds the file replaced under ${SLIDE_A} (${now.bytes} bytes, the new cut is ${recut})`);
      h.check(now.dropped, 'refresh: the file the manifest no longer lists is gone from the cache');
      await k.offline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await k.shell('offline');
      await waitSrc(page, SLIDE_A);
      const width = await page.locator('.loop-media img').evaluate((img) => img.naturalWidth);
      h.check(width === 54, `refresh, offline reload: the loop shows the new cut (naturalWidth ${width}, the new cut is 54, the old 108)`);
      await k.close();
    },
  },
  {
    name: 'offline cache: the case of the last play started is kept, and offline the kiosk shows the loop with no way to start',
    async run(h) {
      const k = await h.kiosk({ files: FILES, label: 'case offline' });
      const { page, stub } = k;
      await k.shell('start');
      const missing = await cached(k);
      if (!h.check(missing.length === 0, `case: the offline cache is ready${missing.length ? ` (missing ${missing.join(', ')})` : ''}`)) return;
      await toVignette(k);
      const readCase = () => page.evaluate(async () => {
        const res = await caches.match('/booth-case.json');
        return res ? res.json() : null;
      });
      let kase = await readCase();
      for (let i = 0; i < 40 && !kase; i++) { await h.sleep(250); kase = await readCase(); }
      h.check(h.same(kase, h.KASE), 'case: the case the play started with is in the booth cache');
      await k.offline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await k.shell('offline');
      const served = await page.evaluate(async () => {
        const res = await fetch('/booth-case.json');
        return res.ok ? res.json() : res.status;
      });
      h.check(h.same(served, h.KASE), 'case, offline reload: GET /booth-case.json serves the case from the cache');
      h.check(await page.locator('[data-action="start"]').count() === 0 && hasBoth(await barText(page), h.COPY.offline),
        'case, offline reload: the offline bar shows and there is no Tap-to-try (a play needs the server to start and to score)');
      h.check(stub.of(START).length === 1, `case, offline reload: no play was started offline (${stub.of(START).length} starts in all)`);
      await k.close();
    },
  },
  {
    name: 'a network failure mid-play stops the play and returns to the loop with the offline bar',
    async run(h) {
      const k = await h.kiosk({ files: FILES, label: 'mid-play failure' });
      const { page } = k;
      await k.shell('start');
      const missing = await cached(k);
      if (!h.check(missing.length === 0, `mid-play: the offline cache is ready${missing.length ? ` (missing ${missing.join(', ')})` : ''}`)) return;
      await toVignette(k);
      await k.tap('[data-action="begin"]');
      await k.screen('step');
      await k.offline(true);
      await k.tap('[data-option="a"]');
      await k.screen('stopped');
      h.check(hasBoth(await page.locator('#booth').innerText(), h.COPY.stoppedOffline), 'mid-play: "The connection was lost", TH and EN');
      await k.shell('offline', 15_000);
      h.check(hasBoth(await barText(page), h.COPY.offline), 'mid-play: after the reset the loop is back with the offline bar');
      await k.close();
    },
  },
];
