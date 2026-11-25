// The kiosk's last screen (owner, 2026-11-21): after Done, the Calibration Workshop invitation with a QR to the Portal's
// own /workshop.html, which links on to registration. Finish, or INVITE_SECONDS without a touch, starts over.
import { DEMO_LABEL } from './booth-copy.js';
import { el, bi, phrases } from './booth-dom.js';
import { qrSvg } from './booth-play.js';
import { WORKSHOP_COPY, WORKSHOP_PATH, INVITE_SECONDS } from './booth-workshop.js';

/** English first in every look that shows English, as on the phone page (booth-result.js enFirst, booth.css .en-first). */
const enFirst = (pair, cls) => el('span', { class: `en-first ${cls}` },
  el('span', { class: 'en-first-en', lang: 'en' }, pair.en),
  el('span', { class: 'en-first-th', lang: 'th' }, ...phrases(pair.th)));

/**
 * Draws the invitation into `stage` and a Finish button into `bar`; resolves nothing, calls `reset` once. An abort of
 * `signal` (the shell's in-page reset) stops its timer and listener without calling `reset`.
 * @param {{ stage: HTMLElement, bar: HTMLElement, reset: () => void, signal?: AbortSignal }} ctx
 */
export function showInvite({ stage, bar, reset, signal }) {
  let timer = 0;
  const stop = () => { clearTimeout(timer); document.removeEventListener('pointerdown', restart, true); };
  const end = () => { stop(); reset(); };
  const restart = () => { clearTimeout(timer); timer = setTimeout(end, INVITE_SECONDS * 1000); };
  const url = new URL(WORKSHOP_PATH, location.origin).href;
  const card = el('article', { class: 'invite-card', dataset: { invite: '' }, 'aria-label': WORKSHOP_COPY.title.en },
    enFirst(WORKSHOP_COPY.title, 'invite-title'),
    // What it is, then why a College member would scan: it is held alongside their own specialty's audit.
    el('div', { class: 'invite-lead' }, bi(WORKSHOP_COPY.line, 'invite-line'), bi(WORKSHOP_COPY.alongside, 'invite-alongside')),
    el('figure', { class: 'invite-qr', dataset: { inviteQr: url } }, qrSvg(url, WORKSHOP_COPY.scan.en), bi(WORKSHOP_COPY.scan, 'invite-scan')),
    bi(WORKSHOP_COPY.when, 'invite-when'));
  // The demo label stays pinned under it, as under every play screen: the line names the PIS-7 rubric.
  stage.replaceChildren(el('div', { class: 'play-frame' }, el('div', { class: 'play-body invite-body' }, card),
    el('div', { class: 'play-foot' }, el('div', { class: 'demo-label', dataset: { demoLabel: '' } }, bi(DEMO_LABEL)))));
  stage.dataset.screen = 'invite';
  window.hydrateIcons?.(stage);
  const finish = el('button', { type: 'button', class: 'booth-btn primary wide', dataset: { action: 'finish' } }, bi(WORKSHOP_COPY.finish, 'btn-label'));
  finish.addEventListener('click', end, { once: true });
  bar.replaceChildren(finish);
  document.addEventListener('pointerdown', restart, true);
  signal?.addEventListener('abort', stop, { once: true });
  restart();
}
