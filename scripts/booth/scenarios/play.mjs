const REPLY_KEY = 'POST /booth/plays/:id/reply';
const SCORE_KEY = 'POST /booth/plays/:id/score';

const text = (page, sel) => page.locator(sel).first().textContent({ timeout: 5000 });
const count = (page, sel) => page.locator(sel).count();

async function toStep(k) {
  await k.shell('start');
  await k.tap('[data-action="start"]');
  await k.screen('vignette');
  await k.tap('[data-action="begin"]');
  await k.screen('step');
}

async function answerAll(k, choice = 'a') {
  for (;;) {
    await k.tap(`[data-option="${choice}"]`);
    await k.page.waitForSelector('#booth [data-screen="reply"], #booth [data-screen="unavailable"], #booth [data-screen="stopped"]', { timeout: 10_000 });
    const at = await k.screenNow();
    if (at !== 'reply') return at;
    await k.screen('reply');
    if (await count(k.page, '[data-action="see-score"]')) return 'reply';
    await k.tap('[data-action="next"]');
    await k.screen('step');
  }
}

export default [
  {
    name: 'happy path at 1080x1920, coarse pointer: two taps, one typed answer, score, result card',
    async run(h) {
      const k = await h.kiosk();
      const { page, stub } = k;
      await k.shell('start');
      await h.screenCheck(page, 'start screen');
      await k.tap('[data-action="start"]');

      await k.screen('vignette');
      await h.screenCheck(page, 'vignette');
      await h.shot(page, 'vignette');
      h.check(h.KASE.placeholder === true && (await text(page, '[data-placeholder]')).includes(h.COPY.placeholder.th)
        && (await text(page, '[data-placeholder]')).includes(h.COPY.placeholder.en), 'vignette: the placeholder case is marked as one, TH and EN');
      h.check(await text(page, '.vignette .bi-th') === h.KASE.vignette.th && await text(page, '.vignette .bi-en') === h.KASE.vignette.en,
        'vignette: the case file\'s vignette, Thai then English');
      await k.tap('[data-action="begin"]');

      await k.screen('step');
      await h.screenCheck(page, 'step 1 pop-up');
      await h.shot(page, 'step');
      const shown = await page.$$eval('[data-option]', (els) => els.map((e) => ({
        id: e.dataset.option,
        label: { th: e.querySelector('.opt-label .bi-th').textContent, en: e.querySelector('.opt-label .bi-en').textContent },
        line: { th: e.querySelector('.opt-line .bi-th').textContent, en: e.querySelector('.opt-line .bi-en').textContent },
      })));
      h.check(h.same(shown, h.KASE.steps[0].options), 'step 1: three option cards, each the case\'s label and line in TH and EN');
      h.check(await count(page, '[data-action="type-own"]') === 1, 'step 1: a "type my own" card');
      h.check((await text(page, '.step-of')).includes('1') && await text(page, '.question .bi-th') === h.KASE.steps[0].question.th, 'step 1: "Step 1 of 3" and the case\'s question');

      await k.doubleTap('[data-option="b"]');
      await k.screen('reply');
      h.check(stub.of(REPLY_KEY).length === 1, `a double tap on an option sends one reply request (${stub.of(REPLY_KEY).length})`);
      const r1 = stub.of(REPLY_KEY)[0];
      h.check(r1.path === `/booth/plays/${h.PLAY_ID}/reply`, 'step 1: the reply goes to the play\'s own id');
      h.check(h.same(r1.body, { answers: [{ choice: 'b' }], replies: [], reply_sigs: [] }), `step 1: reply body is { answers: [{ choice: 'b' }], replies: [], reply_sigs: [] } (${JSON.stringify(r1.body)})`);
      const aiLabel = await page.evaluate(() => window.AI_LABEL?.th);
      h.check(await text(page, '.ai-label') === aiLabel && aiLabel === 'AI', 'reply 1: labelled "AI" (js/ui.js AI_LABEL) and nothing else');
      const bubble = await page.locator('.ai-text').evaluate((e) => {
        const range = document.createRange();
        const tops = [];
        const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          for (let i = 0; i < n.data.length; i++) {
            if (/\s|\p{M}/u.test(n.data[i])) continue;
            range.setStart(n, i);
            range.setEnd(n, i + 1);
            tops.push(range.getBoundingClientRect().top);
          }
        }
        return {
          text: e.textContent,
          phrasesOnly: [...e.querySelectorAll('*')].every((c) => c.matches('span.ph') && c.childElementCount === 0),
          topToBottom: tops.every((t, i) => i === 0 || t >= tops[i - 1] - 1),
        };
      });
      h.check(bubble.text === h.REPLY(1) && bubble.phrasesOnly && bubble.topToBottom,
        'reply 1: the AI reply is plain text in phrase spans, markup shown as typed, newline kept, read top to bottom');
      h.check(await text(page, '.answer-card .bi-th') === h.COPY.yourAnswer.th
        && await text(page, '.answer-choice .bi-th') === h.KASE.steps[0].options[1].label.th, 'reply 1: the chosen option is shown as the answer');
      await h.screenCheck(page, 'reply 1');

      await k.doubleTap('[data-action="next"]');
      await h.sleep(700);
      const landed = await k.screenNow();
      if (!h.check(landed === 'step' && stub.of(REPLY_KEY).length === 1, `a double tap on "Next step" lands on step 2 and nothing more (on '${landed}')`)) return;
      await k.screen('step');
      h.check((await text(page, '.step-of')).includes('2') && await text(page, '.question .bi-th') === h.KASE.steps[1].question.th, 'step 2: "Step 2 of 3" and the case\'s question');
      await k.tap('[data-option="a"]');
      await k.screen('reply');
      h.check(h.same(stub.of(REPLY_KEY)[1]?.body, { answers: [{ choice: 'b' }, { choice: 'a' }], replies: [h.REPLY(1)], reply_sigs: [h.SIG(1)] }),
        'step 2: reply body carries both answers and reply 1 back verbatim');
      await k.tap('[data-action="next"]');

      await k.screen('step');
      h.check((await text(page, '.step-of')).includes('3'), 'step 3: "Step 3 of 3"');
      await k.tap('[data-action="type-own"]');
      await k.screen('typing');
      await h.screenCheck(page, 'step 3 typing sheet');
      const geo = await page.evaluate(() => {
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        return { h: innerHeight, sheet: r('.typing-sheet'), box: r('.typing-box'), send: r('[data-action="send"]'), focused: document.activeElement?.className };
      });
      h.check(geo.sheet.top >= 0 && geo.sheet.bottom <= geo.h * 0.52 + 1,
        `typing: the sheet is top-anchored and ends above 52% of the screen (${Math.round(geo.sheet.top)}..${Math.round(geo.sheet.bottom)} of ${geo.h})`);
      h.check(geo.box.bottom <= geo.sheet.bottom && geo.send.bottom <= geo.sheet.bottom,
        `typing: the box and Send sit inside the sheet (box ends ${Math.round(geo.box.bottom)}, Send ${Math.round(geo.send.bottom)})`);
      h.check(geo.focused === 'typing-box', 'typing: the box has the focus, so the on-screen keyboard opens on it');
      h.check(await page.locator('[data-action="send"]').isDisabled(), 'typing: Send waits for some text');
      await page.keyboard.type('line one');
      await page.keyboard.press('Enter');
      await page.keyboard.type('line two');
      await h.sleep(300);
      h.check(await page.locator('.typing-box').inputValue({ timeout: 2000 }).catch(() => null) === 'line one\nline two', 'typing: Enter is a newline in the box');
      h.check(await k.screenNow() === 'typing' && stub.of(REPLY_KEY).length === 2, 'typing: Enter sent nothing');
      await h.shot(page, 'typing');
      await k.tap('[data-action="send"]');
      await k.screen('reply');
      h.check(h.same(stub.of(REPLY_KEY)[2]?.body, { answers: [{ choice: 'b' }, { choice: 'a' }, { text: 'line one\nline two' }], replies: [h.REPLY(1), h.REPLY(2)], reply_sigs: [h.SIG(1), h.SIG(2)] }),
        'step 3: reply body carries the typed answer, newline kept, and both earlier replies');
      h.check(await text(page, '.answer-text') === 'line one\nline two', 'reply 3: the typed answer is shown as typed');

      const release = stub.hold(SCORE_KEY);
      await k.tap('[data-action="see-score"]');
      await k.screen('scoring');
      await h.screenCheck(page, 'scoring screen', { demo: true });
      h.check((await page.locator('#booth').innerText()).includes(h.COPY.scoringWait.en), 'scoring: says it takes about 30 seconds');
      release();

      await k.screen('scored');
      await h.screenCheck(page, 'result card', { demo: true });
      await h.shot(page, 'result');
      const score = stub.of(SCORE_KEY);
      h.check(score.length === 1 && h.same(score[0].body, {
        answers: [{ choice: 'b' }, { choice: 'a' }, { text: 'line one\nline two' }], replies: [h.REPLY(1), h.REPLY(2), h.REPLY(3)],
        reply_sigs: [h.SIG(1), h.SIG(2), h.SIG(3)],
      }), 'score: one request with all three answers and all three replies as the stub sent them');
      h.check(await text(page, '.result-card .booth-tag') === 'Booth #042', 'result: the booth tag "Booth #042"');
      h.check(await text(page, '[data-score]') === '72' && await text(page, '.result-outof') === '/ 100', 'result: the composite as a whole number out of 100 (72.4 -> 72)');
      const bars = await page.$$eval('.result-card .domain', (els) => els.map((e) => ({
        key: e.dataset.key, th: e.querySelector('.domain-name .bi-th').textContent, en: e.querySelector('.domain-name .bi-en').textContent,
        value: e.querySelector('.domain-value').textContent,
        fill: e.querySelector('.domain-bar > span').getBoundingClientRect().width / e.querySelector('.domain-bar').getBoundingClientRect().width,
      })));
      h.check(bars.length === 7 && h.same(bars.map(({ key, th, en }) => ({ key, th, en })), h.DOMAINS.map(({ key, th, en }) => ({ key, th, en }))),
        'result: seven bars d1..d7, each named with the rubric\'s TH and EN domain name');
      h.check(bars.every((b) => b.value === `${h.SCORED.domains[b.key]} / 5` && Math.abs(b.fill - h.SCORED.domains[b.key] / 5) < 0.01),
        `result: each bar reads "n / 5" and fills n/5 of its track (${bars.map((b) => `${b.key} ${b.fill.toFixed(2)}`).join(', ')})`);
      const inCard = await page.locator('.result-card [data-demo-label]').innerText().catch(() => '');
      h.check(inCard.includes(h.DEMO_LABEL.th) && inCard.includes(h.DEMO_LABEL.en), 'result: the demo label is inside the card, TH and EN');
      const page3p = await page.evaluate(() => ({
        scripts: [...document.scripts].map((s) => s.src),
        globals: ['marked', 'DOMPurify', 'Chart', 'supabase'].filter((g) => g in window),
      }));
      h.check(page3p.scripts.length > 0 && page3p.scripts.every((s) => s && new URL(s).origin === new URL(page.url()).origin),
        `no inline or third-party script (${page3p.scripts.map((s) => new URL(s).pathname).join(', ')})`);
      h.check(page3p.globals.length === 0, `no marked, DOMPurify, Chart.js or supabase-js on the page${page3p.globals.length ? ` (${page3p.globals})` : ''}`);

      await k.shell('done');
      await k.tap('[data-action="done"]');
      await k.shell('start');
      h.check(stub.of('GET /booth/status').length === 2, 'Done reloads the page to a fresh start screen');
      await k.close();
    },
  },
  {
    name: 'score unavailable: the evaluator timed out or failed, the visitor gets a finished card',
    async run(h) {
      const stub = h.makeStub({ routes: { [SCORE_KEY]: () => ({ status: 200, body: { status: 'unavailable' } }) } });
      const k = await h.kiosk({ stub });
      await toStep(k);
      h.check(await answerAll(k) === 'reply', 'three answers, three replies');
      await k.tap('[data-action="see-score"]');
      await k.screen('unavailable');
      await h.screenCheck(k.page, 'score-unavailable card');
      await h.shot(k.page, 'unavailable');
      const shown = await k.page.locator('#booth').innerText();
      h.check(shown.includes(h.COPY.unavailable.th) && shown.includes(h.COPY.unavailable.en), 'unavailable: says the score is unavailable, TH and EN');
      h.check(await count(k.page, '.result-card') === 0 && await count(k.page, '[data-score]') === 0 && !/\d/.test(shown.split(h.DEMO_LABEL.en).join('')),
        'unavailable: no score, no result card, no number');
      await k.shell('done');
      await k.close();
    },
  },
  {
    name: 'soft reply failure: 502 ai_unavailable shows a note, and the play goes on with its receipt',
    async run(h) {
      const stub = h.makeStub({ routes: {
        [REPLY_KEY]: (call, calls) => (calls.filter((c) => c.key === REPLY_KEY).length === 1
          ? { status: 502, body: { error: 'The AI is unavailable.', reason: 'ai_unavailable', reply_sig: 'sig-none-1' } }
          : { status: 200, body: { status: 'replied', reply: h.REPLY(call.body.answers.length), reply_sig: h.SIG(call.body.answers.length) } }),
      } });
      const k = await h.kiosk({ stub });
      await toStep(k);
      await k.tap('[data-option="c"]');
      await k.page.waitForSelector('#booth [data-screen="reply"], #booth [data-screen="stopped"]', { timeout: 10_000 });
      if (!h.check(await k.screenNow() === 'reply', `a 502 ai_unavailable reply does not stop the play (on '${await k.screenNow()}')`)) return;
      await k.screen('reply');
      const note = await k.page.locator('.reply-note').innerText().catch(() => '');
      h.check(note.includes(h.COPY.noReply.th) && note.includes(h.COPY.noReply.en), 'reply 1: the "no AI reply for this step" note, TH and EN');
      h.check(await count(k.page, '.ai-text') === 0, 'reply 1: no AI text is invented');
      h.check(await count(k.page, '.ai-bubble') === 0, 'reply 1: the system note carries no AI label or AI style');
      await h.screenCheck(k.page, 'no-reply note');
      await h.shot(k.page, 'no-reply');
      await k.tap('[data-action="next"]');
      await k.screen('step');
      h.check((await text(k.page, '.step-of')).includes('2'), 'the play goes on to step 2');
      h.check(await answerAll(k, 'b') === 'reply', 'steps 2 and 3 answered');
      h.check(h.same(stub.of(REPLY_KEY)[1]?.body, { answers: [{ choice: 'c' }, { choice: 'b' }], replies: [''], reply_sigs: ['sig-none-1'] }),
        `step 2: the missing reply goes back as "" with the 502's receipt (${JSON.stringify(stub.of(REPLY_KEY)[1]?.body)})`);
      await k.tap('[data-action="see-score"]');
      await k.screen('scored');
      h.check(h.same(stub.of(SCORE_KEY)[0]?.body?.replies, ['', h.REPLY(2), h.REPLY(3)]), 'score: replies are "", reply 2, reply 3');
      h.check(h.same(stub.of(SCORE_KEY)[0]?.body?.reply_sigs, ['sig-none-1', h.SIG(2), h.SIG(3)]), 'score: reply_sigs carry the receipt, sig 2, sig 3');
      await k.close();
    },
  },
  {
    name: 'ceiling refusal on a reply ends the play on the unavailable card',
    async run(h) {
      const stub = h.makeStub({ routes: {
        [REPLY_KEY]: (call) => (call.body.answers.length === 2
          ? { status: 200, body: { status: 'unavailable' } }
          : { status: 200, body: { status: 'replied', reply: h.REPLY(call.body.answers.length), reply_sig: h.SIG(call.body.answers.length) } }),
      } });
      const k = await h.kiosk({ stub });
      await toStep(k);
      h.check(await answerAll(k) === 'unavailable', 'the step 2 reply refusal shows the unavailable card');
      await k.screen('unavailable');
      await h.screenCheck(k.page, 'unavailable after a reply refusal');
      h.check(stub.of(SCORE_KEY).length === 0, 'no score request is sent');
      await k.close();
    },
  },
  {
    name: 'a refused or lost reply stops the play with a plain message, then the page resets itself',
    async run(h) {
      const refused = h.makeStub({ routes: { [REPLY_KEY]: () => ({ status: 409, body: { error: 'The play is not started.', reason: 'not_started' } }) } });
      const k = await h.kiosk({ stub: refused, label: '409 refusal' });
      await toStep(k);
      await k.tap('[data-option="a"]');
      await k.screen('stopped');
      await h.screenCheck(k.page, 'stopped (refusal)');
      const shown = await k.page.locator('#booth').innerText();
      h.check(shown.includes(h.COPY.stopped.th) && shown.includes(h.COPY.stopped.en) && !shown.includes(h.COPY.stoppedOffline.en),
        'refusal: "This play has stopped", TH and EN, without the lost-connection line');
      await k.shell('start', 15_000);
      h.check(refused.of('GET /booth/status').length === 2, 'the page reloads to a fresh start screen on its own');
      await k.close();

      const lost = h.makeStub({ routes: { [REPLY_KEY]: () => 'abort' } });
      const k2 = await h.kiosk({ stub: lost, label: 'lost connection' });
      await toStep(k2);
      await k2.tap('[data-option="a"]');
      await k2.screen('stopped');
      const shown2 = await k2.page.locator('#booth').innerText();
      h.check(shown2.includes(h.COPY.stoppedOffline.th) && shown2.includes(h.COPY.stoppedOffline.en), 'lost connection: "The connection was lost", TH and EN');
      await k2.close();
    },
  },
  {
    name: 'closed and offline: a notice and no way to start a play',
    async run(h) {
      const closed = h.makeStub({ routes: { 'GET /booth/status': () => ({ status: 200, body: { open: false, reason: 'off', event_code: 'NFCME-2026', case_version: 'x' } }) } });
      const k = await h.kiosk({ stub: closed, label: 'closed' });
      await k.shell('closed');
      const t = await k.page.locator('#booth').innerText();
      h.check(t.includes(h.COPY.closed.th) && t.includes(h.COPY.closed.en), 'closed: "The booth is closed right now", TH and EN');
      h.check(await count(k.page, 'button') === 0 && closed.of('POST /booth/plays').length === 0, 'closed: nothing to tap, no play started');
      await h.screenCheck(k.page, 'closed notice');
      await k.close();

      const down = h.makeStub({ routes: { 'GET /booth/status': () => ({ status: 503, body: { error: 'Unavailable', reason: 'unavailable' } }) } });
      const k2 = await h.kiosk({ stub: down, label: 'offline' });
      await k2.shell('offline');
      const t2 = await k2.page.locator('#booth').innerText();
      h.check(t2.includes(h.COPY.offline.th) && t2.includes(h.COPY.offline.en), 'a 503 on status: "CLICS is offline right now", TH and EN');
      await k2.close();
    },
  },
  {
    name: 'touch is forced: the same floors hold when the OS reports a mouse',
    async run(h) {
      const k = await h.kiosk({ pointer: 'fine' });
      await toStep(k);
      await h.screenCheck(k.page, 'step 1, fine pointer');
      await k.tap('[data-action="type-own"]');
      await k.screen('typing');
      await h.screenCheck(k.page, 'typing, fine pointer');
      await k.close();
    },
  },
  {
    name: 'the typing box stays above an on-screen keyboard that resizes the page',
    async run(h) {
      const k = await h.kiosk();
      await toStep(k);
      await k.tap('[data-action="type-own"]');
      await k.screen('typing');
      await k.page.keyboard.type('draft');
      await k.page.setViewportSize({ width: 1080, height: 1920 - 860 });
      await h.sleep(300);
      const g = await k.page.evaluate(() => {
        const vv = visualViewport;
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        const inside = (a, b) => a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
        const sheet = r('.typing-sheet');
        const body = r('.play-body');
        const view = { top: vv.offsetTop, bottom: vv.offsetTop + vv.height };
        return {
          box: inside(r('.typing-box'), view) && inside(r('.typing-box'), sheet) && inside(r('.typing-box'), body),
          send: inside(r('[data-action="send"]'), view) && inside(r('[data-action="send"]'), sheet) && inside(r('[data-action="send"]'), body),
          scrollY, focused: document.activeElement?.className, value: document.querySelector('.typing-box').value,
        };
      });
      h.check(g.box && g.send, `keyboard up (1080x1060): the box and Send are fully on screen (box ${g.box}, send ${g.send})`);
      h.check(g.scrollY === 0 && g.focused === 'typing-box' && g.value === 'draft', 'keyboard up: the page did not scroll and the draft and focus stayed');
      await h.screenCheck(k.page, 'typing, keyboard up');
      await k.close();
    },
  },
  {
    name: 'the layout scales to 2160x3840: every floor doubles',
    async run(h) {
      const sizeOf = (k) => k.page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.opt-label .bi-th')).fontSize));
      const small = await h.kiosk({ label: '1080x1920' });
      await toStep(small);
      const at1080 = await sizeOf(small);
      await small.close();

      const big = await h.kiosk({ width: 2160, height: 3840 });
      await toStep(big);
      const r = await h.screenCheck(big.page, 'step 1 at 2160x3840');
      const at2160 = await sizeOf(big);
      h.check(r.scale === 2 && at2160 === at1080 * 2, `2160 wide: the floors are x${r.scale} and the option label is ${at2160}px (${at1080}px at 1080)`);
      h.check(await answerAll(big) === 'reply', 'three answers at 2160x3840');
      await big.tap('[data-action="see-score"]');
      await big.screen('scored');
      await h.screenCheck(big.page, 'result card at 2160x3840', { demo: true });
      await big.close();
    },
  },
];
