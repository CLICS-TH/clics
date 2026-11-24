import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRadar, checkRadar } from '../radar-check.mjs';

const SCORE_KEY = 'POST /booth/plays/:id/score';
const KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const STEPS = fileURLToPath(new URL('../../../physician-ui/public/booth-steps/', import.meta.url));
const js = (name) => fileURLToPath(new URL(`../../../physician-ui/public/js/${name}`, import.meta.url));

const dataUrl = (text) => `data:text/javascript,${encodeURIComponent(text)}`;
// booth-copy.js has no imports, and booth-result-link.js imports only it: a data: URL loads each as the module it is,
// with the link's one import pointed at the copy's data: URL.
const COPY_URL = dataUrl(await readFile(js('booth-copy.js'), 'utf8'));
const load = async (name) => import(dataUrl((await readFile(js(name), 'utf8')).replaceAll("'./booth-copy.js'", JSON.stringify(COPY_URL))));
const { parseResultFragment, resultFragment, boothDate, RESULT_PATH } = await load('booth-result-link.js');
const { BAND_LINES, MEASURES, SCALE_NOTE, bandOf } = await load('booth-bands.js');
const { WORKSHOP_COPY, WORKSHOP_PATH } = await load('booth-workshop.js');

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

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const GOOD = { s: 72, d: [4, 3, 4, 2, 3, 5, 1], t: 42, at: '2026-11-03', th: 'ชาวนา', en: 'A farmer' };

const GOOD2 = { s: 72, d: [4, 3, 4, 2, 3, 5, 1], t: 42, at: '2026-11-03', c: 'cap-adult', v: '1', p: 'BWR', a: 'v1.a.,v2.c.b,v3..a' };

/** Fragments that must show the plain message, each with what is wrong with it. */
const MALFORMED = [
  [`#r2.${b64({ ...GOOD2, c: 'Cap Adult' })}`, 'an r2 case id outside a-z, 0-9 and -'],
  [`#r2.${b64({ ...GOOD2, c: '../js/booth-play' })}`, 'an r2 case id that is a path'],
  [`#r2.${b64({ ...GOOD2, v: undefined })}`, 'an r2 link with no case version'],
  [`#r2.${b64({ ...GOOD2, v: '../1' })}`, 'a case version that is a path'],
  [`#r2.${b64({ ...GOOD2, th: 'ชาวนา', en: 'A farmer' })}`, 'an r2 link that also carries a teaser'],
  [`#r2.${b64({ ...GOOD2, a: 'v1.a.,v2.c.b' })}`, 'fewer picks than tiers'],
  [`#r2.${b64({ ...GOOD2, a: 'v1.a,v2.c.b,v3..a' })}`, 'a pick without its best field'],
  [`#r2.${b64({ ...GOOD2, p: undefined })}`, 'picks with no tiers'],
  [`#r1.${b64({ ...GOOD, a: 'v1.a.' , p: 'B' })}`, 'picks on an r1 link'],
  ['', 'no fragment'],
  ['#', 'an empty fragment'],
  ['#r1.', 'the format and no data'],
  ['#hello', 'no format'],
  ['#r1.%%%', 'characters base64url has none of'],
  [`#r1.${b64(GOOD).slice(0, 20)}`, 'a link cut short'],
  [`#r9.${b64(GOOD)}`, 'an unknown format'],
  [`#r1.${Buffer.from('not json').toString('base64url')}`, 'data that is not JSON'],
  [`#r1.${b64({ ...GOOD, s: 101 })}`, 'a score over 100'],
  [`#r1.${b64({ ...GOOD, d: [4, 3, 4, 2, 3, 5] })}`, 'six domains'],
  [`#r1.${b64({ ...GOOD, d: [4, 3, 4, 2, 3, 5, 6] })}`, 'a domain over 5'],
  [`#r1.${b64({ ...GOOD, d: [4, 3, 4, 2, 3, 5, 5.1] })}`, 'a one-decimal domain over 5'],
  [`#r1.${b64({ ...GOOD, d: [4, 3, 4, 2, 2.65, 5, 1] })}`, 'a domain with two decimals'],
  [`#r1.${b64({ ...GOOD, d: [4, 3, 4, -0.1, 3, 5, 1] })}`, 'a domain below 0'],
  [`#r1.${b64({ ...GOOD, d: [4, 3, 4, 2, '3', 5, 1] })}`, 'a domain that is a string'],
  [`#r1.${b64({ ...GOOD, t: 0 })}`, 'tag 0'],
  [`#r1.${b64({ ...GOOD, at: '3 Nov' })}`, 'a date not YYYY-MM-DD'],
  [`#r1.${b64({ ...GOOD, th: '' })}`, 'no Thai teaser'],
  [`#r1.${b64({ ...GOOD, at: { toString: null } })}`, 'a date that is an object with no toString'],
  [`#r1.${b64({ ...GOOD, th: { length: 3 } })}`, 'a teaser that is an object'],
  [`#r1.${b64({ ...GOOD, d: { length: 7, every: 1 } })}`, 'domains that are an object shaped like an array'],
  [`#r1.${b64([GOOD])}`, 'an array instead of an object'],
  [`#r1.${b64(42)}`, 'a number instead of an object'],
  [`#r1.${Buffer.from([0xff, 0xfe, 0x7b]).toString('base64url')}`, 'bytes that are not UTF-8'],
  [`#r1.${b64({ ...GOOD, p: '' })}`, 'an empty tier path'],
  [`#r1.${b64({ ...GOOD, p: 'BXW' })}`, 'a tier path with a letter that is no tier'],
  [`#r1.${b64({ ...GOOD, p: 'brw' })}`, 'a tier path in lower case'],
  [`#r1.${b64({ ...GOOD, p: 'BRWBRW' })}`, 'a tier path of six steps'],
  [`#r1.${b64({ ...GOOD, p: null })}`, 'a tier path that is null'],
  [`#r1.${b64({ ...GOOD, p: ['B', 'R', 'W'] })}`, 'a tier path that is an array'],
  [`#r1.${b64({ ...GOOD, l: 'fr' })}`, 'a look the kiosk does not have'],
  [`#r1.${b64({ ...GOOD, l: 'TH+EN' })}`, 'a look in upper case'],
  [`#r1.${b64({ ...GOOD, l: null })}`, 'a look that is null'],
  [`#r1.${b64({ ...GOOD, l: 'toString' })}`, 'a look named like an object key'],
];

