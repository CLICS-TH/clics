// The seven PIS-7 rows with their band descriptors, shared by the kiosk's result card and the result page (#251).
import { COPY, DOMAINS, DOMAIN_BREAKS, domainText } from './booth-copy.js';
import { BAND_LINES, MEASURES, PRACTISE_KEYS, bandOf, practiseNext, weakestFirst } from './booth-bands.js';
import { el, bi } from './booth-dom.js';

/** The two weakest of d1-d4 under "Practise next" (practiseNext), with a line saying so, `between` them and the other
 *  five, weakest first, d5-d7 tagged as domains a booth play gives little room. `steps` is the play's step count, null
 *  when unknown: it sets how a value is written (domainText). `measures` adds what each domain looks at (the phone
 *  result page; the kiosk card has no room). `otherHead` false leaves the other five's title to the caller (the phone
 *  page draws it as the summary of the fold they sit in). */
export function domainSections(scores, steps, between = null, { measures = false, otherHead = true } = {}) {
  const next = practiseNext(scores);
  const section = (title, note, keys, cls, head = true) => el('section', { class: `domain-section ${cls}`, 'aria-label': title.en },
    head ? el('div', { class: 'section-head' }, bi(title, 'section-title'), note && bi(note, 'section-note')) : null,
    el('ol', { class: 'domains' }, ...keys.map((key) => domainRow(DOMAINS.find((d) => d.key === key), scores[key], steps, measures))));
  return [section(COPY.practiseNext, COPY.practiseFrom, next, 'practise-next'), between,
    section(COPY.otherDomains, null, weakestFirst(scores).filter((key) => !next.includes(key)), 'other-domains', otherHead)];
}

function domainRow(d, value, steps, measures) {
  const band = bandOf(value);
  return el('li', { class: 'domain', dataset: { key: d.key, value: String(value), band } },
    el('div', { class: 'domain-head' },
      // The rubric's name, with the places a narrow column may end its Thai line (DOMAIN_BREAKS).
      bi({ th: DOMAIN_BREAKS[d.key], en: d.en }, 'domain-name'),
      el('span', { class: 'domain-value' }, `${domainText(value, steps)} / 5`)),
    PRACTISE_KEYS.includes(d.key) ? null : bi(COPY.littleRoom, 'domain-tag'),
    measures ? bi(MEASURES[d.key], 'domain-measure') : null,
    el('div', { class: 'domain-bar', 'aria-hidden': 'true' }, el('span', { style: `width: ${value * 20}%` })),
    bi(BAND_LINES[d.key][band], 'domain-band'));
}
