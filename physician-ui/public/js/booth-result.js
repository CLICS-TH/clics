// The booth result page (#251): renders the result in the URL fragment (booth-result-link.js), and for an r2 link its case's
// step text, a script of the Portal's own (booth-steps/<case_id>.js), and nothing else.
import { COPY, DEFAULT_LOOK, DEMO_LABEL, TIERS, scoreText, fill } from './booth-copy.js';
import { domainSections } from './booth-domains.js';
import { radar } from './booth-radar.js';
import { tierChip } from './booth-answers.js';
import { parseResultFragment } from './booth-result-link.js';
import { SCALE_NOTE } from './booth-bands.js';
import { el, bi, phrases, setLook, tagName } from './booth-dom.js';
import { WORKSHOP_COPY, WORKSHOP_PATH } from './booth-workshop.js';

const demoLabel = () => el('div', { class: 'demo-label result-demo', dataset: { demoLabel: '' } }, bi(DEMO_LABEL));

// The Portal's root and nothing more: no play id, no query, no fragment, never /login (the Portal routes a visitor
// who is not signed in itself).
const tryClics = (kind = 'primary') => el('a', { class: `booth-btn ${kind} wide try-clics`, href: '/', dataset: { action: 'try-clics' } }, bi(COPY.tryClics, 'btn-label'));

/** The invitation to the calibration workshop, the result's next step (so Try CLICS steps down to secondary under it).
 *  It opens the Portal's own page, /workshop.html, which links on to registration. The phone page only. */
const workshopCard = () => el('section', { class: 'workshop-card', dataset: { workshop: '' }, 'aria-label': WORKSHOP_COPY.title.en },
  enFirst(WORKSHOP_COPY.title, 'workshop-title'),
  bi(WORKSHOP_COPY.line, 'workshop-line'),
  bi(WORKSHOP_COPY.when, 'workshop-when'),
  el('a', { class: 'booth-btn primary wide workshop-open', href: WORKSHOP_PATH, dataset: { action: 'workshop' } }, enFirst(WORKSHOP_COPY.open, 'btn-label')));

/** A pair drawn English first in every look that shows English, Thai under it (owner, 2026-11-19: the workshop's title
 *  and button). Not a .bi, so setLook leaves its order alone and the look check (look.mjs) does not hold it to the
 *  look's order; a one-language look still hides the other language (booth-result.css .en-first). */
const enFirst = (pair, cls) => el('span', { class: `en-first ${cls}` },
  el('span', { class: 'en-first-en', lang: 'en' }, pair.en),
  el('span', { class: 'en-first-th', lang: 'th' }, ...phrases(pair.th)));

function tierList(tiers) {
  return el('section', { class: 'result-tiers', 'aria-label': COPY.stepTiers.en },
    bi(COPY.stepTiers, 'section-title'),
    el('ol', { class: 'tier-steps' }, ...tiers.map((tier, i) => el('li', { class: 'tier-step', dataset: { step: String(i + 1), tier } },
      bi(fill(COPY.stepN, { n: i + 1 }), 'tier-step-n'), tierChip(tier)))));
}

/**
 * @typedef {{ th: string, en: string }} Bi
 * @typedef {{ variants: Record<string, Bi>, options: Record<string, { label: Bi, line: Bi }> }} StepBank
 * @typedef {{ case_id: string, version: string, teaser: Bi, banks: Record<string, StepBank | Record<string, StepBank>> }} StepText
 */

/** The step text of the case version the link was played on (scripts/booth/step-text.mjs, kept for every version ever
 *  admitted), a script of the Portal's own, so connect-src 'none' holds. Null when there is none: the page then lists
 *  each step's tier alone. */
async function stepText(caseId, version) {
  try {
    const text = (await import(`/booth-steps/${caseId}@${version}.js`)).default;
    return text?.case_id === caseId && text.version === version ? text : null;
  } catch {
    return null;
  }
}

/** Each step's question, the answer given and the best option offered, from the bank the step was dealt from: step 1's
 *  own, else the one keyed by the tiers before it (three-step) or the last of them (five-step). Null when any id is
 *  not in the text (a hand-edited link), so the page falls back to the tier list rather than show wrong text. */
