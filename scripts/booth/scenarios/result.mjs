import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRadar, checkRadar } from '../radar-check.mjs';

const SCORE_KEY = 'POST /booth/plays/:id/score';
const START_KEY = 'POST /booth/plays';
const BOARD_KEY = 'GET /booth/board';
const SIZES = [[1080, 1920], [2160, 3840]];
const BANDS = ['low', 'mid', 'high'];
const KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const BAD = /on[-\s]?premise|validated\b|certif|ติดตั้งภายในองค์กร|ใบรับรอง/i;

// booth-bands.js has no imports, so a data: URL loads it as the module it is.
const SOURCE = await readFile(fileURLToPath(new URL('../../../physician-ui/public/js/booth-bands.js', import.meta.url)), 'utf8');
const { BAND_LINES, SAFETY_REVIEW, bandOf, weakestFirst } = await import(`data:text/javascript,${encodeURIComponent(SOURCE)}`);

const size = (line) => line.th.length + line.en.length;
const RANKS = { rank_today: 3, rank_event: 5 };

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

const TYPED = 'ไข้ ไอ และหอบ ตรวจเอกซเรย์ปอดก่อน';

/** Every tier label, Thai and English: none may be on any screen before the score response. */
const tierWords = (h) => Object.values(h.TIERS).flatMap((t) => [t.label.th, t.label.en]);
const tierLeak = (page, words) => page.evaluate((w) => ({
  marks: document.querySelectorAll('[data-tier], .tier-chip, [data-reveal-overlay], [data-action="see-answers"]').length,
  words: w.filter((x) => document.body.innerText.includes(x)),
}), words);

/**
 * Plays the three steps by `plan`: a tier name taps the offered option of that tier, 'type' types TYPED. Checks for
 * tier text on every screen on the way, the scoring screen included (the score is held until then).
 * @returns {Promise<object[]>} the answers given
 */
async function playByTier(h, k, plan, release) {
  const { page } = k;
  const words = tierWords(h);
  const leaks = [];
  const look = async (where) => { const l = await tierLeak(page, words); if (l.marks || l.words.length) leaks.push(`${where}: ${JSON.stringify(l)}`); };
  await k.shell('start');
  await k.toVignette();
  await look('vignette');
  await k.tap('[data-action="begin"]');
  const answers = [];
  for (let n = 1; n <= 3; n++) {
    await k.screen('step');
    await look(`step ${n}`);
    const how = plan[n - 1];
    if (how === 'type') {
      await k.tap('[data-action="type-own"]');
      await k.screen('typing');
      await page.keyboard.type(TYPED);
      await look(`typing ${n}`);
      await k.tap('[data-action="send"]');
      answers.push({ text: TYPED });
    } else {
      const bank = h.bankFor(h.TREE, h.pathOf(h.TREE, answers));
      const offered = await page.$$eval('.options > [data-option]', (els) => els.map((e) => e.dataset.option));
      const id = offered.find((o) => bank.options.find((b) => b.id === o)?.tier === how);
      await k.tap(`[data-option="${id}"]`);
      await page.waitForSelector(`[data-option="${id}"][aria-pressed="true"]`);
      await look(`chosen ${n}`);
      await k.tap('[data-action="send"]');
      answers.push({ choice: id });
    }
    await k.screen('reply');
    await look(`reply ${n}`);
    await k.tap(`[data-action="${n === 3 ? 'see-score' : 'next'}"]`);
  }
  await k.screen('scoring');
  await look('scoring');
  release();
  await k.screen('scored');
  h.check(leaks.length === 0, `no tier label, chip or answer button on any screen before the score response${leaks.length ? ` (${leaks.slice(0, 2).join('; ')})` : ''}`);
  return answers;
}

