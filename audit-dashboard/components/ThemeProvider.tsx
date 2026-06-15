'use client';
import { createContext, useContext, useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';
const ThemeCtx = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'light', toggle: () => {} });

// The DOM `.dark` class is the single source of truth — the inline script in layout.tsx sets it
// before hydration (no FOUC). Subscribe to it via useSyncExternalStore instead of mirroring it into
// state in a mount effect; getServerSnapshot('light') keeps SSR + first render in sync.
function subscribe(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => obs.disconnect();
}
function snapshot(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribe, snapshot, (): Theme => 'light');

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    try { localStorage.setItem('clics_theme', next); } catch {}
    // No setState — the MutationObserver re-reads the class and `theme` updates.
  }

  return <ThemeCtx.Provider value={{ theme, toggle }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
