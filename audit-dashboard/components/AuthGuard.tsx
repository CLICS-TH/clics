'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

// Pages a visitor without a session may see. Everything else needs a clics_token.
const PUBLIC_PATHS = ['/login', '/forgot', '/reset', '/manual'];

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'));
}

function hasToken() {
  try { return !!localStorage.getItem('clics_token'); } catch { return false; }
}

// Sends a signed-out visitor on a private page to /login, which forwards to the Portal. Runs on
// mount and again on a back/forward-cache restore, which re-runs no effects: without it, Back after
// Sign out shows a private page whose data never loads.
export function AuthGuard() {
  const pathname = usePathname();
  useEffect(() => {
    const check = () => {
      if (!isPublicPath(pathname) && !hasToken()) window.location.replace('/login');
    };
    check();
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) check(); };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [pathname]);
  return null;
}
