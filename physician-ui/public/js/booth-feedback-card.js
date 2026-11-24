// The phone result page's feedback card (spec 2026-11-24, section 2): a link to the form with the case and the look the page
// shows. Its own module, loaded by booth-result.js with import() only when js/config.js sets window.CLICS_BOOTH_FEEDBACK to
// true, and importing nothing of the kiosk's play engine (booth-play.js and what it pulls in): the page loads none of it
// with the switch off, and a failed load here leaves the page without the card, never without the result.
import { FEEDBACK_COPY } from './booth-feedback-copy.js';
import { feedbackIcon } from './booth-feedback-icons.js';
import { feedbackUrl } from './booth-feedback-link.js';
import { el, bi } from './booth-dom.js';

const { card: CARD } = FEEDBACK_COPY;

/** @param {string | null} caseId @param {string} look @returns {HTMLAnchorElement | null} null when the switch is off */
export function feedbackCard(caseId, look) {
  if (window.CLICS_BOOTH_FEEDBACK !== true) return null;
  const glyph = el('span', { class: 'booth-icon', 'aria-hidden': 'true', dataset: { icon: 'clipboardCheck', iconDone: '' } });
  glyph.innerHTML = feedbackIcon('clipboardCheck', 24);
  return el('a', { class: 'feedback-link', href: feedbackUrl({ caseId, look }), dataset: { feedback: '' } },
    glyph, el('span', { class: 'feedback-link-text' }, bi(CARD.title, 'feedback-link-title'), bi(CARD.line, 'feedback-link-line')));
}
