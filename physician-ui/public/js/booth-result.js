// The booth result page (#251): renders the result in the URL fragment (booth-result-link.js), and for an r2 link its case's
// step text, a script of the Portal's own (booth-steps/<case_id>.js), and nothing else.
import { COPY, DEFAULT_LOOK, DEMO_LABEL, TIERS, scoreText, fill, isRescaled } from './booth-copy.js';
import { domainSections } from './booth-domains.js';
import { radar } from './booth-radar.js';
import { tierChip } from './booth-answers.js';
import { parseResultFragment } from './booth-result-link.js';
import { SCALE_NOTE } from './booth-bands.js';
import { el, bi, caseBi, phrases, setLook, tagName } from './booth-dom.js';
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
  bi(WORKSHOP_COPY.alongside, 'workshop-alongside'),
  bi(WORKSHOP_COPY.when, 'workshop-when'),
  el('a', { class: 'booth-btn primary wide workshop-open', href: WORKSHOP_PATH, dataset: { action: 'workshop' } }, enFirst(WORKSHOP_COPY.open, 'btn-label')));

/** A pair drawn English first in every look that shows English, Thai under it (owner, 2026-11-19: the workshop's title
 *  and button). Not a .bi, so setLook leaves its order alone and the look check (look.mjs) does not hold it to the
 *  look's order; a one-language look still hides the other language (booth-result.css .en-first). */
const enFirst = (pair, cls) => el('span', { class: `en-first ${cls}` },
  el('span', { class: 'en-first-en', lang: 'en' }, pair.en),
  el('span', { class: 'en-first-th', lang: 'th' }, ...phrases(pair.th)));

/** A section folded behind a tap, closed when the page is drawn, so the visitor's own score, Practise next and the
 *  workshop come first and the page stays short. Its title is the summary: a <details> opens from the keyboard too, and
 *  the browser opens it for a find in the page or a link to text inside it (the page's own fragment is the result, so
 *  no link names an element in it). */
const fold = (key, title, body) => el('details', { class: 'result-fold', id: `fold-${key}`, dataset: { fold: key } },
  el('summary', { class: 'fold-head' }, bi(title, 'section-title'), chevron()),
  body);

/** The fold's mark: a chevron pointing down, which booth-result.css turns over when the fold is open. */
function chevron() {
  const ns = 'http://www.w3.org/2000/svg';
  const mark = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ class: 'fold-mark', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' })) mark.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'm6 9 6 6 6-6');
  mark.append(path);
  return mark;
}

function tierList(tiers) {
  return el('section', { class: 'result-tiers', 'aria-label': COPY.stepTiers.en },
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
    el('ol', { class: 'reveal-steps' }, ...rows.map((row, i) => el('li', { class: 'reveal-step', dataset: { step: String(i + 1), tier: row.tier } },
      bi(fill(COPY.stepN, { n: i + 1 }), 'step-of'),
      bi(row.question, 'reveal-question'),
      el('section', { class: 'reveal-answer', 'aria-label': COPY.yourAnswer.en },
        bi(COPY.yourAnswer, 'answer-label'), ...(row.given ? optionView(row.given) : [bi(COPY.typedOwn, 'reveal-given')]), tierChip(row.tier)),
      row.best ? el('section', { class: 'reveal-best', dataset: { best: '' }, 'aria-label': COPY.bestOffered.en },
        bi(COPY.bestOffered, 'answer-label'), ...optionView(row.best), tierChip('best')) : null))));
}

/** @param {import('./booth-result-link.js').KeptResult} r @param {StepText | null} text the case's step text, if read */
function resultView(r, text, feedbackCard) {
  const teaser = r.teaser ?? text?.teaser ?? null;
  const explained = r.tiers && r.picks && text ? explainRows(r, text) : null;
  const [practise, , others] = domainSections(r.domains, r.tiers?.length ?? null, null, { measures: true, otherHead: false });
  return [
    el('header', { class: 'result-head' },
      el('h1', {}, bi(COPY.resultTitle, 'result-title')),
      el('p', { class: 'result-meta' },
        el('span', { dataset: { tag: '' } }, tagName(r.tag)),
        el('time', { datetime: r.date }, r.date))),
    demoLabel(),
    teaser ? el('section', { class: 'result-case', 'aria-label': COPY.resultCase.en },
      bi(COPY.resultCase, 'result-case-title'), caseBi(teaser, 'teaser')) : null,
    el('article', { class: 'result-card' },
      el('div', { class: 'result-total' },
        bi(COPY.overall, 'result-overall'),
        el('p', { class: 'result-score' },
          el('span', { class: 'result-number', dataset: { score: '' } }, scoreText(r.score)),
          el('span', { class: 'result-outof' }, '/ 100')),
        isRescaled(r.tiers?.length) ? bi(COPY.displayScale, 'score-note') : null),
      radar(r.domains)),
    el('section', { class: 'result-card result-domains' }, bi(SCALE_NOTE, 'scale-note'), practise),
    // The workshop invitation right after the visitor's own feedback (owner, 2026-11-21: visitors must see it), before
    // the folded domain and step lists.
    workshopCard(),
    // The feedback form's card, next to it; null unless js/config.js switches the feedback on.
    feedbackCard?.(r.caseId ?? null, r.look),
    fold('domains', COPY.otherDomains, el('div', { class: 'result-card result-domains' }, others)),
    explained ? fold('answers', COPY.answersTitle, stepList(explained)) : r.tiers ? fold('answers', COPY.stepTiers, tierList(r.tiers)) : null,
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
  // The feedback card's module only when the switch is on, and never a reason for the result not to show.
  const card = r && window.CLICS_BOOTH_FEEDBACK === true ? (await import('./booth-feedback-card.js').catch(() => null))?.feedbackCard : null;
  if (mine !== rendering) return;
  document.getElementById('result').replaceChildren(...(r ? resultView(r, text, card) : missingView()));
  document.getElementById('result').dataset.rendered = '';
}

addEventListener('hashchange', render);
render();
