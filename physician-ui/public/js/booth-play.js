// Contract with the shell (booth-shell.js; #213 rewrites the shell, never this file):
//   - runPlay renders into `root`, which the shell owns and may cover with overlays.
//   - root.dataset.screen always names the current screen (SCREEN). #213 reads it to hold its idle timer while
//     'scoring' and to start its result timer; the harness waits on it.
//   - runPlay resolves once a terminal screen is showing. The screen stays up until the shell resets the page.
// Contract with the board (booth-board.js): the result card's tag is renderTag(tag), and its board panel is
// mountResultBoard(slot, { tag, scoreBody }); its leaderboard button is leaderboardButton({ host, api, board, tag }).
import { COPY, DEMO_LABEL, DOMAINS, scoreText, fill } from './booth-copy.js';
import { renderTag, mountResultBoard, leaderboardButton } from './booth-board.js';
import { BAND_LINES, bandOf, weakestFirst } from './booth-bands.js';
import { BoothApiError } from './booth-api.js';
import { el, phrases, bi } from './booth-dom.js';

const START_TIMEOUT_MS = 15_000;
const REPLY_TIMEOUT_MS = 45_000;
const SCORE_TIMEOUT_MS = 75_000;
const STEPS = 3;
const GHOST_TAP_MS = 350;

/**
 * @typedef {{ th: string, en: string }} Bi
 * @typedef {{ id: string, label: Bi, line: Bi }} Option
 * @typedef {{ variant: string, bridge: string, options: string[] }} Ask   ids only, posted back as the server sent it
 * @typedef {{ ask: Ask, question: Bi, options: Option[] }} Next   options in ask.options order, text from the case file
 * @typedef {{ id: string, tag: number, vignette: Bi, answerMax: number }} Play
 * @typedef {{ choice: string } | { text: string }} Answer
 * @typedef {{ composite: number, domains: Record<string, number>, body: object }} Score
 *   `body` is the score response as received, handed to mountResultBoard so #212 can read its rank fields.
 *
 * @typedef {{ at: 'vignette' } | { at: 'step' } | { at: 'typing' } | { at: 'replying' } | { at: 'reply' }
 *         | { at: 'scoring' } | { at: 'scored', score: Score } | { at: 'unavailable' }
 *         | { at: 'stopped', offline: boolean }} Screen
 * @typedef {{ play: Play, steps: Next[], answers: Answer[], replies: string[], sigs: string[], screen: Screen }} PlayState
 *   steps[i] is the Next the server issued for step i (start, then each reply); the asks posted back are its
 *   asks. sigs[0] comes from start and sigs[k] from the reply to answer k; each binds everything issued before it.
 *
 * @typedef {{ type: 'begin' } | { type: 'openTyping' } | { type: 'closeTyping' } | { type: 'answer', answer: Answer }
 *         | { type: 'replied', text: string, sig: string, next: Next | null } | { type: 'next' } | { type: 'scored', score: Score }
 *         | { type: 'unavailable' } | { type: 'stop', offline: boolean }} PlayEvent
 * @typedef {{ kind: 'scored' | 'unavailable' | 'stopped' }} PlayOutcome
 */

/** root.dataset.screen values: the Screen tags plus the three before the play exists: 'drawing' (a case is being
 *  dealt), 'teaser' (the dealt case is offered) and 'starting'. */
export const SCREEN = Object.freeze(['drawing', 'teaser', 'starting', 'vignette', 'step', 'typing', 'replying', 'reply',
  'scoring', 'scored', 'unavailable', 'stopped']);
const TERMINAL = new Set(['scored', 'unavailable', 'stopped']);

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
      return parseStart(await api.post('/booth/plays', { case_id: dealt.caseId }, { timeoutMs: START_TIMEOUT_MS }));
    } catch (e) {
      // The case was switched off after it was dealt: deal another, with no word to the visitor.
      if (!(e instanceof BoothApiError && e.kind === 'http' && e.reason === 'case_off')) throw e;
    }
  }
}

/**
 * Run one booth play to a terminal screen.
 * @param {{ root: HTMLElement, api: ReturnType<import('./booth-api.js').createBoothApi> }} ctx
 * @returns {Promise<PlayOutcome>}
 */
