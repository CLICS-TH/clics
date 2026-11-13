import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRadar, checkRadar } from '../radar-check.mjs';

const START_KEY = 'POST /booth/plays';
const REPLY_KEY = 'POST /booth/plays/:id/reply';
const SCORE_KEY = 'POST /booth/plays/:id/score';
const SIZES = [[1080, 1920], [2160, 3840]];
const PHONES = [[375, 812], [320, 640]];
const KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
/** The five taps, one tier each: every tier, on tier path BRWBR, whose fitted d5 (2.6) is in the middle band only once
 *  rounded and whose d1 is whole. */
const PLAN = ['best', 'reasonable', 'weaker', 'best', 'reasonable'];
/** The band of a whole score, as the rubric's anchors give it; a one-decimal score takes the band of its rounded value. */
const BAND_OF_WHOLE = ['low', 'low', 'low', 'mid', 'high', 'high'];
const bandWant = (v) => BAND_OF_WHOLE[Math.round(v)];

const js = (name) => fileURLToPath(new URL(`../../../physician-ui/public/js/${name}`, import.meta.url));
const dataUrl = (text) => `data:text/javascript,${encodeURIComponent(text)}`;
// booth-copy.js and booth-bands.js have no imports, and booth-result-link.js imports only the copy: a data: URL loads
// each as the module it is, with the link's one import pointed at the copy's data: URL.
const COPY_URL = dataUrl(await readFile(js('booth-copy.js'), 'utf8'));
const load = async (name) => import(dataUrl((await readFile(js(name), 'utf8')).replaceAll("'./booth-copy.js'", JSON.stringify(COPY_URL))));
const { parseResultFragment, resultFragment, boothDate, RESULT_PATH } = await load('booth-result-link.js');
const { BAND_LINES } = await load('booth-bands.js');

const lookIn = (page, look) => page.evaluate(async (l) => {
  (await import('/js/booth-dom.js')).setLook(l);
  await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(r));
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => {})));
}, look);

const stepOf = (page) => page.evaluate(() => {
  const head = document.querySelector('.step-of');
  return { th: head?.querySelector('.bi-th').textContent, en: head?.querySelector('.bi-en').textContent };
});

/** The two weakest domains first, a tie in the rubric's order. */
const weakest = (d) => [...KEYS].sort((a, b) => d[a] - d[b] || KEYS.indexOf(a) - KEYS.indexOf(b));

/** Each domain row as drawn: its value text, band, bar fill (0-1) and band line. */
const readRows = (page) => page.$$eval('.result-card .domain', (els) => els.map((e) => ({
  key: e.dataset.key, band: e.dataset.band, text: e.querySelector('.domain-value').textContent,
  fill: e.querySelector('.domain-bar > span').getBoundingClientRect().width / e.querySelector('.domain-bar').getBoundingClientRect().width,
  th: e.querySelector('.domain-band .bi-th').textContent, en: e.querySelector('.domain-band .bi-en').textContent,
})));

/** Every row reads `want(value) / 5`, fills value/5 of its bar, and carries the band line of its rounded value. */
function checkRows(h, tag, rows, domains, want) {
  const off = rows.filter((r) => {
    const v = domains[r.key];
    const line = BAND_LINES[r.key][bandWant(v)];
    return r.text !== `${want(v)} / 5` || Math.abs(r.fill - v / 5) > 0.01 || r.band !== bandWant(v) || r.th !== line.th || r.en !== line.en;
  });
  h.check(rows.length === 7 && off.length === 0,
    `${tag}: seven rows, each with its value, its bar at value/5 and the band line of its rounded value `
    + `(${rows.map((r) => `${r.key} "${r.text}" ${r.band}`).join(', ')})${off.length ? `; off: ${off.map((r) => r.key).join(', ')}` : ''}`);
}

/** Tap the offered option of `tier` and send it. */
async function answerTier(h, k, tree, answers, tier) {
  const bank = h.bankFor(tree, h.pathOf(tree, answers));
  const offered = await k.page.$$eval('.options > [data-option]', (els) => els.map((e) => e.dataset.option));
  const id = offered.find((o) => bank.options.find((b) => b.id === o)?.tier === tier);
  await k.tap(`[data-option="${id}"]`);
  await k.page.waitForSelector(`[data-option="${id}"][aria-pressed="true"]`);
  await k.tap('[data-action="send"]');
  return { choice: id, offered, inBank: offered.every((o) => bank.options.some((b) => b.id === o)) };
}

