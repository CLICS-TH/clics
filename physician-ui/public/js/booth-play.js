// Contract with the shell (booth-shell.js; #213 rewrites the shell, never this file):
//   - runPlay renders into `root`, which the shell owns and may cover with overlays.
//   - root.dataset.screen always names the screen on show (SCREEN). #213 reads it to hold its idle timer while
//     'scoring' and to start its result timer; the harness waits on it. The score's wait shows only once the score
//     has taken SCORING_SHOWN_MS: a faster score goes from 'reply' straight to its terminal screen, never 'scoring'.
//   - runPlay resolves once a terminal screen is showing. The screen stays up until the shell resets the page.
//   - Start over's Leave calls `reset` (the shell's page reload, as Done does) and makes no request.
// Contract with the board (booth-board.js): the result card's tag is renderTag(tag), and its board panel is
// mountResultBoard(slot, { tag, scoreBody }); its leaderboard button is leaderboardButton({ host, api, board, tag }).
import { COPY, DEMO_LABEL, DOMAINS, LOOKS, REPLY_FIELDS, TIERS, scoreText, fill, isDomainScore } from './booth-copy.js';
import { renderTag, mountResultBoard, leaderboardButton } from './booth-board.js';
import { domainSections } from './booth-domains.js';
import { radar } from './booth-radar.js';
import { revealRows, answersButton } from './booth-answers.js';
import { resultUrl, boothDate } from './booth-result-link.js';
import { BoothApiError } from './booth-api.js';
import { el, phrases, markedPhrases, bi, textLang, currentLook, onLook } from './booth-dom.js';

const START_TIMEOUT_MS = 15_000;
const REPLY_TIMEOUT_MS = 45_000;
const SCORE_TIMEOUT_MS = 75_000;
const SCORING_SHOWN_MS = 1_000;
const STILL_WORKING_MS = 8_000;
/** A start that names no step count comes from a backend older than five-step cases (spec #370): its plays are three. */
const OLDER_BACKEND_STEPS = 3;
const MAX_STEPS = 5;
const GHOST_TAP_MS = 350;

/**
 * @typedef {{ th: string, en: string }} Bi
 * @typedef {{ id: string, label: Bi, line: Bi }} Option
 * @typedef {{ variant: string, bridge: string, options: string[] }} Ask   ids only, posted back as the server sent it
 * @typedef {{ ask: Ask, question: Bi, options: Option[] }} Next   options in ask.options order, text from the case file
 * @typedef {{ id: string, tag: number, vignette: Bi, teaser: Bi, answerMax: number, steps: number }} Play
 *   steps: how many answers the play takes (1-5), from the start; the last reply carries no Next.
 * @typedef {{ choice: string } | { text: string, deidentified?: string }} Answer
 *   deidentified: the server's de-identified copy of a typed answer, from its reply, posted back untouched (ADR 0010).
 * @typedef {{ strength: string, weigh: string, safety: string }} Reply   the object as received, posted back as is.
 *   '' is an absent field, and all three '' is no reply. Inside a field `**…**` marks a bold run the server checked.
 * @typedef {{ tier: string, options: { id: string, tier: string }[] }} StepTier   options in the posted ask's order
 * @typedef {{ composite: number, domains: Record<string, number>, steps: StepTier[] | null, body: object }} Score
 *   `body` is the score response as received, handed to mountResultBoard so #212 can read its rank fields.
 *   `steps` is null when the response carries no tiers that fit the asks posted (a backend older than #372).
 *
 * @typedef {{ at: 'vignette' } | { at: 'step', chosen: string | null } | { at: 'typing' } | { at: 'replying' } | { at: 'reply' }
 *         | { at: 'scoring', shown: boolean } | { at: 'scored', score: Score } | { at: 'unavailable' }
 *         | { at: 'stopped', offline: boolean }} Screen
 *   step.chosen is the option the visitor tapped (an id of the step's ask), sent only by Send. scoring.shown is false
 *   for the score's first SCORING_SHOWN_MS, while the reply screen stays up.
 * @typedef {{ play: Play, steps: Next[], answers: Answer[], replies: Reply[], sigs: string[], screen: Screen }} PlayState
 *   steps[i] is the Next the server issued for step i (start, then each reply); the asks posted back are its
 *   asks. sigs[0] comes from start and sigs[k] from the reply to answer k; each binds everything issued before it.
 *
 * @typedef {{ type: 'begin' } | { type: 'choose', choice: string } | { type: 'sendChoice' } | { type: 'openTyping' } | { type: 'closeTyping' }
 *         | { type: 'sendText', text: string } | { type: 'replied', reply: Reply, sig: string, next: Next | null, deidentified: string | null } | { type: 'next' }
 *         | { type: 'slow' } | { type: 'scored', score: Score } | { type: 'unavailable' } | { type: 'stop', offline: boolean }} PlayEvent
 *   sendChoice is the step's Send: it sends step.chosen.
 * @typedef {{ kind: 'scored' | 'unavailable' | 'stopped' }} PlayOutcome
 */