const TRY_KEY = '[data-action="try-clics"]';
/** The "Try CLICS" link as the page draws it, resolved the way a tap would follow it. */
const tryLink = (page) => page.locator(TRY_KEY).evaluate((a) => ({ count: document.querySelectorAll('[data-action="try-clics"]').length,
  raw: a.getAttribute('href'), href: a.href, text: a.innerText.replace(/\s+/g, ' '), tag: a.tagName }));
const checkTry = (h, label, seen, origin) => h.check(seen.count === 1 && seen.tag === 'A' && seen.href === `${origin}/` && seen.raw === '/'
  && seen.text.includes('ลองใช้ CLICS') && seen.text.includes('Try CLICS'),
`${label}: one "Try CLICS" link to the Portal root, ${seen.href} (no /login, no play id, no query or fragment)`);

/** Opens the page's folds (booth-result.js fold), which it draws closed, so what sits in them is measured too. */
const openFolds = (page) => page.evaluate(() => { for (const d of document.querySelectorAll('details.result-fold')) d.open = true; });

/** The folds as drawn: each one's key, whether it is open, its summary's box and text, whether anything in it shows, and
 *  whether the page runs Practise next, the workshop, the two folds and "Try CLICS" in that order. */
const readFolds = (page) => page.evaluate(() => {
  const order = ['.practise-next', '[data-workshop]', '[data-fold="domains"]', '[data-fold="answers"]', '[data-action="try-clics"]'].map((s) => document.querySelector(s));
  return {
    folds: [...document.querySelectorAll('details.result-fold')].map((d) => {
      const sum = d.querySelector(':scope > summary');
      const r = sum.getBoundingClientRect();
      // A closed fold's content is laid out but not drawn (content-visibility), so ask whether it would be seen.
      return { key: d.dataset.fold, open: d.open, height: r.height, width: r.width, text: sum.innerText.replace(/\s+/g, ' ').trim(),
        shows: [...d.children].some((c) => c !== sum && c.checkVisibility()) };
    }),
    inOrder: order.every(Boolean) && order.every((e, i) => i === 0 || order[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING),
    screens: document.scrollingElement.scrollHeight / innerHeight,
  };
});

const WORKSHOP_KEY = '[data-action="workshop"]';
/** The workshop invitation as the phone page draws it: its link resolved the way a tap would follow it, and whether it
 *  sits above "Try CLICS" as the result's next step. */
const workshopLink = (page) => page.evaluate((key) => {
  const links = document.querySelectorAll(key);
  const a = links[0];
  const card = a?.closest('[data-workshop]');
  const tryLink = document.querySelector('[data-action="try-clics"]');
  return { count: links.length, cards: document.querySelectorAll('[data-workshop]').length, raw: a?.getAttribute('href'), href: a?.href, tag: a?.tagName,
    target: a?.getAttribute('target'), text: card?.innerText.replace(/\s+/g, ' ') ?? '', primary: a?.classList.contains('primary'),
    above: !!(card && tryLink && card.compareDocumentPosition(tryLink) & Node.DOCUMENT_POSITION_FOLLOWING), trySecondary: tryLink?.classList.contains('secondary') };
}, WORKSHOP_KEY);
const checkWorkshop = (h, label, seen, origin) => {
  // The card's own lines; scan and finish belong to the kiosk's invitation screen.
  const words = ['title', 'line', 'when', 'alongside', 'open'].flatMap((key) => [WORKSHOP_COPY[key].th, WORKSHOP_COPY[key].en]);
  h.check(seen.count === 1 && seen.cards === 1 && seen.tag === 'A' && seen.raw === WORKSHOP_PATH && seen.href === `${origin}${WORKSHOP_PATH}` && seen.target === null
    && words.every((w) => seen.text.replace(/\s+/g, '').includes(w.replace(/\s+/g, ''))),
  `${label}: one workshop card, Thai and English, whose link opens ${WORKSHOP_PATH} on the Portal in the same tab (${seen.href})`);
  h.check(seen.primary && seen.above && seen.trySecondary, `${label}: the workshop link is the primary next step, above a secondary "Try CLICS"`);
};

export default [
  {
    name: 'result link: the fragment round-trips the result, and every malformed fragment parses to null',
    async run(h) {
      const r = { score: 72.4, domains: h.SCORED.domains, tag: 42, date: '2026-11-03', teaser: h.TREE.teaser, tiers: ['best', 'weaker', 'reasonable'], look: 'en+th' };
      const back = parseResultFragment(`#${resultFragment(r)}`);
      h.check(h.same(back, { ...r, score: 72, caseId: null, caseVersion: null, picks: null }), 'link: score (rounded), d1-d7, tag, date, both teasers, the three tiers and the look come back as written');
      const untiered = parseResultFragment(`#${resultFragment({ ...r, tiers: null })}`);
      h.check(h.same(untiered, { ...r, score: 72, tiers: null, caseId: null, caseVersion: null, picks: null }), 'link: a result with no tiers comes back with tiers null');
      h.check(Object.keys(h.LOOKS).every((look) => parseResultFragment(`#${resultFragment({ ...r, look })}`)?.look === look), `link: each of the ${Object.keys(h.LOOKS).length} looks comes back as written`);
      h.check(h.same(parseResultFragment(`#r1.${b64(GOOD)}`), { score: 72, domains: { d1: 4, d2: 3, d3: 4, d4: 2, d5: 3, d6: 5, d7: 1 }, tag: 42, date: '2026-11-03',
        teaser: { th: 'ชาวนา', en: 'A farmer' }, tiers: null, look: h.DEFAULT_LOOK, caseId: null, caseVersion: null, picks: null }), `link: a link made before tiers and looks were kept (3-4 Nov, no p, no l) still reads, with tiers null and the look ${h.DEFAULT_LOOK}`);
      const picks = [{ variant: 'v1', chosen: 'a', best: null }, { variant: 'v2', chosen: 'c', best: 'b' }, { variant: 'v3', chosen: null, best: 'a' }];
      const r2 = { ...r, teaser: null, caseId: h.TREE.case_id, caseVersion: h.TREE.version, picks };
      h.check(h.same(parseResultFragment(`#${resultFragment(r2)}`), { ...r2, score: 72 }) && resultFragment(r2).startsWith('r2.'),
        'link: an r2 link (a case id and no teaser) round-trips each step\'s variant, pick (null when typed) and best option');
      h.check(h.same(parseResultFragment(`#${resultFragment({ ...r2, tiers: null })}`), { ...r2, score: 72, tiers: null, picks: null }),
        'link: an r2 link without tiers carries no picks');
      h.check(/^r1\.[A-Za-z0-9_-]+$/.test(resultFragment(r)), 'link: the fragment is base64url behind its format prefix, no character a scanner or browser rewrites');
      h.check(MALFORMED.every(([f]) => parseResultFragment(f) === null), `link: ${MALFORMED.length} malformed fragments all parse to null`);
      h.check(boothDate(new Date('2026-11-03T18:30:00Z')) === '2026-11-04', 'link: the date is Bangkok\'s day, not UTC\'s');
    },
  },
  ...[[1080, 1920], [2160, 3840]].map(([width, height]) => ({
    name: `result QR at ${width}x${height}: the result card's QR holds the result page with the play's result in the fragment only`,
    async run(h) {
      const k = await h.kiosk({ width, height });
      const { page } = k;
      await toResult(k);
      const qr = await page.locator('.result-card [data-keep-qr]').evaluate((f) => {
        const svg = f.querySelector('svg').getBoundingClientRect();
        return { url: f.dataset.resultUrl, w: svg.width, h: svg.height, caption: f.innerText };
      });
      const url = new URL(qr.url);
      h.check(url.origin === new URL(page.url()).origin && url.pathname === RESULT_PATH && url.search === '',
        `${width}: the QR opens ${RESULT_PATH} on the Portal with no query (${url.origin}${url.pathname}${url.search})`);
      const kept = parseResultFragment(url.hash);
      const scored = k.stub.of(SCORE_KEY)[0].body;
      const steps = h.stepsFor(h.TREE, scored);
      const tiers = steps.map((st) => st.tier);
      const picks = scored.asks.map((ask, i) => ({ variant: ask.variant, chosen: 'choice' in scored.answers[i] ? scored.answers[i].choice : null,
        best: steps[i].options.find((o) => o.tier === 'best')?.id ?? null }));
      h.check(h.same(kept, { score: 72, domains: h.SCORED.domains, tag: 42, date: boothDate(), teaser: null, tiers, look: h.DEFAULT_LOOK, caseId: h.TREE.case_id, caseVersion: h.TREE.version, picks }),
        `${width}: the fragment (r2) holds the score, d1-d7, tag, today's date, the drawn case's id and no teaser, the tier, variant, pick and best option of each step (${tiers}) and the look (${kept?.look})`);
      h.check(qr.url.length < 300, `${width}: the result link is ${qr.url.length} characters, so the QR stays sparse`);
      h.check(qr.w >= 320 * (width / 1080) - 1 && qr.w === qr.h, `${width}: the QR is square and ${Math.round(qr.w)} px wide`);
      h.check(qr.caption.includes('Scan to keep your result') && qr.caption.includes('สแกน'), `${width}: the QR is captioned in Thai and English`);
      const sent = k.stub.calls.filter((c) => JSON.stringify(c).includes(url.hash.slice(4, 40)));
      h.check(sent.length === 0, `${width}: no booth API call carried the result link`);
      const invite = await page.evaluate(() => document.querySelectorAll('[data-workshop], [data-action="workshop"], a[href*="workshop"]').length);
      h.check(invite === 0, `${width}: the kiosk's result card carries no workshop card or link (a touch screen link goes nowhere; ${invite} found)`);
      await h.screenCheck(page, `result card with the result QR ${width}x${height}`, { demo: true });
      await h.shot(page, `keep-qr-${width}`);
      await k.close();
    },
  })),
  {
    name: 'result page at 320px for every admitted case from an r2 link: each step\'s longest question and options fit',
    async run(h) {
      const admitted = new Set((await readdir(STEPS)).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')));
      const trees = (await h.caseTrees()).filter(([f, t]) => !f.includes('versions/') && admitted.has(`${t.case_id}@${t.version}`));
      h.check(trees.length === admitted.size, `${trees.length} admitted cases have step text (${[...admitted].join(', ')})`);
      // A Thai line breaks only between phrases, so rank by each text's longest phrase: that is what must fit a line.
      const len = (b) => Math.max(...b.th.split(/ +/).map((ph) => ph.length));
      const p = await h.phone(RESULT_PATH, { width: 320, height: 640 });
      for (const [file, tree] of trees) {
        let path = '';
        const picks = [];
        for (let i = 0; i < h.stepCount(tree); i++) {
          const bank = h.bankFor(tree, path);
          const variant = [...bank.variants].sort((x, y) => len(y.question) - len(x.question))[0];
          const longest = (os) => [...os].sort((x, y) => len(y.label) + len(y.line) - len(x.label) - len(x.line))[0];
          const best = longest(bank.options.filter((o) => o.tier === 'best'));
          const chosen = longest(bank.options.filter((o) => o.tier !== 'best')) ?? best;
          picks.push({ variant: variant.id, chosen: chosen.id, best: best.id });
          path += { best: 'B', reasonable: 'R', weaker: 'W' }[chosen.tier];
        }
        const tiers = [...path].map((c) => ({ B: 'best', R: 'reasonable', W: 'weaker' })[c]);
        const domains = Object.fromEntries(KEYS.map((k) => [k, 2]));
        await p.page.evaluate((f) => { location.hash = f; }, resultFragment({ score: 50, domains, tag: 7, date: '2026-11-19', tiers, look: 'th+en', caseId: tree.case_id, caseVersion: tree.version, picks }));
        await p.page.waitForFunction((n) => document.querySelectorAll('.result-steps .reveal-step').length === n, tiers.length);
        await openFolds(p.page);
        await h.screenCheck(p.page, `explained steps, ${file}, 320px`, { demo: 'auto', phone: true });
      }
      await p.close();
    },
  },
  ...[[375, 812], [320, 640]].map(([width, height]) => ({
    name: `result page at ${width}px from an r2 link: each step's question, the answer and its reason, the best option when missed, a typed answer, and the case's teaser`,
    async run(h) {
      // A five-step walk through cap-adult-5: step 2 taps a weaker option, step 4 is typed (the stub sorts it best).
      const tree = h.TREE5;
      const plan = [];
      let path = '';
      for (let i = 0; i < 5; i++) {
        const bank = h.bankFor(tree, path);
        const best = bank.options.find((o) => o.tier === 'best');
        const pickOf = i === 1 ? bank.options.find((o) => o.tier === 'weaker') : best;
        const typed = i === 3;
        plan.push({ bank, variant: bank.variants[0], given: typed ? null : pickOf, best });
        path += typed ? h.TYPED_TIER : { best: 'B', reasonable: 'R', weaker: 'W' }[pickOf.tier];
      }
      const tiers = [...path].map((c) => ({ B: 'best', R: 'reasonable', W: 'weaker' })[c]);
      const picks = plan.map((st) => ({ variant: st.variant.id, chosen: st.given?.id ?? null, best: st.best.id }));
      const domains = h.TABLE5.paths[path];
      const fragment = resultFragment({ score: 72, domains, tag: 42, date: '2026-11-19', tiers, look: 'th+en', caseId: tree.case_id, caseVersion: tree.version, picks });
      const p = await h.phone(`${RESULT_PATH}#${fragment}`, { width, height });
      const { page } = p;
      await page.waitForSelector('#result[data-rendered] .result-steps', { state: 'attached' });
      const seen = await page.evaluate(() => ({
        teaser: document.querySelector('.result-case .teaser')?.innerText,
        steps: [...document.querySelectorAll('.result-steps .reveal-step')].map((e) => ({
          tier: e.dataset.tier,
          question: e.querySelector('.reveal-question .bi-en')?.textContent,
          given: e.querySelector('.reveal-answer .reveal-given .bi-en')?.textContent,
          line: e.querySelector('.reveal-answer .reveal-line .bi-en')?.textContent ?? null,
          best: e.querySelector('.reveal-best .reveal-given .bi-en')?.textContent ?? null,
          bestLine: e.querySelector('.reveal-best .reveal-line .bi-en')?.textContent ?? null,
        })),
        tierList: document.querySelectorAll('.tier-step').length,
        scrollX: document.documentElement.scrollWidth - innerWidth,
      }));
      h.check(seen.teaser?.includes(tree.teaser.en), `${width}: the case teaser comes from the case's step text`);
      h.check(seen.steps.length === 5 && seen.tierList === 0, `${width}: five explained steps replace the tier list (${seen.steps.length}, ${seen.tierList})`);
      seen.steps.forEach((st, i) => {
        const want = plan[i];
        const missed = want.given && want.given.id !== want.best.id;
        h.check(st.tier === tiers[i] && st.question === want.variant.question.en
          && st.given === (want.given ? want.given.label.en : h.COPY.typedOwn.en) && st.line === (want.given ? want.given.line.en : null)
          && st.best === (missed || !want.given ? want.best.label.en : null) && st.bestLine === (missed || !want.given ? want.best.line.en : null),
        `${width}: step ${i + 1} shows its question, ${want.given ? 'the tapped answer and its reason' : 'that the answer was typed'}, the ${tiers[i]} tier${missed || !want.given ? ' and the best option with its reason' : ''}`);
      });
      h.check(seen.scrollX <= 0, `${width}: no sideways scroll (${seen.scrollX} px over)`);
      const closed = await readFolds(page);
      h.check(closed.folds.length === 2 && closed.folds.every((f) => !f.open && !f.shows) && closed.folds[1].text.includes(h.COPY.answersTitle.th) && closed.folds[1].text.includes(h.COPY.answersTitle.en),
        `${width}: the explained steps sit folded under "${h.COPY.answersTitle.en}", closed (${closed.screens.toFixed(1)} screens closed)`);
      await openFolds(page);
      await h.screenCheck(page, `explained result page ${width}px`, { demo: 'auto', phone: true });
      await h.shot(page, `result-page-steps-${width}`, { fullPage: true });
      // A link from another case version: an id the text lacks falls back to the tier list, never to wrong text.
      const stale = resultFragment({ score: 72, domains, tag: 42, date: '2026-11-19', tiers, look: 'th+en', caseId: tree.case_id, caseVersion: tree.version,
        picks: picks.map((k, i) => (i === 2 ? { ...k, variant: 'zz9' } : k)) });
      await page.evaluate((f) => { location.hash = f; }, stale);
      await page.waitForFunction(() => document.querySelectorAll('.tier-step').length === 5);
      h.check(await page.locator('.result-steps').count() === 0, `${width}: an id the case's text lacks shows the tier list, not explained steps`);
      await p.close();
    },
  })),
  ...[[375, 812], [320, 640]].map(([width, height]) => ({
    name: `result page at ${width}px: the score, radar, d1-d7 bars, band descriptors, tier per step, Try CLICS and demo label from the fragment, with no data call`,
    async run(h) {
      const domains = { d1: 1, d2: 3, d3: 5, d4: 0, d5: 2, d6: 4, d7: 3 };
      const tiers = ['reasonable', 'best', 'weaker'];
      const r = { score: 64, domains, tag: 7, date: '2026-11-03', teaser: h.TREE.teaser, tiers };
      const fragment = resultFragment(r);
      const p = await h.phone(`${RESULT_PATH}#${fragment}`, { width, height });
      const { page } = p;
      await page.waitForSelector('.result-card');
      await page.evaluate(() => document.fonts.ready);
      // Other domains and the answers are folded, closed, so the visitor's own feedback and the workshop come first.
      const folds = await readFolds(page);
      h.check(h.same(folds.folds.map((f) => f.key), ['domains', 'answers']) && folds.folds.every((f) => !f.open && !f.shows && f.height >= 44),
        `${width}: Other domains and the answers are folded and closed, each behind a summary at least 44 px tall (${folds.folds.map((f) => `${f.key} ${Math.round(f.width)}x${Math.round(f.height)}`).join(', ')}; ${folds.screens.toFixed(1)} screens)`);
      h.check(folds.folds[0]?.text.includes(h.COPY.otherDomains.th) && folds.folds[0].text.includes(h.COPY.otherDomains.en)
        && folds.folds[1]?.text.includes(h.COPY.stepTiers.th) && folds.folds[1].text.includes(h.COPY.stepTiers.en),
      `${width}: each fold is named in Thai and English (${folds.folds.map((f) => f.text).join(' | ')})`);
      h.check(folds.inOrder, `${width}: Practise next, then the workshop card, then the two folds, then "Try CLICS"`);
      await h.screenCheck(page, `result page ${width}px, folds closed`, { demo: 'auto', phone: true });
      await h.shot(page, `result-page-${width}`, { fullPage: true });
      // Each fold's mark is a chevron pointing down while it is closed, turned over (pointing up) once it is open.
      const turn = (open) => page.evaluate((o) => [...document.querySelectorAll('details.result-fold')].map((d) => {
        d.open = o;
        const mark = d.querySelector('summary .fold-mark');
        for (const a of mark.getAnimations()) a.finish();
        const m = new DOMMatrix(getComputedStyle(mark).transform === 'none' ? undefined : getComputedStyle(mark).transform);
        return { svg: mark.tagName === 'svg', path: mark.querySelector('path')?.getAttribute('d'), a: Math.round(m.a), d: Math.round(m.d) };
      }), open);
      const shut0 = await turn(false);
      const open0 = await turn(true);
      await turn(false);
      h.check([...shut0, ...open0].every((m) => m.svg && m.path === 'm6 9 6 6 6-6') && shut0.every((m) => m.a === 1 && m.d === 1) && open0.every((m) => m.a === -1 && m.d === -1),
        `${width}: each fold's mark is a chevron, pointing down closed and turned over to point up open (${JSON.stringify([shut0[0], open0[0]])})`);
      // The keyboard opens and closes a fold: Enter on its summary, then Space.
      await page.focus('[data-fold="domains"] > summary');
      await page.keyboard.press('Enter');
      const keyed = await page.evaluate(() => { const s = document.querySelector('[data-fold="domains"] > summary'); return { open: s.parentElement.open, ring: s.matches(':focus-visible') && getComputedStyle(s).outlineStyle !== 'none' }; });
      await page.keyboard.press(' ');
      const shut = await page.evaluate(() => document.querySelector('[data-fold="domains"]').open);
      h.check(keyed.open && keyed.ring && !shut, `${width}: Enter on a fold's summary opens it, with a focus ring, and Space closes it (${JSON.stringify({ ...keyed, shut })})`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await openFolds(page);
      const seen = await page.evaluate(() => ({
        score: document.querySelector('[data-score]')?.textContent,
        tag: document.querySelector('[data-tag]')?.innerText,
        date: document.querySelector('time')?.getAttribute('datetime'),
        teaser: document.querySelector('.result-case .teaser')?.innerText,
        labels: document.querySelectorAll('[data-demo-label]').length,
        label: document.querySelector('[data-demo-label]')?.innerText,
        rows: [...document.querySelectorAll('.result-card .domain')].map((e) => {
          const [row, name, value] = [e, e.querySelector('.domain-name'), e.querySelector('.domain-value')].map((x) => x.getBoundingClientRect());
          return {
            key: e.dataset.key, value: e.dataset.value, bar: e.querySelector('.domain-bar > span').getBoundingClientRect().width / e.querySelector('.domain-bar').getBoundingClientRect().width,
            th: e.querySelector('.domain-band .bi-th').textContent, en: e.querySelector('.domain-band .bi-en').textContent,
            mth: e.querySelector('.domain-measure .bi-th')?.textContent, men: e.querySelector('.domain-measure .bi-en')?.textContent,
            // The name across the row's whole width, the score on a line of its own under it.
            nameWide: name.width >= row.width - 1, valueUnder: value.top >= name.bottom - 1,
            text: e.textContent,
          };
        }),
        // The scale note's lines, each language, and whether each line that starts with a number keeps its clause on
        // the number's line.
        scale: Object.fromEntries(['th', 'en'].map((lang) => [lang, [...document.querySelectorAll(`.result-card .scale-note .bi-${lang} > .bi-line`)].map((l) => l.textContent)])),
        held: [...document.querySelectorAll('.result-card .scale-note .bi-line')].filter((l) => /^\d/.test(l.textContent)).map((l) => {
          const walk = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
          const at = (n, i) => { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); return r.getBoundingClientRect().top; };
          const first = walk.nextNode();
          const clause = first.data.indexOf('\u00a0') + 1;
          return clause > 0 && clause < first.data.length && Math.abs(at(first, 0) - at(first, clause)) < 2;
        }),
        next: [...document.querySelectorAll('.practise-next .domain')].map((e) => e.dataset.key),
        scrollX: document.documentElement.scrollWidth - innerWidth,
        smallest: Math.min(...[...document.querySelectorAll('.result-page *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
          .map((e) => parseFloat(getComputedStyle(e).fontSize))),
      }));
      h.check(seen.score === '64' && seen.tag === 'Player #007' && seen.date === '2026-11-03', `${width}: score 64, Player #007 and the date shown (${seen.score}, ${seen.tag}, ${seen.date})`);
      h.check(seen.teaser?.includes(h.TREE.teaser.th.split(' ')[0]) && seen.teaser.includes(h.TREE.teaser.en), `${width}: the case teaser in Thai and English`);
      h.check(seen.labels >= 1 && seen.label.includes(h.DEMO_LABEL.th) && seen.label.includes(h.DEMO_LABEL.en), `${width}: the demo label is on the page`);
      h.check(seen.rows.length === 7 && seen.rows.every((row) => Number(row.value) === domains[row.key]
        && Math.abs(row.bar - domains[row.key] / 5) < 0.02
        && row.th === h.unbroken(BAND_LINES[row.key][bandOf(domains[row.key])].th) && row.en === BAND_LINES[row.key][bandOf(domains[row.key])].en),
      `${width}: 7 rows, each bar at its score and carrying its domain's band line in Thai and English`);
      h.check(seen.rows.every((row) => row.mth === h.unbroken(MEASURES[row.key].th) && row.men === MEASURES[row.key].en),
        `${width}: every row says what its domain looks at, in Thai and English (booth-bands.js MEASURES)`);
      h.check(seen.rows.every((row) => row.nameWide && row.valueUnder),
        `${width}: each domain's name takes the row's width and its score a line of its own under it`);
      const room = { th: h.unbroken(h.COPY.littleRoom.th), en: h.COPY.littleRoom.en };
      const times = (text, part) => text.split(part).length - 1;
      h.check(seen.rows.every((row) => ['th', 'en'].every((lang) => times(row.text, room[lang]) === (['d5', 'd6', 'd7'].includes(row.key) ? 1 : 0))),
        `${width}: d5-d7 each say "${room.en}" once, in their tag, in Thai and English, and no other row says it`);
      h.check(h.same(seen.scale, { th: SCALE_NOTE.th.split('\n').map(h.unbroken), en: SCALE_NOTE.en.split('\n') }) && seen.held.length === 4 && seen.held.every(Boolean),
        `${width}: the 0-5 scale note sits above the domains in four lines a language, "0 …" and "5 …" each a line of its own with the number on its clause's line (${JSON.stringify(seen.scale.en)})`);
      h.check(h.same(seen.next, ['d4', 'd1']), `${width}: Practise next lists the two weakest of d1-d4 first (${seen.next})`);
      h.check(seen.scrollX <= 0, `${width}: no sideways scroll (${seen.scrollX} px over)`);
      h.check(seen.smallest >= 16, `${width}: no text under 16 px (smallest ${seen.smallest} px)`);
      h.check(p.requests.every((q) => !q.url.includes('#') && !q.url.includes(fragment.slice(3, 40))), `${width}: no request URL carries the fragment`);
      checkRadar(h, `${width}`, await readRadar(page), domains);
      const steps = await page.$$eval('.tier-step', (els) => els.map((e) => ({ n: e.innerText.replace(/\s+/g, ' '), tier: e.querySelector('.tier-chip')?.dataset.tier })));
      h.check(steps.length === 3 && steps.every((st, i) => st.tier === tiers[i] && st.n.includes(`ขั้นที่ ${i + 1}`) && st.n.includes(`Step ${i + 1}`)
        && st.n.includes(h.TIERS[tiers[i]].label.th) && st.n.includes(h.TIERS[tiers[i]].label.en)),
      `${width}: the tier of each step, in order, Thai and English (${steps.map((st) => st.tier).join(', ')})`);
      const tinted = await h.aiTinted(page, '.tier-chip');
      h.check(tinted.length === 0, `${width}: no tier chip wears an --ai-* colour${tinted.length ? ` (${[...new Set(tinted)].slice(0, 3).join('; ')})` : ''}`);
      const origin = new URL(page.url()).origin;
      checkTry(h, `${width}`, await tryLink(page), origin);
      checkWorkshop(h, `${width}`, await workshopLink(page), origin);
      for (const y of [0, 1e6]) {
        await page.evaluate((to) => document.scrollingElement.scrollTo(0, to), y);
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await h.screenCheck(page, `result page ${width}px, folds open`, { demo: 'auto', phone: true });
      await h.shot(page, `result-page-open-${width}`, { fullPage: true });
      await page.evaluate(() => document.querySelector('[data-workshop]').scrollIntoView({ block: 'center' }));
      await h.shot(page, `result-page-register-${width}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate((f) => { location.hash = f; }, `r1.${b64({ ...GOOD, s: 91 })}`);
      await page.waitForFunction(() => document.querySelector('[data-score]')?.textContent === '91');
      h.check(await page.locator('.tier-step').count() === 0 && await page.locator('[data-radar]').count() === 1,
        `${width}: a new fragment re-renders the page, and an old link with no tiers shows the radar and no tier list`);
      await p.close();
      // The page's own fragment is the result, so a link into a fold is a link to its text: the browser opens the fold.
      const inside = BAND_LINES.d5[bandOf(domains.d5)].en;
      const q = await h.phone(`${RESULT_PATH}#${fragment}:~:text=${encodeURIComponent(inside).replace(/-/g, '%2D')}`, { width, height });
      const opened = await q.page.waitForFunction(() => document.querySelector('[data-fold="domains"]')?.open, null, { timeout: 5000 }).then(() => true, () => false);
      h.check(opened, `${width}: a link to a line inside the closed Other domains fold ("${inside}") opens it`);
      await q.close();
    },
  })),
  {
    name: 'result page: a missing or malformed fragment shows a plain message, not an error',
    async run(h) {
      for (const [fragment, what] of MALFORMED) {
        const p = await h.phone(`${RESULT_PATH}${fragment}`);
        const { page } = p;
        await page.waitForSelector('[data-result-missing]');
        const text = await page.locator('[data-result-missing]').innerText();
        h.check(text.includes('This link does not hold a readable booth result') && await page.locator('.result-card').count() === 0,
          `missing: ${what} shows the plain message`);
        if (fragment === '') {
          checkTry(h, 'missing', await tryLink(page), new URL(page.url()).origin);
          for (const [w, ht] of [[375, 812], [320, 640]]) {
            await page.setViewportSize({ width: w, height: ht });
            await h.screenCheck(page, `missing result page ${w}px`, { demo: 'auto', phone: true });
            const smallest = await page.evaluate(() => Math.min(...[...document.querySelectorAll('.result-page *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
              .map((e) => parseFloat(getComputedStyle(e).fontSize))));
            h.check(smallest >= 16, `missing ${w}px: no text under 16 px (smallest ${smallest} px)`);
            await h.shot(page, `result-page-missing-${w}`);
          }
        }
        await p.close();
      }
    },
  },
];
