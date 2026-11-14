'use client';
import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { ClicsLogo } from '@/components/ClicsLogo';
import { PORTAL } from '@/lib/portal';
import { clearSession } from '@/lib/auth';

// The Portal and this dashboard share one origin (Portal at /, dashboard at /audit), so the Portal's sign-in
// leaves the session in localStorage and sends admin/auditor/superadmin here. A visit without one goes to the
// Portal's sign-in. A ?token= in the URL (the old cross-origin handoff, or a stale link) is dropped unread: a
// session never travels in a URL.

interface ClicsUser { id: string; role: string; full_name_th: string; full_name_en: string; can_audit?: boolean; }

function readToken(): string | null {
  try { return localStorage.getItem('clics_token'); } catch { return null; }
}

function redirectByRole(user: Pick<ClicsUser, 'role' | 'can_audit'>, router: ReturnType<typeof useRouter>) {
  // Superadmin lands straight on the executive overview; admin/auditor land on the
  // role-aware /home, whose cards link into each workspace. A physician with
  // can_audit (dual-role "Special" user) enters straight at the auditor queue —
  // they arrive from the Portal's Auditor console link.
  // replace, not push: /login must not stay in history, or Back from the console lands here, finds the
  // shared session and forwards again, so Back never reaches the Portal.
  if (user.role === 'superadmin') router.replace('/admin/overview');
  else if (user.role === 'analyst') router.replace('/analyst');
  else if (user.role === 'ethics') router.replace('/ethics');
  else if (user.role === 'auditor' || user.role === 'admin') router.replace('/home');
  else if (user.role === 'physician' && user.can_audit) router.replace('/auditor/queue');
  else {
    // A physician without can_audit has no dashboard home: back to the Portal, which sends them to
    // /dashboard. The session is the Portal's too, so it is kept.
    window.location.replace(PORTAL.dashboard);
  }
}

function LoginGate() {
  const router = useRouter();
  const params = useSearchParams();
  // Read once at mount: stripping the query below re-syncs useSearchParams, and re-running the effect on
  // that would sign the user in a second time.
  const [loggingOut] = useState(() => params.get('logout') === '1');
  const [hadUrlToken] = useState(() => params.has('token'));
  const [token] = useState(() => (loggingOut ? null : readToken()));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (hadUrlToken) {
      // Off the URL and out of history, so Back after Sign out cannot bring it back (#182).
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
    if (loggingOut) {
      clearSession();
      window.location.replace(PORTAL.login);
    } else if (token) {
      // apiFetch only special-cases 401: a 403 (account pending/deactivated) resolves with the JSON error
      // body ({ error, code }), NOT { user }. Validate the shape, and drop the session on any failure so
      // the Portal's forward does not send the user straight back here.
      apiFetch<{ user?: ClicsUser; error?: string }>('/auth/me')
        .then(res => {
          if (res?.user?.role) {
            localStorage.setItem('clics_user', JSON.stringify(res.user));
            // If the user was bounced by a mid-session expiry, return them to that exact page (set by
            // lib/api.ts, without the base path). Only honor a same-origin path, never /login.
            let next: string | null = null;
            try { next = sessionStorage.getItem('clics_reauth_next'); sessionStorage.removeItem('clics_reauth_next'); } catch {}
            if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login')) router.replace(next);
            else redirectByRole(res.user, router);
          } else {
            localStorage.removeItem('clics_token');
            localStorage.removeItem('clics_user');
            setError(typeof res?.error === 'string' ? res.error : 'เข้าสู่ระบบไม่สำเร็จ / Sign-in failed.');
          }
        })
        .catch(() => {
          setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ / Could not reach the server.');
        });
    } else {
      window.location.replace(PORTAL.login);
    }
  }, [token, loggingOut, hadUrlToken, router]);

  const hasToken = !!token;
  return (
    <div className="flex items-center justify-center min-h-dvh bg-background p-6">
      <div className="w-full max-w-sm space-y-2 p-8 bg-card rounded-xl shadow border border-border text-center animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-link">Audit Dashboard</p>
        {/* The ECG pulse loops while the token is validating; it rests once an error stops the sign-in. */}
        <h1 className="mt-2 flex justify-center">
          <ClicsLogo size={30} animated={error ? 'none' : hasToken ? 'loading' : 'once'} />
          <span className="sr-only">CLICS</span>
        </h1>
        {error ? (
          <>
            <p className="mt-1 text-sm text-danger">{error}</p>
            <a href={PORTAL.login} className="mt-3 inline-block text-sm text-link underline underline-offset-4">
              กลับไปหน้าเข้าสู่ระบบ / Back to the sign-in portal
            </a>
          </>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {hasToken ? 'กำลังเข้าสู่ระบบ… / Signing you in…' : 'กำลังนำไปยังหน้าเข้าสู่ระบบ… / Redirecting to sign-in…'}
          </p>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense><LoginGate /></Suspense>;
}
