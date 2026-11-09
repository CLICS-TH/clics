// "See the answers" on the result card (#379): each step's question, the visitor's answer with its tier, and the
// best option offered when the visitor did not tap it. Every tier comes from the score response (booth-play.js
// parseScore); nothing here exists before it.
import { COPY, TIERS, fill } from './booth-copy.js';
import { el, bi, phrases } from './booth-dom.js';

const OVERLAY_IDLE_MS = 30_000;

/**
 * @typedef {{ th: string, en: string }} Bi
 * @typedef {{ question: Bi, given: { label: Bi } | { text: string }, tier: string, best: Bi | null }} RevealRow
 *   best: the label of the offered option whose tier is best, null when the visitor tapped that very option.
 */

/**
 * @param {import('./booth-play.js').Next[]} nexts the step each answer replied to
 * @param {import('./booth-play.js').Answer[]} answers
 * @param {{ tier: string, options: { id: string, tier: string }[] }[]} tiers the score response's steps, checked
 * @returns {RevealRow[]}
 */
export function revealRows(nexts, answers, tiers) {
  return answers.map((answer, i) => {
    const { options } = nexts[i];
    const bestId = tiers[i].options.find((o) => o.tier === 'best')?.id ?? null;
    const tapped = 'choice' in answer ? answer.choice : null;
    return {
      question: nexts[i].question,
      given: tapped ? { label: options.find((o) => o.id === tapped).label } : { text: answer.text },
      tier: tiers[i].tier,
      best: bestId === null || bestId === tapped ? null : options.find((o) => o.id === bestId).label,
    };
  });
}

export const tierChip = (tier) => el('span', { class: 'tier-chip', dataset: { tier } }, bi(TIERS[tier].label));

const icon = (name) => el('span', { class: 'booth-icon', 'aria-hidden': 'true', dataset: { icon: name } });

function rowView(row, i) {
  const given = 'label' in row.given
    ? bi(row.given.label, 'reveal-given')
    : el('p', { class: 'reveal-typed', lang: 'th' }, ...phrases(row.given.text));
  return el('li', { class: 'reveal-step', dataset: { step: String(i + 1), tier: row.tier } },
    bi(fill(COPY.stepN, { n: i + 1 }), 'step-of'),
    bi(row.question, 'reveal-question'),
    el('section', { class: 'reveal-answer', 'aria-label': COPY.yourAnswer.en },
      bi(COPY.yourAnswer, 'answer-label'), given, tierChip(row.tier)),
    row.best ? el('section', { class: 'reveal-best', dataset: { best: '' }, 'aria-label': COPY.bestOffered.en },
      bi(COPY.bestOffered, 'answer-label'), bi(row.best, 'reveal-given'), tierChip('best')) : null);
}

/** The overlay, the leaderboard's pattern (booth-board.js openBoard): one Close, and it closes itself when left. */
function openAnswers(host, rows) {
  const close = el('button', { type: 'button', class: 'booth-btn primary wide', dataset: { action: 'close-answers' } },
    icon('x'), bi(COPY.closeAnswers, 'btn-label'));
  const overlay = el('div', { class: 'reveal-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': COPY.answersTitle.en, dataset: { revealOverlay: '' } },
    el('div', { class: 'reveal-card' },
      el('h2', { class: 'reveal-title' }, bi(COPY.answersTitle)),
      el('ol', { class: 'reveal-steps' }, ...rows.map(rowView)),
      close));
  let idle = 0;
  const shut = () => { clearTimeout(idle); overlay.remove(); };
  const restart = () => { clearTimeout(idle); idle = setTimeout(shut, OVERLAY_IDLE_MS); };
  restart();
  overlay.addEventListener('pointerdown', restart);
  overlay.addEventListener('scroll', restart, { passive: true });
  close.addEventListener('click', shut);
  host.append(overlay);
  window.hydrateIcons?.(overlay);
  close.focus({ preventScroll: true });
}

/** @param {{ host: HTMLElement, rows: RevealRow[] }} ctx @returns {HTMLButtonElement} */
export function answersButton({ host, rows }) {
  const b = el('button', { type: 'button', class: 'booth-btn secondary wide', dataset: { action: 'see-answers' } },
    bi(COPY.seeAnswers, 'btn-label'));
  b.addEventListener('click', () => { if (!host.querySelector('[data-reveal-overlay]')) openAnswers(host, rows); });
  return b;
}
