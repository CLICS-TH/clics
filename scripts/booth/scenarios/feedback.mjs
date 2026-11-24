import { inflateSync } from 'node:zlib';

// The anonymous feedback form on a phone (physician-ui/public/booth-feedback.html, spec 2026-11-24). Each scenario opens
// the page the way the kiosk's QR does, with the case and look in the fragment, against a stub of GET and POST
// /booth/feedback, so no backend runs and nothing is stored.
const GET = 'GET /booth/feedback';
const POST = 'POST /booth/feedback';
const PATH = '/booth-feedback.html#c=cap-adult&l=th';
const THAI_FLOOR = 15.36;
const MIN_TAP = 44;

const closedReply = { status: 403, body: { error: 'The booth is closed.', reason: 'closed' } };
const commentReply = { status: 503, body: { error: 'The comment could not be checked. Send again, or send without it.', reason: 'comment_unavailable' } };
const stubFor = (h, routes = {}) => h.makeStub({ routes: { [GET]: () => ({ status: 200, body: { open: true } }), [POST]: () => ({ status: 201, body: {} }), ...routes } });

/** The answers the helpers below give: a chip, a face, two chips, then four sliders by key (ArrowRight from the
 *  middle, End, Home, ArrowRight): easy 4, real 5, fair 1, use 6. */
const GIVEN = { role: 'resident', mood: 'enjoyed', felt_like: ['exam', 'game'], easy: 4, real: 5, fair: 1, use: 6 };
const KEYS = { easy: 'ArrowRight', real: 'End', fair: 'Home', use: 'ArrowRight' };

const key = async (page, id) => {
  const range = page.locator(`[data-q="${id}"] input[type="range"]`);
  await range.focus();
  await page.keyboard.press(KEYS[id]);
};
const pick = (page, id, value) => page.locator(`[data-q="${id}"] [data-value="${value}"]`).tap();
const ready = (page) => page.waitForSelector('[data-feedback-form]', { state: 'visible' });
/** The first six answers (everything but `use`). */
async function answerSix(page) {
  await pick(page, 'role', GIVEN.role);
  await pick(page, 'mood', GIVEN.mood);
  for (const v of GIVEN.felt_like) await pick(page, 'felt_like', v);
  for (const id of ['easy', 'real', 'fair']) await key(page, id);
}
const answerAll = async (page) => { await answerSix(page); await key(page, 'use'); };
/** The colour a slider's thumb ring is painted in, read from a screenshot: getComputedStyle cannot see inside the
 *  browser's own slider thumb (it answers the UA default whatever the page's CSS says). One CSS pixel in the middle of the
 *  ring (the 3 px border sits 12 to 15 px from the thumb's centre, which is where the value puts it). */
async function thumbBorder(page, id) {
  const range = page.locator(`[data-q="${id}"] input[type="range"]`);
  await range.scrollIntoViewIfNeeded();
  const b = await range.boundingBox();
  const r = await range.evaluate((e) => ({ min: Number(e.min), max: Number(e.max), value: Number(e.value) }));
  const cx = b.x + 15 + ((r.value - r.min) / (r.max - r.min)) * (b.width - 30);
  const png = await page.screenshot({ clip: { x: cx + 13, y: b.y + b.height / 2, width: 1, height: 1 }, animations: 'disabled' });
  const px = pngPixel(png);
  return `rgb(${px.join(', ')})`;
}
/** The first pixel of an 8-bit RGB or RGBA PNG (Playwright's screenshot). Whatever its row filter, a first pixel has no
 *  neighbour to the left or above, so its bytes are the colour as they stand. */
