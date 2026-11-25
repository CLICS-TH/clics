// The loop's ambient fill (owner, 2026-11-25): on a screen wider than the 9:16 column (a landscape screen, in full screen
// or not), the blank strips beside the column show a blurred, faded copy of what the loop is playing. The column itself is
// untouched. It runs on the loop only (booth-shell.js showLoop); a play's sides stay plain.
// The blur is drawn into a canvas a few dozen pixels wide and the browser scales it up, so the kiosk never blurs a
// full-screen layer.

const WIDE = 96;
const BLUR_PX = 8;
const FRAME_MS = 80;
const REDUCED_FRAME_MS = 1000;

/** Draws the whole of `media` stretched over `ctx`'s canvas, three blur radii past each edge, so the blur reads no
 *  empty pixel and the edges keep their colour. Stretched, not cropped: the fill carries the frame's colours, never a
 *  magnified piece of its text. */
function stretch(ctx, media) {
  const { width: cw, height: ch } = ctx.canvas;
  const m = 3 * BLUR_PX;
  ctx.drawImage(media, -m, -m, cw + 2 * m, ch + 2 * m);
}

/** Mounts the fill behind the column, fed from `stage`'s loop media. @param {{ stage: HTMLElement, column: HTMLElement }} ctx
 *  @returns {() => void} stops it and takes the canvas away */
export function mountAmbient({ stage, column }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'loop-ambient';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0;
  let last = -Infinity;

  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    if (now - last < (reduced.matches ? REDUCED_FRAME_MS : FRAME_MS)) return;
    last = now;
    const sides = innerWidth - column.getBoundingClientRect().width > 1;
    const media = stage.querySelector('.loop-media > video, .loop-media > img');
    const mw = media?.videoWidth ?? media?.naturalWidth ?? 0;
    const mh = media?.videoHeight ?? media?.naturalHeight ?? 0;
    const ready = media instanceof HTMLVideoElement ? media.readyState >= 2 : media?.complete;
    if (!sides || !ready || !mw || !mh) { canvas.hidden = true; return; }
    const tall = Math.max(1, Math.round(WIDE * innerHeight / innerWidth));
    if (canvas.width !== WIDE || canvas.height !== tall) { canvas.width = WIDE; canvas.height = tall; }
    ctx.filter = `blur(${BLUR_PX}px)`;
    stretch(ctx, media);
    canvas.hidden = false;
  };
  raf = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(raf); canvas.remove(); };
}