/** The rows the overlay must show, from the fixture's banks and the asks the kiosk posted for scoring. */
function expectedRows(h, answers, asks) {
  const path = h.pathOf(h.TREE, answers);
  return answers.map((a, i) => {
    const bank = h.bankFor(h.TREE, path.slice(0, i));
    const tierOf = (id) => bank.options.find((o) => o.id === id).tier;
    const labelOf = (id) => bank.options.find((o) => o.id === id).label.th;
    const best = asks[i].options.find((id) => tierOf(id) === 'best');
    return {
      question: bank.variants.find((v) => v.id === asks[i].variant).question.th,
      given: 'choice' in a ? labelOf(a.choice) : a.text,
      tier: 'choice' in a ? tierOf(a.choice) : 'best',
      best: 'choice' in a && a.choice === best ? null : labelOf(best),
    };
  });
}

const readReveal = (page) => page.$$eval('[data-reveal-overlay] .reveal-step', (els) => els.map((li) => ({
  step: li.querySelector('.step-of').innerText.replace(/\s+/g, ' '),
  question: li.querySelector('.reveal-question .bi-th').textContent,
  given: (li.querySelector('.reveal-answer .reveal-given .bi-th') ?? li.querySelector('.reveal-typed')).textContent,
  chip: li.querySelector('.reveal-answer .tier-chip').innerText.replace(/\s+/g, ' '),
  tier: li.querySelector('.reveal-answer .tier-chip').dataset.tier,
  best: li.querySelector('[data-best] .reveal-given .bi-th')?.textContent ?? null,
})));

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
      h.check(SAFETY_REVIEW?.model && /^\d{4}-\d{2}-\d{2}$/.test(SAFETY_REVIEW.date) && SAFETY_REVIEW.findings, 'bands: the AI safety review is recorded with its model, date and findings (ADR 0005)');
      h.check([0, 1, 2, 3, 4, 5].map(bandOf).join() === 'low,low,low,mid,high,high', 'bands: 0-2 low, 3 middle, 4-5 high');
      h.check(weakestFirst({ d1: 3, d2: 1, d3: 3, d4: 1, d5: 5, d6: 0, d7: 3 }).slice(0, 3).join() === 'd6,d2,d4', 'bands: weakest first, a tie keeping the rubric\'s order');
    },
  },
  ...SIZES.map(([width, height]) => ({
    name: `result card at ${width}x${height}: the radar, a descriptor per domain, the two weakest first under Practise next, the leaderboard button above the fold`,
    async run(h) {
      for (const [label, domains] of scoreSets()) {
        const stub = h.makeStub({ routes: { [SCORE_KEY]: (call) => h.scoredFor(call, { domains, ...RANKS }) } });
        const k = await h.kiosk({ width, height, stub });
        const { page } = k;
        await toResult(k);
        const tag = `${width}x${height} ${label}`;
        await h.screenCheck(page, `result card ${tag}`, { demo: true });
        await h.shot(page, `result-bands-${width}-${label.split(' ').slice(0, 2).join('-')}`);
        checkRadar(h, tag, await readRadar(page), domains);

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
          `${tag}: with both ranks, Practise next and the leaderboard button are visible without scrolling (button ends ${fit.buttonBottom}, card area ends ${fit.bodyBottom})`);
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
      await k.toVignette();
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
  ...SIZES.map(([width, height]) => ({
    name: `See the answers at ${width}x${height}: each step's question, answer and tier, and the best option offered when it was not tapped`,
    async run(h) {
      const stub = h.makeStub({ routes: { [SCORE_KEY]: (call) => h.scoredFor(call, RANKS) } });
      const release = stub.hold(SCORE_KEY);
      const k = await h.kiosk({ width, height, stub });
      const { page } = k;
      const answers = await playByTier(h, k, ['best', 'weaker', 'type'], release);
      const want = expectedRows(h, answers, stub.of(SCORE_KEY)[0].body.asks);
      await k.tap('[data-action="see-answers"]');
      await page.waitForSelector('[data-reveal-overlay] .reveal-step');
      await page.evaluate(() => document.fonts.ready);
      const seen = await readReveal(page);
      h.check(seen.length === 3 && seen.every((r, i) => r.step.includes(`ขั้นที่ ${i + 1}`) && r.step.includes(`Step ${i + 1}`)), `${width}: three steps, numbered in Thai and English`);
      h.check(seen.every((r, i) => r.question === want[i].question && r.given === want[i].given),
        `${width}: each step shows its question and the visitor's answer, the typed one as typed`);
      h.check(seen.every((r, i) => r.tier === want[i].tier && r.chip.includes(h.TIERS[want[i].tier].label.th) && r.chip.includes(h.TIERS[want[i].tier].label.en)),
        `${width}: the answers' tiers read ${seen.map((r) => r.chip).join(' | ')} (want ${want.map((w) => w.tier).join(', ')})`);
      h.check(seen.every((r) => !/ปลอดภัย|safe/i.test(r.chip)),
        `${width}: no tier chip claims safety, since a typed answer sorted unsafe also shows as weaker (${seen.map((r) => r.chip).join(' | ')})`);
      h.check(seen[0].best === null, `${width}: step 1 tapped the best option, so no best-option line`);
      h.check(seen[1].best === want[1].best && seen[1].best !== null, `${width}: step 2 tapped the weaker option, and the best option offered is named (${seen[1].best})`);
      h.check(seen[2].best === want[2].best && seen[2].best !== null, `${width}: step 3 was typed, and the best option offered is named (${seen[2].best})`);
      const tinted = await h.aiTinted(page, '[data-reveal-overlay] :is(.tier-chip, .reveal-best)');
      h.check(tinted.length === 0, `${width}: no tier chip or best-option panel wears an --ai-* colour${tinted.length ? ` (${[...new Set(tinted)].slice(0, 3).join('; ')})` : ''}`);
      await h.screenCheck(page, `answers overlay ${width}x${height}`, { demo: 'auto' });
      await h.shot(page, `answers-${width}`);
      const fits = await page.locator('[data-reveal-overlay]').evaluate((o) => ({ scrolls: o.scrollHeight > o.clientHeight, close: !!o.querySelector('[data-action="close-answers"]') }));
      await page.locator('[data-reveal-overlay] [data-action="close-answers"]').scrollIntoViewIfNeeded();
      await h.sleep(400);
      await k.tap('[data-reveal-overlay] [data-action="close-answers"]');
      h.check(fits.close && await page.locator('[data-reveal-overlay]').count() === 0 && await k.screenNow() === 'scored',
        `${width}: Close${fits.scrolls ? ', reached by scrolling the overlay,' : ''} returns to the result card`);
      const kept = new URL(await page.locator('[data-keep-qr]').getAttribute('data-result-url'));
      h.check(kept.hash.length > 4, `${width}: the result QR is still drawn`);
      await k.close();
    },
  })),
  {
    name: 'See the answers: hidden when the score carries no tiers, or tiers that do not fit the asks posted',
    async run(h) {
      const cases = [
        ['no steps (a backend older than #372)', () => ({ status: 200, body: { ...h.SCORED } })],
        ['steps whose options are out of order', (call) => {
          const { body } = h.scoredFor(call);
          return { status: 200, body: { ...body, steps: body.steps.map((st) => ({ ...st, options: [...st.options].reverse() })) } };
        }],
        ['a tier the kiosk does not know', (call) => {
          const { body } = h.scoredFor(call);
          return { status: 200, body: { ...body, steps: body.steps.map((st, i) => (i === 1 ? { ...st, tier: 'great' } : st)) } };
        }],
      ];
      for (const [what, route] of cases) {
        const k = await h.kiosk({ stub: h.makeStub({ routes: { [SCORE_KEY]: route } }) });
        await toResult(k);
        const shown = await k.page.evaluate(() => ({
          button: document.querySelectorAll('[data-action="see-answers"]').length, radar: document.querySelectorAll('[data-radar]').length,
          score: document.querySelector('[data-score]')?.textContent,
        }));
        h.check(shown.button === 0 && shown.radar === 1 && shown.score === '72', `${what}: the card shows the score and radar, with no "See the answers" (${JSON.stringify(shown)})`);
        await k.close();
      }
    },
  },
];
