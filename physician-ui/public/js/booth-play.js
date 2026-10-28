// Contract with the shell (booth-shell.js; #213 rewrites the shell, never this file):
//   - runPlay renders into `root`, which the shell owns and may cover with overlays.
//   - root.dataset.screen always names the current screen (SCREEN). #213 reads it to hold its idle timer while
//     'scoring' and to start its result timer; the harness waits on it.
//   - runPlay resolves once a terminal screen is showing. The screen stays up until the shell resets the page.
// Contract with the board (booth-board.js): the result card's tag is renderTag(tag), and its board panel is
// mountResultBoard(slot, { tag, scoreBody }).
import { COPY, DEMO_LABEL, DOMAINS, scoreText, fill } from './booth-copy.js';
import { renderTag, mountResultBoard } from './booth-board.js';
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
 * @typedef {{ placeholder: boolean, vignette: Bi, steps: { question: Bi, options: Option[] }[] }} BoothCase
 * @typedef {{ id: string, tag: number, kase: BoothCase, answerMax: number }} Play
 * @typedef {{ choice: string } | { text: string }} Answer
 * @typedef {{ composite: number, domains: Record<string, number>, body: object }} Score
 *   `body` is the score response as received, handed to mountResultBoard so #212 can read its rank fields.
 *
 * @typedef {{ at: 'vignette' } | { at: 'step' } | { at: 'typing' } | { at: 'replying' } | { at: 'reply' }
 *         | { at: 'scoring' } | { at: 'scored', score: Score } | { at: 'unavailable' }
 *         | { at: 'stopped', offline: boolean }} Screen
 * @typedef {{ play: Play, answers: Answer[], replies: string[], sigs: string[], screen: Screen }} PlayState
 *   sigs[i] is the reply_sig /reply gave with replies[i] ('' when the AI gave none); the backend scores only
 *   replies that carry theirs.
 *
 * @typedef {{ type: 'begin' } | { type: 'openTyping' } | { type: 'closeTyping' } | { type: 'answer', answer: Answer }
 *         | { type: 'replied', text: string, sig: string } | { type: 'next' } | { type: 'scored', score: Score }
 *         | { type: 'unavailable' } | { type: 'stop', offline: boolean }} PlayEvent
 * @typedef {{ kind: 'scored' | 'unavailable' | 'stopped' }} PlayOutcome
 */

/** root.dataset.screen values: the Screen tags plus 'starting' (before the play exists). */
export const SCREEN = Object.freeze(['starting', 'vignette', 'step', 'typing', 'replying', 'reply', 'scoring',
  'scored', 'unavailable', 'stopped']);
const TERMINAL = new Set(['scored', 'unavailable', 'stopped']);

/**
 * Run one booth play to a terminal screen.
 * @param {{ root: HTMLElement, api: ReturnType<import('./booth-api.js').createBoothApi> }} ctx
 * @returns {Promise<PlayOutcome>}
 */
