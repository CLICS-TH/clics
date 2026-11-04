const REPLY_KEY = 'POST /booth/plays/:id/reply';
const SCORE_KEY = 'POST /booth/plays/:id/score';
const EMPTY = { strength: '', weigh: '', safety: '' };
/** Three fields longer than the server's FIELD_MAX_CHARS, each with two bold runs at their cap, in realistic Thai with
 *  spaces between phrases; the fit check hard-cuts them to the longest field the server can send. */
const FIT_TEXT = {
  strength: 'คุณเชื่อมโยง**ประวัติลุยน้ำท่วมขัง**เข้ากับ**ไข้สูง ปวดน่อง ตาแดง**ได้อย่างเป็นระบบ จึงนึกถึงโรคเลปโตสไปโรซิสตั้งแต่ต้น ก่อนผลตรวจทางห้องปฏิบัติการจะกลับมา แล้วถามอาชีพ',
  weigh: 'สิ่งที่ควรชั่งน้ำหนักคือ **ผลเลือดวันแรกอาจปกติ** จึงควรนัดตรวจซ้ำ และเฝ้าดู**ค่าครีเอตินินในเลือด**กับปริมาณปัสสาวะอย่างใกล้ชิดในสองสามวันถัดไป ก่อนสรุปว่าโรคไม่รุนแรง',
  safety: 'หากผู้ป่วยเริ่ม**ไอเป็นเลือด หายใจหอบ** หรือ**ปัสสาวะออกน้อยลงมากๆ** ควรส่งต่อโรงพยาบาลที่มีหอผู้ป่วยหนักทันที เพราะอาจเป็นเลือดออกในปอดหรือไตวาย ซึ่งอันตรายถึงชีวิตได้',
};

const text = (page, sel) => page.locator(sel).first().textContent({ timeout: 5000 });
const count = (page, sel) => page.locator(sel).count();
const opt = (n) => `.options > [data-option]:nth-child(${n})`;

/** The step on screen, read from the DOM: the option ids, letters and texts, the question and the bridge. */
const readStep = (page) => page.evaluate(() => {
  const t = (e, s) => e.querySelector(s)?.textContent ?? null;
  return {
    options: [...document.querySelectorAll('.options > [data-option]')].map((e) => ({
      id: e.dataset.option, letter: t(e, '.opt-letter'),
      label: { th: t(e, '.opt-label .bi-th'), en: t(e, '.opt-label .bi-en') },
      line: { th: t(e, '.opt-line .bi-th'), en: t(e, '.opt-line .bi-en') },
    })),
    question: { th: t(document, '.step-sheet .question .bi-th'), en: t(document, '.step-sheet .question .bi-en') },
    bridge: t(document, '.step-sheet [data-bridge] .bridge-text'),
    bridgeLabel: t(document, '.step-sheet [data-bridge] .ai-label'),
  };
});

/**
 * The step on screen is the fixture's bank for `path` word for word: the variant the ask names, its three options
 * in the ask's order, lettered A/B/C by position, and the bridge shown exactly when it is not ''.
 */
async function checkStep(h, page, path, bridge, label) {
  const bank = h.bankFor(h.TREE, path);
  const { ask } = h.nextFor(h.TREE, path, bridge);
  const shown = await readStep(page);
  const want = ask.options.map((id, i) => {
    const o = bank.options.find((x) => x.id === id);
    return { id, letter: 'ABC'[i], label: o.label, line: o.line };
  });
  h.check(h.same(shown.options, want), `${label}: the three options of bank ${path || 'step1'} in the ask's order, case text word for word, lettered A/B/C`);
  h.check(h.same(shown.question, bank.variants.find((v) => v.id === ask.variant).question), `${label}: the question is variant ${ask.variant} of the bank, word for word`);
  h.check(bridge === '' ? shown.bridge === null : shown.bridge === bridge && shown.bridgeLabel === 'AI',
    `${label}: ${bridge === '' ? 'no bridge when the bridge is \'\'' : 'the AI-labelled bridge above the question, as sent'}`);
  return ask;
}

