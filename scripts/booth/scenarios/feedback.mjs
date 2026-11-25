import { inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

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

// The kiosk's feedback button and QR pop-up, and the result page's card (task 4, spec 2026-11-24 sections 1 and 2). The
// switch is window.CLICS_BOOTH_FEEDBACK in js/config.js, on in the repo since 2026-11-25: a scenario sets it for its own page.
const KIOSK_SIZES = [[1080, 1920], [2160, 3840]];
const JSQR = createRequire(import.meta.url).resolve('jsqr/dist/jsQR.js');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const GOOD2 = { s: 72, d: [4, 3, 4, 2, 3, 5, 1], t: 42, at: '2026-11-03', c: 'cap-adult', v: '1', p: 'BWR', a: 'v1.a.,v2.c.b,v3..a' };

/** Appends the switch to config.js for this page, as board.mjs does for the Landing QR, and reloads. The booth worker may
 *  have cached config.js already, and a page it controls never reaches page.route. */
async function switchOn(page, on = true) {
  await page.route('**/js/config.js', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: `${await res.text()}\nwindow.CLICS_BOOTH_FEEDBACK = ${on};\n` });
  });
  await page.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function toResult(k, steps = 3) {
  await k.shell('start');
  await k.toVignette();
  await k.tap('[data-action="begin"]');
  for (let n = 1; n <= steps; n++) {
    await k.screen('step');
    await k.answer(1);
    await k.screen('reply');
    await k.tap(`[data-action="${n === steps ? 'see-score' : 'next'}"]`);
  }
  await k.screen('scored');
  await k.shell('done');
}

/** Sets the look through the kiosk's own setLook and waits for the fonts and the entrance animations (result.mjs lookIn). */
const lookIn = (page, look) => page.evaluate(async (l) => {
  (await import('/js/booth-dom.js')).setLook(l);
  await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(r));
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
}, look);

/** What jsQR (the decoder scripts/booth/promo/qr-check.mjs uses) reads from a screenshot of `locator`, in a blank page of
 *  the same context: the kiosk's CSP would refuse the decoder script, and the screenshot is the QR as a camera sees it. */
async function decodeQr(k, locator) {
  const png = await locator.screenshot({ animations: 'disabled' });
  const page = await k.ctx.newPage();
  try {
    await page.addScriptTag({ content: await readFile(JSQR, 'utf8') });
    return await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const c = canvas.getContext('2d', { willReadFrequently: true });
      c.drawImage(img, 0, 0);
      const px = c.getImageData(0, 0, canvas.width, canvas.height);
      return window.jsQR(px.data, px.width, px.height)?.data ?? null;
    }, png.toString('base64'));
  } finally {
    await page.close();
  }
}

/** The phone result page on a GOOD2 (r2) link for cap-adult, its step text answered with an empty module (that case has
 *  none, and a 404 would log an error), the switch on or off. */
