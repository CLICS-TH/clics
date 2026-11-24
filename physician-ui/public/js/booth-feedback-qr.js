// The kiosk's feedback button and its QR pop-up, and the phone result page's card (spec 2026-11-24, sections 1 and 2).
// Both show only when js/config.js sets window.CLICS_BOOTH_FEEDBACK to true. The link is the form with the case and the
// look in the fragment (booth-feedback-link.js): no tag and no play id is ever in it, so an answer cannot be traced back
// to a play. The QR is drawn on the kiosk (booth-play.js qrSvg), so nothing leaves it. qrSvg is a function declaration,
// so the import cycle with booth-play.js is safe: nothing here runs before booth-play.js has loaded.
import { FEEDBACK_COPY } from './booth-feedback-copy.js';
import { feedbackIcon } from './booth-feedback-icons.js';
import { feedbackUrl } from './booth-feedback-link.js';
import { el, bi, currentLook, onLook } from './booth-dom.js';
import { qrSvg } from './booth-play.js';

const OVERLAY_IDLE_MS = 30_000;
const { kiosk: KIOSK, card: CARD, title: TITLE } = FEEDBACK_COPY;

const on = () => window.CLICS_BOOTH_FEEDBACK === true;

/** An icon from the Portal set (js/icons.js), drawn by hydrateIcons. */
const icon = (name) => el('span', { class: 'booth-icon', 'aria-hidden': 'true', dataset: { icon: name } });

/** An icon from the feedback set (booth-feedback-icons.js), drawn here; hydrateIcons has nothing to add to it. */
function feedbackGlyph(name) {
  const span = el('span', { class: 'booth-icon', 'aria-hidden': 'true', dataset: { icon: name, iconDone: '' } });
  span.innerHTML = feedbackIcon(name, 24);
  return span;
}

const tag = (glyph, pair) => el('li', { class: 'feedback-tag' }, glyph, bi(pair, 'feedback-tag-label'));

/** The pop-up over `host`: the QR in the accent colour, two tags and a caption, with one Close. It is a modal dialog:
 *  focus moves to Close and stays there (it is the only control), Escape, a tap on the backdrop and Close all shut it and
 *  return focus to `opener`, and 30 s without a touch shuts it. */
function openFeedback({ host, caseId, opener }) {
  const fig = el('figure', { class: 'feedback-qr', dataset: { feedbackQr: '' } });
  const drawQr = () => {
    const url = feedbackUrl({ caseId, look: currentLook() });
    fig.querySelector('svg')?.remove();
    fig.prepend(qrSvg(url, TITLE.en, 'var(--accent)'));
    fig.dataset.feedbackUrl = url;
  };
  drawQr();
  const off = onLook(() => { if (fig.isConnected) drawQr(); else off(); });
  const close = el('button', { type: 'button', class: 'booth-btn secondary wide', dataset: { action: 'close-feedback' } },
    icon('x'), bi(KIOSK.close, 'btn-label'));
  const overlay = el('div', { class: 'board-overlay feedback-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': TITLE.en, dataset: { feedbackOverlay: '' } },
    el('div', { class: 'board-card feedback-card' },
      bi(TITLE, 'feedback-title'),
      fig,
      el('ul', { class: 'feedback-tags' }, tag(icon('clock'), KIOSK.minute), tag(feedbackGlyph('lock'), KIOSK.anonymous)),
      bi(KIOSK.scan, 'feedback-scan'),
      close));
  let idle = 0;
  const shut = () => {
    clearTimeout(idle);
    document.removeEventListener('keydown', keys, true);
    overlay.remove();
    opener.focus({ preventScroll: true });
  };
  const restart = () => { clearTimeout(idle); idle = setTimeout(shut, OVERLAY_IDLE_MS); };
  // Close is the only control, so Tab has nowhere else to go.
  function keys(e) {
    if (e.key === 'Escape') { e.preventDefault(); shut(); } else if (e.key === 'Tab') { e.preventDefault(); close.focus({ preventScroll: true }); }
  }
  overlay.addEventListener('pointerdown', restart);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) shut(); });
  close.addEventListener('click', shut);
  document.addEventListener('keydown', keys, true);
  restart();
  host.append(overlay);
  window.hydrateIcons?.(overlay);
  close.focus({ preventScroll: true });
}

/** The button beside Done once a play is scored (booth-shell.js), which opens the pop-up over `host`. Null when the switch is off.
 *  @param {{ host: HTMLElement, caseId: string | null }} ctx @returns {HTMLButtonElement | null} */
export function feedbackButton({ host, caseId }) {
  if (!on()) return null;
  const b = el('button', { type: 'button', class: 'booth-btn secondary wide', dataset: { action: 'feedback' } },
    icon('message'), bi(KIOSK.button, 'btn-label'));
  b.addEventListener('click', () => { if (!host.querySelector('[data-feedback-overlay]')) openFeedback({ host, caseId, opener: b }); });
  return b;
}

/** The phone result page's card: a link to the same form, with the case and the look the page shows. Null when the
 *  switch is off. @param {string | null} caseId @param {string} look @returns {HTMLAnchorElement | null} */
export function feedbackCard(caseId, look) {
  if (!on()) return null;
  const glyph = feedbackGlyph('clipboardCheck');
  return el('a', { class: 'feedback-link', href: feedbackUrl({ caseId, look }), dataset: { feedback: '' } },
    glyph, el('span', { class: 'feedback-link-text' }, bi(CARD.title, 'feedback-link-title'), bi(CARD.line, 'feedback-link-line')));
}
