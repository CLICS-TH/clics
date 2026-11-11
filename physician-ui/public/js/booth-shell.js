import { createBoothApi } from './booth-api.js';
import { runPlay } from './booth-play.js';
import * as board from './booth-board.js';
import { mountLoop, loadLoopItems } from './booth-loop.js';
import { watchIdle } from './booth-idle.js';
import { mountLookControl } from './booth-look.js';
import { COPY, DEFAULT_LOOK } from './booth-copy.js';
import { el, bi, setLook, currentLook, onLook } from './booth-dom.js';

const STATUS_TIMEOUT_MS = 8_000;
const STATUS_POLL_MS = 30_000;
const GHOST_TAP_MS = 350;
const LOOP_LOOK_IDLE_MS = 90_000;

/** @typedef {'checking' | 'open' | 'closed' | 'offline'} ShellStatus */

/** What the bar under the loop says for each status, and #booth[data-shell]. Only 'open' can start a play. */
const BAR = {
  checking: { shell: 'checking', copy: COPY.checking, tap: false },
  open: { shell: 'start', copy: COPY.tapToStart, tap: true },
  closed: { shell: 'closed', copy: COPY.closed, tap: false },
  offline: { shell: 'offline', copy: COPY.offline, tap: false },
};

const root = document.getElementById('booth');
const api = keepingCase(createBoothApi(window.CLICS_API_URL));
const reset = () => location.reload();

/** @returns {Promise<ShellStatus>} */
async function eventStatus() {
  try {
    const body = await api.get('/booth/status', { timeoutMs: STATUS_TIMEOUT_MS });
    return body?.open === true ? 'open' : 'closed';
  } catch {
    return 'offline';
  }
}

/** A tap on a control drawn under 350 ms ago is the tail of the tap that drew it: swallow it. */
function guardGhostTaps() {
  const drawnAt = new WeakMap();
  new MutationObserver((records) => {
    const now = performance.now();
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === Node.ELEMENT_NODE) drawnAt.set(n, now);
  }).observe(root, { childList: true, subtree: true });
  root.addEventListener('click', (e) => {
    let latest = -Infinity;
    for (let n = e.target; n && n !== root; n = n.parentNode) latest = Math.max(latest, drawnAt.get(n) ?? -Infinity);
    if (performance.now() - latest < GHOST_TAP_MS) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

/** Hands the case each started play returns to the offline cache (booth-sw.js), under the id the kiosk started it
 *  with, so every case played is kept. */
function keepingCase(base) {
  return {
    ...base,
    async post(path, body, opts) {
      const res = await base.post(path, body, opts);
      if (path === '/booth/plays' && res?.case) {
        navigator.serviceWorker?.controller?.postMessage({ type: 'case', id: body?.case_id, kase: res.case });
      }
      return res;
    },
  };
}

/** Offline cache (booth-sw.js): the page tells the worker what it loaded, so there is no hand-kept list. */
async function registerWorker() {
  try {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    await sw.register('/booth-sw.js', { scope: '/booth' });
    const reg = await sw.ready;
    await document.fonts.ready;
    const loaded = performance.getEntriesByType('resource').map((e) => new URL(e.name))
      .filter((u) => u.origin === location.origin).map((u) => u.pathname + u.search);
    const media = (await loadLoopItems()).map((item) => item.src).filter(Boolean);
    reg.active?.postMessage({ type: 'precache', urls: [...new Set([location.pathname, ...loaded, ...media])] });
  } catch {
    // no offline cache this load; the next load tries again
  }
}

function showLoop() {
  const stage = el('div', { class: 'loop-stage' },
    el('div', { class: 'loop-fallback' },
      el('span', { class: 'shell-wordmark' }, 'CLICS'),
      bi(COPY.intro, 'shell-intro')));
  const loop = mountLoop(stage);
  const boardSlot = el('div', { class: 'loop-board', dataset: { boothSlot: 'loop-board' } });
  stage.append(boardSlot);
  const stopBoard = board.mountLoopBoard?.(boardSlot, { api });
  let bar = el('div');
  const boardButton = board.leaderboardButton({ host: root, api, cls: 'secondary loop-board-button', short: true });
  root.replaceChildren(el('div', { class: 'shell-loop' }, stage, boardButton, bar));
  window.hydrateIcons?.(boardButton);

  let status = null;
  let poll = 0;
  // The loop never reloads, so a look a passer-by picked here would carry into the next visitor's play: left alone
  // for 90 s, the loop returns to the default look. A look picked and then started keeps.
  let lookIdle = 0;
  const restartLookIdle = () => {
    clearTimeout(lookIdle);
    if (currentLook() !== DEFAULT_LOOK) lookIdle = setTimeout(() => setLook(DEFAULT_LOOK), LOOP_LOOK_IDLE_MS);
  };
  const stopLookWatch = onLook(restartLookIdle);
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, restartLookIdle, true);
  const leave = () => {
    clearInterval(poll);
    clearTimeout(lookIdle);
    stopLookWatch();
    for (const type of ['pointerdown', 'keydown']) document.removeEventListener(type, restartLookIdle, true);
    loop.stop();
    if (typeof stopBoard === 'function') stopBoard();
  };
  /** Swaps only the bar: the loop keeps playing through a status change. */
  const setStatus = (next) => {
    if (next === status || !root.contains(bar)) return;
    status = next;
    const view = BAR[next];
    // Attract mode: the open bar carries a pulsing tap cue, so the prompt is the kiosk's own and not only the video's.
    const line = el('div', { class: 'loop-bar', ...(view.tap ? {} : { role: 'status' }) },
      ...(view.tap ? [el('span', { class: 'tap-cue', 'aria-hidden': 'true' })] : []), bi(view.copy, 'bar-label'));
    let node = line;
    if (view.tap) {
      node = el('button', { type: 'button', class: 'shell-tap', dataset: { action: 'start' } }, line);
      node.addEventListener('click', () => { leave(); play(); }, { once: true });
    }
    bar.replaceWith(node);
    bar = node;
    root.dataset.shell = view.shell;
  };

  setStatus('checking');
  eventStatus().then(setStatus);
  poll = setInterval(() => eventStatus().then(setStatus), STATUS_POLL_MS);
}

async function play() {
  const stage = el('div', { class: 'booth-stage' });
  const bar = el('div', { class: 'shell-bar' });
  root.replaceChildren(stage, bar);
  root.dataset.shell = 'play';
  const outcome = runPlay({ root: stage, api, reset });
  watchIdle({ stage, host: root, reset });
  await outcome;
  const done = el('button', { type: 'button', class: 'booth-btn primary wide', dataset: { action: 'done' } }, bi(COPY.done, 'btn-label'));
  done.addEventListener('click', reset, { once: true });
  bar.append(done);
  root.dataset.shell = 'done';
}

setLook(DEFAULT_LOOK);
mountLookControl(document.body);
guardGhostTaps();
showLoop();
registerWorker();
