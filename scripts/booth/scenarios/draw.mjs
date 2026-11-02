import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { caseTreeProblems } = createRequire(import.meta.url)('../../../backend/src/booth-cases/tree-schema.js');
const CASES = fileURLToPath(new URL('../../../backend/src/booth-cases', import.meta.url));

const DRAW = 'POST /booth/draw';
const START = 'POST /booth/plays';
const SIZES = [{ width: 1080, height: 1920 }, { width: 2160, height: 3840 }];
const TEASER_BUDGET = { th: 120, en: 180 };
const COMBINING = /[ัิ-ฺ็-๎]/gu;
const widthOf = { th: (s) => s.replace(COMBINING, '').length, en: (s) => s.length };

const deal = (case_id, th, en) => ({ case_id, teaser: { th, en } });
const B = deal('case-b', 'หญิงอายุ 30 ปี ปวดท้องมา 2 วัน ที่ห้องฉุกเฉิน', 'A 30-year-old woman with abdominal pain for 2 days, seen in the emergency room');
const C = deal('case-c', 'เด็กชายอายุ 6 ปี ไอและหายใจเร็วมา 1 สัปดาห์ ที่คลินิกเด็ก', 'A 6-year-old boy with cough and fast breathing for a week, at a paediatric clinic');
const D = deal('case-d', 'ชายอายุ 70 ปี เหนื่อยง่ายขึ้นมา 1 เดือน ที่หน่วยปฐมภูมิ', 'A 70-year-old man who tires more easily over a month, at a primary care unit');

const text = (page, sel) => page.locator(sel).first().textContent({ timeout: 5000 });
const label = (size) => `${size.width}x${size.height}`;
const dealtCalls = (stub) => stub.of(DRAW);

/** A stub whose draws answer `list` in order, the last one for any call after it; `routes` merge over the defaults. */
const dealing = (h, list, routes = {}) => h.makeStub({ routes: {
  [DRAW]: (_call, calls) => ({ status: 200, body: list[Math.min(calls.filter((c) => c.key === DRAW).length, list.length) - 1] }),
  ...routes,
} });

/** Wait until the kiosk shows this teaser on the teaser screen (not the one it is leaving), then let it settle. */
async function shows(k, dealt) {
  await k.page.waitForFunction((th) => document.querySelector('[data-screen="teaser"] .teaser .bi-th')?.textContent === th, dealt.teaser.th, { timeout: 10_000 });
  await k.screen('teaser');
}

const readTeaserScreen = (page) => page.evaluate(() => {
  const root = document.querySelector('[data-screen="teaser"]');
  const t = (s) => root.querySelector(s)?.textContent ?? null;
  return {
    th: t('.teaser .bi-th'), en: t('.teaser .bi-en'),
    order: [...root.querySelectorAll('.teaser > span')].map((e) => e.lang),
    buttons: [...root.querySelectorAll('button')].map((b) => ({ action: b.dataset.action, th: b.querySelector('.bi-th')?.textContent, en: b.querySelector('.bi-en')?.textContent })),
    text: root.innerText,
  };
});

/** Lines used by the teaser's Thai and English, and the card's free height in Thai body lines. */
const measureFit = (page) => page.evaluate(() => {
  const th = document.querySelector('.teaser .bi-th');
  const en = document.querySelector('.teaser .bi-en');
  const card = document.querySelector('[data-screen="teaser"] .case-card');
  const body = document.querySelector('[data-screen="teaser"] .play-body');
  const lines = (e) => { const cs = getComputedStyle(e); return Math.round(e.getBoundingClientRect().height / parseFloat(cs.lineHeight)); };
  const cs = getComputedStyle(card);
  const inner = card.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const content = th.parentElement.getBoundingClientRect().height;
  const lh = parseFloat(getComputedStyle(th).lineHeight);
  const actions = [...document.querySelectorAll('[data-screen="teaser"] .play-actions button')];
  return {
    thLines: lines(th), enLines: lines(en), headroomLines: Math.floor((inner - content) / lh),
    cardScrolls: card.scrollHeight > card.clientHeight + 1, bodyScrolls: body.scrollHeight > body.clientHeight + 1,
    buttonsInside: actions.every((b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }),
  };
});

/** `words` joined by spaces while they fit `max`, then topped up letter by letter from `filler` to exactly `max` wide. */
function fillTo(lang, max, words, filler) {
  let s = '';
  for (const w of words) {
    const next = s ? `${s} ${w}` : w;
    if (widthOf[lang](next) > max) break;
    s = next;
  }
  for (const ch of filler) {
    if (widthOf[lang](s + ch) > max) break;
    s += ch;
  }
  return s;
}

