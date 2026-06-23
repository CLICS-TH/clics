'use client';
import { createContext, useContext, useSyncExternalStore } from 'react';
import { useIsNarrow, useIsNavNarrow, useIsTableNarrow } from '@/lib/client-store';

type View = 'auto' | 'mobile' | 'desktop';
const ViewportCtx = createContext<{
  view: View; setView: (v: View) => void; forcedMobile: boolean; forcedDesktop: boolean;
}>({ view: 'auto', setView: () => {}, forcedMobile: false, forcedDesktop: false });

// The persisted viewport preference (clics_view) as a tiny external store, read via
// useSyncExternalStore — start 'auto' on the server + first render (matches SSR), then the real
// value, with no mount effect. setView writes through and notifies same-tab subscribers.
let viewMem: View | undefined;
const viewListeners = new Set<() => void>();
function readView(): View {
  if (viewMem !== undefined) return viewMem;
  try {
    const v = localStorage.getItem('clics_view');
    viewMem = v === 'mobile' || v === 'desktop' ? v : 'auto';
  } catch {
    viewMem = 'auto';
  }
  return viewMem;
}
function writeView(v: View) {
  viewMem = v;
  try {
    if (v === 'auto') localStorage.removeItem('clics_view');
    else localStorage.setItem('clics_view', v);
  } catch {}
  viewListeners.forEach((l) => l());
}
function subscribeView(cb: () => void) {
  viewListeners.add(cb);
  return () => viewListeners.delete(cb);
}

export function ViewportProvider({ children }: { children: React.ReactNode }) {
  const view = useSyncExternalStore(subscribeView, readView, (): View => 'auto');
  return (
    <ViewportCtx.Provider value={{ view, setView: writeView, forcedMobile: view === 'mobile', forcedDesktop: view === 'desktop' }}>
      {children}
    </ViewportCtx.Provider>
  );
}

export const useViewport = () => useContext(ViewportCtx);

// Single source of truth for "render the mobile layout" — mirrors NavBar's logic so the manual
// ViewportToggle (which only shrinks the container, not the real viewport) still flips page bodies
// between table and stacked-card layouts. Returns false until mounted so SSR and first render match.
export function useIsMobile() {
  const { forcedMobile, forcedDesktop } = useViewport();
  const isNarrow = useIsNarrow();
  return forcedMobile || (!forcedDesktop && isNarrow);
}

// Like useIsMobile, but with the wider ~1535px nav threshold: the NavBar collapses its full bilingual
// row to the hamburger below this width (and in forced-mobile) so the labels can never wrap. Respects
// the forced desktop/mobile toggle exactly like useIsMobile.
export function useIsNavCompact() {
  const { forcedMobile, forcedDesktop } = useViewport();
  const navNarrow = useIsNavNarrow();
  return forcedMobile || (!forcedDesktop && navNarrow);
}

// Like useIsMobile but with the wider ≤1024px breakpoint, for the densest tables (the admin users
// list — 8 bilingual columns) whose card fallback must extend through iPad portrait/landscape, not
// just phones. Respects the forced desktop/mobile toggle exactly like useIsMobile.
export function useIsTableCompact() {
  const { forcedMobile, forcedDesktop } = useViewport();
  const tableNarrow = useIsTableNarrow();
  return forcedMobile || (!forcedDesktop && tableNarrow);
}