export async function runPlay({ root, api }) {
  draw(root, 'starting', frame([waitView(COPY.starting)]));
  let play = null;
  let offline = false;
  try {
    play = parseStart(await api.post('/booth/plays', {}, { timeoutMs: START_TIMEOUT_MS }));
  } catch (e) {
    offline = isOffline(e);
  }
  if (!play) {
    draw(root, 'stopped', frame([stoppedView(offline)]));
    return { kind: 'stopped' };
  }
  return new Promise((resolve) => {
    let state = { play, answers: [], replies: [], sigs: [], screen: { at: 'vignette' } };
    const dispatch = (ev) => {
      const next = transition(state, ev);
      if (next === state) return;
      state = next;
      render(root, state, dispatch);
      if (state.screen.at === 'replying') requestReply(api, state).then(dispatch);
      else if (state.screen.at === 'scoring') requestScore(api, state).then(dispatch);
      else if (TERMINAL.has(state.screen.at)) resolve({ kind: state.screen.at });
    };
    render(root, state, dispatch);
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
      ? { ...s, replies: [...s.replies, ev.text], sigs: [...s.sigs, ev.sig], screen: { at: 'reply' } } : s;
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
    return stepOf(s).options.some((o) => o.id === answer.choice) ? { choice: answer.choice } : null;
  }
  if (s.screen.at === 'typing' && 'text' in answer) {
    const text = answer.text.trim();
    return text.length > 0 && text.length <= s.play.answerMax ? { text } : null;
  }
  return null;
}

const stepIndex = (s) => (s.screen.at === 'step' || s.screen.at === 'typing' ? s.answers.length : s.answers.length - 1);
const stepOf = (s) => s.play.kase.steps[stepIndex(s)];
const dialogue = (s) => ({ answers: s.answers, replies: s.replies, reply_sigs: s.sigs });
const isOffline = (e) => !(e instanceof BoothApiError && e.kind === 'http');

async function requestReply(api, s) {
  try {
    const body = await api.post(`/booth/plays/${encodeURIComponent(s.play.id)}/reply`, dialogue(s), { timeoutMs: REPLY_TIMEOUT_MS });
    if (body?.status === 'replied' && typeof body.reply === 'string' && typeof body.reply_sig === 'string') {
      return { type: 'replied', text: body.reply, sig: body.reply_sig };
    }
    if (body?.status === 'unavailable') return { type: 'unavailable' };
    return { type: 'stop', offline: false };
  } catch (e) {
    if (e instanceof BoothApiError && e.status === 502 && e.reason === 'ai_unavailable') return { type: 'replied', text: '', sig: '' };
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

function parseStart(body) {
  const k = body?.case;
  const stepOk = (st) => isBi(st?.question) && Array.isArray(st.options) && st.options.length === 3
    && st.options.every((o) => typeof o?.id === 'string' && o.id !== '' && isBi(o.label) && isBi(o.line));
  if (typeof body?.play_id !== 'string' || body.play_id === '' || !Number.isInteger(body.tag) || body.tag < 1
    || !Number.isInteger(body.answer_max_chars) || body.answer_max_chars < 1
    || !isBi(k?.vignette) || !Array.isArray(k.steps) || k.steps.length !== STEPS || !k.steps.every(stepOk)) {
    return null;
  }
  return {
    id: body.play_id,
    tag: body.tag,
    answerMax: body.answer_max_chars,
    kase: { placeholder: k.placeholder === true, vignette: k.vignette, steps: k.steps },
  };
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

function frame(body, actions = [], { foot = true } = {}) {
  return el('div', { class: 'play-frame' },
    el('div', { class: 'play-body' }, ...body),
    actions.length ? el('div', { class: 'play-actions' }, ...actions) : null,
    foot ? demoLabel('play-foot') : null);
}

const demoLabel = (cls) => el('div', { class: `demo-label ${cls}`, dataset: { demoLabel: '' } }, bi(DEMO_LABEL));

function draw(root, at, node) {
  root.replaceChildren(node);
  root.dataset.screen = at;
  window.hydrateIcons?.(root);
}

/** @param {HTMLElement} root @param {PlayState} s @param {(ev: PlayEvent) => void} dispatch */
function render(root, s, dispatch) {
  const drawnAt = performance.now();
  const button = (kids, cls, ev, attrs = {}) => {
    const b = el('button', { type: 'button', class: `booth-btn ${cls}`, ...attrs }, ...kids);
    b.addEventListener('click', () => { if (performance.now() - drawnAt >= GHOST_TAP_MS) dispatch(ev()); });
    return b;
  };
  draw(root, s.screen.at, VIEWS[s.screen.at](s, button));
}

const VIEWS = {
  vignette: (s, button) => frame(
    [caseCard(s.play.kase, 'case-card--full')],
    [button(labelled(COPY.begin, null, 'arrowRight'), 'primary wide', () => ({ type: 'begin' }), { 'data-action': 'begin' })]),

  step: (s, button) => {
    const step = stepOf(s);
    return frame([
      caseCard(s.play.kase),
      el('section', { class: 'step-sheet', 'aria-label': step.question.en },
        stepHead(s, step),
        el('div', { class: 'options' }, ...step.options.map((o) => button(
          [optionBody(o)], 'secondary wide option', () => ({ type: 'answer', answer: { choice: o.id } }), { 'data-option': o.id }))),
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
      caseCard(s.play.kase, 'case-card--behind'),
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

  scored: (s) => {
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
      el('ol', { class: 'domains' }, ...DOMAINS.map((d) => domainRow(d, score.domains[d.key]))),
      demoLabel('card-label'));
    mountResultBoard(slot, { tag: s.play.tag, scoreBody: score.body });
    return frame([card], [], { foot: false });
  },

  unavailable: () => frame([el('article', { class: 'end-card' }, bi(COPY.unavailable, 'end-title'), bi(COPY.thanks))]),

  stopped: (s) => frame([stoppedView(s.screen.offline)]),
};

function caseCard(kase, mod = '') {
  return el('section', { class: `case-card ${mod}`.trim() },
    kase.placeholder ? el('p', { class: 'placeholder-badge', dataset: { placeholder: '' } }, bi(COPY.placeholder)) : null,
    bi(kase.vignette, 'vignette'));
}

function stepHead(s, step) {
  return el('header', { class: 'step-head' },
    bi(fill(COPY.stepOf, { n: stepIndex(s) + 1 }), 'step-of'),
    bi(step.question, 'question'));
}

function optionBody(o) {
  return el('span', { class: 'opt-inner' },
    el('span', { class: 'opt-letter', 'aria-hidden': 'true' }, o.id.toUpperCase()),
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

function domainRow(d, value) {
  return el('li', { class: 'domain', dataset: { key: d.key, value: String(value) } },
    el('div', { class: 'domain-head' },
      bi(d, 'domain-name'),
      el('span', { class: 'domain-value' }, `${value} / 5`)),
    el('div', { class: 'domain-bar', 'aria-hidden': 'true' }, el('span', { style: `width: ${value * 20}%` })));
}
