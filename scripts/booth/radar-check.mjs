// The radar checks the kiosk's result card (scenarios/result.mjs) and the result page (scenarios/keep.mjs) share.
const lum = ([r, g, b]) => [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const rgb = (css) => css.match(/[\d.]+/g).slice(0, 3).map(Number);
const contrast = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** What the radar draws: each axis's name, and how far along its spoke the score's corner sits (0..1). Read two frames
 *  on: a radar drawn this frame still has its unmeasured geometry until its first measure (booth-radar.js layout). */
export async function readRadar(page) {
  await page.waitForSelector('[data-radar]', { state: 'attached' });
  return page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const fig = document.querySelector('[data-radar]');
    const shape = fig.querySelector('.radar-score');
    const spokes = [...fig.querySelector('.radar-grid').querySelectorAll('line')];
    const card = fig.closest('.result-card');
    const box = fig.getBoundingClientRect();
    const along = [...shape.points].map((p, i) => {
      const s = spokes[i];
      const dist = (x, y) => Math.hypot(x - s.x1.baseVal.value, y - s.y1.baseVal.value);
      return dist(p.x, p.y) / dist(s.x2.baseVal.value, s.y2.baseVal.value);
    });
    const labels = [...fig.querySelectorAll('.radar-label')].map((l) => {
      const r = l.getBoundingClientRect();
      const main = l.querySelector('.bi-main');
      return { key: l.dataset.key, text: main?.textContent, lang: main?.lang, weight: Number(getComputedStyle(main).fontWeight), color: getComputedStyle(main).color,
        sub: l.querySelector('.bi-sub')?.getBoundingClientRect().height ?? 0, inside: r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1 };
    });
    const pad = getComputedStyle(card);
    return { role: fig.getAttribute('role'), aria: fig.getAttribute('aria-label'), along, labels,
      fill: getComputedStyle(shape).fill, stroke: getComputedStyle(shape).stroke, card: getComputedStyle(card).backgroundColor,
      // The figure's width, the width the card gives its content, the outer ring's and the widest axis name's (CSS px).
      box: box.width, column: card.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight),
      ring: fig.querySelector('.radar-grid [data-ring="5"]').getBoundingClientRect().width,
      widest: Math.max(...[...fig.querySelectorAll('.radar-label')].map((l) => l.getBoundingClientRect().width)) };
  });
}

/** @param {'th' | 'en'} primary the look's primary language: the axis names show in it alone
 *  @param {{ phone?: boolean }} [opts] phone: the result page, where the chart takes the card's whole width */
export function checkRadar(h, tag, seen, domains, primary = 'th', { phone = false } = {}) {
  h.check(seen.labels.length === 7 && seen.labels.every((l, i) => l.key === `d${i + 1}` && l.lang === primary && l.text === h.DOMAIN_SHORT[l.key][primary] && l.sub === 0 && l.inside),
    `${tag}: the radar names d1-d7 by their short ${primary === 'th' ? 'Thai' : 'English'} names alone, each inside its box (${seen.labels.map((l) => l.text).join(', ')})`);
  h.check(seen.along.length === 7 && seen.along.every((a, i) => Math.abs(a - domains[`d${i + 1}`] / 5) < 0.01),
    `${tag}: each corner of the score shape sits at its domain's score along its spoke (${seen.along.map((a) => (a * 5).toFixed(1)).join(' ')})`);
  // Practise next draws from d1-d4 and its line says they are bold on the chart: those four bold and ink, the other three
  // lighter in weight and colour, every name still AA on the card.
  const marked = seen.labels.filter((l) => ['d1', 'd2', 'd3', 'd4'].includes(l.key));
  const quiet = seen.labels.filter((l) => !marked.includes(l));
  const ink = (l) => contrast(l.color, seen.card);
  h.check(marked.length === 4 && marked.every((l) => l.weight >= 700) && quiet.every((l) => l.weight <= 400)
    && Math.min(...quiet.map(ink)) >= 4.5 && Math.min(...marked.map(ink)) - Math.max(...quiet.map(ink)) >= 8,
  `${tag}: the four domains Practise next draws from are bold ink on the radar, the other three regular and quieter, all AA (${seen.labels.map((l) => `${l.key} ${l.weight} ${ink(l).toFixed(1)}:1`).join(', ')})`);
  const fill = contrast(seen.fill, seen.card);
  const stroke = contrast(seen.stroke, seen.card);
  h.check(fill >= 3 && stroke >= 3, `${tag}: the score shape's fill ${fill.toFixed(2)}:1 and outline ${stroke.toFixed(2)}:1 against the card, both >= 3:1`);
  h.check(seen.ring > seen.widest && (!phone || Math.abs(seen.box - seen.column) <= 1),
    `${tag}: the chart's ring is wider than its widest axis name${phone ? ', and the chart takes the card\'s whole width' : ''} (ring ${Math.round(seen.ring)} px, widest name ${Math.round(seen.widest)} px, box ${Math.round(seen.box)} of ${Math.round(seen.column)} px)`);
  h.check(seen.role === 'img' && h.DOMAINS.every((d) => seen.aria.includes(`${d.th} ${domains[d.key]}/5`)),
    `${tag}: the radar is one image whose label names every domain with its score`);
}