/** root.dataset.screen values: the Screen tags plus the three before the play exists: 'drawing' (a case is being
 *  dealt), 'teaser' (the dealt case is offered) and 'starting'. */
export const SCREEN = Object.freeze(['drawing', 'teaser', 'starting', 'vignette', 'step', 'typing', 'replying', 'reply',
  'scoring', 'scored', 'unavailable', 'stopped']);
const TERMINAL = new Set(['scored', 'unavailable', 'stopped']);
/** The screens that offer Start over. A confirm left open outlives a redraw to one of them. */
const START_OVER = new Set(['vignette', 'step', 'typing', 'replying', 'reply']);

/**
 * Deal cases until the visitor starts one. The cases seen so far live in this call only; the server restarts the
 * list (the id it returns is already in it) when it has dealt them all.
 * @returns {Promise<ReturnType<typeof parseStart>>} null when a call failed or answered unreadably
 */
async function startOnADealtCase(root, api) {
  let seen = [];
  for (;;) {
    draw(root, 'drawing', frame([waitView(COPY.drawing)]));
    const dealt = parseDraw(await api.post('/booth/draw', { seen }, { timeoutMs: START_TIMEOUT_MS }));
    if (!dealt) return null;
    seen = seen.includes(dealt.caseId) ? [dealt.caseId] : [...seen, dealt.caseId];
    if (await offerCase(root, dealt) === 'reroll') continue;
    draw(root, 'starting', frame([waitView(COPY.starting)]));
    try {
      return parseStart(await api.post('/booth/plays', { case_id: dealt.caseId }, { timeoutMs: START_TIMEOUT_MS }), dealt.teaser);
    } catch (e) {
      // The case was switched off after it was dealt: deal another, with no word to the visitor.
      if (!(e instanceof BoothApiError && e.kind === 'http' && e.reason === 'case_off')) throw e;
    }
  }
}

/**
 * Run one booth play to a terminal screen.
 * @param {{ root: HTMLElement, api: ReturnType<import('./booth-api.js').createBoothApi>, reset: () => void }} ctx
 * @returns {Promise<PlayOutcome>}
 */
