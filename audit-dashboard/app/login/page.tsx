'use client';
import { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/api';

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
  else if (user.role === 'auditor' || user.role === 'admin') router.push('/home');
  else if (user.role === 'physician' && user.can_audit) router.push('/auditor/queue');
  else router.push('/login');
}

function LoginGate() {
  const router = useRouter();
  const params = useSearchParams();
  const hasToken = !!params.get('token');

  useEffect(() => {
    const token = params.get('token');
    if (token) {
      localStorage.setItem('clics_token', token);
      apiFetch<{ user: ClicsUser }>('/auth/me').then(({ user }) => {
        localStorage.setItem('clics_user', JSON.stringify(user));
        redirectByRole(user, router);
      });
    } else {
      // No handoff token — send the visitor to the single sign-in portal.
      window.location.replace(PORTAL_URL);
    }
  }, [params, router]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-6">
      <div className="w-full max-w-sm space-y-2 p-8 bg-card rounded-xl shadow border border-border text-center animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-primary">Audit Dashboard</p>
        <h1 className="mt-2 text-3xl font-semibold text-primary font-heading tracking-tight">CLICS</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {hasToken ? 'กำลังเข้าสู่ระบบ… / Signing you in…' : 'กำลังนำไปยังหน้าเข้าสู่ระบบ… / Redirecting to sign-in…'}
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense><LoginGate /></Suspense>;
}