/** The AI bubble on screen, read from the DOM: per field its heading, text, phrase spans, bold runs and weights. */
const readReply = (page) => page.evaluate(() => {
  const weight = (e) => Number(getComputedStyle(e).fontWeight);
  const bubble = document.querySelector('.ai-bubble');
  const range = document.createRange();
  const tops = [];
  const walk = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    for (let i = 0; i < n.data.length; i++) {
      if (/\s|\p{M}/u.test(n.data[i])) continue;
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      tops.push(range.getBoundingClientRect().top);
    }
  }
  return {
    topToBottom: tops.every((t, i) => i === 0 || t >= tops[i - 1] - 1),
    fields: [...bubble.querySelectorAll('[data-field]')].map((f) => {
      const text = f.querySelector('.ai-text');
      const head = [...f.querySelectorAll('.reply-head .bi-th, .reply-head .bi-en')];
      const strong = [...text.querySelectorAll('strong')];
      return {
        key: f.dataset.field,
        head: { th: head[0]?.textContent, en: head[1]?.textContent },
        headWeight: Math.min(...head.map(weight)),
        text: text.textContent,
        textWeight: weight(text),
        phrases: [...text.querySelectorAll('.ph')].map((e) => e.textContent),
        bold: strong.map((e) => e.textContent),
        boldWeight: Math.min(...strong.map(weight)),
        boldInPhrase: strong.every((s) => s.parentElement.matches('.ai-text > span.ph')),
        onlyPhrases: [...text.children].every((c) => c.matches('span.ph') && [...c.children].every((s) => s.matches('strong') && s.childElementCount === 0)),
      };
    }),
  };
});

const plainOf = (field) => field.split('**').join('');
const runsOf = (field) => field.split('**').filter((_, i) => i % 2);

/** `field` hard-cut at `max` visible characters, trailing space dropped, a bold run cut through staying bold: the
 *  longest field the server can send (booth-dialogue.js checkedField ends a field at or before `max`). */
function atCut(field, max) {
  let room = plainOf(field).slice(0, max).trimEnd().length;
  return field.split('**').map((part, i) => {
    const cut = part.slice(0, room);
    room -= cut.length;
    return cut && i % 2 ? `**${cut}**` : cut;
  }).join('');
}

/** The reply on screen is `reply`: a bold heading from the copy over each non-empty field, the field's text in
 *  regular weight, and its bold runs as <strong> inside the phrase spans. */
async function checkReply(h, page, reply, label) {
  const shown = await readReply(page);
  const want = h.REPLY_FIELDS.filter(({ key }) => reply[key] !== '');
  h.check(h.same(shown.fields.map((f) => [f.key, f.head]), want.map((f) => [f.key, { th: f.th, en: f.en }])),
    `${label}: a heading from the copy over each non-empty field, in strength, weigh, safety order, ${reply.safety ? 'safety included' : 'no safety heading'} (${shown.fields.map((f) => f.key).join(', ') || 'none'})`);
  const fields = shown.fields.map((f) => ({ ...f, sent: reply[f.key] }));
  h.check(fields.every((f) => f.text === plainOf(f.sent)), `${label}: each field shows its text as sent, the ** markers removed and markup shown as typed`);
  h.check(fields.every((f) => f.headWeight >= 600 && f.textWeight === 400 && (f.bold.length === 0 || f.boldWeight >= 600)),
    `${label}: headings bold, field text regular, bold runs bold (heading/text/bold weights ${fields.map((f) => `${f.key} ${f.headWeight}/${f.textWeight}/${f.bold.length ? f.boldWeight : '-'}`).join(', ')})`);
  h.check(fields.every((f) => f.onlyPhrases && f.boldInPhrase && f.bold.join(' ') === runsOf(f.sent).join(' ')),
    `${label}: every bold run is drawn as <strong> inside a phrase span, cut only at the spaces between phrases`);
  h.check(fields.every((f) => f.phrases.join(' ') === f.text), `${label}: no Thai phrase is split by a bold run (the phrase spans are the text's space-separated phrases)`);
  h.check(shown.topToBottom, `${label}: the reply reads top to bottom`);
  return shown;
}

