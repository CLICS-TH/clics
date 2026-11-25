// The language look control (#377): fixed in one corner of every booth screen, overlays included. It sits outside
// #booth, which the loop and the play redraw wholesale, so a tap on it never starts a play or reaches an overlay.
import { LOOKS, LOOK_COPY, lookOf } from './booth-copy.js';
import { el, bi, currentLook, setLook, onLook } from './booth-dom.js';

const tick = () => el('span', { class: 'booth-icon look-tick', 'aria-hidden': 'true', dataset: { icon: 'check' } });

/** @param {HTMLElement} host where the control is appended, once */
export function mountLookControl(host) {
  const segment = (primary) => {
    const b = el('button', { type: 'button', class: 'look-btn look-seg', lang: primary, dataset: { lookPrimary: primary } },
      tick(), el('span', { class: 'look-text' }, LOOK_COPY[primary]));
    b.addEventListener('click', () => setLook(lookOf(primary, LOOKS[currentLook()].both)));
    return b;
  };
  const both = el('button', { type: 'button', class: 'look-btn look-both', dataset: { lookBoth: '' } },
    el('span', { class: 'look-box', 'aria-hidden': 'true' }, tick()),
    el('span', { class: 'look-text' }, bi(LOOK_COPY.both)));
  both.addEventListener('click', () => {
    const { primary, both: shown } = LOOKS[currentLook()];
    setLook(lookOf(primary, !shown));
  });
  const control = el('div', { class: 'look-control', role: 'group', 'aria-label': `${LOOK_COPY.group.th} ${LOOK_COPY.group.en}`, dataset: { lookControl: '' } },
    el('div', { class: 'look-segs' }, segment('th'), segment('en')), both);
  const show = (look) => {
    const { primary, both: shown } = LOOKS[look];
    for (const s of control.querySelectorAll('[data-look-primary]')) s.setAttribute('aria-pressed', String(s.dataset.lookPrimary === primary));
    both.setAttribute('aria-pressed', String(shown));
  };
  onLook(show);
  show(currentLook());
  host.append(control);
  window.hydrateIcons?.(control);
  return control;
}

/** CCME's mark, in the column's other top corner, level with the look control (booth-shell.css .booth-brand). Outside
 *  #booth like the control, so the loop and the play never redraw it. It takes taps only while full screen, as the first
 *  half of the exit gesture (booth-fullscreen.js). @param {HTMLElement} host */
export function mountBrand(host) {
  const brand = el('div', { class: 'booth-brand', dataset: { boothBrand: '' } },
    el('img', { src: '/img/ccme-logo.png', alt: 'CCME', width: '900', height: '301', decoding: 'async' }));
  host.append(brand);
  return brand;
}
