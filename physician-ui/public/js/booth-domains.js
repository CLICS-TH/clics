// The seven PIS-7 rows with their band descriptors, shared by the kiosk's result card and the result page (#251).
import { COPY, DOMAINS, domainText } from './booth-copy.js';
import { BAND_LINES, MEASURES, bandOf, weakestFirst } from './booth-bands.js';
import { el, bi } from './booth-dom.js';

/** The two weakest domains under "Practise next", `between` them and the other five. `steps` is the play's step
 *  count, null when unknown: it sets how a value is written (domainText). `measures` adds what each domain looks at
 *  (the phone result page; the kiosk card has no room). */
export function domainSections(scores, steps, between = null, { measures = false } = {}) {
  const order = weakestFirst(scores);
  const section = (title, keys, cls) => el('section', { class: `domain-section ${cls}`, 'aria-label': title.en },
    bi(title, 'section-title'),
    el('ol', { class: 'domains' }, ...keys.map((key) => domainRow(DOMAINS.find((d) => d.key === key), scores[key], steps, measures))));
  return [section(COPY.practiseNext, order.slice(0, 2), 'practise-next'), between, section(COPY.otherDomains, order.slice(2), 'other-domains')];
}

function domainRow(d, value, steps, measures) {
  const band = bandOf(value);
  return el('li', { class: 'domain', dataset: { key: d.key, value: String(value), band } },
    el('div', { class: 'domain-head' },
      bi(d, 'domain-name'),
      el('span', { class: 'domain-value' }, `${domainText(value, steps)} / 5`)),
    measures ? bi(MEASURES[d.key], 'domain-measure') : null,
    el('div', { class: 'domain-bar', 'aria-hidden': 'true' }, el('span', { style: `width: ${value * 20}%` })),
    bi(BAND_LINES[d.key][band], 'domain-band'));
}
