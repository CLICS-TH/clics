import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SCORE_KEY = 'POST /booth/plays/:id/score';
const START_KEY = 'POST /booth/plays';
const BOARD_KEY = 'GET /booth/board';
const SIZES = [[1080, 1920], [2160, 3840]];
const BANDS = ['low', 'mid', 'high'];
const KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const BAD = /on[-\s]?premise|validated\b|certif|ติดตั้งภายในองค์กร|ใบรับรอง/i;

// booth-bands.js has no imports, so a data: URL loads it as the module it is.
const SOURCE = await readFile(fileURLToPath(new URL('../../../physician-ui/public/js/booth-bands.js', import.meta.url)), 'utf8');
const { BAND_LINES, bandOf, weakestFirst } = await import(`data:text/javascript,${encodeURIComponent(SOURCE)}`);

const size = (line) => line.th.length + line.en.length;

/** The score sets the card is checked with: every domain at each band, and the two longest low lines made weakest. */
function scoreSets() {
  const longest = [...KEYS].sort((a, b) => size(BAND_LINES[b].low) - size(BAND_LINES[a].low)).slice(0, 2);
  return [
    ['all low', Object.fromEntries(KEYS.map((k) => [k, 1]))],
    ['all middle', Object.fromEntries(KEYS.map((k) => [k, 3]))],
    ['all high', Object.fromEntries(KEYS.map((k) => [k, 5]))],
    [`longest low lines (${longest.join(', ')}) weakest`, Object.fromEntries(KEYS.map((k) => [k, longest.includes(k) ? 0 : 4]))],
  ];
}

async function toResult(k) {
  await k.shell('start');
  await k.tap('[data-action="start"]');
  await k.screen('vignette');
  await k.tap('[data-action="begin"]');
  for (let n = 1; n <= 3; n++) {
    await k.screen('step');
    await k.tap('.options > [data-option]:nth-child(1)');
    await k.screen('reply');
    await k.tap(`[data-action="${n === 3 ? 'see-score' : 'next'}"]`);
  }
  await k.screen('scored');
}

