// The d1-d7 radar on the kiosk's result card and the result page (#379). The axis names are HTML, not SVG text, so
// they take the booth's type floor and the harness measures them like any other text.
import { DOMAINS, DOMAIN_SHORT, COPY } from './booth-copy.js';
import { el, bi } from './booth-dom.js';

// The box, in its own units: booth-radar.css gives .radar this aspect ratio, so a point here is a percentage there.
const W = 420;
const H = 240;
const CX = W / 2;
const CY = 125;
const R = 70;
const LABEL_R = R + 12;
const MAX = 5;

const angle = (i) => (2 * Math.PI * i) / DOMAINS.length;
const at = (i, r) => [CX + r * Math.sin(angle(i)), CY - r * Math.cos(angle(i))];
const points = (rOf) => DOMAINS.map((_, i) => at(i, rOf(i)).map((v) => v.toFixed(1)).join(',')).join(' ');
const pct = (v, of) => `${((100 * v) / of).toFixed(2)}%`;

function svg(tag, attrs, ...kids) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

/** The scale under the score, and again over it so the rings still read inside the filled shape. */
const grid = (cls) => svg('g', { class: cls },
  ...[1, 2, 3, 4, 5].map((n) => svg('polygon', { points: points(() => (R * n) / MAX) })),
  ...DOMAINS.map((_, i) => { const [x, y] = at(i, R); return svg('line', { x1: String(CX), y1: String(CY), x2: x.toFixed(1), y2: y.toFixed(1) }); }));

/** @param {Record<string, number>} domains d1-d7 at 0-5 @returns {HTMLElement} */
export function radar(domains) {
  const said = DOMAINS.map((d) => `${d.th} ${domains[d.key]}/${MAX}`).join(', ');
  const labels = DOMAINS.map((d, i) => {
    const [x, y] = at(i, LABEL_R);
    // Anchored on the side away from the centre: above the top axis, beside the side ones, below the bottom ones.
    const tx = -50 + 50 * Math.sin(angle(i));
    const ty = -50 - 50 * Math.cos(angle(i));
    return el('span', { class: 'radar-label', dataset: { key: d.key },
      style: `left: ${pct(x, W)}; top: ${pct(y, H)}; transform: translate(${tx.toFixed(1)}%, ${ty.toFixed(1)}%)` }, bi(DOMAIN_SHORT[d.key]));
  });
  return el('figure', { class: 'radar', role: 'img', 'aria-label': `${COPY.radar.th}: ${said}`, dataset: { radar: '' } },
    svg('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', focusable: 'false' },
      grid('radar-grid'),
      svg('polygon', { class: 'radar-score', points: points((i) => (R * domains[DOMAINS[i].key]) / MAX) }),
      grid('radar-grid radar-grid--over')),
    ...labels);
}
