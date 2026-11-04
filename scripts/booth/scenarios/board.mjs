import { fileURLToPath } from 'node:url';

const SCORE_KEY = 'POST /booth/plays/:id/score';
const BOARD_KEY = 'GET /booth/board';
// A fixture loop whose items all allow the board, so these scenarios do not depend on the shipped manifest,
// whose promo hides the board.
const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const LOOP_FILES = {
  '/booth-loop/manifest.json': fixture('manifest-trimmed.json'),
  '/booth-loop/slide-a.png': fixture('loop-slide.png'),
  '/booth-loop/clip.mp4': fixture('loop-clip.mp4'),
};
const TAG_ICONS = ['flag', 'shield', 'clock', 'message', 'folder', 'clipboard', 'paperclip', 'eye', 'check',
  'checkCircle', 'hourglass', 'help'];

const at = (min) => new Date(Date.UTC(2026, 10, 3, 2, min)).toISOString();
const entries = (tags, top) => tags.map((tag, i) => ({ tag, score: top - i * 3.4, at: at(i) }));
const BOARD = {
  today: entries([7, 19, 42, 3, 25, 11, 30, 8, 14, 2], 91.2),
  event: entries([101, 7, 88, 19, 42, 3, 25, 64, 11, 30], 96.6),
};
const RANKED = (h) => ({ ...h.SCORED, rank_today: 3, rank_event: 5, board: BOARD });

async function toResult(k) {
  await k.shell('start');
  await k.toVignette();
  await k.tap('[data-action="begin"]');
  for (let n = 1; n <= 3; n++) {
    await k.screen('step');
    await k.answer(1);
    await k.screen('reply');
    await k.tap(`[data-action="${n === 3 ? 'see-score' : 'next'}"]`);
  }
  await k.screen('scored');
}

const rowsOf = (page, list) => page.$$eval(`[data-board] .board-list:nth-of-type(${list}) .board-row`, (els) => els.map((e) => ({
  rank: e.querySelector('.board-rank').textContent, tag: e.querySelector('.board-tag').textContent,
  score: e.querySelector('.board-score').textContent, icon: e.querySelector('.booth-icon')?.dataset.icon,
  drawn: !!e.querySelector('.booth-icon svg'), mine: e.getAttribute('aria-current') === 'true',
})));

const expectRows = (list, mine) => list.map((e, i) => ({
  rank: String(i + 1), tag: `Booth #${String(e.tag).padStart(3, '0')}`, score: String(Math.round(e.score)),
  icon: TAG_ICONS[(e.tag * 7) % TAG_ICONS.length], drawn: true, mine: e.tag === mine,
}));