async function toStep(k) {
  await k.shell('start');
  await k.toVignette();
  await k.tap('[data-action="begin"]');
  await k.screen('step');
}

async function answerAll(k, n = 1) {
  for (;;) {
    await k.tap(opt(n));
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
      await k.toVignette();
      await h.screenCheck(page, 'vignette');
      await h.shot(page, 'vignette');
      h.check(await text(page, '.vignette .bi-th') === h.KASE.vignette.th && await text(page, '.vignette .bi-en') === h.KASE.vignette.en,
        'vignette: the case file\'s vignette, Thai then English');
      await k.tap('[data-action="begin"]');

      await k.screen('step');
      await h.screenCheck(page, 'step 1 pop-up');
      await h.shot(page, 'step');
      const ask1 = await checkStep(h, page, '', '', 'step 1');
      h.check(await count(page, '[data-action="type-own"]') === 1, 'step 1: a "type my own" card');
      h.check((await text(page, '.step-of')).includes('1'), 'step 1: "Step 1 of 3"');
      const pick1 = ask1.options[1];

      await k.doubleTap(opt(2));
      await k.screen('reply');
      h.check(stub.of(REPLY_KEY).length === 1, `a double tap on an option sends one reply request (${stub.of(REPLY_KEY).length})`);
      const r1 = stub.of(REPLY_KEY)[0];
      h.check(r1.path === `/booth/plays/${h.PLAY_ID}/reply`, 'step 1: the reply goes to the play\'s own id');
      h.check(h.same(r1.body, { answers: [{ choice: pick1 }], replies: [], asks: [ask1], sigs: [h.SIG(0)] }),
        `step 1: reply body is { answers: [the tapped id], replies: [], asks: [ask 1], sigs: [start sig] } (${JSON.stringify(r1.body)})`);
      const aiLabel = await page.evaluate(() => window.AI_LABEL?.th);
      h.check(await text(page, '.ai-label') === aiLabel && aiLabel === 'AI', 'reply 1: labelled "AI" (js/ui.js AI_LABEL) and nothing else');
      const reply1 = await checkReply(h, page, h.REPLY(1), 'reply 1');
      const weigh = reply1.fields.find((f) => f.key === 'weigh');
      h.check(weigh?.phrases[0] === 'ลองพิจารณาผลน้ำตาลสะสมร่วมกับประวัติครอบครัว' && weigh.bold[0] === 'ผลน้ำตาลสะสม',
        `reply 1: "ลองพิจารณา**ผลน้ำตาลสะสม**ร่วมกับประวัติครอบครัว" is one phrase span with the bold run inside it (${JSON.stringify(weigh?.phrases)})`);
      h.check(h.same(weigh?.bold, ['ผลน้ำตาลสะสม', 'ภายใน', '3 เดือน']),
        `reply 1: "**ภายใน 3 เดือน**" spans a space, so it is one <strong> in each of its two phrases (${JSON.stringify(weigh?.bold)})`);
      await h.shot(page, 'reply');
      h.check(await text(page, '.answer-card .bi-th') === h.COPY.yourAnswer.th
        && await text(page, '.answer-choice .bi-th') === h.bankFor(h.TREE, '').options.find((o) => o.id === pick1).label.th, 'reply 1: the chosen option is shown as the answer');
      await h.screenCheck(page, 'reply 1');

      await k.doubleTap('[data-action="next"]');
      await h.sleep(700);
      const landed = await k.screenNow();
      if (!h.check(landed === 'step' && stub.of(REPLY_KEY).length === 1, `a double tap on "Next step" lands on step 2 and nothing more (on '${landed}')`)) return;
      await k.screen('step');
      h.check((await text(page, '.step-of')).includes('2'), 'step 2: "Step 2 of 3"');
      const path1 = h.pathOf(h.TREE, [{ choice: pick1 }]);
      const ask2 = await checkStep(h, page, path1, h.BRIDGE(1), `step 2 (path ${path1})`);
      await h.screenCheck(page, 'step 2 with a bridge');
      await h.shot(page, 'step-bridge');
      const pick2 = ask2.options[0];
      await k.tap(opt(1));
      await k.screen('reply');
      h.check(h.same(stub.of(REPLY_KEY)[1]?.body, { answers: [{ choice: pick1 }, { choice: pick2 }], replies: [h.REPLY(1)], asks: [ask1, ask2], sigs: [h.SIG(0), h.SIG(1)] }),
        'step 2: reply body carries both answers, reply 1 verbatim, both asks and two sigs');
      await k.tap('[data-action="next"]');

      await k.screen('step');
      h.check((await text(page, '.step-of')).includes('3'), 'step 3: "Step 3 of 3"');
      const path2 = h.pathOf(h.TREE, [{ choice: pick1 }, { choice: pick2 }]);
      const ask3 = await checkStep(h, page, path2, h.BRIDGE(2), `step 3 (path ${path2})`);
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
      const sent = [{ choice: pick1 }, { choice: pick2 }, { text: 'line one\nline two' }];
      const typed = sent;
      h.check(h.same(stub.of(REPLY_KEY)[2]?.body, { answers: sent, replies: [h.REPLY(1), h.REPLY(2)], asks: [ask1, ask2, ask3], sigs: [h.SIG(0), h.SIG(1), h.SIG(2)] }),
        'step 3: reply body carries the typed answer, newline kept, both earlier replies, three asks, three sigs');
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
        answers: typed, replies: [h.REPLY(1), h.REPLY(2), h.REPLY(3)], asks: [ask1, ask2, ask3], sigs: [h.SIG(0), h.SIG(1), h.SIG(2), h.SIG(3)],
      }), 'score: one request with three answers, three replies, three asks and four sigs as the stub sent them');
      h.check(await text(page, '.result-card .booth-tag') === 'Booth #042', 'result: the booth tag "Booth #042"');
      h.check(await text(page, '[data-score]') === '72' && await text(page, '.result-outof') === '/ 100', 'result: the composite as a whole number out of 100 (72.4 -> 72)');
      const bars = await page.$$eval('.result-card .domain', (els) => els.map((e) => ({
        key: e.dataset.key, th: e.querySelector('.domain-name .bi-th').textContent, en: e.querySelector('.domain-name .bi-en').textContent,
        value: e.querySelector('.domain-value').textContent,
        fill: e.querySelector('.domain-bar > span').getBoundingClientRect().width / e.querySelector('.domain-bar').getBoundingClientRect().width,
      })));
      const byKey = (list) => [...list].sort((a, b) => a.key.localeCompare(b.key)).map(({ key, th, en }) => ({ key, th, en }));
      h.check(bars.length === 7 && h.same(byKey(bars), byKey(h.DOMAINS)),
        'result: seven bars d1..d7, each named with the rubric\'s TH and EN domain name');
      h.check(bars.every((b) => b.value === `${h.SCORED.domains[b.key]} / 5` && Math.abs(b.fill - h.SCORED.domains[b.key] / 5) < 0.01),
        `result: each bar reads "n / 5" and fills n/5 of its track (${bars.map((b) => `${b.key} ${b.fill.toFixed(2)}`).join(', ')})`);
      const label = await page.locator('.play-foot[data-demo-label]').innerText().catch(() => '');
      h.check(label.includes(h.DEMO_LABEL.th) && label.includes(h.DEMO_LABEL.en), 'result: the demo label is pinned under the card, TH and EN');
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
    name: 'empty reply: a 200 whose three fields are all \'\' shows a note, and the next step comes with no bridge',
    async run(h) {
      const stub = h.makeStub({ routes: {
        [REPLY_KEY]: (call) => ({ status: 200, body: call.body.answers.length === 1
          ? h.replyBody(call.body.answers, { reply: EMPTY, bridge: '' }) : h.replyBody(call.body.answers) }),
      } });
      const k = await h.kiosk({ stub });
      await toStep(k);
      await k.tap(opt(3));
      await k.page.waitForSelector('#booth [data-screen="reply"], #booth [data-screen="stopped"]', { timeout: 10_000 });
      if (!h.check(await k.screenNow() === 'reply', `an empty reply does not stop the play (on '${await k.screenNow()}')`)) return;
      await k.screen('reply');
      const note = await k.page.locator('.reply-note').innerText().catch(() => '');
      h.check(note.includes(h.COPY.noReply.th) && note.includes(h.COPY.noReply.en), 'reply 1: the "no AI reply for this step" note, TH and EN');
      h.check(await count(k.page, '.ai-text') === 0 && await count(k.page, '.reply-head') === 0, 'reply 1: no AI text and no heading is invented');
      h.check(await count(k.page, '.ai-bubble') === 0, 'reply 1: the system note carries no AI label or AI style');
      await h.screenCheck(k.page, 'no-reply note');
      await h.shot(k.page, 'no-reply');
      await k.tap('[data-action="next"]');
      await k.screen('step');
      const first = [{ choice: h.START.next.ask.options[2] }];
      h.check((await text(k.page, '.step-of')).includes('2'), 'the play goes on to step 2');
      await checkStep(h, k.page, h.pathOf(h.TREE, first), '', 'step 2 after an empty reply');
      h.check(await answerAll(k, 2) === 'reply', 'steps 2 and 3 answered');
      h.check(h.same(stub.of(REPLY_KEY)[1]?.body?.replies, [EMPTY]) && h.same(stub.of(REPLY_KEY)[1]?.body?.sigs, [h.SIG(0), h.SIG(1)]),
        `step 2: the empty reply goes back as its three '' fields with its sig (${JSON.stringify(stub.of(REPLY_KEY)[1]?.body)})`);
      await k.tap('[data-action="see-score"]');
      await k.screen('scored');
      h.check(h.same(stub.of(SCORE_KEY)[0]?.body?.replies, [EMPTY, h.REPLY(2), h.REPLY(3)]), 'score: replies are the empty reply, reply 2, reply 3');
      h.check(h.same(stub.of(SCORE_KEY)[0]?.body?.sigs, [h.SIG(0), h.SIG(1), h.SIG(2), h.SIG(3)]), 'score: four sigs, start first');
      await k.close();
    },
  },
  {
    name: 'a reply to answer 1 or 2 without a usable next stops the play',
    async run(h) {
      const stub = h.makeStub({ routes: { [REPLY_KEY]: (call) => {
        const { next, ...rest } = h.replyBody(call.body.answers);
        return { status: 200, body: rest };
      } } });
      const k = await h.kiosk({ stub });
      await toStep(k);
      await k.tap(opt(2));
      await k.screen('stopped');
      h.check(stub.of(REPLY_KEY).length === 1, 'reply 1 without next: the play stops rather than guess step 2');
      await k.close();
    },
  },
  {
    name: 'a reply that is not exactly { strength, weigh, safety } of strings stops the play',
    async run(h) {
      const bad = [['a plain string (the old shape)', 'AI reply'], ['a field missing', { strength: 'a', weigh: 'b' }],
        ['an extra field', { ...h.REPLY(1), note: '' }], ['a field that is not a string', { ...h.REPLY(1), safety: null }], ['null', null]];
      let reply = null;
      const stub = h.makeStub({ routes: { [REPLY_KEY]: (call) => ({ status: 200, body: { ...h.replyBody(call.body.answers), reply } }) } });
      const k = await h.kiosk({ stub });
      const shown = [];
      for (const [name, r] of bad) {
        reply = r;
        await k.page.goto(k.page.url(), { waitUntil: 'domcontentloaded' });
        await toStep(k);
        await k.tap(opt(1));
        await k.page.waitForSelector('#booth [data-screen="reply"], #booth [data-screen="stopped"]', { timeout: 10_000 });
        if (await k.screenNow() !== 'stopped') shown.push(name);
      }
      h.check(shown.length === 0, `each of ${bad.map(([name]) => name).join(', ')} stops the play${shown.length ? ` (drawn instead: ${shown.join(', ')})` : ''}`);
      await k.close();
    },
  },
  {
    name: 'reply fields: bold headings over regular text, bold inside phrase spans, only the fields sent, at 1080x1920 and 2160x3840',
    async run(h) {
      const sent =[{ safety: '', weigh: 'ลองพิจารณา**ผลน้ำตาลสะสม**ร่วมกับประวัติครอบครัว', strength: '' }, h.REPLY(1), h.REPLY(2)];
      await Promise.all([[1080, 1920], [2160, 3840]].map(async ([width, height]) => {
        const stub = h.makeStub({ routes: { [REPLY_KEY]: (call) => ({ status: 200, body: h.replyBody(call.body.answers, { reply: sent[call.body.answers.length - 1] }) }) } });
        const k = await h.kiosk({ stub, width, height, label: `reply fields at ${width}x${height}` });
        await toStep(k);
        for (const [i, reply] of sent.entries()) {
          await k.tap(opt(1));
          await k.screen('reply');
          await checkReply(h, k.page, reply, `${width}x${height} reply ${i + 1}`);
          if (i < 2) {
            await k.tap('[data-action="next"]');
            await k.screen('step');
          }
        }
        await h.screenCheck(k.page, `reply with all three fields, ${width}x${height}`);
        await h.shot(k.page, `reply-fields-${width}`);
        await k.tap('[data-action="see-score"]');
        await k.screen('scored');
        const posted = stub.of(SCORE_KEY)[0]?.body?.replies;
        h.check(JSON.stringify(posted) === JSON.stringify(sent),
          `${width}x${height}: the score posts the three replies back exactly as received, key order kept (${JSON.stringify(posted?.[0])})`);
        await k.close();
      }));
    },
  },
  {
    name: 'fit: every bank of every case file, its tallest texts under a 120-character bridge, at 1080x1920 and 2160x3840',
    async run(h) {
      h.check([...h.LONG_BRIDGE].length === 120, `the long bridge is 120 characters (${[...h.LONG_BRIDGE].length})`);
      const banks = await h.caseBankNexts();
      // Both sizes at once, each in its own kiosk: a size walks every bank on one page, a fresh play per bank.
      await Promise.all([[1080, 1920], [2160, 3840]].map(async ([width, height]) => {
        let start = null;
        const stub = h.makeStub({ routes: { 'POST /booth/plays': () => ({ status: 201, body: { ...h.START, next: start } }) } });
        const k = await h.kiosk({ stub, width, height, label: `fit at ${width}x${height}` });
        const show = async (next) => {
          start = next;
          await k.page.goto(k.page.url(), { waitUntil: 'domcontentloaded' });
          await toStep(k);
        };
        const misfits = [];
        let tallest = { over: -Infinity };
        for (const { name, next } of banks) {
          await show(next);
          const shown = await readStep(k.page);
          const { over } = await k.page.evaluate(() => {
            const body = document.querySelector('.play-body').getBoundingClientRect();
            const below = (s) => Math.max(...[...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect().bottom - body.bottom));
            return { over: Math.max(below('.options > [data-option]'), below('[data-action="type-own"]')) };
          });
          const words = shown.bridge === h.LONG_BRIDGE && h.same(shown.question, next.question)
            && h.same(shown.options.map(({ id, label, line }) => ({ id, label, line })), next.options);
          if (over > tallest.over) tallest = { name, next, over };
          if (!words || over > 1) misfits.push(`${name} (${words ? `${Math.round(over)}px below` : 'text differs'})`);
        }
        h.check(misfits.length === 0, `${width}x${height}: all ${banks.length} distinct banks show their text word for word, `
          + `with all three options and "type my own" on screen without scrolling (tallest ${tallest.name}, `
          + `${Math.round(-tallest.over)}px to spare)${misfits.length ? `; misfits: ${misfits.join(', ')}` : ''}`);
        await show(tallest.next);
        await h.screenCheck(k.page, `step, the tallest bank (${tallest.name}), ${width}x${height}`);
        await h.shot(k.page, `step-tallest-${width}`);
        await k.close();
      }));
    },
  },
  {
    name: 'fit: three reply fields as long as the server can send, under the tallest question and tapped answer of the case files, at 1080x1920 and 2160x3840',
    async run(h) {
      const visible = (f) => plainOf(f).length;
      if (!h.check([h.FIELD_MAX_CHARS, h.BOLD_MAX_RUNS, h.BOLD_MAX_CHARS].every(Number.isInteger),
        `the server's limits read from backend/src/services/booth-dialogue.js: FIELD_MAX_CHARS ${h.FIELD_MAX_CHARS}, `
        + `BOLD_MAX_RUNS ${h.BOLD_MAX_RUNS}, BOLD_MAX_CHARS ${h.BOLD_MAX_CHARS}`)) return;
      const FIT_REPLY = Object.fromEntries(Object.entries(FIT_TEXT).map(([k, v]) => [k, atCut(v, h.FIELD_MAX_CHARS)]));
      h.check(h.REPLY_FIELDS.every(({ key }) => visible(FIT_REPLY[key]) === h.FIELD_MAX_CHARS
        && h.same(runsOf(FIT_REPLY[key]).map((r) => r.length), Array(h.BOLD_MAX_RUNS).fill(h.BOLD_MAX_CHARS))),
      `the fit reply: every field ${h.FIELD_MAX_CHARS} visible characters, the longest the server can send, with ${h.BOLD_MAX_RUNS} ${h.BOLD_MAX_CHARS}-character bold runs (${h.REPLY_FIELDS.map(({ key }) => `${key} ${visible(FIT_REPLY[key])}`).join(', ')})`);
      const tallest = h.longestNext((await h.caseTrees()).map(([, t]) => t),
        { bridge: '', size: (o) => o.label.th.length + o.label.en.length });
      const { question, options } = tallest;
      const words = ['ผู้ป่วยมีไข้สูง', 'ปวดน่อง', 'ตาแดง', 'หลังลุยน้ำท่วม', 'จึงควรตรวจเลือด', 'ปัสสาวะ', 'ค่าไต', 'และเริ่มยาปฏิชีวนะ'];
      let typed = '';
      for (let i = 0; typed.length < h.START.answer_max_chars; i++) typed += `${words[i % words.length]} `;
      typed = typed.slice(0, h.START.answer_max_chars);
      const measure = (page) => page.evaluate(() => {
        const body = document.querySelector('.play-body');
        const button = document.querySelector('.play-actions [data-action]').getBoundingClientRect();
        return {
          spare: Math.round(body.getBoundingClientRect().bottom - body.lastElementChild.getBoundingClientRect().bottom),
          overflow: body.scrollHeight - body.clientHeight,
          button: button.top >= 0 && button.bottom <= innerHeight,
          still: scrollY === 0 && document.scrollingElement.scrollHeight <= innerHeight + 1,
        };
      });
      await Promise.all([[1080, 1920], [2160, 3840]].map(async ([width, height]) => {
        const stub = h.makeStub({ routes: {
          'POST /booth/plays': () => ({ status: 201, body: { ...h.START, next: tallest } }),
          [REPLY_KEY]: (call) => ({ status: 200, body: { status: 'replied', reply: FIT_REPLY, reply_sig: h.SIG(call.body.answers.length),
            ...(call.body.answers.length < 3 ? { next: tallest } : {}) } }),
        } });
        const k = await h.kiosk({ stub, width, height, label: `reply fit at ${width}x${height}` });
        await toStep(k);
        const fits = [];
        for (let n = 1; n <= 3; n++) {
          await k.tap(opt(1));
          await k.screen('reply');
          fits.push(await measure(k.page));
          if (n === 1) {
            await checkReply(h, k.page, FIT_REPLY, `fit reply at ${width}x${height}`);
            await h.screenCheck(k.page, `reply at the cut under the tallest question and answer, ${width}x${height}`);
            await h.shot(k.page, `reply-fit-${width}`);
          }
          if (n < 3) {
            await k.tap('[data-action="next"]');
            await k.screen('step');
          }
        }
        h.check(fits.every((f) => f.overflow <= 1 && f.spare >= 0 && f.button && f.still),
          `${width}x${height}: three fields of ${h.FIELD_MAX_CHARS} characters, the longest the server can send, under the tallest question ("${question.en.slice(0, 32)}...") and tapped answer ("${options[0].label.en}") `
          + `fit with no scroll, Next and See my score fully on screen (${fits.map((f, i) => `reply ${i + 1}: ${f.spare}px to spare`).join(', ')})`);
        await k.page.goto(k.page.url(), { waitUntil: 'domcontentloaded' });
        await toStep(k);
        await k.tap('[data-action="type-own"]');
        await k.screen('typing');
        await k.page.fill('.typing-box', typed);
        await k.tap('[data-action="send"]');
        await k.screen('reply');
        const t = await measure(k.page);
        h.check(t.overflow <= 1 && t.spare >= 0 && t.button && t.still,
          `${width}x${height}: a ${typed.trim().length}-character typed answer under three fields of ${h.FIELD_MAX_CHARS} characters fits `
          + `with no scroll, Next fully on screen (${t.spare >= 0 ? `${t.spare}px to spare` : `${-t.spare}px over`})`);
        h.check(await text(k.page, '.answer-text') === typed.trim(),
          `${width}x${height}: the long typed answer is held to its first lines on screen, its whole text kept in the page`);
        await h.shot(k.page, `reply-fit-typed-${width}`);
        await k.close();
      }));
    },
  },
  {
    name: 'ceiling refusal on a reply ends the play on the unavailable card',
    async run(h) {
      const stub = h.makeStub({ routes: {
        [REPLY_KEY]: (call) => ({ status: 200, body: call.body.answers.length === 2 ? { status: 'unavailable' } : h.replyBody(call.body.answers) }),
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
      await k.tap(opt(1));
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
      await k2.tap(opt(1));
      await k2.screen('stopped');
      const shown2 = await k2.page.locator('#booth').innerText();
      h.check(shown2.includes(h.COPY.stoppedOffline.th) && shown2.includes(h.COPY.stoppedOffline.en), 'lost connection: "The connection was lost", TH and EN');
      await k2.close();
    },
  },
  {
    name: 'closed and offline: a notice and no way to start a play',
    async run(h) {
      const closed = h.makeStub({ routes: { 'GET /booth/status': () => ({ status: 200, body: { open: false, reason: 'off', event_code: 'NFCME-2026' } }) } });
      const k = await h.kiosk({ stub: closed, label: 'closed' });
      await k.shell('closed');
      const t = await k.page.locator('#booth').innerText();
      h.check(t.includes(h.COPY.closed.th) && t.includes(h.COPY.closed.en), 'closed: "The booth is closed right now", TH and EN');
      h.check(await count(k.page, 'button:not([data-action="leaderboard"])') === 0 && closed.of('POST /booth/plays').length === 0, 'closed: nothing to tap, no play started');
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
