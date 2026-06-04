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