const LONGEST = (() => {
  const th = fillTo('th', TEASER_BUDGET.th,
    ['ชายอายุ 58 ปี', 'มีอาการเจ็บแน่นหน้าอก', 'ร้าวไปที่แขนซ้ายและกราม', 'เป็นมา 2 ชั่วโมง', 'หลังตื่นนอนตอนเช้า', 'ที่ห้องฉุกเฉิน', 'โรงพยาบาลประจำอำเภอห่างไกล'],
    'จังหวัดนครศรีธรรมราชภาคใต้ของประเทศไทย');
  const en = fillTo('en', TEASER_BUDGET.en,
    ['A 58-year-old man', 'with chest tightness', 'spreading to the left arm and jaw', 'for 2 hours after waking this morning,', 'seen in the emergency department', 'of a remote district community hospital'],
    'in the southern region of the country');
  return deal('case-long', th, en);
})();

export default [
  ...SIZES.map((size) => ({
    name: `teaser at ${label(size)}, coarse pointer: the case's teaser word for word and two buttons`,
    async run(h) {
      const k = await h.kiosk({ ...size });
      const { page, stub } = k;
      await k.shell('start');
      await k.tap('[data-action="start"]');
      await k.screen('teaser');
      await h.screenCheck(page, `teaser ${label(size)}`);
      await h.shot(page, `teaser-${label(size)}`);
      const shown = await readTeaserScreen(page);
      h.check(h.same({ th: shown.th, en: shown.en }, h.DRAW.teaser) && h.same(shown.order, ['th', 'en']),
        'teaser: the case file\'s teaser, Thai then English, word for word');
      h.check(!shown.text.includes(h.KASE.vignette.th) && !shown.text.includes(h.KASE.vignette.en),
        'teaser: nothing of the vignette is on screen');
      h.check(h.same(shown.buttons.map((b) => b.action), ['start-case', 'reroll'])
        && h.same(shown.buttons.map((b) => ({ th: b.th, en: b.en })), [h.COPY.startCase, h.COPY.reroll]),
        `teaser: exactly two buttons, "${h.COPY.startCase.en}" then "${h.COPY.reroll.en}", Thai and English`);
      h.check(h.same(dealtCalls(stub).map((c) => c.body), [{ seen: [] }]), 'teaser: one draw, with an empty seen list');
      h.check(stub.of(START).length === 0, 'teaser: no play is started by a tap that only deals a case');
      await k.close();
    },
  })),
  ...SIZES.map((size) => ({
    name: `reroll at ${label(size)}: seen grows in order, resets on a repeat, and start posts the shown case`,
    async run(h) {
      const stub = dealing(h, [h.DRAW, B, C, B, D]);
      const k = await h.kiosk({ ...size, stub });
      const { page } = k;
      await k.shell('start');
      await k.tap('[data-action="start"]');
      await shows(k, h.DRAW);
      const seenBodies = () => dealtCalls(stub).map((c) => c.body);
      for (const [i, dealt] of [B, C, B, D].entries()) {
        await k.tap('[data-action="reroll"]');
        await shows(k, dealt);
        h.check(h.same(await readTeaserScreen(page).then((s) => ({ th: s.th, en: s.en })), dealt.teaser), `reroll ${i + 1}: shows the ${dealt.case_id} teaser, word for word`);
        await h.screenCheck(page, `reroll ${i + 1} ${label(size)}`);
        if (i === 0) await h.shot(page, `reroll-${label(size)}`);
      }
      const A = h.DRAW.case_id;
      h.check(h.same(seenBodies(), [{ seen: [] }, { seen: [A] }, { seen: [A, 'case-b'] }, { seen: [A, 'case-b', 'case-c'] }, { seen: ['case-b'] }]),
        `reroll: each draw sends the cases seen so far, in order, and a repeat restarts the list at the repeat (${JSON.stringify(seenBodies().map((b) => b.seen))})`);
      const stored = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, idb: (await indexedDB.databases()).length }));
      h.check(stored.local === 0 && stored.session === 0 && stored.idb === 0, 'reroll: the seen list is held in memory only, nothing is stored');
      await k.tap('[data-action="start-case"]');
      await k.screen('vignette');
      h.check(h.same(stub.of(START).map((c) => c.body), [{ case_id: 'case-d' }]), 'start: posts the case id of the teaser on screen, and nothing else');
      await k.close();
    },
  })),
  {
    name: 'start on a case that is no longer live deals another one, with no word to the visitor',
    async run(h) {
      const refuse = (_call, calls) => (calls.filter((c) => c.key === START).length === 1
        ? { status: 409, body: { error: 'That case is not available.', reason: 'case_off' } }
        : { status: 201, body: h.START });
      const stub = dealing(h, [h.DRAW, B], { [START]: refuse });
      const k = await h.kiosk({ stub });
      const { page } = k;
      await k.shell('start');
      await k.tap('[data-action="start"]');
      await shows(k, h.DRAW);
      await k.tap('[data-action="start-case"]');
      await shows(k, B);
      const sent = stub.of(START).map((c) => c.body);
      h.check(h.same(sent, [{ case_id: h.DRAW.case_id }]), 'case_off: the refused start named the case it was shown');
      h.check(h.same(stub.of(DRAW).map((c) => c.body), [{ seen: [] }, { seen: [h.DRAW.case_id] }]),
        'case_off: the redraw sends the list with the refused case in it');
      h.check(!(await page.locator('#booth').innerText()).includes(h.COPY.stopped.en), 'case_off: no stopped screen, no error shown');
      await h.screenCheck(page, 'case_off redraw');
      await k.tap('[data-action="start-case"]');
      await k.screen('vignette');
      h.check(h.same(stub.of(START).map((c) => c.body), [{ case_id: h.DRAW.case_id }, { case_id: 'case-b' }]), 'case_off: the second start names the new case');
      await k.close();
    },
  },
  {
    name: 'a draw or a start that fails stops the play: offline shows the lost-connection line, an http refusal does not',
    async run(h) {
      for (const [name, key, out, offline] of [
        ['draw offline', DRAW, 'abort', true],
        ['draw 503', DRAW, { status: 503, body: { error: 'x', reason: 'unavailable' } }, false],
        ['draw 403', DRAW, { status: 403, body: { error: 'x', reason: 'closed' } }, false],
        ['draw unreadable', DRAW, { status: 200, body: { case_id: 'case-x' } }, false],
        ['start 503', START, { status: 503, body: { error: 'x', reason: 'unavailable' } }, false],
        ['start 409 other reason', START, { status: 409, body: { error: 'x', reason: 'not_started' } }, false],
      ]) {
        const k = await h.kiosk({ stub: h.makeStub({ routes: { [key]: () => out } }), label: name });
        await k.shell('start');
        await k.tap('[data-action="start"]');
        if (key === START) { await k.screen('teaser'); await k.tap('[data-action="start-case"]'); }
        await k.screen('stopped');
        const shown = await k.page.locator('#booth').innerText();
        h.check(shown.includes(h.COPY.stopped.th) && shown.includes(h.COPY.stopped.en), `${name}: the play stops`);
        h.check(shown.includes(h.COPY.stoppedOffline.en) === offline, `${name}: ${offline ? 'says the connection was lost' : 'does not say the connection was lost'}`);
        await k.close();
      }
    },
  },
  ...SIZES.map((size) => ({
    name: `fit at ${label(size)}: the longest legal teaser and every real teaser fit with room for both buttons`,
    async run(h) {
      const real = await Promise.all((await readdir(CASES, { recursive: true })).filter((f) => /^[^/]+\/[^/]+\.json$/.test(f)).sort()
        .map(async (f) => [f, JSON.parse(await readFile(join(CASES, f), 'utf8')).teaser]));
      const legal = caseTreeProblems({ ...h.TREE, teaser: LONGEST.teaser }).filter((p) => p.startsWith('teaser'));
      const over = caseTreeProblems({ ...h.TREE, teaser: { th: `${LONGEST.teaser.th}ก`, en: `${LONGEST.teaser.en}x` } }).filter((p) => p.startsWith('teaser'));
      h.check(legal.length === 0 && widthOf.th(LONGEST.teaser.th) === TEASER_BUDGET.th && widthOf.en(LONGEST.teaser.en) === TEASER_BUDGET.en,
        `fit: the test teaser is the legal maximum, ${TEASER_BUDGET.th} Thai and ${TEASER_BUDGET.en} English characters, and the case-file contract accepts it${legal.length ? ` (${legal.join('; ')})` : ''}`);
      h.check(over.length === 2, 'fit: one character more in either language is rejected by the case-file contract');
      const list = [['longest legal', LONGEST], ['fixture', h.DRAW], ...real.map(([f, teaser]) => [f, { case_id: f.split('/')[1].slice(0, -5), teaser }])];
      const ids = new Set();
      const unique = list.filter(([, d]) => !ids.has(d.case_id) && ids.add(d.case_id));
      const k = await h.kiosk({ ...size, stub: dealing(h, unique.map(([, d]) => d)) });
      await k.shell('start');
      await k.tap('[data-action="start"]');
      for (const [i, [name, dealt]] of unique.entries()) {
        if (i > 0) await k.tap('[data-action="reroll"]');
        await shows(k, dealt);
        await h.screenCheck(k.page, `teaser fit ${name} ${label(size)}`);
        const fit = await measureFit(k.page);
        h.check(!fit.cardScrolls && !fit.bodyScrolls && fit.buttonsInside,
          `teaser fit ${name} ${label(size)}: ${fit.thLines} Thai + ${fit.enLines} English lines, ${fit.headroomLines} Thai lines of headroom, no scrolling, both buttons on screen`);
        if (i === 0) await h.shot(k.page, `teaser-longest-${label(size)}`);
      }
      await k.close();
    },
  })),
];