function pngPixel(png) {
  let pos = 8;
  const data = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    if (png.toString('ascii', pos + 4, pos + 8) === 'IDAT') data.push(png.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  return [...inflateSync(Buffer.concat(data)).subarray(1, 4)];
}
const EDGE = 'rgb(138, 133, 120)';
const ACCENT = 'rgb(169, 88, 62)';
const visible = (page, selector) => page.locator(selector).first().isVisible();
const submitOn = (page) => page.locator('[data-submit]').isEnabled();

export default [
  {
    name: 'feedback: submit stays off until the seven are answered, and untouched sliders send nothing',
    async run(h) {
      const stub = stubFor(h);
      const p = await h.phone(PATH, { stub });
      const { page } = p;
      await ready(page);
      h.check(!(await submitOn(page)), 'nothing answered: submit is off');
      h.check(await thumbBorder(page, 'easy') === EDGE && await thumbBorder(page, 'use') === EDGE, `before any touch the thumbs are grey, not the accent (${await thumbBorder(page, 'easy')})`);
      const idle = await page.evaluate(() => [...document.querySelectorAll('[data-q] input[type="range"]')].map((r) => ({
        idle: r.classList.contains('idle'), text: r.getAttribute('aria-valuetext'), readout: r.closest('.fb-slider').querySelector('.fb-readout').innerText.trim(),
      })));
      h.check(idle.length === 4 && idle.every((s) => s.idle && s.text === 'ยังไม่ได้ตอบ' && s.readout.startsWith('ลากเพื่อตอบ')), `four sliders start grey and unanswered (${JSON.stringify(idle[0])})`);
      await answerSix(page);
      h.check(!(await submitOn(page)), 'six answered, the last slider untouched: submit stays off');
      h.check(await thumbBorder(page, 'easy') === ACCENT && await thumbBorder(page, 'use') === EDGE, `an answered slider's thumb turns accent, the untouched one stays grey (${await thumbBorder(page, 'easy')}, ${await thumbBorder(page, 'use')})`);
      h.check((await page.locator('[data-progress]').innerText()).includes('ตอบแล้ว 6 จาก 7'), 'the header counts six of seven');
      await key(page, 'use');
      h.check(await submitOn(page), 'the seventh, by keyboard on its slider: submit is on');
      await page.locator('[data-submit]').tap();
      await page.waitForSelector('[data-thanks]', { state: 'visible' });
      const posts = stub.of(POST);
      h.check(posts.length === 1, `one POST (${posts.length})`);
      h.check(h.same(posts[0]?.body, { form: 'fb-1', case_id: 'cap-adult', answers: GIVEN }), `the body is the answers, the case and the form version, and nothing else (${JSON.stringify(posts[0]?.body)})`);
      h.check(!('comment' in (posts[0]?.body ?? {})), 'an empty comment sends no comment key');
      h.check(!JSON.stringify(posts[0]?.body).match(/tag|play|time|date/i), 'the body names no tag, play or time');
    },
  },
  {
    name: "feedback: a slider's face and words follow the value",
    async run(h) {
      const p = await h.phone(PATH, { stub: stubFor(h) });
      const { page } = p;
      await ready(page);
      const range = page.locator('[data-q="easy"] input[type="range"]');
      const bubble = page.locator('[data-q="easy"] .fb-bubble');
      const drag = async (toRight) => {
        await range.scrollIntoViewIfNeeded();
        const b = await range.boundingBox();
        const y = b.y + b.height / 2;
        await page.mouse.move(b.x + b.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(toRight ? b.x + b.width - 1 : b.x + 1, y, { steps: 8 });
        await page.mouse.up();
      };
      const greyFace = await bubble.innerHTML();
      await drag(false);
      const low = { value: await range.inputValue(), text: await range.getAttribute('aria-valuetext'), face: await bubble.innerHTML(), idle: await bubble.evaluate((e) => e.classList.contains('idle')) };
      await drag(true);
      const high = { value: await range.inputValue(), text: await range.getAttribute('aria-valuetext'), face: await bubble.innerHTML() };
      h.check(low.value === '1' && low.text.startsWith('น้อยมาก'), `dragged to 1: "${low.text}"`);
      h.check(high.value === '5' && high.text.startsWith('มากที่สุด'), `dragged to 5: "${high.text}"`);
      h.check(!low.idle && low.face !== high.face && low.face !== greyFace, 'the face is a different drawing at 1, at 5 and before the first touch');
      h.check(low.face.includes('M12 17.5l7-3') && !high.face.includes('M12 17.5l7-3'), 'the low end has raised inner brows, the high end none');
      const readout = await page.locator('[data-q="easy"] .fb-readout').innerText();
      h.check(readout.includes('มากที่สุด') && readout.includes('5/5'), `the words under it follow: "${readout.replace(/\s+/g, ' ')}"`);
    },
  },
  {
    name: 'feedback: one answer per page',
    async run(h) {
      const stub = stubFor(h);
      const p = await h.phone(PATH, { stub });
      const { page } = p;
      await ready(page);
      await answerAll(page);
      const release = stub.hold(POST);
      await page.locator('[data-submit]').scrollIntoViewIfNeeded();
      const b = await page.locator('[data-submit]').boundingBox();
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      await h.sleep(40);
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      await h.sleep(150);
      h.check(!(await submitOn(page)), 'while the send is in flight, submit is off');
      release();
      await page.waitForSelector('[data-thanks]', { state: 'visible' });
      h.check(stub.of(POST).length === 1, `two taps, one POST (${stub.of(POST).length})`);
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('[data-thanks]', { state: 'visible' });
      h.check(!(await visible(page, '[data-feedback-form]')) && !(await visible(page, '[data-closed]')), 'after a reload the thanks shows and the form does not');
      h.check(stub.of(POST).length === 1 && stub.of(GET).length === 1, `the reload asked nothing more (${stub.of(GET).length} GET, ${stub.of(POST).length} POST)`);
      h.check(await page.evaluate(() => sessionStorage.getItem('clics.booth.feedback.sent')) === '1', 'the flag is in sessionStorage');
      h.check(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 1), 'nothing else is stored');
    },
  },
  {
    name: 'feedback: a closed booth shows the closed notice',
    async run(h) {
      const stub = stubFor(h, { [GET]: () => ({ status: 200, body: { open: false } }) });
      const p = await h.phone(PATH, { stub });
      const { page } = p;
      await page.waitForSelector('[data-closed]', { state: 'visible' });
      const copy = await page.locator('[data-closed]').innerText();
      h.check(copy.includes('บูทปิดรับแบบประเมินแล้ว ขอบคุณที่ร่วมเล่น'), `the notice reads "${copy.replace(/\s+/g, ' ').slice(0, 60)}"`);
      h.check(!(await visible(page, '[data-feedback-form]')) && !(await visible(page, '[data-q]')) && !(await visible(page, '[data-thanks]')), 'no question is shown');

      const stub2 = stubFor(h, { [POST]: () => closedReply });
      const q = await h.phone(PATH, { stub: stub2 });
      await ready(q.page);
      await answerAll(q.page);
      await q.page.locator('[data-submit]').tap();
      await q.page.waitForSelector('[data-closed]', { state: 'visible' });
      h.check(!(await visible(q.page, '[data-feedback-form]')) && stub2.of(POST).length === 1, 'a send answered "closed" shows the closed notice too, and the form is gone');
      h.check(await q.page.evaluate(() => sessionStorage.length === 0), 'a refused send sets no sent flag');
    },
  },
  {
    name: 'feedback: a failed comment check offers retry and send-without',
    async run(h) {
      let n = 0;
      const stub = stubFor(h, { [POST]: () => (++n <= 2 ? commentReply : { status: 201, body: {} }) });
      const p = await h.phone(PATH, { stub });
      const { page } = p;
      await ready(page);
      await answerAll(page);
      await page.locator('[data-q="comment"] textarea').fill('เคสดีมาก');
      await page.locator('[data-submit]').tap();
      await page.waitForSelector('[data-comment-failed]', { state: 'visible' });
      const kept = () => page.evaluate(() => ({
        pressed: [...document.querySelectorAll('[data-q] [aria-pressed="true"]')].map((b) => b.dataset.value),
        sliders: [...document.querySelectorAll('[data-q] input[type="range"]')].map((r) => (r.classList.contains('idle') ? null : Number(r.value))),
        comment: document.querySelector('[data-q="comment"] textarea').value,
      }));
      const want = { pressed: ['resident', 'enjoyed', 'exam', 'game'], sliders: [4, 5, 1, 6], comment: 'เคสดีมาก' };
      h.check(h.same(await kept(), want), `every answer and the comment stay (${JSON.stringify(await kept())})`);
      const names = await page.locator('[data-comment-failed] button').allInnerTexts();
      h.check(names.length === 2 && names[0].includes('ลองอีกครั้ง') && names[1].includes('ส่งโดยไม่มีความเห็น'), `both buttons show (${names.map((t) => t.replace(/\s+/g, ' ')).join(' | ')})`);
      await page.locator('[data-action="retry"]').tap();
      await page.waitForFunction(() => document.querySelectorAll('[data-comment-failed]:not([hidden])').length === 1 && !document.querySelector('[data-action="retry"]').disabled);
      h.check(stub.of(POST).length === 2 && stub.of(POST)[1].body.comment === 'เคสดีมาก', 'try again posts the comment again');
      await page.locator('[data-action="send-without"]').tap();
      await page.waitForSelector('[data-thanks]', { state: 'visible' });
      const last = stub.of(POST)[2]?.body;
      h.check(stub.of(POST).length === 3 && !('comment' in last) && h.same(last.answers, GIVEN), `send without the comment posts the same answers and no comment (${JSON.stringify(last)})`);
    },
  },
  {
    name: 'feedback: a refused send keeps the answers and can be sent again',
    async run(h) {
      let n = 0;
      const stub = stubFor(h, { [POST]: () => (++n === 1 ? { status: 429, body: { error: 'Too many answers from this network. Try again in a minute.' } } : { status: 201, body: {} }) });
      const p = await h.phone(PATH, { stub });
      const { page } = p;
      await ready(page);
      await answerAll(page);
      await page.locator('[data-submit]').tap();
      await page.waitForSelector('[data-send-failed]', { state: 'visible' });
      h.check(await submitOn(page) && (await page.locator('[data-send-failed]').innerText()).includes('ลองอีกครั้ง'), 'a 429 shows "ลองอีกครั้ง" and submit is on again');
      h.check(await page.locator('[data-q] [aria-pressed="true"]').count() === 4 && await page.locator('[data-q] input.idle').count() === 0, 'the answers are still there');
      await page.locator('[data-submit]').tap();
      await page.waitForSelector('[data-thanks]', { state: 'visible' });
      h.check(stub.of(POST).length === 2, 'the second send went through');
    },
  },
  {
    name: 'feedback: a swipe over a slider is not an answer',
    async run(h) {
      const p = await h.phone(PATH, { stub: stubFor(h) });
      const { page } = p;
      await ready(page);
      const range = page.locator('[data-q="easy"] input[type="range"]');
      await range.scrollIntoViewIfNeeded();
      const b = await range.boundingBox();
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      const cdp = await page.context().newCDPSession(page);
      const touch = (type, at) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: at }] });
      const before = await page.evaluate(() => scrollY);
      await touch('touchStart', y);
      for (let i = 1; i <= 8; i++) { await touch('touchMove', y - (200 * i) / 8); await h.sleep(16); }
      await touch('touchEnd', y - 200);
      await h.sleep(300);
      const after = await page.evaluate(() => ({
        scrolled: scrollY, idle: document.querySelector('[data-q="easy"] input').classList.contains('idle'),
        text: document.querySelector('[data-q="easy"] input').getAttribute('aria-valuetext'), progress: document.querySelector('[data-progress]').innerText,
      }));
      h.check(after.scrolled > before, `the swipe scrolled the page (${before} -> ${after.scrolled}), so it was a real swipe`);
      h.check(after.idle && after.text === 'ยังไม่ได้ตอบ' && after.progress.includes('ตอบแล้ว 0 จาก 7'), `the slider is still unanswered and the count is still 0 of 7 (${JSON.stringify(after)})`);
    },
  },
  {
    name: 'feedback: the link and the faces keep their contract',
    async run(h) {
      const p = await h.phone(PATH, { stub: stubFor(h) });
      const { page } = p;
      await ready(page);
      const r = await page.evaluate(async () => {
        const link = await import('/js/booth-feedback-link.js');
        const faces = await import('/js/booth-faces.js');
        const copy = await import('/js/booth-copy.js');
        const svgs = [...faces.MOODS.map(faces.moodFace), faces.scaleFace(0), faces.scaleFace(0.5), faces.scaleFace(0.7), faces.scaleFace(0.95), faces.scaleFace(1)];
        return {
          path: link.FEEDBACK_PATH, origin: location.origin,
          url: link.feedbackUrl({ caseId: 'cap-adult', look: 'th' }), urlDefault: link.feedbackUrl({ caseId: 'cap-adult', look: copy.DEFAULT_LOOK }),
          parsed: link.parseFeedbackFragment('#c=cap-adult&l=th'),
          roundTrip: link.parseFeedbackFragment(new URL(link.feedbackUrl({ caseId: 'cap-adult', look: copy.DEFAULT_LOOK })).hash),
          badCase: link.parseFeedbackFragment('#c=Cap_Adult&l=th').caseId, longCase: link.parseFeedbackFragment(`#c=${'a'.repeat(65)}`).caseId,
          badLook: link.parseFeedbackFragment('#c=cap-adult&l=zz').look, none: link.parseFeedbackFragment(''), defaultLook: copy.DEFAULT_LOOK,
          moods: faces.MOODS, every: svgs.every((s) => /^<svg class="face" viewBox="0 0 48 48"[^>]*aria-hidden="true"/.test(s) && !/[^\x00-\x7f]/.test(s)),
          distinct: new Set(faces.MOODS.map(faces.moodFace)).size, brows: svgs.slice(5).map((s) => s.includes('M12 17.5l7-3')),
          cheeks: svgs.slice(5).map((s) => s.includes('r="3"')), happy: svgs.slice(5).map((s) => s.includes('M13 22q4-5 8 0')),
        };
      });
      h.check(r.path === '/booth-feedback.html' && r.url === `${r.origin}/booth-feedback.html#c=cap-adult&l=th`, `feedbackUrl is absolute from the origin, with the case and look in the fragment (${r.url})`);
      h.check(h.same(r.parsed, { caseId: 'cap-adult', look: 'th' }) && h.same(r.roundTrip, { caseId: 'cap-adult', look: r.defaultLook }), `the default look "${r.defaultLook}" survives the URL (${r.urlDefault})`);
      h.check(r.badCase === null && r.longCase === null && r.badLook === r.defaultLook && h.same(r.none, { caseId: null, look: r.defaultLook }), 'a case id outside /^[a-z0-9-]{1,64}$/ is null, an unknown look is the default');
      const privacy = await page.locator('.fb-privacy').innerText();
      h.check(privacy.includes('ไม่เก็บชื่อ หมายเลขผู้เล่น หรือเวลาที่เล่น') && privacy.includes('เก็บเพียงวันที่ส่งและเคสที่เล่น') && /date you send this and the case/.test(await page.locator('.fb-privacy .bi-en').evaluate((e) => e.textContent)), 'the privacy line says no name, player number or time of play, and that only the date sent and the case played are kept');
      h.check(h.same(r.moods, ['stressed', 'confused', 'neutral', 'enjoyed', 'excited']), 'MOODS lists the five moods in order');
      h.check(r.every && r.distinct === 5, 'every face is a 48-unit SVG, aria-hidden, with no emoji or other non-ASCII, and the five moods differ');
      h.check(h.same(r.brows, [true, false, false, false, false]) && h.same(r.cheeks, [false, false, true, true, true]) && h.same(r.happy, [false, false, false, true, true]),
        `scaleFace: brows at t <= 0.1, cheeks at t >= 0.7, happy eyes at t >= 0.95 (${JSON.stringify([r.brows, r.cheeks, r.happy])})`);
    },
  },
  {
    name: 'feedback: readable on phones',
    async run(h) {
      for (const [width, height] of [[320, 640], [375, 812], [430, 932]]) {
        const label = `${width}x${height}`;
        const stub = stubFor(h);
        const p = await h.phone(PATH, { width, height, stub });
        const { page } = p;
        await ready(page);
        const measureText = () => page.evaluate((floor) => {
          const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
          const small = [...document.body.querySelectorAll('*')].filter((e) => shown(e)
            && ([...e.childNodes].some((n) => n.nodeType === 3 && n.data.trim()) || e.matches('textarea')))
            .filter((e) => parseFloat(getComputedStyle(e).fontSize) < floor).map((e) => `${parseFloat(getComputedStyle(e).fontSize)}px "${e.textContent.trim().slice(0, 30)}"`);
          const taps = [...document.querySelectorAll('button, textarea, input')].filter(shown).map((e) => e.getBoundingClientRect())
            .filter((r) => r.width < 44 || r.height < 44).map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`);
          const emoji = /\p{Extended_Pictographic}/u.test(document.body.innerText);
          const svgs = [...document.querySelectorAll('svg')].filter((s) => s.getAttribute('aria-hidden') !== 'true').length;
          return { small, taps, emoji, svgs, wide: document.documentElement.scrollWidth - innerWidth };
        }, THAI_FLOOR);
        const check = async (state) => {
          // Chips, faces and the submit button ease their colours in: measure once they have stopped, as the kiosk's screen() does.
          await page.evaluate(() => document.fonts.ready);
          await h.sleep(300);
          await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 10_000 });
          await h.screenCheck(page, `${label} ${state}`, { phone: true, demo: false });
          const f = await measureText();
          h.check(f.small.length === 0, `${label} ${state}: every text is >= ${THAI_FLOOR}px${f.small.length ? ` (${f.small.slice(0, 3).join('; ')})` : ''}`);
          h.check(f.taps.length === 0, `${label} ${state}: every button, field and slider is >= ${MIN_TAP}px each way${f.taps.length ? ` (${f.taps.slice(0, 3).join(', ')})` : ''}`);
          h.check(!f.emoji && f.svgs === 0 && f.wide <= 1, `${label} ${state}: no system emoji, every drawing aria-hidden, no sideways scroll`);
        };
        await check('blank');
        await h.shot(page, `feedback-${label}-blank`, { fullPage: true });
        await answerAll(page);
        await page.locator('[data-q="comment"] textarea').fill('เคสดีมาก');
        await page.evaluate(() => window.scrollTo(0, 0));
        await check('answered');
        await h.shot(page, `feedback-${label}-answered`, { fullPage: true });
        await page.locator('[data-submit]').tap();
        await page.waitForSelector('[data-thanks]', { state: 'visible' });
        await page.evaluate(() => window.scrollTo(0, 0));
        await check('thanks');
        await h.shot(page, `feedback-${label}-thanks`);
        await p.close();
        const q = await h.phone(PATH, { width, height, stub: stubFor(h, { [GET]: () => ({ status: 200, body: { open: false } }) }) });
        await q.page.waitForSelector('[data-closed]', { state: 'visible' });
        await h.screenCheck(q.page, `${label} closed`, { phone: true, demo: false });
        await q.close();
      }
    },
  },
];