export default [
  {
    name: 'band descriptors: every domain and band has a Thai and an English line, free of the banned claims',
    async run(h) {
      h.check(h.same(Object.keys(BAND_LINES), h.DOMAINS.map((d) => d.key)), 'bands: the table covers d1..d7 in the rubric\'s order');
      const lines = KEYS.flatMap((k) => BANDS.map((b) => [k, b, BAND_LINES[k]?.[b]]));
      h.check(lines.length === 21 && lines.every(([, , l]) => /[฀-๿]/.test(l?.th ?? '') && /[A-Za-z]/.test(l?.en ?? '') && !/[฀-๿]/.test(l.en)),
        'bands: 7 domains x 3 bands, each with a Thai line and an English line in its own script');
      h.check(lines.every(([, , l]) => !BAD.test(`${l.th} ${l.en}`)), 'bands: no line says validated, on-premise or certificate');
      h.check(lines.every(([, , l]) => l.th.length <= 60 && l.en.length <= 70), 'bands: Thai lines <= 60 characters and English <= 70, so each stays within two lines');
      h.check([0, 1, 2, 3, 4, 5].map(bandOf).join() === 'low,low,low,mid,high,high', 'bands: 0-2 low, 3 middle, 4-5 high');
      h.check(weakestFirst({ d1: 3, d2: 1, d3: 3, d4: 1, d5: 5, d6: 0, d7: 3 }).slice(0, 3).join() === 'd6,d2,d4', 'bands: weakest first, a tie keeping the rubric\'s order');
    },
  },
  ...SIZES.map(([width, height]) => ({
    name: `result card at ${width}x${height}: a descriptor per domain, the two weakest first under Practise next, the leaderboard button above the fold`,
    async run(h) {
      for (const [label, domains] of scoreSets()) {
        const stub = h.makeStub({ routes: { [SCORE_KEY]: () => ({ status: 200, body: { ...h.SCORED, domains } }) } });
        const k = await h.kiosk({ width, height, stub });
        const { page } = k;
        await toResult(k);
        const tag = `${width}x${height} ${label}`;
        await h.screenCheck(page, `result card ${tag}`, { demo: true });
        await h.shot(page, `result-bands-${width}-${label.split(' ')[1]}`);

        const order = weakestFirst(domains);
        const next = await page.$$eval('.practise-next .domain', (els) => els.map((e) => e.dataset.key));
        const other = await page.$$eval('.other-domains .domain', (els) => els.map((e) => e.dataset.key));
        h.check(h.same(next, order.slice(0, 2)) && h.same(other, order.slice(2)),
          `${tag}: Practise next lists ${order.slice(0, 2)} first, then the other five (${next} | ${other})`);
        const rows = await page.$$eval('.result-card .domain', (els) => els.map((e) => ({
          key: e.dataset.key, th: e.querySelector('.domain-band .bi-th')?.textContent, en: e.querySelector('.domain-band .bi-en')?.textContent,
        })));
        h.check(rows.length === 7 && rows.every((r) => r.th === BAND_LINES[r.key][bandOf(domains[r.key])].th && r.en === BAND_LINES[r.key][bandOf(domains[r.key])].en),
          `${tag}: each of the 7 rows carries the Thai and English line of its domain and band`);
        const fit = await page.evaluate(() => {
          const lines = (e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight));
          const body = document.querySelector('.play-body').getBoundingClientRect();
          const button = document.querySelector('.result-card [data-action="leaderboard"]').getBoundingClientRect();
          const next = document.querySelector('.practise-next').getBoundingClientRect();
          return {
            tall: [...document.querySelectorAll('.domain-band span[lang]')].filter((e) => lines(e) > 2).length,
            buttonBottom: Math.round(button.bottom), nextBottom: Math.round(next.bottom), bodyBottom: Math.round(body.bottom),
            sheetBelowFold: document.querySelector('.other-domains').getBoundingClientRect().top >= next.bottom,
          };
        });
        h.check(fit.tall === 0, `${tag}: no descriptor runs past two lines`);
        h.check(fit.nextBottom <= fit.bodyBottom && fit.buttonBottom <= fit.bodyBottom && fit.sheetBelowFold,
          `${tag}: Practise next and the leaderboard button are visible without scrolling (button ends ${fit.buttonBottom}, card area ends ${fit.bodyBottom})`);
        await k.close();
      }
    },
  })),
  {
    name: 'leaderboard buttons: the result card and the loop each open the board, and a tap on the loop button starts no play',
    async run(h) {
      const stub = h.makeStub();
      const k = await h.kiosk({ stub });
      const { page } = k;
      await k.shell('start');
      const loopButton = page.locator('.shell-loop [data-action="leaderboard"]');
      h.check(await loopButton.count() === 1, 'loop: one leaderboard button');
      await h.screenCheck(page, 'loop with the leaderboard button');
      await k.tap('.shell-loop [data-action="leaderboard"]');
      await page.waitForSelector('[data-board-overlay] [data-board]');
      h.check(stub.of(BOARD_KEY).length >= 1 && stub.of(START_KEY).length === 0 && await page.locator('#booth[data-shell="start"]').count() === 1,
        'loop: the button fetched the board and started no play');
      await h.screenCheck(page, 'loop leaderboard overlay', { demo: true });
      await h.shot(page, 'loop-leaderboard');
      await h.sleep(500);
      await k.tap('[data-board-overlay] [data-action="close-board"]');
      h.check(await page.locator('[data-board-overlay]').count() === 0, 'loop: Close removes the overlay and the loop is back');
      await k.tap('[data-action="start"]');
      await k.screen('vignette');
      h.check(stub.of(START_KEY).length === 1, 'loop: a tap elsewhere still starts a play');
      await k.close();

      let fail = () => {};
      const gate = new Promise((r) => { fail = r; });
      const k2 = await h.kiosk({ stub: h.makeStub({ routes: { [SCORE_KEY]: () => ({ status: 200, body: { ...h.SCORED, board: null } }), [BOARD_KEY]: async () => { await gate; return 'abort'; } } }) });
      await toResult(k2);
      await k2.tap('.result-card [data-action="leaderboard"]');
      await k2.page.waitForSelector('[data-board-overlay] .board-unavailable');
      h.check((await k2.page.locator('.board-unavailable').innerText()).includes('โหลด'), 'result: while the board loads the overlay says loading, not unavailable');
      fail();
      await k2.page.waitForFunction(() => document.querySelector('.board-unavailable')?.innerText.includes('ไม่ได้'));
      await h.screenCheck(k2.page, 'result leaderboard unavailable', { demo: 'auto' });
      h.check(await k2.page.locator('[data-board-overlay] [data-action="close-board"]').count() === 1, 'result: with the board unreachable the overlay says so and still closes');
      await k2.close();

      const k3 = await h.kiosk();
      await k3.page.clock.install();
      await k3.page.reload({ waitUntil: 'domcontentloaded' });
      await k3.shell('start');
      await k3.tap('.shell-loop [data-action="leaderboard"]');
      await k3.page.waitForSelector('[data-board-overlay]');
      await k3.page.clock.fastForward(31_000);
      h.check(await k3.page.locator('[data-board-overlay]').count() === 0, 'loop: a board left open closes itself after 30 s');
      await k3.close();
    },
  },
];
