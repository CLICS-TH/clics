import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

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
  rank: e.querySelector('.board-rank').textContent, tag: e.querySelector('.board-tag').innerText,
  score: e.querySelector('.board-score').textContent, icon: e.querySelector('.booth-icon')?.dataset.icon,
  drawn: !!e.querySelector('.booth-icon svg'), mine: e.getAttribute('aria-current') === 'true',
})));

/** The rows of board list `list` once they read as `want`, or as they stand after `ms`: the overlay draws its rows
 *  first and their icons a frame or more later, so a read the moment it shows can miss an icon. */
async function settledRows(page, list, want, ms = 5_000) {
  const until = Date.now() + ms;
  for (;;) {
    const rows = await rowsOf(page, list);
    if (isDeepStrictEqual(rows, want) || Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const expectRows = (list, mine) => list.map((e, i) => ({
  rank: String(i + 1), tag: `#${String(e.tag).padStart(3, '0')}`, score: String(Math.round(e.score)),
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
        text: e.innerText, icon: e.querySelector('.booth-icon')?.dataset.icon, drawn: (e.querySelector('.booth-icon svg')?.getBoundingClientRect().width ?? 0) > 0,
      }));
      h.check(tag.text === 'Participant #042' && tag.icon === TAG_ICONS[(42 * 7) % TAG_ICONS.length] && tag.drawn,
        `result: "Participant #042" with its icon from the Portal set (${JSON.stringify(tag)})`);
      const ranks = await page.$$eval('.result-card .rank', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
      h.check(ranks.length === 2 && ranks[0].includes('อันดับของคุณวันนี้') && ranks[0].includes('Your rank today') && ranks[0].endsWith('#3')
        && ranks[1].includes('Your rank for the event') && ranks[1].endsWith('#5'), `result: today's rank #3 and the event's rank #5 (${ranks.join(' | ')})`);
      const [today, event] = [expectRows(BOARD.today, 42), expectRows(BOARD.event, 42)];
      h.check(h.same(await settledRows(page, 1, today), today), 'board: top 10 today in order, each with rank, icon, tag and whole score; the visitor\'s row marked');
      h.check(h.same(await settledRows(page, 2, event), event), 'board: top 10 for the event in order');
      const label = await page.locator('[data-board] [data-demo-label]').innerText().catch(() => '');
      h.check(label.includes(h.DEMO_LABEL.th) && label.includes(h.DEMO_LABEL.en), 'board: the panel carries the demo label, TH and EN');
      h.check(await page.locator('[data-board] button, [data-board] a').count() === 0, 'board: no controls in the panel');
      h.check(await page.locator('[data-board-overlay] button').count() === 1, 'board: the overlay has one control, Close');
      h.check(await page.locator('[data-landing-qr]').count() === 0, 'QR: hidden while js/config.js leaves it off');
      // The Thai look (owner, 2026-11-26): the card names the participant number in full, หมายเลขผู้เข้าร่วม NNN, with
      // the number whole on its line; every board row shows its whole #NNN, none of it behind the row's ellipsis.
      await k.tap('[data-look-primary="th"]');
      if (await page.locator('[data-look-both]').getAttribute('aria-pressed') === 'true') await k.tap('[data-look-both]');
      await page.waitForFunction(() => document.documentElement.dataset.look === 'th', null, { timeout: 5_000 }).catch(() => {});
      const thai = await page.evaluate(() => ({
        look: document.documentElement.dataset.look,
        rows: [...document.querySelectorAll('[data-board] .board-tag')].map((e) => ({ text: e.innerText, cut: e.scrollWidth > e.clientWidth + 1 })),
        card: (() => {
          const t = document.querySelector('.result-card .booth-tag .tag-th');
          const r = document.createRange();
          r.setStart(t.firstChild, t.textContent.lastIndexOf(' ') + 1);
          r.setEnd(t.firstChild, t.textContent.length);
          return { text: t.innerText, lines: t.getClientRects().length, numberLines: r.getClientRects().length };
        })(),
      }));
      h.check(thai.look === 'th' && thai.rows.length === 20 && thai.rows.every((r) => /^#\d{3}$/.test(r.text) && !r.cut),
        `board, Thai look: every row shows its whole #NNN (${JSON.stringify(thai.rows.filter((r) => r.cut || !/^#\d{3}$/.test(r.text)))})`);
      h.check(thai.card.text === 'หมายเลขผู้เข้าร่วม 042' && thai.card.lines === 1 && thai.card.numberLines === 1,
        `result, Thai look: the card reads "หมายเลขผู้เข้าร่วม 042" on one line (${JSON.stringify(thai.card)})`);
      // Every look holds the card's tag on one line, up to a four-digit number, with the visitor's icon still drawn (a
      // box, not just an svg in the DOM): the tag's spans are rewritten as the kiosk would write them (booth-copy.js
      // tagText) and measured where they show.
      for (const look of ['th', 'en', 'th+en', 'en+th']) {
        await page.evaluate(async (l) => (await import('/js/booth-dom.js')).setLook(l), look);
        await h.sleep(150);
        const fit = await page.evaluate(async () => {
          const { tagText: text } = await import('/js/booth-copy.js');
          const tag = document.querySelector('.result-card .booth-tag');
          const shown = () => [...tag.querySelectorAll('.tag-en, .tag-th')].find((e) => getComputedStyle(e).display !== 'none');
          const drawn = () => (tag.querySelector('.booth-icon svg')?.getBoundingClientRect().width ?? 0) > 0;
          const out = [];
          for (const n of [42, 1234]) {
            for (const e of tag.querySelectorAll('.tag-en, .tag-th')) e.textContent = text(n, e.lang);
            out.push({ n, lines: shown().getClientRects().length, over: tag.scrollWidth > tag.clientWidth + 1, icon: drawn() });
          }
          for (const e of tag.querySelectorAll('.tag-en, .tag-th')) e.textContent = text(42, e.lang);
          return out;
        });
        h.check(fit.every((f) => f.lines === 1 && !f.over && f.icon), `result, ${look}: the card's tag holds one line at #042 and #1234, its icon drawn (${JSON.stringify(fit)})`);
      }
      await page.evaluate(async () => (await import('/js/booth-dom.js')).setLook('th'));
      await h.sleep(150);
      await h.screenCheck(page, 'result leaderboard overlay, Thai look', { demo: true });
      await h.shot(page, 'result-board-th');
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
      const today = expectRows(BOARD.today.slice(0, 5), null);
      h.check(h.same(await settledRows(page, 1, today), today), 'loop board: today\'s top 5 only, no row marked');
      const loop = await page.evaluate(() => {
        const slot = document.querySelector('[data-booth-slot="loop-board"]').getBoundingClientRect();
        const rows = [...document.querySelectorAll('[data-board] .board-row')].map((r) => r.getBoundingClientRect());
        return { lists: document.querySelectorAll('[data-board] .board-list').length,
          title: document.querySelector('[data-board] .board-list-title')?.innerText.replace(/\s+/g, ' ').trim(),
          inside: rows.length > 0 && rows.every((r) => r.top >= slot.top - 1 && r.bottom <= slot.bottom + 1) };
      });
      h.check(loop.lists === 1 && /5 อันดับวันนี้/.test(loop.title) && /Top 5 today/.test(loop.title) && loop.inside,
        `loop board: one list titled 5 อันดับวันนี้ / Top 5 today, every row inside the slot, none clipped (${JSON.stringify(loop)})`);
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
