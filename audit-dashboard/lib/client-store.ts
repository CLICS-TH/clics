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
 * The two constants below were measured against the built app (Playwright, both label languages
 * rendered, the widest identity block), by binary-searching the narrowest viewport at which
 * `nav > div` reports no overflow:
 *
 *     2 links → fits at ≤1536px      8 links → 2060px      13 links → 2976px
 *
 * which is 183px per link over 594px of fixed chrome (the CLICS wordmark, the identity block, the
 * role badge, both toggles and logout). Rounded UP in both terms, because Thai label widths vary
 * per item and the two errors are not symmetric: too cautious costs a hamburger, too eager costs a
 * sideways-scrolling page.
 *
 * Counting matters here and got it wrong once already — the first fit of these constants counted
 * `nav a[href^="/"]`, which includes the wordmark's link to /home, so every count was one too high
 * and the model came out ~100px under. `linkCount` is the ROSTER length; the wordmark is chrome.
 */
export const NAV_CHROME_PX = 620;
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
