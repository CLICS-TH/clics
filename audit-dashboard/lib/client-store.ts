'use client';
// Client-only state read the React-19 way: useSyncExternalStore instead of "mirror into useState in
// a mount effect" (which the react-hooks/set-state-in-effect lint rightly flags as a cascading
// render). getServerSnapshot makes SSR + first-client render agree, so no manual `mounted` gate and
// no hydration mismatch — React swaps to the live value after hydration.
import { useCallback, useSyncExternalStore } from 'react';
import { getUser, type ClicsUser } from '@/lib/auth';

// --- auth (clics_user in localStorage) ---------------------------------------
// getUser() re-parses localStorage into a NEW object each call; useSyncExternalStore requires a
// STABLE snapshot reference when the value is unchanged, so cache by the raw string.
let authRaw: string | null = null;
let authVal: ClicsUser | null = null;
function authSnapshot(): ClicsUser | null {
  const raw = typeof window === 'undefined' ? null : localStorage.getItem('clics_user');
  if (raw === authRaw) return authVal;
  authRaw = raw;
  authVal = getUser();
  return authVal;
}
function authSubscribe(cb: () => void) {
  // Auth only changes across tabs (login/logout); same-tab logout navigates away. 'storage' covers it.
  window.addEventListener('storage', cb);
  return () => window.removeEventListener('storage', cb);
}
/** The signed-in user, or null on the server / first render / when logged out. */
export function useAuthUser(): ClicsUser | null {
  return useSyncExternalStore(authSubscribe, authSnapshot, () => null);
}

// --- viewport media query ----------------------------------------------------
const NARROW_MQ = '(max-width: 767px)';
function narrowSubscribe(cb: () => void) {
  const mq = window.matchMedia(NARROW_MQ);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
function narrowSnapshot(): boolean {
  return window.matchMedia(NARROW_MQ).matches;
}
/** True when the real viewport is ≤767px. false on the server / first render. */
export function useIsNarrow(): boolean {
  return useSyncExternalStore(narrowSubscribe, narrowSnapshot, () => false);
}

// The admin users list is the densest table (8 bilingual columns); its card fallback must extend up
// through iPad portrait/landscape (768/812/1024), not just phones — otherwise tablets side-scroll it.
// Deliberately separate from the 767px breakpoint above (which still governs every other table↔card).
const TABLE_NARROW_MQ = '(max-width: 1024px)';
function tableNarrowSubscribe(cb: () => void) {
  const mq = window.matchMedia(TABLE_NARROW_MQ);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
function tableNarrowSnapshot(): boolean {
  return window.matchMedia(TABLE_NARROW_MQ).matches;
}
/** True when the viewport is ≤1024px (the densest tables should use the card fallback). false on the server. */
export function useIsTableNarrow(): boolean {
  return useSyncExternalStore(tableNarrowSubscribe, tableNarrowSnapshot, () => false);
}

/*
 * How wide the desktop nav row must be before it may render inline.
 *
 * THIS USED TO BE A CONSTANT AND THAT IS EXACTLY HOW IT BROKE. The old value was
 * `(max-width: 1535px)`, with a comment reading "8 bilingual links + identity + role badge + 2
 * toggles + logout needs ~1536px". That was true when it was written. The roster then grew to 9
 * links for admin and 14 for superadmin, and nothing re-derived the number — so above 1535px both
 * roles rendered a row far wider than the viewport, pushing the identity cluster off-screen and
 * scrolling the whole page sideways on every monitor anybody actually owns. A fixed threshold
 * cannot survive a roster that grows, so the threshold is now DERIVED from the link count.
 *
 * MEASURED, not estimated: `node scripts/responsive/nav-width-audit.mjs --calibrate` against the
 * built app forces each persona's row inline and finds the narrowest viewport from which it FITS at
 * every wider width — fits meaning no control wraps and nothing overflows the row or the page:
 *
 *     ethics 1 → 900    analyst 1 → 855    auditor 2 → 945    dual-role 3 → 1327
 *     admin 9 → 2348    superadmin 14 → 3265
 *
 * 757 is the smallest chrome that clears every one of those at 190 per link, and the dual-role row
 * is the one that sets it. Rounded toward caution because the two errors are not symmetric: too
 * cautious costs a hamburger, too eager costs a wrapped Thai label or a sideways-scrolling page.
 *
 * WHY THE DUAL-ROLE ROW NEEDS 1327 AND NOT ~1195. It fits from about 1195 on the 100% root, then
 * stops fitting at 1280, where the root steps to 118% and every rem in the row grows; it fits again
 * from 1327. A threshold must hold for EVERY wider width, so the row's need is the end of the last
 * band that does not fit. The calibration searches each breakpoint band separately for this reason.
 *
 * THE OLD CONSTANTS WERE TOO EAGER, AND THE MEASUREMENT COULD NOT SEE IT. Chrome 620 was fitted on
 * overflow alone, but the toggles, Return to Physician and Logout had no whitespace-nowrap: squeezed,
 * they WRAPPED ("ออกจาก/ระบบ Logout") rather than overflowing, which the old check never saw.
 * Master wrapped them on the ethics row at 810–893 and the dual-role row at 1000–1149. Those
 * controls are nowrap now (a squeeze becomes overflow) and "fits" also requires no wrap.
 *
 * Counting matters here and got it wrong once already — the first fit of these constants counted
 * `nav a[href^="/"]`, which includes the wordmark's link to /home, so every count was one too high
 * and the model came out ~100px under. `linkCount` is the ROSTER length; the wordmark is chrome.
 * The dual-role physician's Return to Physician control is a full bilingual control in the same row,
 * so NavBar counts it as one more link.
 */
export const NAV_CHROME_PX = 757;
export const NAV_PER_LINK_PX = 190;
/** The narrowest viewport that fits `n` bilingual links on one line. */
export const navRowWidthPx = (n: number) => NAV_CHROME_PX + n * NAV_PER_LINK_PX;

// One matchMedia list per required width, cached so useSyncExternalStore sees a stable subscribe
// for a stable link count and does not resubscribe on every render.
const navMqCache = new Map<number, MediaQueryList>();
function navMq(requiredPx: number): MediaQueryList {
  let mq = navMqCache.get(requiredPx);
  if (!mq) { mq = window.matchMedia(`(max-width: ${requiredPx - 1}px)`); navMqCache.set(requiredPx, mq); }
  return mq;
}

/**
 * True when the viewport is too narrow for a nav row of `linkCount` bilingual links — i.e. the
 * NavBar must collapse to the hamburger so the labels never wrap. false on the server.
 */
export function useIsNavNarrow(linkCount: number): boolean {
  const requiredPx = navRowWidthPx(linkCount);
  const subscribe = useCallback((cb: () => void) => {
    const mq = navMq(requiredPx);
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  }, [requiredPx]);
  const snapshot = useCallback(() => navMq(requiredPx).matches, [requiredPx]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
