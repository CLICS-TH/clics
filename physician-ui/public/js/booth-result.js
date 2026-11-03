// The booth result page (#251): renders the result in the URL fragment (booth-result-link.js) and nothing else.
import { COPY, DEMO_LABEL, scoreText, tagText } from './booth-copy.js';
import { domainSections } from './booth-domains.js';
import { parseResultFragment } from './booth-result-link.js';
import { el, bi } from './booth-dom.js';

const demoLabel = () => el('div', { class: 'demo-label result-demo', dataset: { demoLabel: '' } }, bi(DEMO_LABEL));

/** @param {import('./booth-result-link.js').KeptResult} r */
function resultView(r) {
  return [
    el('header', { class: 'result-head' },
      el('h1', {}, bi(COPY.resultTitle, 'result-title')),
      el('p', { class: 'result-meta' },
        el('span', { dataset: { tag: '' } }, tagText(r.tag)),
        el('time', { datetime: r.date }, r.date))),
    demoLabel(),
    el('section', { class: 'result-case', 'aria-label': COPY.resultCase.en },
      bi(COPY.resultCase, 'result-case-title'), bi(r.teaser, 'teaser')),
    el('article', { class: 'result-card' },
      el('div', { class: 'result-total' },
        bi(COPY.overall, 'result-overall'),
        el('p', { class: 'result-score' },
          el('span', { class: 'result-number', dataset: { score: '' } }, scoreText(r.score)),
          el('span', { class: 'result-outof' }, '/ 100'))),
      ...domainSections(r.domains)),
    demoLabel(),
  ];
}

function missingView() {
  return [el('article', { class: 'end-card', dataset: { resultMissing: '' } },
    bi(COPY.resultMissing, 'end-title'), bi(COPY.resultMissingHint))];
}

function render() {
  const r = parseResultFragment(location.hash);
  document.getElementById('result').replaceChildren(...(r ? resultView(r) : missingView()));
}

addEventListener('hashchange', render);
render();
