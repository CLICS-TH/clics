// The radar checks the kiosk's result card (scenarios/result.mjs) and the result page (scenarios/keep.mjs) share.
const lum = ([r, g, b]) => [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const rgb = (css) => css.match(/[\d.]+/g).slice(0, 3).map(Number);
const contrast = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** What the radar draws: each axis's name, and how far along its spoke the score's corner sits (0..1). */
export const readRadar = (page) => page.locator('[data-radar]').first().evaluate((fig) => {
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
    return { key: l.dataset.key, text: l.textContent, inside: r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1 };
  });
  return { role: fig.getAttribute('role'), aria: fig.getAttribute('aria-label'), along, labels,
    fill: getComputedStyle(shape).fill, stroke: getComputedStyle(shape).stroke, card: getComputedStyle(card).backgroundColor };
});

export function checkRadar(h, tag, seen, domains) {
  h.check(seen.labels.length === 7 && seen.labels.every((l, i) => l.key === `d${i + 1}` && l.text === h.DOMAIN_SHORT[l.key].th && l.inside),
    `${tag}: the radar names d1-d7 by their short Thai names, each inside its box (${seen.labels.map((l) => l.text).join(', ')})`);
  h.check(seen.along.length === 7 && seen.along.every((a, i) => Math.abs(a - domains[`d${i + 1}`] / 5) < 0.01),
    `${tag}: each corner of the score shape sits at its domain's score along its spoke (${seen.along.map((a) => (a * 5).toFixed(1)).join(' ')})`);
  const fill = contrast(seen.fill, seen.card);
  const stroke = contrast(seen.stroke, seen.card);
  h.check(fill >= 3 && stroke >= 3, `${tag}: the score shape's fill ${fill.toFixed(2)}:1 and outline ${stroke.toFixed(2)}:1 against the card, both >= 3:1`);
  h.check(seen.role === 'img' && h.DOMAINS.every((d) => seen.aria.includes(`${d.th} ${domains[d.key]}/5`)),
    `${tag}: the radar is one image whose label names every domain with its score`);
}

/** The score sets the card is checked with: every domain at each band, and the two longest low lines made weakest. */
function scoreSets() {
  const longest = [...KEYS].sort((a, b) => size(BAND_LINES[b].low) - size(BAND_LINES[a].low)).slice(0, 2);
  return [
    ['all low', Object.fromEntries(KEYS.map((k) => [k, 1]))],
    ['all middle', Object.fromEntries(KEYS.map((k) => [k, 3]))],
    ['all high', Object.fromEntries(KEYS.map((k) => [k, 5]))],
    [`longest low lines (${longest.join(', ')}) weakest`, Object.fromEntries(KEYS.map((k) => [k, longest.includes(k) ? 0 : 4]))],
  ];
}

async function toResult(k) {
  await k.shell('start');
  await k.toVignette();
  await k.tap('[data-action="begin"]');
  for (let n = 1; n <= 3; n++) {
    await k.screen('step');
    await k.tap('.options > [data-option]:nth-child(1)');
    await k.screen('reply');
    await k.tap(`[data-action="${n === 3 ? 'see-score' : 'next'}"]`);
  }
  await k.screen('scored');
}

