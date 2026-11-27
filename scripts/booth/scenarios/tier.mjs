// The per-step tier badge (owner, 2026-11-26; ADR 0011 amendment): right after each answer the reply screen names that
// answer's tier beside "Your answer", in the reviewed TIERS labels. A reply with no tier, or a tier the kiosk does not
// know (an older backend, a typed answer the AI gave none), draws no badge. The tier is display only: the kiosk never
// posts it back.
const REPLY_KEY = 'POST /booth/plays/:id/reply';
const SCORE_KEY = 'POST /booth/plays/:id/score';
const SIZES = [[1080, 1920], [2160, 3840]];
const TYPED = 'ไข้ ไอ และหอบ ตรวจเอกซเรย์ปอดก่อน';

/** Sets the look through the kiosk's own setLook, as a tap on the control does (play.mjs lookIn). */
const lookIn = (page, look) => page.evaluate(async (l) => {
  (await import('/js/booth-dom.js')).setLook(l);
  await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(r));
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => {})));
}, look);

/** The badge on the reply screen, read from the DOM: null when none is drawn. */
const readBadge = (page) => page.evaluate(() => {
  const chips = document.querySelectorAll('.tier-chip');
  const chip = document.querySelector('.answer-card .answer-head .tier-chip');
  const shown = (e) => { const r = e?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const box = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const card = document.querySelector('.answer-card');
  const head = document.querySelector('.answer-card .answer-head');
  if (!chip) return { count: chips.length, chip: null, headKids: head ? head.children.length : -1 };
  const main = chip.querySelector('.bi-main');
  const sub = chip.querySelector('.bi-sub');
  return {
    count: chips.length,
    chip: {
      tier: chip.dataset.tier,
      main: { lang: main.lang, text: main.textContent }, sub: { lang: sub.lang, text: sub.textContent, shown: shown(sub) },
      // The main slot reads first: before the sub slot on a shared row, or above it.
      first: !shown(sub) || (() => { const m = box(main); const s = box(sub); return s.top >= m.bottom - 1 || (s.top < m.bottom && s.left >= m.right - 1); })(),
      label: head.querySelector('.answer-label')?.textContent ?? null,
      inCard: (() => { const c = box(card); const b = box(chip); return b.left >= c.left - 0.5 && b.right <= c.right + 0.5 && b.top >= c.top - 0.5 && b.bottom <= c.bottom + 0.5; })(),
      onScreen: (() => { const b = box(chip); return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight; })(),
      clipped: chip.scrollWidth > chip.clientWidth + 1 || chip.scrollHeight > chip.clientHeight + 1,
      firstInCard: card.firstElementChild === head,
    },
  };
});

/** The reply still fits: nothing scrolls, and Next (or See my score) is wholly on screen (play.mjs reply fit). */
const readFit = (page) => page.evaluate(() => {
  const body = document.querySelector('.play-body');
  const button = document.querySelector('.play-actions [data-action]').getBoundingClientRect();
  return {
    spare: Math.round(body.getBoundingClientRect().bottom - body.lastElementChild.getBoundingClientRect().bottom),
    overflow: body.scrollHeight - body.clientHeight,
    button: button.top >= 0 && button.bottom <= innerHeight,
    still: scrollY === 0 && document.scrollingElement.scrollHeight <= innerHeight + 1,
  };
});

/** Tap the offered option of `tier` on the step on screen and send it. @returns {Promise<string>} the id sent */
async function tapTier(h, k, path, tier) {
  const bank = h.bankFor(h.TREE, path);
  const offered = await k.page.$$eval('.options > [data-option]', (els) => els.map((e) => e.dataset.option));
  const id = offered.find((o) => bank.options.find((b) => b.id === o)?.tier === tier);
  await k.tap(`[data-option="${id}"]`);
  await k.page.waitForSelector(`[data-option="${id}"][aria-pressed="true"]`);
  await k.tap('[data-action="send"]');
  return id;
}

async function typeOwn(k, text) {
  await k.tap('[data-action="type-own"]');
  await k.screen('typing');
  await k.page.fill('.typing-box', text);
  await k.tap('[data-action="send"]');
}

/**
 * One play of the three-step fixture. `plan` per step: how the visitor answers (a tier to tap, or 'typed') and what the
 * stub's reply carries as `tier` (a tier name, a value the kiosk must ignore, or undefined for no field). Checks each
 * reply's badge, its fit and its floors, then scores and checks no call posted a tier back.
 */
async function playPlan(h, k, { look, at, plan }) {
  const { primary, both } = h.LOOKS[look];
  const other = primary === 'th' ? 'en' : 'th';
  let path = '';
  for (const [i, step] of plan.entries()) {
    const n = i + 1;
    if (step.answer === 'typed') {
      await typeOwn(k, TYPED);
      path += h.TYPED_TIER;
    } else {
      await tapTier(h, k, path, step.answer);
      path += { best: 'B', reasonable: 'R', weaker: 'W' }[step.answer];
    }
    await k.screen('reply');
    const label = `${at}, ${look}, step ${n} (${step.answer}, reply tier ${JSON.stringify(step.tier) ?? 'absent'})`;
    const badge = await readBadge(k.page);
    const want = Object.hasOwn(h.TIERS, step.tier ?? '') ? step.tier : null;
    if (want === null) {
      h.check(badge.chip === null && badge.count === 0 && badge.headKids === 1,
        `${label}: no badge is drawn, "Your answer" stands alone (${badge.count} chips)`);
    } else {
      const c = badge.chip;
      const words = h.TIERS[want].label;
      h.check(!!c && badge.count === 1 && c.tier === want,
        `${label}: one badge, for ${want} (${c ? c.tier : 'none'}, ${badge.count} chips)`);
      if (c) {
        h.check(c.main.lang === primary && c.main.text === words[primary] && c.sub.lang === other && c.sub.text === words[other]
          && c.sub.shown === both && c.first,
        `${label}: the badge reads "${both ? `${words[primary]} / ${words[other]}` : words[primary]}", the reviewed TIERS label, ${primary} first${both ? `, ${other} after it` : ', no other language'} (main "${c.main.text}", sub "${c.sub.text}" ${c.sub.shown ? 'shown' : 'hidden'})`);
        h.check(c.label === `${h.COPY.yourAnswer.th}${h.COPY.yourAnswer.en}` && c.firstInCard,
          `${label}: the badge sits beside "${h.COPY.yourAnswer.en}" at the top of the answer card`);
        h.check(c.inCard && c.onScreen && !c.clipped, `${label}: the badge sits inside its card, on screen, and its text is not clipped`);
      }
      const tinted = await h.aiTinted(k.page, '.answer-head');
      h.check(tinted.length === 0, `${label}: the badge wears none of the --ai-* colours: the tier is not AI-written text${tinted.length ? ` (${tinted.slice(0, 2).join('; ')})` : ''}`);
    }
    const fit = await readFit(k.page);
    h.check(fit.overflow <= 1 && fit.spare >= 0 && fit.button && fit.still,
      `${label}: the reply fits with no scroll, ${n < plan.length ? 'Next' : 'See my score'} fully on screen (${fit.spare}px to spare)`);
    await h.screenCheck(k.page, `reply with ${want ? `the ${want} badge` : 'no badge'}, ${label}`);
    await h.shot(k.page, `tier-badge-${at}-${look}-step${n}-${want ?? 'none'}`);
    await k.tap(n < plan.length ? '[data-action="next"]' : '[data-action="see-score"]');
    await k.screen(n < plan.length ? 'step' : 'scored');
  }
  const posted = k.stub.calls.filter((c) => c.key === REPLY_KEY || c.key === SCORE_KEY);
  h.check(posted.length === plan.length + 1 && posted.every((c) => c.body.answers.every((a) => !Object.hasOwn(a, 'tier'))),
    `${at}, ${look}: no reply or score call posted a tier back (${posted.length} calls)`);
}

/** A stub whose reply n carries plan[n - 1].tier as `tier` (or no field when undefined) over the default reply body. */
const stubFor = (h, plan) => h.makeStub({ routes: {
  [REPLY_KEY]: (call) => {
    const answers = call.body?.answers ?? [];
    const { tier: _, ...body } = h.replyBody(answers);
    const { tier } = plan[answers.length - 1];
    return { status: 200, body: tier === undefined ? body : { ...body, tier } };
  },
} });

/** Each tier tapped once: every badge colour and label. */
const TAPPED = [{ answer: 'best', tier: 'best' }, { answer: 'reasonable', tier: 'reasonable' }, { answer: 'weaker', tier: 'weaker' }];
/** A typed answer the AI sorted weaker (the neutral label, never a warning), a typed one it gave no tier (the server
 *  sends no field: no badge, never a guess), and a tier the kiosk does not know (ignored, as from an older backend). */
const UNSORTED = [{ answer: 'typed', tier: 'weaker' }, { answer: 'typed', tier: undefined }, { answer: 'best', tier: 'excellent' }];

export default SIZES.map(([width, height]) => ({
  name: `step tier badge at ${width}x${height} in each look: the reviewed label per tier beside "Your answer", it fits, and none without a tier`,
  async run(h) {
    await Promise.all(Object.keys(h.LOOKS).map(async (look) => {
      for (const [name, plan] of [['tapped', TAPPED], ['typed and unknown', UNSORTED]]) {
        const k = await h.kiosk({ stub: stubFor(h, plan), width, height, label: `tier badge ${name} at ${width}x${height}, ${look}` });
        await k.shell('start');
        await lookIn(k.page, look);
        await k.toVignette();
        await k.tap('[data-action="begin"]');
        await k.screen('step');
        await playPlan(h, k, { look, at: `${width}x${height}`, plan });
        await k.close();
      }
    }));
  },
}));