export async function runPlay({ root, api, reset }) {
  let start = null;
  let offline = false;
  try {
    start = await startOnADealtCase(root, api);
  } catch (e) {
    offline = isOffline(e);
  }
  if (!start) {
    draw(root, 'stopped', frame([stoppedView(offline)]));
    return { kind: 'stopped' };
  }
  const ctx = { root, host: root.closest('#booth') ?? root, api, reset };
  return new Promise((resolve) => {
    let state = { play: start.play, steps: [start.next], answers: [], replies: [], sigs: [start.sig], screen: { at: 'vignette' } };
    const dispatch = (ev) => {
      const next = transition(state, ev);
      if (next === state) return;
      const entered = next.screen.at !== state.screen.at;
      state = next;
      const { at } = state.screen;
      if (at === 'step' && !entered) showChoice(root, state.screen.chosen);
      else if (at !== 'scoring' || state.screen.shown) render(state, dispatch, ctx);
      if (!entered) return;
      if (at === 'replying') requestReply(api, state).then(dispatch);
      else if (at === 'scoring') {
        // The reply screen stays up for up to a second. The score request is already sent, so Leave could no longer keep
        // the play unscored, as its confirm says.
        root.querySelector('[data-action="start-over"]')?.setAttribute('disabled', '');
        requestScore(api, state).then(dispatch);
        setTimeout(() => dispatch({ type: 'slow' }), SCORING_SHOWN_MS);
      } else if (TERMINAL.has(at)) resolve({ kind: at });
    };
    render(state, dispatch, ctx);
  });
}

/** @param {PlayState} s @param {PlayEvent} ev @returns {PlayState} */
function transition(s, ev) {
  const at = s.screen.at;
  switch (ev.type) {
    case 'begin': return at === 'vignette' ? { ...s, screen: { at: 'step', chosen: null } } : s;
    case 'choose': return at === 'step' && s.screen.chosen !== ev.choice && stepOf(s).ask.options.includes(ev.choice)
      ? { ...s, screen: { at: 'step', chosen: ev.choice } } : s;
    case 'sendChoice': return at === 'step' && s.screen.chosen ? answered(s, { choice: s.screen.chosen }) : s;
    case 'openTyping': return at === 'step' ? { ...s, screen: { at: 'typing' } } : s;
    case 'closeTyping': return at === 'typing' ? { ...s, screen: { at: 'step', chosen: null } } : s;
    case 'sendText': {
      const text = ev.text.trim();
      return at === 'typing' && text.length > 0 && text.length <= s.play.answerMax ? answered(s, { text }) : s;
    }
    case 'replied': return at === 'replying'
      ? { ...s, answers: keptAnswers(s.answers, ev.deidentified), replies: [...s.replies, ev.reply], sigs: [...s.sigs, ev.sig], steps: ev.next ? [...s.steps, ev.next] : s.steps, screen: { at: 'reply' } } : s;
    case 'next':
      if (at !== 'reply') return s;
      return { ...s, screen: s.answers.length < s.play.steps ? { at: 'step', chosen: null } : { at: 'scoring', shown: false } };
    case 'slow': return at === 'scoring' && !s.screen.shown ? { ...s, screen: { at: 'scoring', shown: true } } : s;
    case 'scored': return at === 'scoring' ? { ...s, screen: { at: 'scored', score: ev.score } } : s;
    case 'unavailable': return at === 'replying' || at === 'scoring' ? { ...s, screen: { at: 'unavailable' } } : s;
    case 'stop': return TERMINAL.has(at) ? s : { ...s, screen: { at: 'stopped', offline: ev.offline } };
    default: return s;
  }
}

const answered = (s, answer) => ({ ...s, answers: [...s.answers, answer], screen: { at: 'replying' } });

// The reply's turn sig binds a typed answer's de-identified text, so the score must post it back as given.
function keptAnswers(answers, deidentified) {
  const last = answers[answers.length - 1];
  return typeof deidentified === 'string' && 'text' in last ? [...answers.slice(0, -1), { ...last, deidentified }] : answers;
}

const stepIndex = (s) => (s.screen.at === 'step' || s.screen.at === 'typing' ? s.answers.length : s.answers.length - 1);
const stepOf = (s) => s.steps[stepIndex(s)];
const dialogue = (s) => ({ answers: s.answers, replies: s.replies, asks: s.steps.slice(0, s.answers.length).map((n) => n.ask), sigs: s.sigs,
  look: currentLook() });
