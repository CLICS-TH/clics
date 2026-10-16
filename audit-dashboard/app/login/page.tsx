'use client';
import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { ClicsLogo } from '@/components/ClicsLogo';

// The physician-ui app is THE login portal for every role; its login screen hands
// admin/auditor/superadmin sessions to this dashboard via /login?token=<jwt>.
// Without a token, this page only forwards the visitor to that portal.
const PORTAL_URL = process.env.NEXT_PUBLIC_PORTAL_URL || 'https://physician-ui.vercel.app';

interface ClicsUser { id: string; role: string; full_name_th: string; full_name_en: string; can_audit?: boolean; }

function redirectByRole(user: Pick<ClicsUser, 'role' | 'can_audit'>, router: ReturnType<typeof useRouter>) {
  // Superadmin lands straight on the executive overview; admin/auditor land on the
  // role-aware /home, whose cards link into each workspace. A physician with
  // can_audit (dual-role "Special" user) enters straight at the auditor queue —
  // this is the token-handoff entry point from the physician app.
  if (user.role === 'superadmin') router.push('/admin/overview');
  else if (user.role === 'analyst') router.push('/analyst');
  else if (user.role === 'ethics') router.push('/ethics');
  else if (user.role === 'auditor' || user.role === 'admin') router.push('/home');
  else if (user.role === 'physician' && user.can_audit) router.push('/auditor/queue');
  else router.push('/login');
}

function LoginGate() {
  const router = useRouter();
  const params = useSearchParams();
  const hasToken = !!params.get('token');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    if (token) {
      localStorage.setItem('clics_token', token);
      // apiFetch only special-cases 401 — a 403 (account pending/deactivated) resolves with
      // the JSON error body ({ error, code }), NOT { user }. Validate the shape before
      // storing, and clear the bad token on any failure so the next visit re-enters the portal.
      apiFetch<{ user?: ClicsUser; error?: string }>('/auth/me')
        .then(res => {
          if (res?.user?.role) {
            localStorage.setItem('clics_user', JSON.stringify(res.user));
            // If the user was bounced here by a mid-session expiry, return them to that exact page
            // (set by lib/api.ts before the redirect). Only honor a same-origin path, never /login.
            let next: string | null = null;
            try { next = sessionStorage.getItem('clics_reauth_next'); sessionStorage.removeItem('clics_reauth_next'); } catch {}
            if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login')) router.push(next);
            else redirectByRole(res.user, router);
          } else {
            localStorage.removeItem('clics_token');
            setError(typeof res?.error === 'string' ? res.error : 'เข้าสู่ระบบไม่สำเร็จ / Sign-in failed.');
          }
        })
        .catch(() => {
          localStorage.removeItem('clics_token');
          setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ / Could not reach the server.');
        });
    } else {
      // No handoff token — send the visitor to the single sign-in portal.
      window.location.replace(PORTAL_URL);
    }
  }, [params, router]);

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
            <a href={PORTAL_URL} className="mt-3 inline-block text-sm text-link underline underline-offset-4">
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
