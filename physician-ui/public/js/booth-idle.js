// Idle reset during a play (#213). The play names its screen in stage.dataset.screen (booth-play.js SCREEN);
// SCREEN_POLICY says what an idle visitor means on each one.
import { COPY, fill } from './booth-copy.js';
import { el, bi } from './booth-dom.js';

const IDLE_MS = 90_000;
const ASK_MS = 15_000;

/** @typedef {{ kind: 'hold' } | { kind: 'watch' } | { kind: 'reset', ms: number }} ScreenPolicy */

const HOLD = { kind: 'hold' };
const WATCH = { kind: 'watch' };

/** @type {Record<string, ScreenPolicy>} */
const SCREEN_POLICY = {
  starting: HOLD, replying: HOLD, scoring: HOLD,
  vignette: WATCH, step: WATCH, typing: WATCH, reply: WATCH,
  scored: { kind: 'reset', ms: 45_000 }, unavailable: { kind: 'reset', ms: 45_000 },
  stopped: { kind: 'reset', ms: 6_000 },
};

/**
 * Applies SCREEN_POLICY for as long as the page lives; every reset is `reset()`, a page reload.
 * Idle phase: off | watching (IDLE_MS timer, any touch or key restarts it) | asking ("Still there?", ASK_MS).
 * @param {{ stage: HTMLElement, host: HTMLElement, reset: () => void }} ctx host holds the overlay
 */
export function watchIdle({ stage, host, reset }) {
  let phase = 'off';
  let timer = 0;
  let ticker = 0;
  let overlay = null;

  const quiet = () => {
    clearTimeout(timer);
    clearInterval(ticker);
    overlay?.remove();
    overlay = null;
    phase = 'off';
  };

  const watch = () => {
    quiet();
    phase = 'watching';
    timer = setTimeout(ask, IDLE_MS);
  };

  const ask = () => {
    phase = 'asking';
    const deadline = Date.now() + ASK_MS;
    const count = el('p', { class: 'still-count', dataset: { countdown: '' } });
    const showCount = () => count.replaceChildren(bi(fill(COPY.stillThereCount, { n: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) })));
    showCount();
    const keep = el('button', { type: 'button', class: 'booth-btn primary wide', dataset: { action: 'keep-going' } }, bi(COPY.keepGoing, 'btn-label'));
    overlay = el('div', { class: 'still-there', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': `${COPY.stillThere.th} ${COPY.stillThere.en}` },
      el('div', { class: 'still-card' }, bi(COPY.stillThere, 'still-title'), count, keep));
    // A click, not a pointerdown: dismissing on pointerdown would let the same tap's click land on the play underneath.
    overlay.addEventListener('click', watch);
    host.append(overlay);
    keep.focus({ preventScroll: true });
    ticker = setInterval(showCount, 1000);
    timer = setTimeout(reset, ASK_MS);
  };

  const onActivity = (e) => {
    if (phase === 'watching') watch();
    else if (phase === 'asking' && e.type !== 'pointerdown') watch();
  };
  for (const type of ['pointerdown', 'keydown', 'input']) document.addEventListener(type, onActivity, true);

  const apply = () => {
    const policy = SCREEN_POLICY[stage.dataset.screen] ?? HOLD;
    if (policy.kind === 'watch') watch();
    else {
      quiet();
      if (policy.kind === 'reset') timer = setTimeout(reset, policy.ms);
    }
  };
  new MutationObserver(apply).observe(stage, { attributes: true, attributeFilter: ['data-screen'] });
  apply();
}