export async function runPlay({ root, api }) {
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
  return new Promise((resolve) => {
    let state = { play: start.play, steps: [start.next], answers: [], replies: [], sigs: [start.sig], screen: { at: 'vignette' } };
    const dispatch = (ev) => {
      const next = transition(state, ev);
      if (next === state) return;
      state = next;
      render(root, state, dispatch, api);
      if (state.screen.at === 'replying') requestReply(api, state).then(dispatch);
      else if (state.screen.at === 'scoring') requestScore(api, state).then(dispatch);
      else if (TERMINAL.has(state.screen.at)) resolve({ kind: state.screen.at });
    };
    render(root, state, dispatch, api);
  });
}

/** @param {PlayState} s @param {PlayEvent} ev @returns {PlayState} */
function transition(s, ev) {
  const at = s.screen.at;
  switch (ev.type) {
    case 'begin': return at === 'vignette' ? { ...s, screen: { at: 'step' } } : s;
    case 'openTyping': return at === 'step' ? { ...s, screen: { at: 'typing' } } : s;
    case 'closeTyping': return at === 'typing' ? { ...s, screen: { at: 'step' } } : s;
    case 'answer': {
      const answer = acceptAnswer(s, ev.answer);
      return answer ? { ...s, answers: [...s.answers, answer], screen: { at: 'replying' } } : s;
    }
    case 'replied': return at === 'replying'
      ? { ...s, replies: [...s.replies, ev.text], sigs: [...s.sigs, ev.sig], steps: ev.next ? [...s.steps, ev.next] : s.steps, screen: { at: 'reply' } } : s;
    case 'next':
      if (at !== 'reply') return s;
      return { ...s, screen: { at: s.answers.length < STEPS ? 'step' : 'scoring' } };
    case 'scored': return at === 'scoring' ? { ...s, screen: { at: 'scored', score: ev.score } } : s;
    case 'unavailable': return at === 'replying' || at === 'scoring' ? { ...s, screen: { at: 'unavailable' } } : s;
    case 'stop': return TERMINAL.has(at) ? s : { ...s, screen: { at: 'stopped', offline: ev.offline } };
    default: return s;
  }
}

function acceptAnswer(s, answer) {
  if (s.screen.at === 'step' && 'choice' in answer) {
    return stepOf(s).ask.options.includes(answer.choice) ? { choice: answer.choice } : null;
  }
  if (s.screen.at === 'typing' && 'text' in answer) {
    const text = answer.text.trim();
    return text.length > 0 && text.length <= s.play.answerMax ? { text } : null;
  }
  return null;
}

const stepIndex = (s) => (s.screen.at === 'step' || s.screen.at === 'typing' ? s.answers.length : s.answers.length - 1);
const stepOf = (s) => s.steps[stepIndex(s)];
const dialogue = (s) => ({ answers: s.answers, replies: s.replies, asks: s.steps.slice(0, s.answers.length).map((n) => n.ask), sigs: s.sigs });
const isOffline = (e) => !(e instanceof BoothApiError && e.kind === 'http');

