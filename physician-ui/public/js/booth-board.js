// Booth Mode board (#212). booth-play.js and booth-shell.js call three seams and never reach inside:
//   renderTag(tag)                              the result card's tag, "Booth #NNN" with its icon
//   mountResultBoard(slot, { tag, scoreBody })  the result card's ranks, board and Landing QR, from the score
//                                               response (rank_today, rank_event, board)
//   mountLoopBoard(slot, { api }) -> stop()     the loop's board, fetched from GET /booth/board every minute
// The board has no controls: on the loop a tap anywhere, the panel included, starts a play.
import { tagText, DEMO_LABEL } from './booth-copy.js';
import { el, bi } from './booth-dom.js';

const BOARD_TIMEOUT_MS = 8_000;
const LOOP_REFRESH_MS = 60_000;
const LANDING_QR_SRC = '/img/booth-landing-qr.svg';

// Icons from the Portal set (js/icons.js) that read as a badge, not as a button's action or a warning.
const TAG_ICONS = Object.freeze(['flag', 'shield', 'clock', 'message', 'folder', 'clipboard', 'paperclip', 'eye', 'check',
  'checkCircle', 'hourglass', 'help']);

const COPY = Object.freeze({
  rankToday: { th: 'อันดับของคุณวันนี้', en: 'Your rank today' },
  rankEvent: { th: 'อันดับตลอดงาน', en: 'Your rank for the event' },
  board: { th: 'กระดานคะแนน', en: 'Leaderboard' },
  today: { th: '10 อันดับวันนี้', en: 'Top 10 today' },
  event: { th: '10 อันดับตลอดงาน', en: 'Top 10 of the event' },
  empty: { th: 'ยังไม่มีคะแนน', en: 'No scores yet' },
  scan: { th: 'สแกนเพื่อรู้จัก CLICS', en: 'Scan to learn about CLICS' },
});

/** Deterministic: 7 is coprime to the 12 icons, so 12 tags in a row never repeat one. */
export const tagIcon = (tag) => TAG_ICONS[(tag * 7) % TAG_ICONS.length];

const icon = (name) => el('span', { class: 'booth-icon', 'aria-hidden': 'true', dataset: { icon: name } });

/** @param {number} tag @returns {HTMLElement} */
export function renderTag(tag) {
  return el('p', { class: 'booth-tag', dataset: { tagIcon: tagIcon(tag) } }, icon(tagIcon(tag)), el('span', {}, tagText(tag)));
}

const isRank = (v) => Number.isInteger(v) && v > 0;
const isEntry = (e) => Number.isInteger(e?.tag) && e.tag > 0 && Number.isFinite(e.score);
const parseBoard = (b) => (b && Array.isArray(b.today) && Array.isArray(b.event)
  ? { today: b.today.filter(isEntry), event: b.event.filter(isEntry) } : null);

function boardList(title, entries, mine) {
  return el('section', { class: 'board-list', 'aria-label': title.en },
    bi(title, 'board-list-title'),
    entries.length
      ? el('ol', { class: 'board-rows' }, ...entries.map((e, i) => el('li', {
        class: 'board-row', dataset: { tag: String(e.tag) }, ...(e.tag === mine ? { 'aria-current': 'true' } : {}),
      }, el('span', { class: 'board-rank' }, String(i + 1)), icon(tagIcon(e.tag)),
      el('span', { class: 'board-tag' }, tagText(e.tag)), el('span', { class: 'board-score' }, String(Math.round(e.score))))))
      : bi(COPY.empty, 'board-empty'));
}

function boardPanel(board, mine = null) {
  return el('section', { class: 'board-panel', dataset: { board: '' }, 'aria-label': COPY.board.en },
    bi(COPY.board, 'board-title'),
    el('div', { class: 'board-lists' }, boardList(COPY.today, board.today, mine), boardList(COPY.event, board.event, mine)),
    el('div', { class: 'demo-label board-label', dataset: { demoLabel: '' } }, bi(DEMO_LABEL)));
}

function rankLine(label, rank) {
  return el('div', { class: 'rank', dataset: { rank: String(rank) } }, bi(label, 'rank-label'), el('span', { class: 'rank-value' }, `#${rank}`));
}

/** The Landing QR shows only when js/config.js switches it on, and only once the Landing page (#191) is live. */
function landingQr() {
  if (window.CLICS_BOOTH_LANDING_QR !== true) return null;
  return el('figure', { class: 'landing-qr', dataset: { landingQr: '' } },
    el('img', { src: LANDING_QR_SRC, alt: COPY.scan.en, width: '240', height: '240' }), bi(COPY.scan, 'landing-qr-caption'));
}

export function mountResultBoard(slot, { tag, scoreBody }) {
  const ranks = [
    isRank(scoreBody?.rank_today) ? rankLine(COPY.rankToday, scoreBody.rank_today) : null,
    isRank(scoreBody?.rank_event) ? rankLine(COPY.rankEvent, scoreBody.rank_event) : null,
  ].filter(Boolean);
  const qr = landingQr();
  const board = parseBoard(scoreBody?.board);
  slot.replaceChildren(...[
    ranks.length || qr ? el('div', { class: 'result-ranks' }, el('div', { class: 'rank-lines' }, ...ranks), qr) : null,
    board ? boardPanel(board, tag) : null,
  ].filter(Boolean));
  window.hydrateIcons?.(slot);
}

/** @returns {() => void} stop: no further fetch or render */
export function mountLoopBoard(slot, { api }) {
  let stopped = false;
  let timer = null;
  const refresh = async () => {
    let board = null;
    try { board = parseBoard((await api.get('/booth/board', { timeoutMs: BOARD_TIMEOUT_MS }))?.board); } catch { board = null; }
    if (stopped) return;
    slot.replaceChildren(...(board ? [boardPanel(board)] : []));
    window.hydrateIcons?.(slot);
    timer = setTimeout(refresh, LOOP_REFRESH_MS);
  };
  refresh();
  return () => { stopped = true; clearTimeout(timer); };
}
