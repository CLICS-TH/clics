'use client';
// Client-only state read the React-19 way: useSyncExternalStore instead of "mirror into useState in
// a mount effect" (which the react-hooks/set-state-in-effect lint rightly flags as a cascading
// render). getServerSnapshot makes SSR + first-client render agree, so no manual `mounted` gate and
// no hydration mismatch — React swaps to the live value after hydration.
import { useSyncExternalStore } from 'react';
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

// The desktop nav's full row (8 bilingual links + identity + role badge + 2 toggles + logout) needs
// ~1536px to fit on ONE line; below that the NavBar collapses to the hamburger (see useIsNavCompact)
// so the labels never wrap. Deliberately separate from the 767px table↔card breakpoint above.
const NAV_COMPACT_MQ = '(max-width: 1535px)';
function navCompactSubscribe(cb: () => void) {
  const mq = window.matchMedia(NAV_COMPACT_MQ);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
function navCompactSnapshot(): boolean {
  return window.matchMedia(NAV_COMPACT_MQ).matches;
}
/** True when the viewport is ≤1535px (too narrow for the full bilingual nav row). false on the server. */
export function useIsNavNarrow(): boolean {
  return useSyncExternalStore(navCompactSubscribe, navCompactSnapshot, () => false);
}
