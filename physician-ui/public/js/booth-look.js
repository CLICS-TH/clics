// The language look control (#377): fixed in one corner of every booth screen. It sits outside #booth, which the loop
// and the play redraw wholesale, and above the loop's tap layer, so a tap on it never starts a play.
import { LOOKS, LOOK_COPY, lookOf } from './booth-copy.js';
import { el, currentLook, setLook, onLook } from './booth-dom.js';

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
    el('span', { class: 'look-text' }, el('span', { lang: 'th' }, LOOK_COPY.both.th), el('span', { lang: 'en' }, LOOK_COPY.both.en)));
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
}