const isOffline = (e) => !(e instanceof BoothApiError && e.kind === 'http');

async function requestReply(api, s) {
  try {
    const body = await api.post(`/booth/plays/${encodeURIComponent(s.play.id)}/reply`, dialogue(s), { timeoutMs: REPLY_TIMEOUT_MS });
    if (body?.status === 'unavailable') return { type: 'unavailable' };
    const last = s.answers.length === s.play.steps;
    const next = last ? null : parseNext(body?.next);
    const reply = parseReply(body?.reply);
    if (body?.status === 'replied' && reply && typeof body.reply_sig === 'string' && (next || last)) {
      return { type: 'replied', reply, sig: body.reply_sig, next,
        deidentified: typeof body.deidentified === 'string' ? body.deidentified : null };
    }
    return { type: 'stop', offline: false };
  } catch (e) {
    return { type: 'stop', offline: isOffline(e) };
  }
}

async function requestScore(api, s) {
  try {
    const body = await api.post(`/booth/plays/${encodeURIComponent(s.play.id)}/score`, dialogue(s), { timeoutMs: SCORE_TIMEOUT_MS });
    if (body?.status === 'unavailable') return { type: 'unavailable' };
    const score = parseScore(body, s);
    return score ? { type: 'scored', score } : { type: 'stop', offline: false };
  } catch (e) {
    return { type: 'stop', offline: isOffline(e) };
  }
}

const isBi = (v) => !!v && typeof v.th === 'string' && typeof v.en === 'string' && v.th.trim() !== '' && v.en.trim() !== '';

const isId = (v) => typeof v === 'string' && v !== '';

/** @returns {Next | null} */
function parseNext(n) {
  const ask = n?.ask;
  if (!isId(ask?.variant) || typeof ask.bridge !== 'string' || !Array.isArray(ask.options) || ask.options.length !== 3
    || !ask.options.every(isId) || new Set(ask.options).size !== 3 || !isBi(n.question)
    || !Array.isArray(n.options) || n.options.length !== 3
    || !n.options.every((o, i) => o?.id === ask.options[i] && isBi(o.label) && isBi(o.line))) {
    return null;
  }
  return { ask: { variant: ask.variant, bridge: ask.bridge, options: [...ask.options] }, question: n.question, options: n.options };
}

/** @returns {Reply | null} `r` itself, so the reply goes back to the server exactly as it came */
function parseReply(r) {
  return r !== null && typeof r === 'object' && Object.keys(r).length === REPLY_FIELDS.length
    && REPLY_FIELDS.every(({ key }) => typeof r[key] === 'string') ? r : null;
}

/** `live` is how many cases can be dealt now; null when the server does not say (a backend older than the count).
 *  @returns {{ caseId: string, teaser: Bi, live: number | null } | null} */
function parseDraw(body) {
  if (!isId(body?.case_id) || !isBi(body.teaser)) return null;
  const live = Number.isInteger(body.live) && body.live >= 1 ? body.live : null;
  return { caseId: body.case_id, teaser: { th: body.teaser.th, en: body.teaser.en }, live };
}

function parseStart(body, teaser) {
  const next = parseNext(body?.next);
  const steps = body?.steps === undefined ? OLDER_BACKEND_STEPS : body.steps;
  if (!isId(body?.play_id) || !Number.isInteger(body.tag) || body.tag < 1
    || !Number.isInteger(body.answer_max_chars) || body.answer_max_chars < 1
    || !isBi(body.case?.vignette) || !next || !isId(body.sig)
    || !Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) {
    return null;
  }
  return { play: { id: body.play_id, tag: body.tag, answerMax: body.answer_max_chars, vignette: body.case.vignette, teaser, steps }, next, sig: body.sig };
}

