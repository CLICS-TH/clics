'use client';
import { createContext, useContext, useEffect, useState } from 'react';

type View = 'auto' | 'mobile' | 'desktop';
const ViewportCtx = createContext<{
  view: View; setView: (v: View) => void; forcedMobile: boolean; forcedDesktop: boolean;
}>({ view: 'auto', setView: () => {}, forcedMobile: false, forcedDesktop: false });

export function ViewportProvider({ children }: { children: React.ReactNode }) {
  // Start 'auto' (matches SSR); read the persisted preference after mount.
  const [view, setViewState] = useState<View>('auto');

  useEffect(() => {
    try {
      const v = localStorage.getItem('clics_view');
      if (v === 'mobile' || v === 'desktop') setViewState(v);
    } catch {}
  }, []);

  function setView(v: View) {
    setViewState(v);
    try { v === 'auto' ? localStorage.removeItem('clics_view') : localStorage.setItem('clics_view', v); } catch {}
  }

  return (
    <ViewportCtx.Provider value={{ view, setView, forcedMobile: view === 'mobile', forcedDesktop: view === 'desktop' }}>
      {children}
    </ViewportCtx.Provider>
  );
}

export const useViewport = () => useContext(ViewportCtx);

// Single source of truth for "render the mobile layout" — mirrors NavBar's logic
// so the manual ViewportToggle (which only shrinks the container, not the real
// viewport) still flips page bodies between table and stacked-card layouts.
// Returns false until mounted so SSR and first client render match.
export function useIsMobile() {
  const { forcedMobile, forcedDesktop } = useViewport();
  const [isNarrow, setIsNarrow] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => setIsNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  if (!mounted) return false;
  return forcedMobile || (!forcedDesktop && isNarrow);
}
