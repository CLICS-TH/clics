// Full screen for the kiosk (owner, 2026-11-25). Staff start it from a pill beside CCME's mark, shown on the loop while the
// page is not full screen. Visitors get no way out: Exit shows only after a tap on the mark (top left) and then, within
// ARM_MS, a tap on the look control (top right). That second tap only reveals Exit; it does not change the look.
import { el, bi } from './booth-dom.js';

const ARM_MS = 3_000;
const EXIT_SHOWN_MS = 6_000;

export const FULLSCREEN_COPY = {
  enter: { th: 'เต็มจอ', en: 'Full screen' },
  exit: { th: 'ออกจากเต็มจอ', en: 'Exit full screen' },
};

/** Chrome's --kiosk (scripts/booth/kiosk/booth-kiosk.sh) already fills the screen without the Fullscreen API, and its
 *  resets reload as a windowed kiosk's do: no pill there, or a passer-by's tap would switch the kiosk to in-page resets. */
const fillsScreen = () => matchMedia('(display-mode: fullscreen)').matches || (innerWidth >= screen.width && innerHeight >= screen.height);

const icon = (name) => el('span', { class: 'booth-icon', 'aria-hidden': 'true', dataset: { icon: name } });
export const isFullscreen = () => Boolean(document.fullscreenElement);

/** Mounts the enter pill and the hidden exit after `brand`, on `host`. Does nothing where the page cannot go full screen.
 *  @param {{ host: HTMLElement, brand: HTMLElement, look: HTMLElement }} ctx */
export function mountFullscreen({ host, brand, look }) {
  if (!document.fullscreenEnabled) return;
  const pill = (cls, action, pair) => el('button', { type: 'button', class: `fs-btn ${cls}`, 'aria-label': `${pair.th} ${pair.en}`,
    dataset: { action } }, icon(action === 'fullscreen' ? 'maximize' : 'minimize'), bi(pair, 'fs-label'));
  const enter = pill('fs-enter', 'fullscreen', FULLSCREEN_COPY.enter);
  const exit = pill('fs-exit', 'exit-fullscreen', FULLSCREEN_COPY.exit);
  exit.hidden = true;

  let armedUntil = 0;
  let hideExit = 0;
  const closeExit = () => { clearTimeout(hideExit); exit.hidden = true; };

  enter.addEventListener('click', () => { document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); });
  exit.addEventListener('click', () => { closeExit(); document.exitFullscreen().catch(() => {}); });
  // The mark takes taps only while full screen (booth-shell.css); a tap on it reaches nothing under it.
  brand.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isFullscreen()) armedUntil = performance.now() + ARM_MS;
  });
  // Capture phase, so the arming tap on the look control is swallowed before its buttons see it.
  look.addEventListener('click', (e) => {
    if (!isFullscreen() || performance.now() > armedUntil) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    armedUntil = 0;
    exit.hidden = false;
    clearTimeout(hideExit);
    hideExit = setTimeout(closeExit, EXIT_SHOWN_MS);
  }, true);
  const place = () => { enter.hidden = !isFullscreen() && fillsScreen(); };
  document.addEventListener('fullscreenchange', () => { armedUntil = 0; closeExit(); place(); });
  addEventListener('resize', place);
  place();

  host.append(enter, exit);
  window.hydrateIcons?.(enter);
  window.hydrateIcons?.(exit);
}