function explainRows(r, text) {
  const letters = r.tiers.map((t) => TIERS[t].letter);
  const rows = r.picks.map((pick, i) => {
    const level = text.banks[`step${i + 1}`];
    const prefix = letters.slice(0, i).join('');
    const bank = i === 0 ? level : level?.[prefix] ?? level?.[prefix.slice(-1)];
    const question = bank?.variants?.[pick.variant];
    const given = pick.chosen === null ? null : bank?.options?.[pick.chosen];
    const best = pick.best === null || pick.best === pick.chosen ? null : bank?.options?.[pick.best];
    const ok = question && (pick.chosen === null || given) && (pick.best === null || pick.best === pick.chosen || best);
    return ok ? { question, given, best, tier: r.tiers[i] } : null;
  });
  return rows.every(Boolean) ? rows : null;
}

const optionView = (o) => [bi(o.label, 'reveal-given'), bi(o.line, 'reveal-line')];

function stepList(rows) {
  return el('section', { class: 'result-tiers result-steps', 'aria-label': COPY.answersTitle.en },
    bi(COPY.answersTitle, 'section-title'),
    el('ol', { class: 'reveal-steps' }, ...rows.map((row, i) => el('li', { class: 'reveal-step', dataset: { step: String(i + 1), tier: row.tier } },
      bi(fill(COPY.stepN, { n: i + 1 }), 'step-of'),
      bi(row.question, 'reveal-question'),
      el('section', { class: 'reveal-answer', 'aria-label': COPY.yourAnswer.en },
        bi(COPY.yourAnswer, 'answer-label'), ...(row.given ? optionView(row.given) : [bi(COPY.typedOwn, 'reveal-given')]), tierChip(row.tier)),
      row.best ? el('section', { class: 'reveal-best', dataset: { best: '' }, 'aria-label': COPY.bestOffered.en },
        bi(COPY.bestOffered, 'answer-label'), ...optionView(row.best), tierChip('best')) : null))));
}

/** @param {import('./booth-result-link.js').KeptResult} r @param {StepText | null} text the case's step text, if read */
function resultView(r, text) {
  const teaser = r.teaser ?? text?.teaser ?? null;
  const explained = r.tiers && r.picks && text ? explainRows(r, text) : null;
  return [
    el('header', { class: 'result-head' },
      el('h1', {}, bi(COPY.resultTitle, 'result-title')),
      el('p', { class: 'result-meta' },
        el('span', { dataset: { tag: '' } }, tagName(r.tag)),
        el('time', { datetime: r.date }, r.date))),
    demoLabel(),
    teaser ? el('section', { class: 'result-case', 'aria-label': COPY.resultCase.en },
      bi(COPY.resultCase, 'result-case-title'), bi(teaser, 'teaser')) : null,
    el('article', { class: 'result-card' },
      el('div', { class: 'result-total' },
        bi(COPY.overall, 'result-overall'),
        el('p', { class: 'result-score' },
          el('span', { class: 'result-number', dataset: { score: '' } }, scoreText(r.score)),
          el('span', { class: 'result-outof' }, '/ 100'))),
      radar(r.domains),
      bi(SCALE_NOTE, 'scale-note'),
      ...domainSections(r.domains, r.tiers?.length ?? null, null, { measures: true })),
    explained ? stepList(explained) : r.tiers ? tierList(r.tiers) : null,
    workshopCard(),
    tryClics('secondary'),
    demoLabel(),
  ].filter(Boolean);
}

function missingView() {
  return [el('article', { class: 'end-card', dataset: { resultMissing: '' } },
    bi(COPY.resultMissing, 'end-title'), bi(COPY.resultMissingHint)), tryClics()];
}

let rendering = 0;
async function render() {
  const r = parseResultFragment(location.hash);
  const mine = ++rendering;
  setLook(r?.look ?? DEFAULT_LOOK);
  const text = r?.caseId ? await stepText(r.caseId, r.caseVersion) : null;
  if (mine !== rendering) return;
  document.getElementById('result').replaceChildren(...(r ? resultView(r, text) : missingView()));
  document.getElementById('result').dataset.rendered = '';
}

addEventListener('hashchange', render);
render();
