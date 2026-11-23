// The d1-d7 radar on the kiosk's result card and the result page (#379). The axis names are HTML, not SVG text, so
// they take the booth's type floor and the harness measures them like any other text.
import { DOMAINS, DOMAIN_SHORT, COPY } from './booth-copy.js';
import { PRACTISE_KEYS } from './booth-bands.js';
import { el, bi } from './booth-dom.js';

const MAX = 5;
/** The gap between the outer ring's corner and its axis name, in the name's font size. */
const GAP = 0.45;

const angle = (i) => (2 * Math.PI * i) / DOMAINS.length;

function svg(tag, attrs, ...kids) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

/**
 * The largest chart the box holds with every axis name inside it. Each name sits on its spoke past the outer ring,
 * anchored on the side away from the centre (above the top axis, beside the side ones, below the bottom ones), so
 * each edge of each name moves linearly with the names' radius: search that radius, then centre the chart in the
 * room it leaves on each axis. Sizes in CSS px.
 * @returns {{ cx: number, cy: number, lr: number } | null} null when the names do not fit the box at any size
 */
function fit(w, h, sizes) {
  const sides = (lr) => {
    let x0 = -Infinity, x1 = Infinity, y0 = -Infinity, y1 = Infinity;
    sizes.forEach(([lw, lh], i) => {
      const s = Math.sin(angle(i)), c = Math.cos(angle(i));
      x0 = Math.max(x0, 1 - lr * s - (s / 2 - 0.5) * lw);
      x1 = Math.min(x1, w - 1 - lr * s - (s / 2 + 0.5) * lw);
      y0 = Math.max(y0, 1 + lr * c + (c / 2 + 0.5) * lh);
      y1 = Math.min(y1, h - 1 + lr * c - (0.5 - c / 2) * lh);
    });
    return { x0, x1, y0, y1 };
  };
  const fits = (b) => b.x0 <= b.x1 && b.y0 <= b.y1;
  if (!fits(sides(0))) return null;
  let lo = 0, hi = Math.max(w, h);
  for (let n = 0; n < 32; n++) {
    const mid = (lo + hi) / 2;
    const b = sides(mid);
    if (fits(b)) lo = mid; else hi = mid;
  }
  const b = sides(lo);
  return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, lr: lo };
}

/** The rings and spokes, drawn under the score and again over it so the rings still read inside the filled shape. */
const grid = (cls) => svg('g', { class: cls },
  ...[1, 2, 3, 4, 5].map((n) => svg('polygon', { 'data-ring': String(n) })),
  ...DOMAINS.map(() => svg('line', {})));

/** Before the box is measured: the chart in a 420 x 240 box, the shape of .radar's default aspect ratio, so the radar
 *  is whole from the moment it is drawn, whatever reads it before its first measure. */
const UNMEASURED = { w: 420, h: 240, cx: 210, cy: 125, lr: 82, r: 70, unit: '%' };

/** Sets the rings, spokes, score shape and axis names for geometry `g`. Attributes only: no node is added, so a
 *  redraw on a look switch draws nothing the shell's ghost-tap guard would read as new. */
function draw(fig, domains, g) {
  const at = (i, d) => [g.cx + d * Math.sin(angle(i)), g.cy - d * Math.cos(angle(i))];
  const points = (rOf) => DOMAINS.map((_, i) => at(i, rOf(i)).map((v) => v.toFixed(1)).join(',')).join(' ');
  fig.querySelector('svg').setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
  for (const ring of fig.querySelectorAll('[data-ring]')) ring.setAttribute('points', points(() => (g.r * Number(ring.dataset.ring)) / MAX));
  for (const grp of fig.querySelectorAll('.radar-grid')) {
    [...grp.querySelectorAll('line')].forEach((line, i) => {
      const [x, y] = at(i, g.r);
      for (const [k, v] of Object.entries({ x1: g.cx, y1: g.cy, x2: x, y2: y })) line.setAttribute(k, v.toFixed(1));
    });
  }
  fig.querySelector('.radar-score').setAttribute('points', points((i) => (g.r * domains[DOMAINS[i].key]) / MAX));
  fig.querySelectorAll('.radar-label').forEach((l, i) => {
    const [x, y] = at(i, g.lr);
    l.style.left = g.unit === '%' ? `${((100 * x) / g.w).toFixed(2)}%` : `${x.toFixed(1)}px`;
    l.style.top = g.unit === '%' ? `${((100 * y) / g.h).toFixed(2)}%` : `${y.toFixed(1)}px`;
  });
}

/** The chart at the size the box and its axis names allow (fit), in CSS px. */
function layout(fig, domains) {
  const w = fig.clientWidth, h = fig.clientHeight;
  const labels = [...fig.querySelectorAll('.radar-label')];
  if (!w || !h) return;
  const fitted = fit(w, h, labels.map((l) => [l.offsetWidth, l.offsetHeight]));
  if (!fitted) return;
  const r = Math.max(0, fitted.lr - GAP * parseFloat(getComputedStyle(labels[0]).fontSize));
  draw(fig, domains, { w, h, ...fitted, r, unit: 'px' });
}

/** @param {Record<string, number>} domains d1-d7 at 0-5 @returns {HTMLElement} */
export function radar(domains) {
  const said = DOMAINS.map((d) => `${d.th} ${domains[d.key]}/${MAX}`).join(', ');
  const labels = DOMAINS.map((d, i) => {
    const tx = -50 + 50 * Math.sin(angle(i));
    const ty = -50 - 50 * Math.cos(angle(i));
    // The four Practise next draws from are marked (booth-radar.css), and its line says so (COPY.practiseFrom).
    return el('span', { class: 'radar-label', dataset: { key: d.key, practise: String(PRACTISE_KEYS.includes(d.key)) },
      style: `transform: translate(${tx.toFixed(1)}%, ${ty.toFixed(1)}%)` }, bi(DOMAIN_SHORT[d.key]));
  });
  const fig = el('figure', { class: 'radar', role: 'img', 'aria-label': `${COPY.radar.th}: ${said}`, dataset: { radar: '' } },
    svg('svg', { 'aria-hidden': 'true', focusable: 'false' },
      grid('radar-grid'), svg('polygon', { class: 'radar-score' }), grid('radar-grid radar-grid--over')),
    ...labels);
  draw(fig, domains, UNMEASURED);
  // A look switch changes the names, a layout change the box: either redraws the chart, before the frame paints.
  const sized = new ResizeObserver(() => layout(fig, domains));
  for (const box of [fig, ...labels]) sized.observe(box);
  return fig;
}
