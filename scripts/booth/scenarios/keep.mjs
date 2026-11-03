import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SCORE_KEY = 'POST /booth/plays/:id/score';
const KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const js = (name) => fileURLToPath(new URL(`../../../physician-ui/public/js/${name}`, import.meta.url));

// Both have no imports, so a data: URL loads each as the module it is.
const load = async (name) => import(`data:text/javascript,${encodeURIComponent(await readFile(js(name), 'utf8'))}`);
const { parseResultFragment, resultFragment, boothDate, RESULT_PATH } = await load('booth-result-link.js');
const { BAND_LINES, bandOf } = await load('booth-bands.js');

async function toResult(k) {
  await k.shell('start');
  await k.toVignette();
  await k.tap('[data-action="begin"]');
  for (let n = 1; n <= 3; n++) {
    await k.screen('step');
    await k.tap('.options > [data-option]:nth-child(1)');
    await k.screen('reply');
    await k.tap(`[data-action="${n === 3 ? 'see-score' : 'next'}"]`);
  }
  await k.screen('scored');
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const GOOD = { s: 72, d: [4, 3, 4, 2, 3, 5, 1], t: 42, at: '2026-11-03', th: 'ชาวนา', en: 'A farmer' };

/** Fragments that must show the plain message, each with what is wrong with it. */
const MALFORMED = [
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
  [`#r1.${b64({ ...GOOD, t: 0 })}`, 'tag 0'],
  [`#r1.${b64({ ...GOOD, at: '3 Nov' })}`, 'a date not YYYY-MM-DD'],
  [`#r1.${b64({ ...GOOD, th: '' })}`, 'no Thai teaser'],
  [`#r1.${b64({ ...GOOD, at: { toString: null } })}`, 'a date that is an object with no toString'],
  [`#r1.${b64({ ...GOOD, th: { length: 3 } })}`, 'a teaser that is an object'],
  [`#r1.${b64({ ...GOOD, d: { length: 7, every: 1 } })}`, 'domains that are an object shaped like an array'],
  [`#r1.${b64([GOOD])}`, 'an array instead of an object'],
  [`#r1.${b64(42)}`, 'a number instead of an object'],
  [`#r1.${Buffer.from([0xff, 0xfe, 0x7b]).toString('base64url')}`, 'bytes that are not UTF-8'],
];

export default [
  {
    name: 'result link: the fragment round-trips the result, and every malformed fragment parses to null',
    async run(h) {
      const r = { score: 72.4, domains: h.SCORED.domains, tag: 42, date: '2026-11-03', teaser: h.TREE.teaser };
      const back = parseResultFragment(`#${resultFragment(r)}`);
      h.check(h.same(back, { ...r, score: 72 }), 'link: score (rounded), d1-d7, tag, date and both teasers come back as written');
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
      h.check(h.same(kept, { score: 72, domains: h.SCORED.domains, tag: 42, date: boothDate(), teaser: h.TREE.teaser }),
        `${width}: the fragment holds the score, d1-d7, tag, today's date and the drawn case's teaser`);
      h.check(qr.w >= 320 * (width / 1080) - 1 && qr.w === qr.h, `${width}: the QR is square and ${Math.round(qr.w)} px wide`);
      h.check(qr.caption.includes('Scan to keep your result') && qr.caption.includes('สแกน'), `${width}: the QR is captioned in Thai and English`);
      const sent = k.stub.calls.filter((c) => JSON.stringify(c).includes(url.hash.slice(4, 40)));
      h.check(sent.length === 0, `${width}: no booth API call carried the result link`);
      await h.screenCheck(page, `result card with the result QR ${width}x${height}`, { demo: true });
      await h.shot(page, `keep-qr-${width}`);
      await k.close();
    },
  })),
  ...[[375, 812], [320, 640]].map(([width, height]) => ({
    name: `result page at ${width}px: the score, d1-d7 bars, band descriptors and demo label from the fragment, with no data call`,
    async run(h) {
      const domains = { d1: 1, d2: 3, d3: 5, d4: 0, d5: 2, d6: 4, d7: 3 };
      const r = { score: 64, domains, tag: 7, date: '2026-11-03', teaser: h.TREE.teaser };
      const fragment = resultFragment(r);
      const p = await h.phone(`${RESULT_PATH}#${fragment}`, { width, height });
      const { page } = p;
      await page.waitForSelector('.result-card');
      const seen = await page.evaluate(() => ({
        score: document.querySelector('[data-score]')?.textContent,
        tag: document.querySelector('[data-tag]')?.textContent,
        date: document.querySelector('time')?.getAttribute('datetime'),
        teaser: document.querySelector('.result-case .teaser')?.innerText,
        labels: document.querySelectorAll('[data-demo-label]').length,
        label: document.querySelector('[data-demo-label]')?.innerText,
        rows: [...document.querySelectorAll('.result-card .domain')].map((e) => ({
          key: e.dataset.key, value: e.dataset.value, bar: e.querySelector('.domain-bar > span').getBoundingClientRect().width / e.querySelector('.domain-bar').getBoundingClientRect().width,
          th: e.querySelector('.domain-band .bi-th').textContent, en: e.querySelector('.domain-band .bi-en').textContent,
        })),
        next: [...document.querySelectorAll('.practise-next .domain')].map((e) => e.dataset.key),
        scrollX: document.documentElement.scrollWidth - innerWidth,
        smallest: Math.min(...[...document.querySelectorAll('.result-page *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
          .map((e) => parseFloat(getComputedStyle(e).fontSize))),
      }));
      h.check(seen.score === '64' && seen.tag === 'Booth #007' && seen.date === '2026-11-03', `${width}: score 64, Booth #007 and the date shown (${seen.score}, ${seen.tag}, ${seen.date})`);
      h.check(seen.teaser?.includes(h.TREE.teaser.th.split(' ')[0]) && seen.teaser.includes(h.TREE.teaser.en), `${width}: the case teaser in Thai and English`);
      h.check(seen.labels >= 1 && seen.label.includes(h.DEMO_LABEL.th) && seen.label.includes(h.DEMO_LABEL.en), `${width}: the demo label is on the page`);
      h.check(seen.rows.length === 7 && seen.rows.every((row) => Number(row.value) === domains[row.key]
        && Math.abs(row.bar - domains[row.key] / 5) < 0.02
        && row.th === BAND_LINES[row.key][bandOf(domains[row.key])].th && row.en === BAND_LINES[row.key][bandOf(domains[row.key])].en),
      `${width}: 7 rows, each bar at its score and carrying its domain's band line in Thai and English`);
      h.check(h.same(seen.next, ['d4', 'd1']), `${width}: Practise next lists the two weakest first (${seen.next})`);
      h.check(seen.scrollX <= 0, `${width}: no sideways scroll (${seen.scrollX} px over)`);
      h.check(seen.smallest >= 16, `${width}: no text under 16 px (smallest ${seen.smallest} px)`);
      h.check(p.requests.every((q) => !q.url.includes('#') && !q.url.includes(fragment.slice(3, 40))), `${width}: no request URL carries the fragment`);
      await h.shot(page, `result-page-${width}`);
      await page.evaluate((f) => { location.hash = f; }, `r1.${b64({ ...GOOD, s: 91 })}`);
      await page.waitForFunction(() => document.querySelector('[data-score]')?.textContent === '91');
      h.check(true, `${width}: a new fragment re-renders the page`);
      await p.close();
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
        if (fragment === '') await h.shot(page, 'result-page-missing');
        await p.close();
      }
    },
  },
];
