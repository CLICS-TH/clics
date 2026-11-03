// The attract loop (#213): the files listed in /booth-loop/manifest.json, played in order, forever.
// Staff add CCME files by dropping them in public/booth-loop/ and listing them in the manifest (README).
import { el } from './booth-dom.js';

const LOOP_DIR = '/booth-loop/';
const MANIFEST = `${LOOP_DIR}manifest.json`;
const RETRY_MS = 60_000;

/**
 * The loop board shows only over an item whose `board` is true. A file says `"board": false` when its own text
 * reaches the bottom of the frame (the promo's demo labels and end card, #216); a `board` item shows the board
 * alone over the stage's wordmark for `seconds`.
 * A file with `"fit": "cover"` and a `safe` box [left, top, right, bottom] in its own pixels fills the stage with no
 * side bands whenever cover-cropping keeps that box whole; on a stage too far from its aspect it is letterboxed.
 * @typedef {({ type: 'image', src: string, seconds: number } | { type: 'video', src: string }
 *   | { type: 'board', seconds: number }) & { board: boolean, safe?: number[] }} LoopItem
 */

/** The item's path, percent-encoded as the browser sends it (staff file names have spaces and Thai), or null. */
const loopPath = (src) => {
  if (typeof src !== 'string') return null;
  try {
    const url = new URL(src, location.origin);
    const ok = url.origin === location.origin && !url.search && !url.hash
      && url.pathname.startsWith(LOOP_DIR) && url.pathname !== MANIFEST;
    return ok ? url.pathname : null;
  } catch {
    return null;
  }
};

const validSeconds = (n) => Number.isInteger(n) && n >= 1 && n <= 120;
const validSafe = (b) => Array.isArray(b) && b.length === 4 && b.every((n) => Number.isInteger(n) && n >= 0) && b[0] < b[2] && b[1] < b[3];
/** The item's safe box when it asked for cover, else nothing (contain). */
const coverSafe = (item) => (item.fit === 'cover' && validSafe(item.safe) ? { safe: item.safe } : {});

/** Cover when the stage crops none of `safe` out of a `w` x `h` picture, else contain. */
export function loopFit(stageW, stageH, w, h, safe) {
  if (!safe || !stageW || !stageH || !w || !h) return 'contain';
  const s = Math.max(stageW / w, stageH / h);
  const seenW = stageW / s;
  const seenH = stageH / s;
  const [l, t, r, b] = safe;
  return l >= (w - seenW) / 2 && r <= (w + seenW) / 2 && t >= (h - seenH) / 2 && b <= (h + seenH) / 2 ? 'cover' : 'contain';
}

/** @returns {LoopItem | null} */
function parseItem(item) {
  if (item?.type === 'board' && validSeconds(item.seconds)) return { type: 'board', seconds: item.seconds, board: true };
  const src = loopPath(item?.src);
  if (src && item.type === 'image' && validSeconds(item.seconds)) {
    return { type: 'image', src, seconds: item.seconds, board: item.board !== false, ...coverSafe(item) };
  }
  if (src && item.type === 'video' && src.endsWith('.mp4')) return { type: 'video', src, board: item.board !== false, ...coverSafe(item) };
  console.warn('booth loop: skipped manifest item', item);
  return null;
}

/** The manifest's playable items; [] when it is missing, unreadable or lists nothing valid. @returns {Promise<LoopItem[]>} */
export async function loadLoopItems() {
  try {
    const res = await fetch(MANIFEST, { cache: 'no-store' });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.items) ? body.items.map(parseItem).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Plays the loop in a media layer appended to `container`. The layer is empty (and hidden by CSS) until an item
 * has loaded, so whatever sits under it shows through. data-loop-kind / data-loop-src name the item on screen, and
 * data-loop-board="on" lets the loop board show over it; with no item on screen yet the board stays hidden.
 * @param {HTMLElement} container
 * @returns {{ stop: () => void }}
 */
export function mountLoop(container) {
  const layer = el('div', { class: 'loop-media', 'aria-hidden': 'true' });
  container.append(layer);
  const life = new AbortController();

  let safe = null;
  /** data-loop-fit picks object-fit for the media on screen; the stage's size decides, so it is redone on resize. */
  const fit = () => {
    const m = layer.firstElementChild;
    const w = m?.videoWidth || m?.naturalWidth;
    const h = m?.videoHeight || m?.naturalHeight;
    layer.dataset.loopFit = loopFit(layer.clientWidth, layer.clientHeight, w, h, safe);
  };
  const sized = new ResizeObserver(fit);
  sized.observe(layer);
  const put = (node, item) => {
    layer.replaceChildren(...(node ? [node] : []));
    layer.dataset.loopKind = item.type;
    if (item.src) layer.dataset.loopSrc = item.src;
    else delete layer.dataset.loopSrc;
    layer.dataset.loopBoard = item.board ? 'on' : 'off';
    safe = item.safe ?? null;
    fit();
  };
  const clear = () => {
    layer.replaceChildren();
    delete layer.dataset.loopFit;
    delete layer.dataset.loopKind;
    delete layer.dataset.loopSrc;
    delete layer.dataset.loopBoard;
  };

  /** Resolves true once the item has played through, false if it failed to load or play, or the loop stopped. */
  const show = (item) => new Promise((resolve) => {
    let timer = 0;
    if (item.type === 'board') {
      put(null, item);
      timer = setTimeout(() => resolve(true), item.seconds * 1000);
      life.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(false); }, { once: true });
      return;
    }
    // A video that failed is never rewound: the next item loads afresh instead.
    const shown = layer.querySelector('video');
    const replay = item.type === 'video' && layer.dataset.loopSrc === item.src && shown && !shown.error ? shown : null;
    const node = replay ?? (item.type === 'image'
      ? el('img', { alt: '', decoding: 'async' })
      : el('video', { muted: '', playsinline: '', autoplay: '', preload: 'auto' }));
    const end = (ok) => {
      clearTimeout(timer);
      life.signal.removeEventListener('abort', abort);
      resolve(ok);
    };
    const abort = () => end(false);
    life.signal.addEventListener('abort', abort);
    node.addEventListener('error', () => end(false), { once: true });
    if (replay) {
      // The same video again (the promo is listed twice): rewind the element on screen instead of loading a new
      // one, so the cut from its last frame back to its first has no gap and the attract loop reads as seamless.
      replay.addEventListener('ended', () => end(true), { once: true });
      replay.currentTime = 0;
      replay.play().catch(() => end(false));
      return;
    }
    if (item.type === 'image') {
      node.addEventListener('load', () => { put(node, item); timer = setTimeout(() => end(true), item.seconds * 1000); }, { once: true });
    } else {
      node.muted = true;
      node.addEventListener('loadeddata', () => { put(node, item); node.play().catch(() => end(false)); }, { once: true });
      node.addEventListener('ended', () => end(true), { once: true });
    }
    node.src = item.src;
  });

  const wait = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    life.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  (async () => {
    while (!life.signal.aborted) {
      let played = 0;
      for (const item of await loadLoopItems()) {
        if (life.signal.aborted) return;
        if (await show(item)) played++;
      }
      if (!played && !life.signal.aborted) {
        clear();
        await wait(RETRY_MS);
      }
    }
  })();

  return {
    stop() {
      life.abort();
      sized.disconnect();
      layer.querySelector('video')?.pause();
    },
  };
}
