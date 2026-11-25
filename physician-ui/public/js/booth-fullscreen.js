// Full screen for the kiosk (owner, 2026-11-25): CCME's mark is the switch. A tap on it goes full screen; in full screen a
// tap on it leaves. The shell starts over in the page while full screen (booth-shell.js startOver), so it holds from one
// visitor to the next.

export const FULLSCREEN_COPY = {
  enter: { th: 'เต็มจอ', en: 'Full screen' },
  exit: { th: 'ออกจากเต็มจอ', en: 'Exit full screen' },
};

export const isFullscreen = () => Boolean(document.fullscreenElement);

/** Chrome's --kiosk (scripts/booth/kiosk/booth-kiosk.sh) already fills the screen without the Fullscreen API, and its
 *  resets reload as a windowed kiosk's do: there the mark stays inert, or a passer-by's tap would switch the kiosk to
 *  in-page resets. */
const fillsScreen = () => matchMedia('(display-mode: fullscreen)').matches || (innerWidth >= screen.width && innerHeight >= screen.height);

/** Makes `brand` (booth-look.js mountBrand, a disabled button) the full-screen switch. Leaves it disabled where the page
 *  cannot go full screen. @param {{ brand: HTMLButtonElement }} ctx */
export function mountFullscreen({ brand }) {
  if (!document.fullscreenEnabled) return;
  const place = () => {
    const full = isFullscreen();
    const pair = full ? FULLSCREEN_COPY.exit : FULLSCREEN_COPY.enter;
    brand.disabled = !full && fillsScreen();
    brand.setAttribute('aria-label', brand.disabled ? 'CCME' : `CCME: ${pair.th} ${pair.en}`);
  };
  brand.addEventListener('click', () => {
    if (isFullscreen()) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  });
  document.addEventListener('fullscreenchange', place);
  addEventListener('resize', place);
  place();
}