function parseScore(body, s) {
  if (body?.status !== 'scored' || !Number.isFinite(body.composite) || body.composite < 0 || body.composite > 100) return null;
  const domains = {};
  for (const { key } of DOMAINS) {
    const v = body.domains?.[key];
    if (!isDomainScore(v)) return null;
    domains[key] = v;
  }
  return { composite: body.composite, domains, steps: parseSteps(body.steps, dialogue(s).asks), body };
}

const isTier = (v) => typeof v === 'string' && Object.hasOwn(TIERS, v);

/** One StepTier per answer, each naming the options of the ask posted for it, in order; else null. */
function parseSteps(steps, asks) {
  if (!Array.isArray(steps) || steps.length !== asks.length) return null;
  const fits = steps.every((st, i) => isTier(st?.tier) && Array.isArray(st.options) && st.options.length === asks[i].options.length
    && st.options.every((o, j) => o?.id === asks[i].options[j] && isTier(o.tier)));
  return fits ? steps.map((st) => ({ tier: st.tier, options: st.options.map((o) => ({ id: o.id, tier: o.tier })) })) : null;
}

// A newline inside a phrase's inline block would split that block in two, not end the line.
const plainText = (text) => text.split('\n').flatMap((line, i) => (i ? ['\n', ...phrases(line)] : phrases(line)));

const icon = (name) => el('span', { class: 'booth-icon', dataset: { icon: name } });

const labelled = (pair, lead = null, trail = null) => [lead && icon(lead), bi(pair, 'btn-label'), trail && icon(trail)];

function frame(body, actions = [], { stack = false } = {}) {
  return el('div', { class: 'play-frame' },
    el('div', { class: 'play-body' }, ...body),
    actions.length ? el('div', { class: stack ? 'play-actions play-actions--stack' : 'play-actions' }, ...actions) : null,
    el('div', { class: 'play-foot' }, el('div', { class: 'demo-label', dataset: { demoLabel: '' } }, bi(DEMO_LABEL))));
}

function draw(root, at, node) {
  root.replaceChildren(node);
  root.dataset.screen = at;
  window.hydrateIcons?.(root);
}

/** The button maker of one screen: a tap within GHOST_TAP_MS of the screen being drawn is the tail of the tap that drew
 *  it. `ev` is called at the tap and its result goes to `act`. */
function buttonsFor(act) {
  const drawnAt = performance.now();
  return (kids, cls, ev, attrs = {}) => {
    const b = el('button', { type: 'button', class: `booth-btn ${cls}`, ...attrs }, ...kids);
    b.addEventListener('click', () => { if (performance.now() - drawnAt >= GHOST_TAP_MS) act(ev()); });
    return b;
  };
}

/** @param {PlayState} s @param {(ev: PlayEvent) => void} dispatch */
function render(s, dispatch, { root, host, api, reset }) {
  const { at } = s.screen;
  const view = VIEWS[at](s, { button: buttonsFor(dispatch), host, api });
  if (START_OVER.has(at)) {
    view.querySelector('.play-foot').append(buttonsFor(() => confirmLeave(host, reset))(
      labelled(COPY.startOver), 'secondary start-over', () => null, { 'data-action': 'start-over' }));
  } else {
    // The play moved on by itself (a score came back): a Start over still asking would ask about a screen now gone.
    host.querySelector('[data-leave-confirm]')?.remove();
  }
  draw(root, at, view);
}

/** A choice updates the drawn step in place: a redraw would restart both ghost-tap guards and drop a quick second tap. */
function showChoice(root, chosen) {
  for (const o of root.querySelectorAll('[data-option]')) o.setAttribute('aria-pressed', String(o.dataset.option === chosen));
  const send = root.querySelector('[data-action="send"]');
  send.disabled = !chosen;
  // Eased out of the disabled track, Send's white label would sit on the track for a moment.
  for (const a of send.getAnimations()) a.finish();
}

/** "Leave this play?" over the whole screen. Leave is the shell's reset; Keep playing, or a tap on the scrim outside
 *  the card, closes it and hands the focus to Start over. The play goes on under it: a reply can land meanwhile. */
