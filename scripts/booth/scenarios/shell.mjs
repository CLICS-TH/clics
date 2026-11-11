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
  await k.toVignette();
}

async function toLastReply(k) {
  await toVignette(k);
  await k.tap('[data-action="begin"]');
  for (let i = 0; i < 3; i++) {
    await k.screen('step');
    await k.answer(1);
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
    name: 'loop: image, video, image under the Tap-to-start bar; a tap on the media starts one play',
    async run(h) {
      const k = await h.kiosk({ files: FILES, label: 'loop' });
      const { page, stub } = k;
      await k.shell('start');
      h.check(hasBoth(await barText(page), h.COPY.tapToStart), 'loop: the bar reads "แตะเพื่อเริ่ม / Tap to start"');
      const cue = await page.evaluate(() => {
        const c = document.querySelector('.shell-tap .loop-bar .tap-cue');
        const r = c?.getBoundingClientRect();
        return { inButton: !!c?.closest('[data-action="start"]'), hidden: c?.getAttribute('aria-hidden'), w: Math.round(r?.width ?? 0),
          pulse: c ? getComputedStyle(c, '::after').animationName : null };
      });
      h.check(cue.inButton && cue.hidden === 'true' && cue.w > 0 && cue.pulse === 'tap-ring',
        `attract: the open bar draws its own pulsing tap cue, in the start button and hidden from screen readers (${JSON.stringify(cue)})`);
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
      await k.screen('teaser');
      h.check(stub.of('POST /booth/draw').length === 1 && stub.of(START).length === 0,
        `loop: a tap on the media deals exactly one case and starts no play (${stub.of('POST /booth/draw').length} draws, ${stub.of(START).length} starts)`);
      await k.tap('[data-action="start-case"]');
      await k.screen('vignette');
      h.check(stub.of(START).length === 1, `loop: a tap on the media, then "Start this case", starts exactly one play (${stub.of(START).length})`);
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
        h.check(await page.locator('#booth button:not([data-action="leaderboard"])').count() === 0 && await page.locator('.loop-bar[role="status"]').count() === 1
          && await page.locator('.tap-cue').count() === 0,
          `${mode}: no button but the leaderboard's, the bar is a status line with no tap cue`);
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
        h.check(hasBoth(await barText(page), h.COPY.tapToStart), `${mode} -> open: the Tap-to-start bar appears`);
        const log = await loopLog(page);
        h.check(log.same && inOrder(log.srcs), `${mode} -> open: the loop did not restart (same media layer, items in order: ${log.srcs.map((s) => s.split('/').pop()).join(' ')})`);
        await k.toVignette();
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
    name: 'scoring holds the idle timer; the result card waits 45 s from the last touch, overlays included, and 3 min at most',
    async run(h) {
      const k = await h.kiosk({ label: 'holds' });
      const { page, stub } = k;
      await withClock(k);
      await toLastReply(k);
      const loads = stub.of(STATUS).length;
      const release = stub.hold(SCORE_KEY);
      await k.tap('[data-action="see-score"]');
      await k.screen('scoring');
      // booth-play's own 75 s score deadline runs on the same fake clock (Playwright fakes AbortSignal.timeout), from the
      // tap, and real time keeps running: 'scoring' shows a second later and the settle waits add more on a loaded host.
      await page.clock.fastForward(70_000);
      await h.sleep(300);
      const at = await k.screenNow();
      h.check(await overlays(page) === 0 && at === 'scoring', `scoring + 70 s (under the play's 75 s deadline): no "Still there?", still scoring (on '${at}')`);
      release();
      await k.screen('scored');
      await page.clock.fastForward(44_000);
      await h.sleep(300);
      h.check(await k.screenNow() === 'scored' && stub.of(STATUS).length === loads, 'result + 44 s with no touch: still on the result card');
      await page.clock.fastForward(2_000);
      await k.shell('start');
      h.check(stub.of(STATUS).length === loads + 1, 'result + 46 s with no touch: the page reloads to the loop');
      await k.close();

      /** A touch on the card away from every button, the way a reader rests a finger on the score. */
      const touchCard = async (p) => {
        const b = await p.locator('.result-total').boundingBox();
        await p.touchscreen.tap(b.x + 8, b.y + b.height / 2);
      };
      const atResult = async (label) => {
        const r = await h.kiosk({ label });
        await withClock(r);
        await toLastReply(r);
        await r.tap('[data-action="see-score"]');
        await r.screen('scored');
        return r;
      };
      const reloaded = async (r, before) => { await r.shell('start'); return r.stub.of(STATUS).length === before + 1; };

      const t = await atResult('touch restarts');
      let before = t.stub.of(STATUS).length;
      await t.page.clock.fastForward(40_000);
      await touchCard(t.page);
      await t.page.clock.fastForward(6_000);
      await h.sleep(300);
      h.check(await t.screenNow() === 'scored' && t.stub.of(STATUS).length === before, 'a touch at 40 s: still on the result card at 46 s');
      await t.page.clock.fastForward(38_000);
      await h.sleep(300);
      h.check(await t.screenNow() === 'scored', 'a touch at 40 s: still on the result card 44 s after it');
      await t.page.clock.fastForward(2_000);
      h.check(await reloaded(t, before), 'a touch at 40 s: the page reloads 46 s after it');
      await t.close();

      const o = await atResult('overlay touch');
      before = o.stub.of(STATUS).length;
      await o.tap('[data-action="see-answers"]');
      await o.page.waitForSelector('[data-reveal-overlay]');
      await o.page.clock.fastForward(25_000);
      const title = await o.page.locator('[data-reveal-overlay] .reveal-title').boundingBox();
      await o.page.touchscreen.tap(title.x + 8, title.y + title.height / 2);
      await o.page.clock.fastForward(44_000);
      await h.sleep(300);
      h.check(await o.screenNow() === 'scored' && o.stub.of(STATUS).length === before,
        'a touch inside the answers overlay at 25 s: still on the result card at 69 s');
      await o.page.clock.fastForward(2_000);
      h.check(await reloaded(o, before), 'a touch inside the answers overlay at 25 s: the page reloads 46 s after it');
      await o.close();

      const c = await atResult('cap');
      before = c.stub.of(STATUS).length;
      for (let at = 30; at <= 150; at += 30) {
        await c.page.clock.fastForward(30_000);
        await touchCard(c.page);
      }
      await c.page.clock.fastForward(29_000);
      await h.sleep(300);
      h.check(await c.screenNow() === 'scored' && c.stub.of(STATUS).length === before, 'a touch every 30 s: still on the result card at 179 s');
      await c.page.clock.fastForward(2_000);
      h.check(await reloaded(c, before), 'a touch every 30 s: the page reloads at 3 min from the result all the same');
      await c.close();
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
    name: 'offline cache: the case of a play started is kept under its own path, and offline the kiosk shows the loop with no way to start',
    async run(h) {
      const k = await h.kiosk({ files: FILES, label: 'case offline' });
      const { page, stub } = k;
      const path = `/booth-case/${h.DRAW.case_id}.json`;
      await k.shell('start');
      const missing = await cached(k);
      if (!h.check(missing.length === 0, `case: the offline cache is ready${missing.length ? ` (missing ${missing.join(', ')})` : ''}`)) return;
      await toVignette(k);
      const readCase = () => page.evaluate(async (p) => {
        const res = await caches.match(p);
        return res ? res.json() : null;
      }, path);
      let kase = await readCase();
      for (let i = 0; i < 40 && !kase; i++) { await h.sleep(250); kase = await readCase(); }
      h.check(h.same(kase, h.KASE), `case: the case the play started with is in the booth cache at ${path}`);
      h.check(await page.evaluate(async () => !(await caches.match('/booth-case.json'))), 'case: nothing is kept at the old single-case path');
      await k.offline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await k.shell('offline');
      const served = await page.evaluate(async (p) => {
        const res = await fetch(p);
        return res.ok ? res.json() : res.status;
      }, path);
      h.check(h.same(served, h.KASE), `case, offline reload: GET ${path} serves the case from the cache`);
      h.check(await page.locator('[data-action="start"]').count() === 0 && hasBoth(await barText(page), h.COPY.offline),
        'case, offline reload: the offline bar shows and there is no Tap-to-try (a play needs the server to start and to score)');
      h.check(stub.of(START).length === 1, `case, offline reload: no play was started offline (${stub.of(START).length} starts in all)`);
      await k.close();
    },
  },
  {
    name: 'offline cache: two plays on two cases keep both, each under its own path, and a case never played is 404 offline',
    async run(h) {
      const second = { case_id: 'second-case', teaser: { th: 'หญิงอายุ 30 ปี ปวดท้องมา 2 วัน', en: 'A 30-year-old woman with abdominal pain for 2 days' } };
      const secondCase = { vignette: { th: 'หญิงอายุ 30 ปี ปวดท้องมา 2 วัน และคลื่นไส้', en: 'A 30-year-old woman with abdominal pain for 2 days and nausea' } };
      const stub = h.makeStub({ routes: {
        'POST /booth/draw': (_call, calls) => ({ status: 200, body: calls.filter((c) => c.key === 'POST /booth/draw').length === 1 ? h.DRAW : second }),
        'POST /booth/plays': (call) => ({ status: 201, body: { ...h.START, case: call.body.case_id === second.case_id ? secondCase : h.KASE } }),
      } });
      const k = await h.kiosk({ files: FILES, stub, label: 'two cases offline' });
      const { page } = k;
      await k.shell('start');
      const missing = await cached(k);
      if (!h.check(missing.length === 0, `two cases: the offline cache is ready${missing.length ? ` (missing ${missing.join(', ')})` : ''}`)) return;
      const path = (c) => `/booth-case/${c.case_id}.json`;
      const kept = (c) => page.evaluate(async (p) => (await (await caches.match(p))?.json()) ?? null, path(c));
      const waitKept = async (c, want) => {
        for (let i = 0; i < 40 && !h.same(await kept(c), want); i++) await h.sleep(250);
        return kept(c);
      };
      await toVignette(k);
      h.check(h.same(await waitKept(h.DRAW, h.KASE), h.KASE), `two cases: the first case is kept at ${path(h.DRAW)}`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await toVignette(k);
      h.check(h.same(await waitKept(second, secondCase), secondCase), `two cases: the second case is kept at ${path(second)}`);
      h.check(h.same(await kept(h.DRAW), h.KASE), 'two cases: the first case is still kept after the second');
      await k.offline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await k.shell('offline');
      const fetched = (p) => page.evaluate(async (u) => {
        try {
          const res = await fetch(u);
          return res.ok ? await res.json() : res.status;
        } catch {
          return 'failed';
        }
      }, p);
      h.check(h.same(await fetched(path(h.DRAW)), h.KASE) && h.same(await fetched(path(second)), secondCase),
        'two cases, offline reload: both are served from the cache, each its own');
      h.check(await fetched('/booth-case/never-played.json') === 404, 'two cases, offline reload: a case never played is 404');
      const notServed = (v) => v === 404 || v === 'failed';
      h.check(notServed(await fetched('/booth-case/Not_An_Id.json')) && notServed(await fetched('/booth-case.json')),
        'two cases, offline reload: a path that is not a case id, and the old single-case path, are not served');
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
      await k.answer(1);
      await k.screen('stopped');
      h.check(hasBoth(await page.locator('#booth').innerText(), h.COPY.stoppedOffline), 'mid-play: "The connection was lost", TH and EN');
      await k.shell('offline', 15_000);
      h.check(hasBoth(await barText(page), h.COPY.offline), 'mid-play: after the reset the loop is back with the offline bar');
      await k.close();
    },
  },
];