export default [
  {
    name: 'result card: the tag with its icon and the ranks; the board (today and the event) opens from the leaderboard button, QR off by default',
    async run(h) {
      const stub = h.makeStub({ routes: { [SCORE_KEY]: () => ({ status: 200, body: RANKED(h) }), [BOARD_KEY]: () => ({ status: 200, body: { board: BOARD } }) } });
      const k = await h.kiosk({ stub });
      const { page } = k;
      await toResult(k);
      await h.screenCheck(page, 'result card with ranks', { demo: true });
      h.check(await page.locator('.result-card [data-board]').count() === 0, 'result: the board is not inline on the card, the button opens it');
      await k.tap('.result-card [data-action="leaderboard"]');
      await page.waitForSelector('[data-board-overlay] [data-board]');
      await h.screenCheck(page, 'result leaderboard overlay', { demo: true });
      await h.shot(page, 'result-board');
      const tag = await page.locator('.result-card .booth-tag').evaluate((e) => ({
        text: e.textContent, icon: e.querySelector('.booth-icon')?.dataset.icon, drawn: !!e.querySelector('.booth-icon svg'),
      }));
      h.check(tag.text === 'Booth #042' && tag.icon === TAG_ICONS[(42 * 7) % TAG_ICONS.length] && tag.drawn,
        `result: "Booth #042" with its icon from the Portal set (${JSON.stringify(tag)})`);
      const ranks = await page.$$eval('.result-card .rank', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
      h.check(ranks.length === 2 && ranks[0].includes('อันดับของคุณวันนี้') && ranks[0].includes('Your rank today') && ranks[0].endsWith('#3')
        && ranks[1].includes('Your rank for the event') && ranks[1].endsWith('#5'), `result: today's rank #3 and the event's rank #5 (${ranks.join(' | ')})`);
      h.check(h.same(await rowsOf(page, 1), expectRows(BOARD.today, 42)), 'board: top 10 today in order, each with rank, icon, tag and whole score; the visitor\'s row marked');
      h.check(h.same(await rowsOf(page, 2), expectRows(BOARD.event, 42)), 'board: top 10 for the event in order');
      const label = await page.locator('[data-board] [data-demo-label]').innerText().catch(() => '');
      h.check(label.includes(h.DEMO_LABEL.th) && label.includes(h.DEMO_LABEL.en), 'board: the panel carries the demo label, TH and EN');
      h.check(await page.locator('[data-board] button, [data-board] a').count() === 0, 'board: no controls in the panel');
      h.check(await page.locator('[data-board-overlay] button').count() === 1, 'board: the overlay has one control, Close');
      h.check(await page.locator('[data-landing-qr]').count() === 0, 'QR: hidden while js/config.js leaves it off');
      await h.sleep(500);
      await k.tap('[data-board-overlay] [data-action="close-board"]');
      h.check(await page.locator('[data-board-overlay]').count() === 0 && await k.screenNow() === 'scored', 'board: Close returns to the result card');
      await k.close();
    },
  },
  {
    name: 'Landing QR: shown on the result card when switched on, and never pointing at /login',
    async run(h) {
      const stub = h.makeStub({ routes: { [SCORE_KEY]: () => ({ status: 200, body: RANKED(h) }) } });
      const k = await h.kiosk({ stub });
      const { page } = k;
      await page.route('**/js/config.js', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, body: `${await res.text()}\nwindow.CLICS_BOOTH_LANDING_QR = true;\n` });
      });
      // The booth worker may have cached config.js already, and a page it controls never reaches page.route.
      await page.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await toResult(k);
      await h.screenCheck(page, 'result card with QR', { demo: true });
      await h.shot(page, 'result-qr');
      const qr = await page.locator('[data-landing-qr] img').evaluate(async (img) => {
        await img.decode().catch(() => {});
        return { src: new URL(img.src).pathname, loaded: img.naturalWidth > 0, w: img.getBoundingClientRect().width };
      });
      h.check(qr.src === '/img/booth-landing-qr.svg' && qr.loaded && qr.w > 100, `QR: the static image is shown and loaded (${JSON.stringify(qr)})`);
      const caption = await page.locator('[data-landing-qr]').innerText();
      h.check(caption.includes('Scan') && !/login/i.test(caption), 'QR: captioned, TH and EN');
      await k.close();
    },
  },
  {
    name: 'a score from a backend without ranks still shows the card, with no ranks and no board',
    async run(h) {
      const k = await h.kiosk();
      await toResult(k);
      h.check(await k.page.locator('.result-card .rank, [data-board]').count() === 0, 'result: no ranks and no board when the score carries none');
      await h.screenCheck(k.page, 'result card without board', { demo: true });
      await k.close();
    },
  },
  {
    name: 'loop board: the attract loop mounts GET /booth/board, a start stops it, and an error renders nothing',
    async run(h) {
      let fail = false;
      const stub = h.makeStub({ routes: { [BOARD_KEY]: () => (fail ? { status: 503, body: { reason: 'unavailable' } } : { status: 200, body: { board: BOARD } }) } });
      const k = await h.kiosk({ stub, files: LOOP_FILES });
      const { page } = k;
      await k.shell('start');
      await page.waitForSelector('.loop-stage [data-booth-slot="loop-board"] [data-board]', { timeout: 10_000 });
      await page.evaluate(() => document.fonts.ready);
      await h.screenCheck(page, 'loop board', { demo: true });
      await h.shot(page, 'loop-board');
      h.check(h.same(await rowsOf(page, 1), expectRows(BOARD.today, null)) && h.same(await rowsOf(page, 2), expectRows(BOARD.event, null)),
        'loop board: top 10 today and for the event, no row marked');
      h.check(await page.locator('[data-board] button, [data-board] a').count() === 0, 'loop board: no controls, so a tap on it starts a play');
      h.check(stub.of(BOARD_KEY).length === 1, 'loop board: one request on mount');

      fail = true;
      await k.toVignette();
      const before = stub.of(BOARD_KEY).length;
      await h.sleep(300);
      h.check(stub.of(BOARD_KEY).length === before && await page.locator('[data-booth-slot="loop-board"]').count() === 0,
        'loop board: a start leaves the loop and stop() ends the refreshes');

      await page.evaluate(async () => {
        const { mountLoopBoard } = await import('/js/booth-board.js');
        const { createBoothApi } = await import('/js/booth-api.js');
        const slot = document.createElement('div');
        slot.dataset.boothSlot = 'loop-board';
        document.body.append(slot);
        window.__stopBoard = mountLoopBoard(slot, { api: createBoothApi(window.CLICS_API_URL) });
      });
      await page.waitForFunction(() => document.querySelector('[data-booth-slot="loop-board"]').childElementCount === 0, null, { timeout: 10_000 });
      h.check(true, 'loop board: a 503 renders nothing, not a stale or broken panel');
      await page.evaluate(() => window.__stopBoard());
      await k.close();
    },
  },
];
