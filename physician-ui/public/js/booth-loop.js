// The attract loop (#213): the files listed in /booth-loop/manifest.json, played in order, forever.
// Staff add CCME files by dropping them in public/booth-loop/ and listing them in the manifest (README).
import { el } from './booth-dom.js';

const LOOP_DIR = '/booth-loop/';
const MANIFEST = `${LOOP_DIR}manifest.json`;
const RETRY_MS = 60_000;

/**
 * `board: false` hides the loop board while that item shows, for a file whose own text reaches the bottom of the
 * frame (the promo's demo labels and end card, #216).
 * @typedef {({ type: 'image', src: string, seconds: number } | { type: 'video', src: string }) & { board: boolean }} LoopItem
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

/** @returns {LoopItem | null} */
function parseItem(item) {
  const src = loopPath(item?.src);
  if (src && item.type === 'image' && Number.isInteger(item.seconds) && item.seconds >= 1 && item.seconds <= 120) {
    return { type: 'image', src, seconds: item.seconds, board: item.board !== false };
  }
  if (src && item.type === 'video' && src.endsWith('.mp4')) return { type: 'video', src, board: item.board !== false };
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
 * data-loop-board says whether the loop board may show over it.
 * @param {HTMLElement} container
 * @returns {{ stop: () => void }}
 */
export function mountLoop(container) {
  const layer = el('div', { class: 'loop-media', 'aria-hidden': 'true' });
  container.append(layer);
  const life = new AbortController();

  const put = (node, item) => {
    layer.replaceChildren(node);
    layer.dataset.loopKind = item.type;
    layer.dataset.loopSrc = item.src;
    layer.dataset.loopBoard = item.board ? 'on' : 'off';
  };
  const clear = () => {
    layer.replaceChildren();
    delete layer.dataset.loopKind;
    delete layer.dataset.loopSrc;
    delete layer.dataset.loopBoard;
  };

  /** Resolves true once the item has played through, false if it failed to load or play, or the loop stopped. */
  const show = (item) => new Promise((resolve) => {
    let timer = 0;
    const node = item.type === 'image'
      ? el('img', { alt: '', decoding: 'async' })
      : el('video', { muted: '', playsinline: '', autoplay: '', preload: 'auto' });
    const end = (ok) => {
      clearTimeout(timer);
      life.signal.removeEventListener('abort', abort);
      resolve(ok);
    };
    const abort = () => end(false);
    life.signal.addEventListener('abort', abort);
    node.addEventListener('error', () => end(false), { once: true });
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
      layer.querySelector('video')?.pause();
    },
  };
}