const readReveal = (page) => page.$$eval('[data-reveal-overlay] .reveal-step', (els) => els.map((li) => ({
  th: li.querySelector('.step-of .bi-th').textContent, en: li.querySelector('.step-of .bi-en').textContent,
  tier: li.querySelector('.reveal-answer .tier-chip').dataset.tier,
})));

export default [
  {
    name: 'five-step fixture: the stub follows cap-adult-5, and the result link keeps one-decimal domains and five tiers',
    async run(h) {
      const path = PLAN.map((t) => h.TIERS[t].letter).join('');
      const domains = h.TABLE5.paths[path];
      h.check(h.stepCount(h.TREE5) === 5 && h.stepCount(h.TREE) === 3, `fixtures: cap-adult-5 has ${h.stepCount(h.TREE5)} steps, the three-step fixture ${h.stepCount(h.TREE)}`);
      h.check(KEYS.some((k) => !Number.isInteger(domains[k])) && KEYS.some((k) => Number.isInteger(domains[k]))
        && KEYS.some((k) => bandWant(domains[k]) !== BAND_OF_WHOLE[Math.trunc(domains[k])]),
      `fixtures: table entry ${path} has a one-decimal domain, a whole one, and one whose band moves when rounded (${JSON.stringify(domains)})`);
      const r = { score: 72, domains, tag: 42, date: '2026-11-11', teaser: h.TREE5.teaser, tiers: PLAN, look: 'en+th' };
      h.check(h.same(parseResultFragment(`#${resultFragment(r)}`), r), 'link: one-decimal domains and five tiers come back as written');
      h.check(parseResultFragment(`#${resultFragment({ ...r, domains: { ...domains, d5: 2.65 } })}`) === null, 'link: a domain with two decimals does not read');
    },
  },
  ...SIZES.map(([width, height]) => ({
    name: `five-step play at ${width}x${height} in each look: "Step n of 5", five replies, the reveal's five rows, one-decimal bars from the fitted table`,
    async run(h) {
      const stub = h.makeStub({ tree: h.TREE5, table: h.TABLE5 });
      const release = stub.hold(SCORE_KEY);
      const k = await h.kiosk({ width, height, stub });
      const { page } = k;
      const looks = Object.keys(h.LOOKS);
      await k.shell('start');
      await k.toVignette();
      h.check(h.same(stub.of(START_KEY).map((c) => c.body), [{ case_id: h.TREE5.case_id }]), `${width}: the play started on ${h.TREE5.case_id}`);
      await k.tap('[data-action="begin"]');
      const answers = [];
      const heads = [];
      const buttons = [];
      let banksOk = true;
      for (let n = 1; n <= 5; n++) {
        await k.screen('step');
        heads.push(await stepOf(page));
        for (const look of looks) {
          await lookIn(page, look);
          await h.screenCheck(page, `${width}x${height} five-step step ${n}, ${look}`);
        }
        await lookIn(page, h.DEFAULT_LOOK);
        if (n === 1) await h.shot(page, `five-step-${width}-step-1`);
        const a = await answerTier(h, k, h.TREE5, answers, PLAN[n - 1]);
        banksOk &&= a.inBank;
        answers.push({ choice: a.choice });
        await k.screen('reply');
        buttons.push(await page.evaluate(() => document.querySelector('.play-actions [data-action]')?.dataset.action));
        if (n === 5) {
          heads.push(await stepOf(page));
          for (const look of looks) {
            await lookIn(page, look);
            await h.screenCheck(page, `${width}x${height} five-step reply 5, ${look}`);
          }
          await lookIn(page, h.DEFAULT_LOOK);
        }
        await k.tap(`[data-action="${buttons[n - 1]}"]`);
      }
      h.check(h.same(heads, [1, 2, 3, 4, 5, 5].map((n) => ({ th: `ขั้นที่ ${n} จาก 5`, en: `Step ${n} of 5` }))),
        `${width}: each step reads "ขั้นที่ n จาก 5" and "Step n of 5", the fifth reply too (${heads.map((x) => x.en).join(', ')})`);
      h.check(banksOk, `${width}: each step offered the options of its bank on tier path ${h.pathOf(h.TREE5, answers)}, keyed by the previous tier`);
      h.check(h.same(buttons, ['next', 'next', 'next', 'next', 'see-score']), `${width}: Next step after replies 1-4, See my score after reply 5 (${buttons.join(', ')})`);

      await k.screen('scoring');
      release();
      await k.screen('scored');
      const replies = stub.of(REPLY_KEY);
      const score = stub.of(SCORE_KEY);
      h.check(replies.length === 5 && replies.every((c, i) => c.body.answers.length === i + 1 && c.body.asks.length === i + 1),
        `${width}: five reply requests, the nth with n answers and n asks`);
      h.check(score.length === 1 && score[0].body.answers.length === 5 && score[0].body.asks.length === 5 && score[0].body.sigs.length === 6,
        `${width}: one score request with five answers, five asks and six sigs`);
      const path = h.pathOf(h.TREE5, answers);
      const domains = h.TABLE5.paths[path];
      h.check(path === 'BRWBR' && await page.locator('[data-score]').textContent() === '72', `${width}: tier path ${path}, the composite whole (72)`);
      for (const look of looks) {
        await lookIn(page, look);
        const tag = `${width}x${height} five-step result card, ${look}`;
        await h.screenCheck(page, tag, { demo: true });
        checkRows(h, tag, await readRows(page), domains, (v) => v.toFixed(1));
        checkRadar(h, tag, await readRadar(page), domains, h.LOOKS[look].primary);
        if (look === h.DEFAULT_LOOK) await h.shot(page, `five-step-${width}-result`);
      }
      const next = await page.$$eval('.practise-next .domain', (els) => els.map((e) => e.dataset.key));
      h.check(h.same(next, weakest(domains).slice(0, 2)), `${width}: Practise next lists the two weakest, a fitted 2.6 among them (${next})`);
      const kept = parseResultFragment(new URL(await page.locator('[data-keep-qr]').getAttribute('data-result-url')).hash);
      h.check(h.same(kept?.domains, domains) && h.same(kept?.tiers, PLAN) && kept?.score === 72,
        `${width}: the result QR keeps the fitted domains, the five tiers and the composite (${JSON.stringify(kept?.domains)}, ${kept?.tiers})`);

      await k.tap('[data-action="see-answers"]');
      await page.waitForSelector('[data-reveal-overlay] .reveal-step');
      const rows = await readReveal(page);
      h.check(h.same(rows, PLAN.map((tier, i) => ({ th: `ขั้นที่ ${i + 1}`, en: `Step ${i + 1}`, tier }))),
        `${width}: See the answers lists five steps, numbered in Thai and English, each with its tier (${rows.map((r) => r.tier).join(', ')})`);
      for (const look of looks) {
        await lookIn(page, look);
        await h.screenCheck(page, `${width}x${height} five-step answers overlay, ${look}`, { demo: 'auto' });
      }
      await lookIn(page, h.DEFAULT_LOOK);
      await h.shot(page, `five-step-${width}-answers`);
      await page.locator('[data-reveal-overlay] [data-action="close-answers"]').scrollIntoViewIfNeeded();
      await h.sleep(400);
      await k.tap('[data-reveal-overlay] [data-action="close-answers"]');
      h.check(await page.locator('[data-reveal-overlay]').count() === 0 && await k.screenNow() === 'scored', `${width}: Close returns to the result card`);
      await k.close();
    },
  })),
  ...PHONES.map(([width, height]) => ({
    name: `result page at ${width}px for a five-step link in each look: one-decimal values, bars and bands, five tiers`,
    async run(h) {
      const domains = h.TABLE5.paths.BRWBR;
      const link = (look, over = {}) => `${RESULT_PATH}#${resultFragment({ score: 72, domains, tag: 42, date: boothDate(), teaser: h.TREE5.teaser, tiers: PLAN, look, ...over })}`;
      const p = await h.phone(link(h.DEFAULT_LOOK), { width, height });
      const { page } = p;
      for (const look of Object.keys(h.LOOKS)) {
        await page.evaluate((url) => { location.hash = new URL(url, location.href).hash; }, link(look));
        await page.waitForFunction((l) => document.documentElement.dataset.look === l && document.querySelector('.result-card'), look);
        await page.evaluate(() => document.fonts.ready);
        const tag = `${width}px five-step result page, ${look}`;
        checkRows(h, tag, await readRows(page), domains, (v) => v.toFixed(1));
        checkRadar(h, tag, await readRadar(page), domains, h.LOOKS[look].primary);
        const tiers = await page.$$eval('.tier-step', (els) => els.map((e) => ({ th: e.querySelector('.tier-step-n .bi-th').textContent, tier: e.dataset.tier })));
        h.check(h.same(tiers, PLAN.map((tier, i) => ({ th: `ขั้นที่ ${i + 1}`, tier }))), `${tag}: five steps, each with its tier (${tiers.map((t) => t.tier).join(', ')})`);
        await h.screenCheck(page, tag, { demo: 'auto', phone: true });
        if (look === h.DEFAULT_LOOK) await h.shot(page, `five-step-result-page-${width}`, { fullPage: true });
      }
      const three = { d1: 4, d2: 3, d3: 4, d4: 2, d5: 3, d6: 5, d7: 1 };
      await page.evaluate((url) => { location.hash = new URL(url, location.href).hash; }, link(h.DEFAULT_LOOK, { domains: three, tiers: PLAN.slice(0, 3) }));
      await page.waitForFunction(() => document.querySelectorAll('.tier-step').length === 3);
      checkRows(h, `${width}px three-step result page`, await readRows(page), three, String);
      await p.close();
    },
  })),
  {
    name: 'a start with no step_count (a backend older than five steps) plays three; a step_count outside 1-5 and a two-decimal domain stop the play',
    async run(h) {
      const { step_count: _, ...older } = h.START;
      const k = await h.kiosk({ stub: h.makeStub({ routes: { [START_KEY]: () => ({ status: 201, body: older }) } }) });
      await k.shell('start');
      await k.toVignette();
      await k.tap('[data-action="begin"]');
      const heads = [];
      const buttons = [];
      for (let n = 1; n <= 3; n++) {
        await k.screen('step');
        heads.push((await stepOf(k.page)).en);
        await k.answer(1);
        await k.screen('reply');
        buttons.push(await k.page.evaluate(() => document.querySelector('.play-actions [data-action]')?.dataset.action));
        await k.tap(`[data-action="${buttons[n - 1]}"]`);
      }
      await k.screen('scored');
      h.check(h.same(heads, ['Step 1 of 3', 'Step 2 of 3', 'Step 3 of 3']) && h.same(buttons, ['next', 'next', 'see-score'])
        && k.stub.of(SCORE_KEY)[0]?.body.answers.length === 3,
      `older backend: three steps, "Step n of 3", See my score after reply 3 (${heads.join(', ')}; ${buttons.join(', ')})`);
      checkRows(h, 'older backend result card', await readRows(k.page), h.SCORED.domains, String);
      await k.close();

      for (const bad of [0, 6, 2.5, '5', null]) {
        const s = await h.kiosk({ stub: h.makeStub({ routes: { [START_KEY]: () => ({ status: 201, body: { ...h.START, step_count: bad } }) } }), label: `step_count ${JSON.stringify(bad)}` });
        await s.shell('start');
        await s.tap('[data-action="start"]');
        await s.screen('teaser');
        await s.tap('[data-action="start-case"]');
        await s.screen('stopped');
        h.check(await s.screenNow() === 'stopped', `step_count ${JSON.stringify(bad)}: the start does not read, and the play stops`);
        await s.close();
      }

      const two = await h.kiosk({ stub: h.makeStub({ routes: { [SCORE_KEY]: (call) => h.scoredFor(call, { domains: { ...h.SCORED.domains, d5: 2.65 } }) } }), label: 'two-decimal domain' });
      await two.shell('start');
      await two.toVignette();
      await two.tap('[data-action="begin"]');
      for (let n = 1; n <= 3; n++) {
        await two.screen('step');
        await two.answer(1);
        await two.screen('reply');
        await two.tap(`[data-action="${n === 3 ? 'see-score' : 'next'}"]`);
      }
      await two.screen('stopped');
      h.check(await two.screenNow() === 'stopped' && await two.page.locator('.result-card').count() === 0, 'a score with a two-decimal domain does not read, and the play stops');
      await two.close();
    },
  },
];
