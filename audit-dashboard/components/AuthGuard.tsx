'use client';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

// Pages a visitor without a session may see. Everything else needs a clics_token.
const PUBLIC_PATHS = ['/login', '/forgot', '/reset', '/manual'];

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'));
}

function readToken() {
  try { return localStorage.getItem('clics_token'); } catch { return null; }
}

// Sends a signed-out visitor on a private page to /login, which forwards to the Portal. Runs on
// mount and again on a back/forward-cache restore, which re-runs no effects: without it, Back after
// Sign out shows a private page whose data never loads. A restore under a different token means
// another user signed in on this tab, so the page reloads under them.
export function AuthGuard() {
  const pathname = usePathname();
  // Refreshed on every navigation, not only on mount: /login stores the handoff token and then
  // router.pushes within this same document.
  const renderedToken = useRef<string | null>(null);
  useEffect(() => {
    renderedToken.current = readToken();
    if (!isPublicPath(pathname) && !renderedToken.current) window.location.replace('/login');
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted || isPublicPath(pathname)) return;
      const token = readToken();
      if (!token) window.location.replace('/login');
      else if (token !== renderedToken.current) window.location.reload();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [pathname]);
  return null;
}