function confirmLeave(host, reset) {
  const leave = el('button', { type: 'button', class: 'booth-btn secondary', dataset: { action: 'leave' } }, bi(COPY.leave, 'btn-label'));
  const keep = el('button', { type: 'button', class: 'booth-btn primary', dataset: { action: 'keep-playing' } }, bi(COPY.keepPlaying, 'btn-label'));
  const overlay = el('div', { class: 'leave-confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': `${COPY.leaveTitle.th} ${COPY.leaveTitle.en}`, dataset: { leaveConfirm: '' } },
    el('div', { class: 'leave-card' }, bi(COPY.leaveTitle, 'leave-title'), bi(COPY.leaveLine), el('div', { class: 'action-row' }, leave, keep)));
  overlay.addEventListener('click', (e) => {
    if (e.target !== overlay && !keep.contains(e.target)) return;
    overlay.remove();
    host.querySelector('[data-action="start-over"]')?.focus({ preventScroll: true });
  });
  leave.addEventListener('click', reset, { once: true });
  host.append(overlay);
  keep.focus({ preventScroll: true });
}

/** The dealt case's teaser and the ways on. Resolves 'start' or 'reroll' on the first tap that counts. With one live
 *  case a reroll could only deal it again, so it is not offered; it comes back by itself once a second case is live.
 *  @returns {Promise<'start' | 'reroll'>} */
function offerCase(root, dealt) {
  return new Promise((resolve) => {
    const button = buttonsFor(resolve);
    const reroll = dealt.live === null || dealt.live >= 2;
    draw(root, 'teaser', frame(
      [caseCard(dealt.teaser, 'teaser', 'case-card--full')],
      [button(labelled(COPY.startCase, null, 'arrowRight'), 'primary wide', () => 'start', { 'data-action': 'start-case' }),
        ...(reroll ? [button(labelled(COPY.reroll, 'refresh'), 'secondary wide', () => 'reroll', { 'data-action': 'reroll' })] : [])],
      { stack: true }));
  });
}

