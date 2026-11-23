// "Read the case again" during a play: the dealt case's whole vignette over the screen, in the current look, with one
// Close; the answers overlay's pattern (booth-answers.js). It shows only what the play already holds, so it makes no
// request, and the play under it stays as it was: a chosen option, a typed draft, a reply landing meanwhile.
import { COPY } from './booth-copy.js';
import { el, bi, caseBi } from './booth-dom.js';

const OVERLAY = '[data-case-overlay]';

const icon = (name) => el('span', { class: 'booth-icon', 'aria-hidden': 'true', dataset: { icon: name } });

/** @param {HTMLElement} host the play's #booth, which holds the overlays @param {{ th: string, en: string }} vignette */
export function openCase(host, vignette) {
  if (host.querySelector(OVERLAY)) return;
  const close = el('button', { type: 'button', class: 'booth-btn primary wide', dataset: { action: 'close-case' } },
    icon('x'), bi(COPY.closeCase, 'btn-label'));
  // Only the vignette scrolls: the title and Close stay on screen, and no scrolled line rises under the language control.
  const overlay = el('div', { class: 'case-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${COPY.caseTitle.th} ${COPY.caseTitle.en}`, dataset: { caseOverlay: '' } },
    el('div', { class: 'case-sheet' },
      el('h2', { class: 'case-title' }, bi(COPY.caseTitle)),
      el('div', { class: 'case-read' }, caseBi(vignette, 'vignette')),
      close));
  // The screen under it may have been redrawn meanwhile (a reply landed): the focus goes to that screen's opener.
  close.addEventListener('click', () => {
    overlay.remove();
    host.querySelector('[data-action="read-case"]')?.focus({ preventScroll: true });
  });
  host.append(overlay);
  window.hydrateIcons?.(overlay);
  close.focus({ preventScroll: true });
}

/** The play moved on to a screen with no way back to the case (a score, a stop): an open overlay goes with it. */
export const closeCase = (host) => host.querySelector(OVERLAY)?.remove();