async function openResult(h, { on, width = 375, height = 812, look = 'th+en' }) {
  const p = await h.phone('/booth-result', { width, height });
  const { page } = p;
  await page.route('**/booth-steps/cap-adult@1.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export default null;' }));
  await page.route('**/js/config.js', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: `${await res.text()}\nwindow.CLICS_BOOTH_FEEDBACK = ${on};\n` });
  });
  await page.evaluate((f) => { location.hash = f; }, `r2.${b64({ ...GOOD2, l: look })}`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#result[data-rendered] [data-workshop]', { state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
  return p;
}

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
      h.check(privacy.includes('ไม่ถามชื่อ ไม่เก็บหมายเลขผู้เล่นหรือเวลาที่เล่น') && !privacy.includes('ไม่เก็บชื่อ') && privacy.includes('เก็บเพียงวันที่ส่งและเคสที่เล่น') && /date you send this and the case/.test(await page.locator('.fb-privacy .bi-en').evaluate((e) => e.textContent)), 'the privacy line says no name is asked, no player number or time of play is kept, and that only the date sent and the case played are kept');
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
  ...KIOSK_SIZES.map(([width, height]) => ({
    name: `feedback kiosk: the button opens one QR to the form, without tag or play id (${width}x${height})`,
    async run(h) {
      const k = await h.kiosk({ width, height });
      const { page } = k;
      await switchOn(page);
      await toResult(k);
      const label = `${width}x${height}`;
      h.check(await page.locator('[data-keep-qr] svg, [data-feedback-qr] svg').count() === 1 && await page.locator('[data-keep-qr] svg').count() === 1,
        `${label}: the scored screen shows exactly one QR before the tap, the keep-your-result one`);
      const button = page.locator('[data-action="feedback"]');
      h.check(await button.count() === 1, `${label}: one feedback button on the scored screen`);
      const btn = await button.evaluate((b) => ({ text: b.innerText, icon: b.querySelector('.booth-icon')?.dataset.icon, drawn: !!b.querySelector('.booth-icon svg'),
        bar: !!b.closest('.shell-bar'), beside: b.parentElement.querySelector('[data-action="done"]') !== null, h: b.getBoundingClientRect().height, kind: b.type }));
      h.check(btn.text.includes('ให้ความเห็น') && btn.text.includes('Give feedback') && btn.icon === 'message' && btn.drawn && btn.bar && btn.beside && btn.kind === 'button',
        `${label}: the button reads "ให้ความเห็น / Give feedback" with the message icon, in the bar beside Done (${JSON.stringify(btn)})`);
      await h.screenCheck(page, `${label} scored screen with the feedback button`, { demo: true });
      await h.shot(page, `feedback-scored-${width}`);
      const calls = k.stub.calls.length;
      await h.sleep(500);
      await k.tap('[data-action="feedback"]');
      await page.waitForSelector('[data-feedback-overlay] [data-feedback-qr] svg');
      await page.evaluate(() => document.fonts.ready);
      await h.sleep(300);
      const dialog = await page.locator('[data-feedback-overlay]').evaluate((o) => ({
        role: o.getAttribute('role'), modal: o.getAttribute('aria-modal'), label: o.getAttribute('aria-label'),
        focus: document.activeElement?.dataset.action ?? null, focusIn: o.contains(document.activeElement),
        qrs: o.querySelectorAll('[data-feedback-qr] svg').length, text: o.innerText.replace(/\s+/g, ' '),
        icons: [...o.querySelectorAll('.booth-icon')].map((i) => `${i.dataset.icon}:${!!i.querySelector('svg')}`),
      }));
      h.check(dialog.role === 'dialog' && dialog.modal === 'true' && dialog.focus === 'close-feedback' && dialog.focusIn,
        `${label}: a modal dialog, focus moved to its Close (${dialog.role}, ${dialog.modal}, ${dialog.focus})`);
      h.check(dialog.qrs === 1, `${label}: exactly one QR inside the overlay (${dialog.qrs})`);
      h.check(['ช่วยเราปรับปรุง CLICS', 'Help us improve CLICS', '1 นาที', 'ไม่ระบุตัวตน', 'สแกนด้วยกล้องมือถือ', 'Scan with your phone camera'].every((t) => dialog.text.includes(t)),
        `${label}: title, the two tags and the caption, TH and EN (${dialog.text})`);
      h.check(dialog.icons.includes('clock:true') && dialog.icons.includes('lock:true'), `${label}: the tags carry the clock and lock icons, drawn (${dialog.icons})`);
      h.check(k.stub.calls.length === calls, `${label}: opening it made no booth API call (${k.stub.calls.length - calls})`);
      const qr = page.locator('[data-feedback-overlay] [data-feedback-qr] svg');
      const url = await page.locator('[data-feedback-qr]').getAttribute('data-feedback-url');
      const origin = new URL(page.url()).origin;
      const look = await page.evaluate(() => document.documentElement.dataset.look);
      const expected = `${origin}/booth-feedback.html#c=${h.TREE.case_id}&l=${encodeURIComponent(look)}`;
      h.check(url === expected, `${label}: the link is the form with the case and the look in the fragment (${url})`);
      const rest = url.slice(origin.length);
      h.check(!/tag|play|player|\b42\b|6f1c2d3e/i.test(rest) && !rest.includes(h.PLAY_ID) && new URL(url).search === '',
        `${label}: the link carries no tag, no play id and no query (${rest})`);
      const read = await decodeQr(k, qr);
      const box = await qr.evaluate((s) => { const r = s.getBoundingClientRect(); return { w: r.width, h: r.height, fill: getComputedStyle(s.querySelector('path')).fill }; });
      h.check(read === expected, `${label}: a QR decoder reads the overlay's QR back as the link (${box.w}x${box.h} px, modules ${box.fill}): ${read}`);
      h.check(box.fill === 'rgb(169, 88, 62)' && box.w === box.h, `${label}: the modules are the accent, the QR is square`);
      await h.screenCheck(page, `${label} feedback overlay`, { demo: false });
      await h.shot(page, `feedback-overlay-${width}`);
      await k.tap('[data-feedback-overlay] [data-action="close-feedback"]');
      h.check(await page.locator('[data-feedback-overlay]').count() === 0 && await k.screenNow() === 'scored', `${label}: Close returns to the scored screen`);
      h.check(await page.evaluate(() => document.activeElement?.dataset.action) === 'feedback', `${label}: focus returns to the feedback button`);
      await k.close();
    },
  })),
  {
    name: 'feedback kiosk: the button, beside Done, leaves the card and its leaderboard row above the fold in every look, three and five steps, both sizes',
    async run(h) {
      const domains = Object.fromEntries(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map((d) => [d, 1]));
      for (const [width, height] of KIOSK_SIZES) {
        for (const steps of [3, 5]) {
          const tree = steps === 5 ? h.TREE5 : h.TREE;
          const stub = h.makeStub({ tree, ...(steps === 5 ? { table: h.TABLE5 } : {}), routes: { 'POST /booth/plays/:id/score': (call) => h.scoredFor(call, { domains, rank_today: 3, rank_event: 5 }, tree) } });
          const k = await h.kiosk({ width, height, stub });
          const { page } = k;
          await switchOn(page);
          await toResult(k, steps);
          for (const look of Object.keys(h.LOOKS)) {
            await lookIn(page, look);
            const tag = `${width}x${height} ${steps} steps, ${look}`;
            const fit = await page.evaluate(() => {
              const rect = (s) => document.querySelector(s).getBoundingClientRect();
              const fold = Math.min(innerHeight, ...['.play-body', '.result-more'].map((s) => rect(s).bottom));
              const f = rect('[data-action="feedback"]');
              const d = rect('[data-action="done"]');
              const over = f.right > d.left + 0.5 || Math.abs(f.top - d.top) > 1 || Math.abs(f.height - d.height) > 1 ? 1 : 0;
              return { fold: Math.round(fold), feedbackBottom: Math.round(f.bottom), feedbackW: Math.round(f.width), doneW: Math.round(d.width), over, screenH: innerHeight, next: Math.round(rect('.practise-next').bottom),
                board: Math.round(rect('.result-card .result-board-row').bottom), others: Math.round(rect('.other-domains').top),
                column: document.querySelector('#booth').getBoundingClientRect().width };
            });
            h.check(fit.over === 0, `${tag}: the button shares Done's row, at its height, and does not overlap it`);
            h.check(fit.next <= fit.fold && fit.board <= fit.fold && fit.others >= fit.fold - 0.5 && fit.feedbackBottom <= fit.screenH && Math.abs(fit.feedbackW - fit.doneW) <= 1,
              `${tag}: Practise next and the leaderboard row stay above the fold, Other domains below it, the two buttons are half the bar each (button bottom ${fit.feedbackBottom}/${fit.screenH}, next ${fit.next}, board ${fit.board}, others ${fit.others}, fold ${fit.fold}; ${Math.round((fit.fold - fit.board) * 1080 / fit.column)}u to spare; widths ${fit.feedbackW}/${fit.doneW})`);
            await h.screenCheck(page, `result card with the feedback button ${tag}`, { demo: true });
            if (steps === 5 && look === 'th+en') await h.shot(page, `feedback-fold-${width}`);
          }
          await k.close();
        }
      }
    },
  },
  {
    name: 'feedback kiosk: Escape, the backdrop and the Close button close it and focus stays inside',
    async run(h) {
      const k = await h.kiosk();
      const { page } = k;
      await switchOn(page);
      await toResult(k);
      const open = async () => {
        await h.sleep(450);
        await k.tap('[data-action="feedback"]');
        await page.waitForSelector('[data-feedback-overlay] [data-feedback-qr] svg');
        await h.sleep(450);
      };
      const isOpen = () => page.locator('[data-feedback-overlay]').count().then((n) => n === 1);
      const focusOn = () => page.evaluate(() => document.activeElement?.dataset.action ?? document.activeElement?.tagName);
      await open();
      await page.keyboard.press('Tab');
      h.check(await focusOn() === 'close-feedback', `Tab stays on Close, the dialog's only control (${await focusOn()})`);
      await page.keyboard.press('Shift+Tab');
      h.check(await focusOn() === 'close-feedback', `Shift+Tab stays on Close (${await focusOn()})`);
      await page.keyboard.press('Escape');
      h.check(!(await isOpen()) && await focusOn() === 'feedback', `Escape closes it and focus returns to the button (${await focusOn()})`);
      await open();
      const card = await page.locator('[data-feedback-overlay] > *').first().boundingBox();
      await page.touchscreen.tap(card.x / 2, card.y / 2);
      await h.sleep(100);
      h.check(!(await isOpen()) && await focusOn() === 'feedback', `a tap on the backdrop closes it and focus returns (${await focusOn()})`);
      await open();
      await page.touchscreen.tap(card.x + card.width / 2, card.y + card.height / 2);
      await h.sleep(100);
      h.check(await isOpen(), 'a tap on the card itself leaves it open');
      await k.tap('[data-feedback-overlay] [data-action="close-feedback"]');
      h.check(!(await isOpen()) && await focusOn() === 'feedback', 'the Close button closes it and focus returns');
      await k.close();
    },
  },
  {
    name: "feedback kiosk: the pop-up stays up for the scored screen's 45 s of no touch, and that screen's reset removes it",
    async run(h) {
      const k = await h.kiosk();
      const { page } = k;
      await switchOn(page);
      // The clock goes in before the scored screen is drawn, so its idle timer (booth-idle.js, 45 s) runs on it too.
      await page.clock.install();
      await toResult(k);
      await h.sleep(450);
      await k.tap('[data-action="feedback"]');
      await page.waitForSelector('[data-feedback-overlay] [data-feedback-qr] svg');
      const isOpen = () => page.locator('[data-feedback-overlay]').count().then((n) => n === 1);
      await page.clock.fastForward(44_000);
      h.check(await isOpen() && await k.screenNow() === 'scored', '44 s after the tap, with no touch, the pop-up is still up over the scored screen');
      await page.clock.fastForward(1_500);
      await page.waitForFunction(() => !document.querySelector('[data-feedback-overlay]') && document.querySelector('#booth [data-screen="scored"]') === null, null, { timeout: 15_000 });
      h.check(!(await isOpen()) && await k.screenNow() !== 'scored', "at 45 s the scored screen's reset reloads the page and the pop-up is gone with it");
      await k.close();
    },
  },
  {
    name: 'feedback kiosk: the QR carries the look the visitor chose',
    async run(h) {
      const k = await h.kiosk();
      const { page } = k;
      await switchOn(page);
      await toResult(k);
      await page.evaluate(async () => (await import('/js/booth-dom.js')).setLook('en'));
      await h.sleep(450);
      await k.tap('[data-action="feedback"]');
      await page.waitForSelector('[data-feedback-overlay] [data-feedback-qr] svg');
      const url = await page.locator('[data-feedback-qr]').getAttribute('data-feedback-url');
      h.check(url === `${new URL(page.url()).origin}/booth-feedback.html#c=${h.TREE.case_id}&l=en`, `the look "en" is in the fragment (${url})`);
      await k.close();
    },
  },
  {
    name: 'feedback kiosk: switched off shows nothing (the repo ships it on)',
    async run(h) {
      const k = await h.kiosk();
      const { page } = k;
      await switchOn(page, false);
      await toResult(k);
      h.check(await page.locator('[data-action="feedback"], [data-feedback-overlay], [data-feedback-qr]').count() === 0, 'no feedback button, overlay or QR on the scored screen with the flag off');
      const config = await readFile(new URL('../../../physician-ui/public/js/config.js', import.meta.url), 'utf8');
      h.check(/window\.CLICS_BOOTH_FEEDBACK = true;/.test(config), 'js/config.js ships the switch on (live since 2026-11-25)');
      await k.close();
      const p = await openResult(h, { on: false });
      h.check(await p.page.locator('[data-feedback]').count() === 0, 'no feedback card on the result page with the flag off');
      const loaded = await p.page.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));
      h.check(!loaded.some((f) => /booth-play\.js|booth-feedback-/.test(f)) && loaded.some((f) => f.endsWith('booth-result.js')),
        `with the flag off the result page loads no booth-play.js and no booth-feedback-*.js (${loaded.filter((f) => f.endsWith('.js')).map((f) => f.split('/').pop())})`);
      await p.close();
    },
  },
  ...[[375, 812], [320, 640]].map(([width, height]) => ({
    name: `feedback result page: the card links to the form for this case (${width}px)`,
    async run(h) {
      const p = await openResult(h, { on: true, width, height, look: 'en+th' });
      const { page } = p;
      const card = await page.locator('[data-feedback]').evaluate((c) => ({
        tag: c.tagName, href: c.getAttribute('href'), text: c.innerText.replace(/\s+/g, ' '), n: document.querySelectorAll('[data-feedback]').length,
        after: c.compareDocumentPosition(document.querySelector('[data-workshop]')) & Node.DOCUMENT_POSITION_PRECEDING ? 'after-workshop' : 'before-workshop',
        icons: [...c.querySelectorAll('svg')].length,
      }));
      const origin = new URL(page.url()).origin;
      h.check(card.tag === 'A' && card.n === 1 && card.href === `${origin}/booth-feedback.html#c=cap-adult&l=en%2Bth`, `${width}: one link card to the form with the case and the look (${card.href})`);
      h.check(card.href === await page.evaluate(async () => (await import('/js/booth-feedback-link.js')).feedbackUrl({ caseId: 'cap-adult', look: 'en+th' })), `${width}: it is exactly feedbackUrl({caseId, look})`);
      h.check(!/tag|play|42|score/i.test(card.href.slice(origin.length)), `${width}: the link names no tag, play or score (${card.href})`);
      const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname.split('/').pop()));
      h.check(!loaded.includes('booth-play.js') && !loaded.includes('booth-api.js') && !loaded.includes('booth-board.js'), `${width}: even with the flag on, the card does not pull in the kiosk play engine (${loaded.filter((f) => f.startsWith('booth-')).join(', ')})`);
      h.check(card.text.includes('ช่วยประเมิน CLICS') && card.text.includes('1 นาที') && card.after === 'after-workshop', `${width}: the card reads "ช่วยประเมิน CLICS (1 นาที)" and sits after the workshop card (${card.text})`);
      await h.screenCheck(page, `${width} result page with the feedback card`, { phone: true, demo: false });
      await h.shot(page, `feedback-card-${width}`, { fullPage: true });
      await p.close();
    },
  })),
];
