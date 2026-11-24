// The feedback form's link (spec 2026-11-24): the kiosk's QR and the result page's card open FEEDBACK_PATH with the case
// and the language look in the URL fragment, which a browser never sends, so no server log sees them. The link names no
// tag and no play id: an answer cannot be traced back to a play through it. One import, booth-copy.js (itself import-free).
import { LOOKS, DEFAULT_LOOK } from './booth-copy.js';

export const FEEDBACK_PATH = '/booth-feedback.html';

const CASE_ID = /^[a-z0-9-]{1,64}$/;

/** @param {{ caseId: string | null, look: string }} link @returns {string} absolute, from the page's own origin */
export const feedbackUrl = ({ caseId, look }) => {
  const parts = [...(typeof caseId === 'string' && CASE_ID.test(caseId) ? [`c=${caseId}`] : []), `l=${encodeURIComponent(look)}`];
  return `${location.origin}${FEEDBACK_PATH}#${parts.join('&')}`;
};

/** @param {string} hash location.hash, with or without the '#'
 *  @returns {{ caseId: string | null, look: string }} caseId null unless it is a plain case id; look DEFAULT_LOOK unless it names a look */
export function parseFeedbackFragment(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const c = params.get('c');
  const l = params.get('l');
  return { caseId: c !== null && CASE_ID.test(c) ? c : null, look: l !== null && Object.hasOwn(LOOKS, l) ? l : DEFAULT_LOOK };
}