async function requestReply(api, s) {
  try {
    const body = await api.post(`/booth/plays/${encodeURIComponent(s.play.id)}/reply`, dialogue(s), { timeoutMs: REPLY_TIMEOUT_MS });
    if (body?.status === 'unavailable') return { type: 'unavailable' };
    const next = s.answers.length < STEPS ? parseNext(body?.next) : null;
    if (body?.status === 'replied' && typeof body.reply === 'string' && typeof body.reply_sig === 'string'
      && (next || s.answers.length === STEPS)) {
      return { type: 'replied', text: body.reply, sig: body.reply_sig, next };
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
    const score = parseScore(body);
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

/** @returns {{ caseId: string, teaser: Bi } | null} */
function parseDraw(body) {
  return isId(body?.case_id) && isBi(body.teaser) ? { caseId: body.case_id, teaser: { th: body.teaser.th, en: body.teaser.en } } : null;
}

function parseStart(body) {
  const next = parseNext(body?.next);
  if (!isId(body?.play_id) || !Number.isInteger(body.tag) || body.tag < 1
    || !Number.isInteger(body.answer_max_chars) || body.answer_max_chars < 1
    || !isBi(body.case?.vignette) || !next || !isId(body.sig)) {
    return null;
  }
  return { play: { id: body.play_id, tag: body.tag, answerMax: body.answer_max_chars, vignette: body.case.vignette }, next, sig: body.sig };
}

function parseScore(body) {
  if (body?.status !== 'scored' || !Number.isFinite(body.composite) || body.composite < 0 || body.composite > 100) return null;
  const domains = {};
  for (const { key } of DOMAINS) {
    const v = body.domains?.[key];
    if (!Number.isInteger(v) || v < 0 || v > 5) return null;
    domains[key] = v;
  }
  return { composite: body.composite, domains, body };
}

// A newline inside a phrase's inline block would split that block in two, not end the line.
const plainText = (text) => text.split('\n').flatMap((line, i) => (i ? ['\n', ...phrases(line)] : phrases(line)));

const icon = (name) => el('span', { class: 'booth-icon', dataset: { icon: name } });

const labelled = (pair, lead = null, trail = null) => [lead && icon(lead), bi(pair, 'btn-label'), trail && icon(trail)];

function frame(body, actions = [], { foot = true, stack = false } = {}) {
  return el('div', { class: 'play-frame' },
    el('div', { class: 'play-body' }, ...body),
    actions.length ? el('div', { class: stack ? 'play-actions play-actions--stack' : 'play-actions' }, ...actions) : null,
    foot ? demoLabel('play-foot') : null);
}

const demoLabel = (cls) => el('div', { class: `demo-label ${cls}`, dataset: { demoLabel: '' } }, bi(DEMO_LABEL));

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

/** @param {HTMLElement} root @param {PlayState} s @param {(ev: PlayEvent) => void} dispatch */
function render(root, s, dispatch, api) {
  draw(root, s.screen.at, VIEWS[s.screen.at](s, buttonsFor(dispatch), root, api));
}

/** The dealt case's teaser and the two ways on. Resolves 'start' or 'reroll' on the first tap that counts.
 *  @returns {Promise<'start' | 'reroll'>} */
function offerCase(root, dealt) {
  return new Promise((resolve) => {
    const button = buttonsFor(resolve);
    draw(root, 'teaser', frame(
      [el('section', { class: 'case-card case-card--full' }, bi(dealt.teaser, 'teaser'))],
      [button(labelled(COPY.startCase, null, 'arrowRight'), 'primary wide', () => 'start', { 'data-action': 'start-case' }),
        button(labelled(COPY.reroll, 'refresh'), 'secondary wide', () => 'reroll', { 'data-action': 'reroll' })],
      { stack: true }));
  });
}

const VIEWS = {
  vignette: (s, button) => frame(
    [caseCard(s.play, 'case-card--full')],
    [button(labelled(COPY.begin, null, 'arrowRight'), 'primary wide', () => ({ type: 'begin' }), { 'data-action': 'begin' })]),

  step: (s, button) => {
    const step = stepOf(s);
    return frame([
      caseCard(s.play),
      el('section', { class: 'step-sheet', 'aria-label': step.question.en },
        stepHead(s, step, { bridge: true }),
        el('div', { class: 'options' }, ...step.options.map((o, i) => button(
          [optionBody(o, i)], 'secondary wide option', () => ({ type: 'answer', answer: { choice: o.id } }), { 'data-option': o.id }))),
        button(labelled(COPY.typeOwn, 'pencil'), 'secondary wide', () => ({ type: 'openTyping' }), { 'data-action': 'type-own' })),
    ]);
  },

  typing: (s, button) => {
    const step = stepOf(s);
    const box = el('textarea', {
      class: 'typing-box', maxlength: String(s.play.answerMax), rows: '3', enterkeyhint: 'enter', lang: 'th',
      'aria-label': `${COPY.typeOwn.th} ${COPY.typeOwn.en}`, autocomplete: 'off', spellcheck: 'false',
    });
    const send = button(labelled(COPY.send), 'primary', () => ({ type: 'answer', answer: { text: box.value } }), { 'data-action': 'send', disabled: '' });
    box.addEventListener('input', () => { send.disabled = box.value.trim() === ''; });
    queueMicrotask(() => box.focus({ preventScroll: true }));
    return frame([
      el('section', { class: 'step-sheet typing-sheet', 'aria-label': step.question.en },
        stepHead(s, step),
        box,
        bi(COPY.enterHint, 'hint'),
        el('div', { class: 'typing-actions' },
          button(labelled(COPY.backToChoices), 'secondary', () => ({ type: 'closeTyping' }), { 'data-action': 'back' }),
          send)),
      caseCard(s.play, 'case-card--behind'),
    ]);
  },

  replying: (s) => frame([exchange(s, aiBubble(el('span', { class: 'ai-wait' }, bi(COPY.replying), dots())))]),

  reply: (s, button) => {
    const text = s.replies[s.replies.length - 1];
    const said = text === '' ? bi(COPY.noReply, 'reply-note') : aiBubble(el('p', { class: 'ai-text', lang: 'th' }, ...plainText(text)));
    const [copy, action] = s.answers.length === STEPS ? [COPY.seeScore, 'see-score'] : [COPY.next, 'next'];
    return frame([exchange(s, said)],
      [button(labelled(copy, null, 'arrowRight'), 'primary wide', () => ({ type: 'next' }), { 'data-action': action })]);
  },

  scoring: () => frame([waitView(COPY.scoring, COPY.scoringWait)]),

  scored: (s, button, root, api) => {
    const { score } = s.screen;
    const slot = el('div', { class: 'board-slot', dataset: { boothSlot: 'board' } });
    const card = el('article', { class: 'result-card' },
      renderTag(s.play.tag),
      el('div', { class: 'result-total' },
        bi(COPY.overall, 'result-overall'),
        el('p', { class: 'result-score' },
          el('span', { class: 'result-number', dataset: { score: '' } }, scoreText(score.composite)),
          el('span', { class: 'result-outof' }, '/ 100'))),
      slot,
      ...domainSections(score.domains, leaderboardButton({ host: root.closest('#booth') ?? root, api, board: score.body.board, tag: s.play.tag })));
    mountResultBoard(slot, { tag: s.play.tag, scoreBody: score.body });
    return frame([card]);
  },

  unavailable: () => frame([el('article', { class: 'end-card' }, bi(COPY.unavailable, 'end-title'), bi(COPY.thanks))]),

  stopped: (s) => frame([stoppedView(s.screen.offline)]),
};

function caseCard(play, mod = '') {
  return el('section', { class: `case-card ${mod}`.trim() }, bi(play.vignette, 'vignette'));
}

// The bridge is the AI's lead-in to this question, so it sits in the question's own block, AI-labelled.
function stepHead(s, step, { bridge = false } = {}) {
  const lead = bridge && step.ask.bridge.trim() !== ''
    ? el('p', { class: 'ai-bridge', dataset: { bridge: '' } },
      el('span', { class: 'ai-label' }, window.AI_LABEL.th), ' ',
      el('span', { class: 'bridge-text', lang: 'th' }, ...phrases(step.ask.bridge)))
    : null;
  return el('header', { class: 'step-head' },
    bi(fill(COPY.stepOf, { n: stepIndex(s) + 1 }), 'step-of'),
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
    : el('p', { class: 'answer-text', lang: 'th' }, ...plainText(answer.text));
  return el('div', { class: 'exchange' },
    stepHead(s, step),
    el('section', { class: 'answer-card', 'aria-label': COPY.yourAnswer.en }, bi(COPY.yourAnswer, 'answer-label'), given),
    aiPart);
}

function aiBubble(content) {
  const label = window.AI_LABEL.th;
  return el('section', { class: 'ai-bubble', 'aria-label': label }, el('p', { class: 'ai-label' }, label), content);
}

const dots = () => el('span', { class: 'waiting-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'));

function waitView(title, sub = null) {
  return el('div', { class: 'wait', role: 'status' }, bi(title, 'wait-title'), sub ? bi(sub) : null, dots());
}

function stoppedView(offline) {
  return el('article', { class: 'end-card' },
    bi(COPY.stopped, 'end-title'), offline ? bi(COPY.stoppedOffline) : null, bi(COPY.restarting));
}

/** The two weakest domains under "Practise next", `between` them and the other five, which sit below the fold. */
function domainSections(scores, between) {
  const order = weakestFirst(scores);
  const section = (title, keys, cls) => el('section', { class: `domain-section ${cls}`, 'aria-label': title.en },
    bi(title, 'section-title'),
    el('ol', { class: 'domains' }, ...keys.map((key) => domainRow(DOMAINS.find((d) => d.key === key), scores[key]))));
  return [section(COPY.practiseNext, order.slice(0, 2), 'practise-next'), between, section(COPY.otherDomains, order.slice(2), 'other-domains')];
}

function domainRow(d, value) {
  const band = bandOf(value);
  return el('li', { class: 'domain', dataset: { key: d.key, value: String(value), band } },
    el('div', { class: 'domain-head' },
      bi(d, 'domain-name'),
      el('span', { class: 'domain-value' }, `${value} / 5`)),
    el('div', { class: 'domain-bar', 'aria-hidden': 'true' }, el('span', { style: `width: ${value * 20}%` })),
    bi(BAND_LINES[d.key][band], 'domain-band'));
}
