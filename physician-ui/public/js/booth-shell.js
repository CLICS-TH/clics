import { createBoothApi } from './booth-api.js';
import { runPlay } from './booth-play.js';
import { COPY } from './booth-copy.js';
import { el, bi } from './booth-dom.js';

const STATUS_TIMEOUT_MS = 8_000;
const STOPPED_RELOAD_MS = 6_000;

const root = document.getElementById('booth');
const api = createBoothApi(window.CLICS_API_URL);

function show(state, ...kids) {
  root.replaceChildren(...kids);
  root.dataset.shell = state;
}

async function eventStatus() {
  try {
    const body = await api.get('/booth/status', { timeoutMs: STATUS_TIMEOUT_MS });
    return body?.open === true ? 'open' : 'closed';
  } catch {
    return 'offline';
  }
}

async function play() {
  const stage = el('div', { class: 'booth-stage' });
  const bar = el('div', { class: 'shell-bar' });
  show('play', stage, bar);
  const outcome = await runPlay({ root: stage, api });
  const done = el('button', { type: 'button', class: 'booth-btn primary wide', dataset: { action: 'done' } }, bi(COPY.done, 'btn-label'));
  done.addEventListener('click', () => location.reload(), { once: true });
  bar.append(done);
  root.dataset.shell = 'done';
  if (outcome.kind === 'stopped') setTimeout(() => location.reload(), STOPPED_RELOAD_MS);
}

async function main() {
  show('checking', el('div', { class: 'shell-notice' }, bi(COPY.checking)));
  const status = await eventStatus();
  if (status !== 'open') {
    show(status, el('div', { class: 'shell-notice' }, bi(status === 'closed' ? COPY.closed : COPY.offline, 'notice-title')));
    return;
  }
  const start = el('button', { type: 'button', class: 'shell-start', dataset: { action: 'start' } },
    el('span', { class: 'shell-wordmark' }, 'CLICS'),
    bi(COPY.intro, 'shell-intro'),
    el('span', { class: 'shell-cta' }, bi(COPY.tapToTry, 'btn-label')));
  start.addEventListener('click', play, { once: true });
  show('start', start);
}

main();
