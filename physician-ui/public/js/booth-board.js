// Booth Mode board (#212). booth-play.js and booth-shell.js call three seams and never reach inside:
//   renderTag(tag)                              the result card's tag, "Booth #NNN" with its icon
//   mountResultBoard(slot, { tag, scoreBody })  the result card's ranks and Landing QR, from the score response
//                                               (rank_today, rank_event)
//   mountLoopBoard(slot, { api }) -> stop()     the loop's board, fetched from GET /booth/board every minute
//   leaderboardButton({ host, api, board, tag, short })  the button on the result card and the loop (#250): opens the board
//                                               over `host`, from `board` when the score carried one, else GET /booth/board
// The panel has no controls: on the loop a tap anywhere, the panel included, starts a play. The overlay has one, Close.
import { tagText, DEMO_LABEL } from './booth-copy.js';
import { el, bi } from './booth-dom.js';

const BOARD_TIMEOUT_MS = 8_000;
const LOOP_REFRESH_MS = 60_000;
const OVERLAY_IDLE_MS = 30_000;
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
  open: { th: 'ดูกระดานคะแนน', en: 'See the leaderboard' },
  close: { th: 'ปิดกระดานคะแนน', en: 'Close the leaderboard' },
  loading: { th: 'กำลังโหลดกระดานคะแนน', en: 'Loading the leaderboard' },
  unavailable: { th: 'ตอนนี้ดูกระดานคะแนนไม่ได้', en: 'The leaderboard is unavailable right now' },
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

export function mountResultBoard(slot, { scoreBody }) {
  const ranks = [
    isRank(scoreBody?.rank_today) ? rankLine(COPY.rankToday, scoreBody.rank_today) : null,
    isRank(scoreBody?.rank_event) ? rankLine(COPY.rankEvent, scoreBody.rank_event) : null,
  ].filter(Boolean);
  const qr = landingQr();
  slot.replaceChildren(...(ranks.length || qr
    ? [el('div', { class: 'result-ranks' }, el('div', { class: 'rank-lines' }, ...ranks), qr)] : []));
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

/** The leaderboard over the whole screen, with one Close. Shows `board` at once when it has one, then the fresh GET. */
function openBoard({ host, api, board, tag }) {
  const body = el('div', { class: 'board-body' });
  const close = el('button', { type: 'button', class: 'booth-btn primary wide', dataset: { action: 'close-board' } },
    icon('x'), bi(COPY.close, 'btn-label'));
  const overlay = el('div', { class: 'board-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': COPY.board.en, dataset: { boardOverlay: '' } },
    el('div', { class: 'board-card' }, body, close));
  const show = (b) => {
    body.replaceChildren(b ? boardPanel(b, tag) : el('p', { class: 'board-unavailable', role: 'status' }, bi(b === undefined ? COPY.loading : COPY.unavailable)));
    window.hydrateIcons?.(body);
  };
  let open = true;
  let idle = 0;
  const shut = () => { open = false; clearTimeout(idle); overlay.remove(); };
  const restart = () => { clearTimeout(idle); idle = setTimeout(shut, OVERLAY_IDLE_MS); };
  const first = parseBoard(board);
  show(first ?? undefined);
  restart();
  overlay.addEventListener('pointerdown', restart);
  close.addEventListener('click', shut);
  host.append(overlay);
  window.hydrateIcons?.(overlay);
  close.focus({ preventScroll: true });
  api.get('/booth/board', { timeoutMs: BOARD_TIMEOUT_MS }).then(
    (res) => { const fresh = parseBoard(res?.board); if (open && (fresh || !first)) show(fresh); },
    () => { if (open && !first) show(null); });
}

/** @returns {HTMLButtonElement} */
export function leaderboardButton({ host, api, board = null, tag = null, cls = 'secondary wide', short = false }) {
  const b = el('button', { type: 'button', class: `booth-btn ${cls}`, dataset: { action: 'leaderboard' } },
    icon('flag'), bi(short ? COPY.board : COPY.open, 'btn-label'));
  b.addEventListener('click', () => { if (!host.querySelector('[data-board-overlay]')) openBoard({ host, api, board, tag }); });
  return b;
}
