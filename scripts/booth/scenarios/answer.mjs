const REPLY_KEY = 'POST /booth/plays/:id/reply';
const SCORE_KEY = 'POST /booth/plays/:id/score';
const STATUS_KEY = 'GET /booth/status';
const SIZES = [[1080, 1920], [2160, 3840]];

const opt = (n) => `.options > [data-option]:nth-child(${n})`;
const pressed = (page) => page.$$eval('.options > [data-option]', (els) => els.map((e) => e.getAttribute('aria-pressed')));
const hasBoth = (text, pair) => text.includes(pair.th) && text.includes(pair.en);
const startOvers = (page) => page.locator('[data-action="start-over"]').count();
const confirms = (page) => page.locator('[data-leave-confirm]').count();

async function toStep(k) {
  await k.shell('start');
  await k.toVignette();
  await k.tap('[data-action="begin"]');
  await k.screen('step');
}

async function toLastReply(k) {
  await toStep(k);
  for (let n = 1; n <= 3; n++) {
    await k.answer(1);
    await k.screen('reply');
    if (n < 3) {
      await k.tap('[data-action="next"]');
      await k.screen('step');
    }
  }
}

/** Tap Start over and wait out the confirm's ghost-tap guard. */
async function openConfirm(k) {
  await k.tap('[data-action="start-over"]');
  await k.page.waitForSelector('[data-leave-confirm]', { timeout: 10_000 });
  await k.page.evaluate(() => document.fonts.ready);
  await k.page.waitForTimeout(400);
}

/** The status the play shows while it waits: its text and whether it carries the dots. */
const waitStatus = (page) => page.evaluate(() => {
  const s = document.querySelector('#booth [data-screen] [role="status"]');
  return { text: s?.innerText ?? '', dots: !!s?.querySelector('.waiting-dots') };
});

