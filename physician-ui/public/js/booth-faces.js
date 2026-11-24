// CLICS's own faces for the feedback form (spec 2026-11-24): line art on a 48 grid, stroke in currentColor with round
// caps, like the portal's icons.js set. Drawn here, never a system emoji: an emoji looks different on an iPhone, an
// Android phone and the kiosk, and a screen reader reads it out by name. Each SVG is aria-hidden; the button that holds
// it carries the word. The markup is built from these constants alone (nothing a visitor typed), so it is safe to set
// as innerHTML.

/** The five moods, in the order the form shows them (the backend's answers.mood values). */
export const MOODS = Object.freeze(['stressed', 'confused', 'neutral', 'enjoyed', 'excited']);

const dot = (x) => `<circle cx="${x}" cy="21" r="2" fill="currentColor" stroke="none"/>`;
const PARTS = {
  stressed: '<path d="M14 18l5 3-5 3M34 18l-5 3 5 3"/><path d="M15 33q2.25-2.5 4.5 0t4.5 0 4.5 0 4.5 0"/>',
  confused: `${dot(17)}${dot(31)}<path d="M28 15l6 2.5"/><path d="M17 33q4-3 7-1t7-2"/>`,
  neutral: `${dot(17)}${dot(31)}<path d="M17 32h14"/>`,
  enjoyed: `${dot(17)}${dot(31)}<path d="M15 29q9 8 18 0"/>`,
  excited: '<path d="M13 22q4-5 8 0M27 22q4-5 8 0"/><path d="M14 28h20q-1.5 10-10 10t-10-10z" fill="currentColor" fill-opacity=".2"/><path d="M42 3v6M39 6h6" stroke-width="2"/>',
};

const face = (inner) => `<svg class="face" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle class="skin" cx="24" cy="24" r="20"/>${inner}</svg>`;

/** @param {string} mood one of MOODS @returns {string} SVG markup */
export function moodFace(mood) {
  if (!Object.hasOwn(PARTS, mood)) throw new RangeError(`no face for mood "${mood}"`);
  return face(PARTS[mood]);
}

/** The slider's one face, its mouth bending from a frown to a smile as the thumb moves.
 *  @param {number} t 0 (low end) to 1 (high end). Raised inner brows at t <= 0.1, cheeks at t >= 0.7, happy eyes at t >= 0.95.
 *  @returns {string} SVG markup */
export function scaleFace(t) {
  const c = -8 + 16 * t;
  const end = 31 - c * 0.25;
  const eyes = t >= 0.95 ? '<path d="M13 22q4-5 8 0M27 22q4-5 8 0"/>' : dot(17) + dot(31);
  const brows = t <= 0.1 ? '<path d="M12 17.5l7-3M36 17.5l-7-3"/>' : '';
  const cheeks = t >= 0.7 ? '<circle cx="12.5" cy="28" r="3" fill="currentColor" fill-opacity=".18" stroke="none"/><circle cx="35.5" cy="28" r="3" fill="currentColor" fill-opacity=".18" stroke="none"/>' : '';
  return face(eyes + brows + cheeks + `<path d="M15 ${end} Q24 ${31 + c} 33 ${end}"/>`);
}