const VIEWS = {
  vignette: (s, { button }) => frame(
    [caseCard(s.play.vignette, 'vignette', 'case-card--full')],
    [button(labelled(COPY.begin, null, 'arrowRight'), 'primary wide', () => ({ type: 'begin' }), { 'data-action': 'begin' })]),

  step: (s, { button }) => {
    const step = stepOf(s);
    const { chosen } = s.screen;
    return frame([
      caseCard(s.play.vignette, 'vignette'),
      el('section', { class: 'step-sheet', 'aria-label': step.question.en },
        stepHead(s, step, { bridge: true }),
        el('div', { class: 'options' }, ...step.options.map((o, i) => button(
          [optionBody(o, i)], 'secondary wide option', () => ({ type: 'choose', choice: o.id }),
          { 'data-option': o.id, 'aria-pressed': String(o.id === chosen) }))),
        el('div', { class: 'action-row' },
          button(labelled(COPY.typeOwn, 'pencil'), 'secondary', () => ({ type: 'openTyping' }), { 'data-action': 'type-own' }),
          button(labelled(COPY.send), 'primary', () => ({ type: 'sendChoice' }),
            { 'data-action': 'send', ...(chosen ? {} : { disabled: '' }) }))),
    ]);
  },

  typing: (s, { button }) => {
    const step = stepOf(s);
    const box = el('textarea', {
      class: 'typing-box', maxlength: String(s.play.answerMax), rows: '3', enterkeyhint: 'enter', lang: LOOKS[currentLook()].primary, 'data-look-lang': '',
      'aria-label': `${COPY.typeOwn.th} ${COPY.typeOwn.en}`, autocomplete: 'off', spellcheck: 'false',
    });
    const send = button(labelled(COPY.send), 'primary', () => ({ type: 'sendText', text: box.value }), { 'data-action': 'send', disabled: '' });
    box.addEventListener('input', () => { send.disabled = box.value.trim() === ''; });
    queueMicrotask(() => box.focus({ preventScroll: true }));
    return frame([
      el('section', { class: 'step-sheet typing-sheet', 'aria-label': step.question.en },
        stepHead(s, step),
        box,
        bi(COPY.enterHint, 'hint'),
        el('div', { class: 'action-row' },
          button(labelled(COPY.backToChoices), 'secondary', () => ({ type: 'closeTyping' }), { 'data-action': 'back' }),
          send)),
      caseCard(s.play.vignette, 'vignette', 'case-card--behind'),
    ]);
  },

  replying: (s) => frame([exchange(s, aiBubble(withStillWorking(el('span', { class: 'ai-wait', role: 'status' }, bi(COPY.replying), dots()))))]),

  reply: (s, { button }) => {
    const reply = s.replies[s.replies.length - 1];
    const fields = REPLY_FIELDS.filter(({ key }) => reply[key].trim() !== '');
    const said = fields.length === 0 ? bi(COPY.noReply, 'reply-note') : aiBubble(...fields.map((f) => el('section',
      { class: 'reply-field', dataset: { field: f.key }, 'aria-label': f.en },
      bi(f, 'reply-head'), el('p', { class: 'ai-text', lang: textLang(reply[f.key]) }, ...markedPhrases(reply[f.key])))));
    const [copy, action] = s.answers.length === s.play.steps ? [COPY.seeScore, 'see-score'] : [COPY.next, 'next'];
    return frame([exchange(s, said)],
      [button(labelled(copy, null, 'arrowRight'), 'primary wide', () => ({ type: 'next' }), { 'data-action': action })]);
  },

  // Drawn by 'slow', SCORING_SHOWN_MS after the score request: the still-working line keeps its time from the request.
  scoring: () => frame([waitView(COPY.scoring, STILL_WORKING_MS - SCORING_SHOWN_MS)]),

  scored: (s, { host, api }) => {
    const { score } = s.screen;
    const slot = el('div', { class: 'board-slot', dataset: { boothSlot: 'board' } });
    const card = el('article', { class: 'result-card' },
      el('div', { class: 'result-top' },
        el('div', { class: 'result-summary' },
          renderTag(s.play.tag),
          el('div', { class: 'result-total' },
            bi(COPY.overall, 'result-overall'),
            el('p', { class: 'result-score' },
              el('span', { class: 'result-number', dataset: { score: '' } }, scoreText(score.composite)),
              el('span', { class: 'result-outof' }, '/ 100'))),
          radar(score.domains)),
        el('div', { class: 'result-side' },
          keepQr(s.play, score),
          score.steps ? answersButton({ host, rows: revealRows(s.steps, s.answers, score.steps) }) : null)),
      // The ranks sit beside the leaderboard button: under the score they would push Practise next below the fold.
      el('div', { class: 'result-more' }, ...domainSections(score.domains, s.play.steps, el('div', { class: 'result-board-row' },
        slot, leaderboardButton({ host, api, board: score.body.board, tag: s.play.tag, short: true })))));
    mountResultBoard(slot, { tag: s.play.tag, scoreBody: score.body });
    return frame([card]);
  },

  unavailable: () => frame([el('article', { class: 'end-card' }, bi(COPY.unavailable, 'end-title'), bi(COPY.thanks))]),

  stopped: (s) => frame([stoppedView(s.screen.offline)]),
};

// The text scrolls in a box of its own, inside the card's top padding, so a scrolled line never rises into the screen's
// top corner, where the language control sits.
function caseCard(pair, cls, mod = '') {
  return el('section', { class: `case-card ${mod}`.trim() }, el('div', { class: 'case-text' }, bi(pair, cls)));
}