export default [
  ...SIZES.map(([width, height]) => ({
    name: `select then Send at ${width}x${height}: a tap highlights an option, another tap moves the highlight, only Send sends`,
    async run(h) {
      const k = await h.kiosk({ width, height });
      const { page, stub } = k;
      await toStep(k);
      const ids = await page.$$eval('.options > [data-option]', (els) => els.map((e) => e.dataset.option));
      const send = page.locator('[data-action="send"]');
      const boxes = () => page.$$eval('.step-sheet, .options > [data-option], [data-action="type-own"], [data-action="send"]',
        (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); }));
      const sheetMotion = () => page.locator('.step-sheet').evaluate((e) => getComputedStyle(e).animationName);
      const before = await boxes();
      const rise = await sheetMotion();
      h.check(h.same(await pressed(page), ['false', 'false', 'false']) && await send.isDisabled(), 'step: no option is chosen and Send waits for one');

      await k.tap(opt(1));
      await page.waitForSelector(`${opt(1)}[aria-pressed="true"]`, { timeout: 10_000 });
      h.check(h.same(await pressed(page), ['true', 'false', 'false']) && !(await send.isDisabled()) && stub.of(REPLY_KEY).length === 0,
        'tap A: A is highlighted, Send is enabled, and no reply request was made');
      h.check(h.same(await boxes(), before), 'tap A: the highlight moves nothing on the step (sheet, options, Type my own and Send keep their boxes)');
      const settled = await sheetMotion();
      h.check(rise === 'booth-rise' && settled === 'none', `the step sheet rises when the step is drawn and not again on a choice (${rise}, then ${settled})`);
      await h.screenCheck(page, `step with A chosen, ${width}x${height}`);

      await h.sleep(400);
      await k.tap(opt(1));
      await h.sleep(400);
      h.check(h.same(await pressed(page), ['true', 'false', 'false']) && stub.of(REPLY_KEY).length === 0, 'tap A again: A stays chosen (a tap is not a toggle) and nothing is sent');

      await k.tap(opt(3));
      await page.waitForSelector(`${opt(3)}[aria-pressed="true"]`, { timeout: 10_000 });
      await h.sleep(1000);
      h.check(h.same(await pressed(page), ['false', 'false', 'true']) && await k.screenNow() === 'step' && stub.of(REPLY_KEY).length === 0,
        'tap C: the highlight moves from A to C, and a second later the step is still up with no reply request');
      await h.screenCheck(page, `step with C chosen, ${width}x${height}`);
      if (width === 1080) await h.shot(page, 'step-chosen');

      await k.tap('[data-action="send"]');
      await k.screen('reply');
      const sent = stub.of(REPLY_KEY);
      h.check(sent.length === 1 && h.same(sent[0].body.answers, [{ choice: ids[2] }]),
        `Send: exactly one reply request, and it names C (${JSON.stringify(sent.map((c) => c.body.answers))})`);
      await k.close();
    },
  })),
  {
    name: 'Start over: on the vignette, step, typing and reply; Keep playing or the scrim leaves the play as it was; Leave reloads with no request',
    async run(h) {
      const k = await h.kiosk();
      const { page, stub } = k;
      await k.shell('start');
      await k.tap('[data-action="start"]');
      await k.screen('teaser');
      h.check(await startOvers(page) === 0, 'teaser: no Start over before a play has begun');
      await k.tap('[data-action="start-case"]');
      await k.screen('vignette');
      h.check(await startOvers(page) === 1, 'vignette: Start over is there');
      await k.tap('[data-action="begin"]');
      await k.screen('step');
      h.check(await startOvers(page) === 1, 'step: Start over is there');
      await k.choose(1);

      const calls = stub.calls.length;
      await openConfirm(k);
      const dialog = await page.evaluate(() => {
        const o = document.querySelector('[data-leave-confirm]');
        const box = (s) => { const r = o.querySelector(s).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
        return { role: o.getAttribute('role'), modal: o.getAttribute('aria-modal'), focus: document.activeElement?.dataset.action,
          leave: box('[data-action="leave"]'), keep: box('[data-action="keep-playing"]'), text: o.innerText };
      });
      h.check(hasBoth(dialog.text, h.COPY.leaveTitle) && hasBoth(dialog.text, h.COPY.leaveLine) && hasBoth(dialog.text, h.COPY.leave)
        && hasBoth(dialog.text, h.COPY.keepPlaying), 'confirm: asks to leave and start over, says the play gets no score, offers Leave and Keep playing, TH and EN');
      h.check(dialog.role === 'alertdialog' && dialog.modal === 'true' && dialog.focus === 'keep-playing',
        `confirm: a modal alertdialog with the focus on Keep playing (${JSON.stringify({ role: dialog.role, modal: dialog.modal, focus: dialog.focus })})`);
      h.check([dialog.leave, dialog.keep].every((b) => b.w >= 80 && b.h >= 80),
        `confirm: Leave and Keep playing are each at least 80 px tall and wide (${JSON.stringify({ leave: dialog.leave, keep: dialog.keep })})`);
      await h.screenCheck(page, 'Start over confirm, 1080x1920');
      await h.shot(page, 'start-over-confirm');
      const title = await page.locator('[data-leave-confirm] .leave-title').boundingBox();
      await page.touchscreen.tap(title.x + title.width / 2, title.y + title.height / 2);
      await h.sleep(300);
      h.check(await confirms(page) === 1, 'confirm: a tap inside the card, off its buttons, keeps it open');
      await k.tap('[data-action="keep-playing"]');
      await h.sleep(300);
      h.check(await confirms(page) === 0 && await k.screenNow() === 'step' && h.same(await pressed(page), ['true', 'false', 'false']) && stub.calls.length === calls,
        'Keep playing: the confirm closes, the step is as it was with A still chosen, and no request was made');

      await k.tap('[data-action="type-own"]');
      await k.screen('typing');
      h.check(await startOvers(page) === 1, 'typing: Start over is there');
      await page.keyboard.type('draft');
      await openConfirm(k);
      const card = await page.locator('[data-leave-confirm] .leave-card').boundingBox();
      await page.touchscreen.tap(card.x + card.width / 2, card.y / 2);
      await h.sleep(300);
      const typing = await page.evaluate(() => ({ value: document.querySelector('.typing-box')?.value, focused: document.activeElement?.dataset.action }));
      h.check(await confirms(page) === 0 && await k.screenNow() === 'typing' && typing.value === 'draft' && stub.calls.length === calls,
        `a tap on the scrim outside the card closes the confirm; the typing sheet keeps its draft, and no request was made (${JSON.stringify(typing)})`);
      h.check(typing.focused === 'start-over', `the confirm hands the focus back to Start over, which opened it (${typing.focused})`);

      await k.tap('[data-action="back"]');
      await k.screen('step');
      await k.answer(2);
      await k.screen('reply');
      h.check(await startOvers(page) === 1, 'reply: Start over is there');
      const sentBefore = stub.calls.length;
      await openConfirm(k);
      await k.tap('[data-action="leave"]');
      await k.shell('start');
      const after = stub.calls.slice(sentBefore).map((c) => c.key);
      h.check(stub.of(STATUS_KEY).length === 2 && after.every((key) => !key.startsWith('POST')),
        `Leave: the page reloads to a fresh start screen, and no POST was made after Start over (${after.join(', ') || 'no calls'})`);
      await k.close();

      const big = await h.kiosk({ width: 2160, height: 3840 });
      await big.shell('start');
      await big.toVignette();
      await openConfirm(big);
      const sizes = await big.page.$$eval('[data-leave-confirm] .booth-btn', (els) => els.map((e) => {
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      }));
      h.check(sizes.length === 2 && sizes.every((b) => b.w >= 160 && b.h >= 160), `2160x3840 confirm: both buttons at least 160 px (${JSON.stringify(sizes)})`);
      await h.screenCheck(big.page, 'Start over confirm, 2160x3840');
      await big.close();
    },
  },
  ...SIZES.map(([width, height]) => ({
    name: `waiting at ${width}x${height}: the dots, then past 8 s a still-working line, while the reply and the score are slow`,
    async run(h) {
      const k = await h.kiosk({ width, height });
      const { page, stub } = k;
      await page.clock.install();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await toStep(k);

      const releaseReply = stub.hold(REPLY_KEY);
      await k.answer(1);
      await k.screen('replying');
      let wait = await waitStatus(page);
      h.check(wait.dots && hasBoth(wait.text, h.COPY.replying) && !wait.text.includes(h.COPY.stillWorking.en),
        `replying at about 1 s: "The AI is replying" and the dots, no still-working line yet (${JSON.stringify(wait.text)})`);
      h.check(await startOvers(page) === 0, 'replying: no Start over');
      await page.clock.fastForward(6_000);
      await h.sleep(100);
      wait = await waitStatus(page);
      h.check(!wait.text.includes(h.COPY.stillWorking.en), 'replying at about 7 s: still no still-working line');
      await page.clock.fastForward(2_000);
      await h.sleep(100);
      wait = await waitStatus(page);
      h.check(wait.dots && hasBoth(wait.text, h.COPY.stillWorking),
        `replying past 8 s: the still-working line joins the dots in the status, TH and EN (${JSON.stringify(wait.text)})`);
      await h.screenCheck(page, `replying with the still-working line, ${width}x${height}`);
      if (width === 1080) await h.shot(page, 'replying-still-working');
      releaseReply();

      await k.screen('reply');
      for (let n = 2; n <= 3; n++) {
        await k.tap('[data-action="next"]');
        await k.screen('step');
        await k.answer(1);
        await k.screen('reply');
      }
      const releaseScore = stub.hold(SCORE_KEY);
      await k.tap('[data-action="see-score"]');
      await k.screen('scoring');
      wait = await waitStatus(page);
      h.check(wait.dots && hasBoth(wait.text, h.COPY.scoring) && !wait.text.includes(h.COPY.stillWorking.en),
        `scoring when it shows: the rubric line and the dots, no still-working line yet (${JSON.stringify(wait.text)})`);
      h.check(!wait.text.includes('30'), 'scoring: no promise of how long it takes');
      h.check(await startOvers(page) === 0, 'scoring: no Start over');
      await page.clock.fastForward(6_000);
      await h.sleep(100);
      h.check(!(await waitStatus(page)).text.includes(h.COPY.stillWorking.en), 'scoring about 7 s after it shows: still no still-working line');
      await page.clock.fastForward(2_000);
      await h.sleep(100);
      wait = await waitStatus(page);
      h.check(wait.dots && hasBoth(wait.text, h.COPY.stillWorking), `scoring past 8 s: the still-working line joins the dots, TH and EN (${JSON.stringify(wait.text)})`);
      await h.screenCheck(page, `scoring with the still-working line, ${width}x${height}`, { demo: true });
      if (width === 1080) await h.shot(page, 'scoring-still-working');
      releaseScore();
      await k.screen('scored');
      h.check(await startOvers(page) === 0, 'scored: no Start over');
      await k.close();
    },
  })),
  {
    name: 'scoring screen: a score back within 1 s goes from the reply straight to the result; a slower one shows scoring from 1 s on',
    async run(h) {
      for (const delay of [500, 3000]) {
        const stub = h.makeStub({ routes: { [SCORE_KEY]: async () => { await h.sleep(delay); return { status: 200, body: h.SCORED }; } } });
        const k = await h.kiosk({ stub, label: `score after ${delay} ms` });
        const { page } = k;
        await toLastReply(k);
        await page.evaluate(() => {
          const stage = document.querySelector('#booth [data-screen]');
          window.boothScreens = [];
          new MutationObserver(() => window.boothScreens.push({ at: stage.dataset.screen, t: performance.now() }))
            .observe(stage, { attributes: true, attributeFilter: ['data-screen'] });
          document.addEventListener('click', (e) => { if (e.target.closest?.('[data-action="see-score"]')) window.boothTapAt ??= performance.now(); }, true);
        });
        await k.tap('[data-action="see-score"]');
        const locked = await page.evaluate(() => document.querySelector('[data-screen="reply"] [data-action="start-over"]')?.disabled ?? null);
        h.check(locked === true, `score in ${delay} ms: while the reply screen stays up, its Start over is disabled, since the score is sent (${locked})`);
        await k.screen('scored');
        const { screens, tapAt } = await page.evaluate(() => ({ screens: window.boothScreens, tapAt: window.boothTapAt }));
        const seen = screens.filter((s, i) => i === 0 || s.at !== screens[i - 1].at);
        const after = (at) => Math.round(seen.find((s) => s.at === at)?.t - tapAt);
        if (delay < 1000) {
          h.check(h.same(seen.map((s) => s.at), ['scored']),
            `score in ${delay} ms: the reply screen stays up until the result, and 'scoring' never shows (${seen.map((s) => s.at).join(' -> ')})`);
        } else {
          h.check(h.same(seen.map((s) => s.at), ['scoring', 'scored']) && after('scoring') >= 950 && after('scoring') <= 1600 && after('scored') >= delay,
            `score in ${delay} ms: 'scoring' shows ${after('scoring')} ms after the tap (from 1 s on), then 'scored' at ${after('scored')} ms`);
        }
        h.check(stub.of(SCORE_KEY).length === 1, `score in ${delay} ms: one score request (${stub.of(SCORE_KEY).length})`);
        await k.close();
      }
    },
  },
];
