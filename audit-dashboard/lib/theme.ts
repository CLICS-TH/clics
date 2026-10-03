// Theme preference: System | Light | Dark.
//
// `clics_theme` already stores 'light' | 'dark' for people who chose one; those values stay valid.
// A missing (or unrecognised) value now means SYSTEM — follow the OS and keep following it live —
// instead of "whatever the OS said on first load, frozen".
//
// The DOM `.dark` class stays the single source of truth for the RESOLVED theme (the inline boot
// script in app/layout.tsx sets it before first paint, so there is no flash). applyTheme() is the one
// place that writes it, and the one place that keeps <meta name="theme-color"> in step.
export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'clics_theme';
export const THEME_EVENT = 'clics-theme-pref';
export const DARK_MQ = '(prefers-color-scheme: dark)';
// Mirror of --background in app/globals.css (:root / .dark) — what the browser chrome should match.
export const THEME_COLOR: Record<Theme, string> = { light: '#faf9f5', dark: '#181715' };

// The no-flash boot snippet, inlined in <head> by app/layout.tsx and run BEFORE first paint. Kept here
// (not in the layout) so a test can execute the real string. Same rule as resolveTheme(): an explicit
// 'light' | 'dark' wins; anything else means follow the OS.
export const THEME_BOOT =
  "var t=localStorage.getItem('clics_theme');" +
  "var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);" +
  "if(d)document.documentElement.classList.add('dark');";

export function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function systemIsDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(DARK_MQ).matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: ThemePref, sysDark: boolean): Theme {
  return pref === 'dark' || (pref === 'system' && sysDark) ? 'dark' : 'light';
}

/** Write the resolved theme onto <html> and sync the theme-color metas. */
export function applyTheme(pref: ThemePref): Theme {
  const theme = resolveTheme(pref, systemIsDark());
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  // Next renders viewport.themeColor as a media pair. Under "system" each keeps its own media
  // colour; under a manual override both are pinned to the chosen theme, because the OS media query
  // no longer says which one the page is actually showing.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const forDark = (m.getAttribute('media') ?? '').includes('dark');
    m.content = THEME_COLOR[pref === 'system' ? (forDark ? 'dark' : 'light') : theme];
  });
  return theme;
}

/** Persist the preference ('system' clears the key) and apply it. */
export function setPref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch { /* storage blocked: the choice still applies for this page view */ }
  applyTheme(pref);
  window.dispatchEvent(new Event(THEME_EVENT));
}

export const NEXT_PREF: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
