'use client';
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import {
  DARK_MQ, NEXT_PREF, THEME_EVENT, THEME_KEY, applyTheme, readPref, setPref,
  type Theme, type ThemePref,
} from '@/lib/theme';

type Ctx = {
  /** The RESOLVED theme on screen (never 'system'). */
  theme: Theme;
  /** What the person chose: system (default), light or dark. */
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  /** Step System → Light → Dark → System. */
  cycle: () => void;
};
const ThemeCtx = createContext<Ctx>({ theme: 'light', pref: 'system', setPref: () => {}, cycle: () => {} });

// The DOM `.dark` class is the single source of truth for the resolved theme — the inline script in
// layout.tsx sets it before hydration (no FOUC). Subscribe to it via useSyncExternalStore instead of
// mirroring it into state in a mount effect; getServerSnapshot('light') keeps SSR + first render in sync.
function subscribeTheme(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => obs.disconnect();
}
function themeSnapshot(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

// The stored preference changes via setPref() (same tab: THEME_EVENT) or another tab ('storage').
function subscribePref(cb: () => void) {
  const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === THEME_KEY) cb(); };
  window.addEventListener(THEME_EVENT, cb);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(THEME_EVENT, cb);
    window.removeEventListener('storage', onStorage);
  };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribeTheme, themeSnapshot, (): Theme => 'light');
  const pref = useSyncExternalStore(subscribePref, readPref, (): ThemePref => 'system');

  // Follow the OS live while the preference is 'system', and re-apply when another tab changes it.
  // Touches only the DOM (the class + metas); the observers above turn that into a re-render, so
  // there is no setState here.
  useEffect(() => {
    const mq = typeof matchMedia === 'function' ? matchMedia(DARK_MQ) : null;
    const sync = () => { applyTheme(readPref()); };
    mq?.addEventListener('change', sync);
    window.addEventListener('storage', sync);
    sync(); // also corrects a class the boot script could not set (storage blocked on first paint)
    return () => {
      mq?.removeEventListener('change', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return (
    <ThemeCtx.Provider value={{ theme, pref, setPref, cycle: () => setPref(NEXT_PREF[pref]) }}>
      {children}
    </ThemeCtx.Provider>
  );
}

export const useTheme = () => useContext(ThemeCtx);