// The bridge is the AI's lead-in to this question, so it sits in the question's own block, AI-labelled.
function stepHead(s, step, { bridge = false } = {}) {
  const lead = bridge && step.ask.bridge.trim() !== ''
    ? el('p', { class: 'ai-bridge', dataset: { bridge: '' } },
      el('span', { class: 'ai-label' }, window.AI_LABEL.th), ' ',
      el('span', { class: 'bridge-text', lang: textLang(step.ask.bridge) }, ...phrases(step.ask.bridge)))
    : null;
  return el('header', { class: 'step-head' },
    bi(fill(COPY.stepOf, { n: stepIndex(s) + 1, total: s.play.steps }), 'step-of'),
    el('div', { class: lead ? 'prompt prompt--bridged' : 'prompt' }, lead, bi(step.question, 'question')));
}

const LETTERS = ['A', 'B', 'C'];

function optionBody(o, i) {
  return el('span', { class: 'opt-inner' },
    el('span', { class: 'opt-letter', 'aria-hidden': 'true' }, LETTERS[i]),
    el('span', { class: 'opt-text' }, bi(o.label, 'opt-label'), bi(o.line, 'opt-line')));
}

function exchange(s, aiPart) {
  const step = stepOf(s);
  const answer = s.answers[s.answers.length - 1];
  const given = 'choice' in answer
    ? bi(step.options.find((o) => o.id === answer.choice).label, 'answer-choice')
    : el('p', { class: 'answer-text', lang: textLang(answer.text) }, ...plainText(answer.text));
  return el('div', { class: 'exchange' },
    stepHead(s, step),
    el('section', { class: 'answer-card', 'aria-label': COPY.yourAnswer.en }, bi(COPY.yourAnswer, 'answer-label'), given),
    aiPart);
}

function aiBubble(...content) {
  const label = window.AI_LABEL.th;
  return el('section', { class: 'ai-bubble', 'aria-label': label }, el('p', { class: 'ai-label' }, label), ...content);
}

const dots = () => el('span', { class: 'waiting-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'));

function waitView(title, stillWorkingMs) {
  return withStillWorking(el('div', { class: 'wait', role: 'status' }, bi(title, 'wait-title'), dots()), stillWorkingMs);
}

function withStillWorking(status, ms = STILL_WORKING_MS) {
  setTimeout(() => { if (status.isConnected) status.append(bi(COPY.stillWorking)); }, ms);
  return status;
}

function stoppedView(offline) {
  return el('article', { class: 'end-card' },
    bi(COPY.stopped, 'end-title'), offline ? bi(COPY.stoppedOffline) : null, bi(COPY.restarting));
}

function svgEl(tag, attrs, ...kids) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

// The QR is drawn here from the vendored encoder (js/vendor/qrcode-generator-1.4.4.js), so nothing leaves the kiosk.
// The link carries the look, so it is drawn again on a switch; the card itself is not, or the result's idle timer
// (booth-idle.js, keyed on data-screen) would start over.
function keepQr(play, score) {
  const fig = el('figure', { class: 'keep-qr', dataset: { keepQr: '' } }, bi(COPY.keepResult, 'keep-qr-caption'));
  const drawQr = () => {
    const url = resultUrl(location.origin, { score: score.composite, domains: score.domains, tag: play.tag, date: boothDate(), teaser: play.teaser,
      tiers: score.steps?.map((st) => st.tier) ?? null, look: currentLook() });
    const qr = window.qrcode(0, 'L');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    const svg = svgEl('svg', { viewBox: `0 0 ${n + 8} ${n + 8}`, 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': COPY.keepResult.en },
      svgEl('rect', { width: String(n + 8), height: String(n + 8), fill: '#fff' }), svgEl('path', { fill: '#000', d }));
    fig.querySelector('svg')?.remove();
    fig.prepend(svg);
    fig.dataset.resultUrl = url;
  };
  drawQr();
  const off = onLook(() => { if (fig.isConnected) drawQr(); else off(); });
  return fig;
}
