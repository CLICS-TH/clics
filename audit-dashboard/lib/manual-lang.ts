// The manual's language choice, as an external store.
//
// It lives on `<html data-manual-lang>` — one DOM source of truth, exactly like the theme's `.dark`
// class — and is read through useSyncExternalStore rather than mirrored into component state in a
// mount effect. That is the house pattern (components/ThemeProvider.tsx) and the ESLint gate
// enforces it.
//
// It is a module of its own, not four functions inside the page, for two reasons: the same attribute
// and the same storage key drive the portal's copy of the manual (physician-ui/public/js/lang.js),
// so this is shared behaviour rather than page detail; and `serverSnapshot` is only ever reached
// during SSR, which a jsdom test cannot exercise — as a plain exported function it can simply be
// called.
import type { ManualLang } from './manual-types';

const LANG_KEY = 'clics_manual_lang';
const ATTR = 'data-manual-lang';

export function subscribeLang(onChange: () => void): () => void {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: [ATTR] });
  return () => obs.disconnect();
}

/** Thai unless the attribute explicitly says English — an absent or unknown value means Thai. */
export function langSnapshot(): ManualLang {
  return document.documentElement.getAttribute(ATTR) === 'en' ? 'en' : 'th';
}

/**
 * What the server renders.
 *
 * Must match the client's FIRST render or hydration mismatches — the server has no localStorage and
 * no attribute, so Thai is the only honest answer, and the pre-hydration script in app/layout.tsx is
 * what makes an English reader's first paint correct.
 */
export function serverLangSnapshot(): ManualLang {
  return 'th';
}

/**
 * Choose a language.
 *
 * Writes the attribute (which the subscriber picks up — no setState), mirrors it onto `lang` so font
 * fallback and screen-reader pronunciation follow, and persists the choice. A refused write is
 * swallowed: in private browsing, losing the preference is acceptable, losing the click is not.
 */
export function setLang(lang: ManualLang): void {
  const root = document.documentElement;
  if (lang === 'en') root.setAttribute(ATTR, 'en');
  else root.removeAttribute(ATTR);
  root.setAttribute('lang', lang === 'en' ? 'en' : 'th');
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* private mode: session-only is fine */ }
}
