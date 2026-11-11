// The booth result page (#251): renders the result in the URL fragment (booth-result-link.js) and nothing else.
import { COPY, DEFAULT_LOOK, DEMO_LABEL, scoreText, fill } from './booth-copy.js';
import { domainSections } from './booth-domains.js';
import { radar } from './booth-radar.js';
import { tierChip } from './booth-answers.js';
import { parseResultFragment } from './booth-result-link.js';
import { el, bi, setLook, tagName } from './booth-dom.js';

const demoLabel = () => el('div', { class: 'demo-label result-demo', dataset: { demoLabel: '' } }, bi(DEMO_LABEL));

// The Portal's root and nothing more: no play id, no query, no fragment, never /login (the Portal routes a visitor
// who is not signed in itself).
const tryClics = () => el('a', { class: 'booth-btn primary wide try-clics', href: '/', dataset: { action: 'try-clics' } }, bi(COPY.tryClics, 'btn-label'));

function tierList(tiers) {
  return el('section', { class: 'result-tiers', 'aria-label': COPY.stepTiers.en },
    bi(COPY.stepTiers, 'section-title'),
    el('ol', { class: 'tier-steps' }, ...tiers.map((tier, i) => el('li', { class: 'tier-step', dataset: { step: String(i + 1), tier } },
      bi(fill(COPY.stepN, { n: i + 1 }), 'tier-step-n'), tierChip(tier)))));
}

/** @param {import('./booth-result-link.js').KeptResult} r */
function resultView(r) {
  return [
    el('header', { class: 'result-head' },
      el('h1', {}, bi(COPY.resultTitle, 'result-title')),
      el('p', { class: 'result-meta' },
        el('span', { dataset: { tag: '' } }, tagName(r.tag)),
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
      radar(r.domains),
      ...domainSections(r.domains)),
    r.tiers ? tierList(r.tiers) : null,
    tryClics(),
    demoLabel(),
  ].filter(Boolean);
}

function missingView() {
  return [el('article', { class: 'end-card', dataset: { resultMissing: '' } },
    bi(COPY.resultMissing, 'end-title'), bi(COPY.resultMissingHint)), tryClics()];
}

function render() {
  const r = parseResultFragment(location.hash);
  setLook(r?.look ?? DEFAULT_LOOK);
  document.getElementById('result').replaceChildren(...(r ? resultView(r) : missingView()));
}

addEventListener('hashchange', render);
render();
