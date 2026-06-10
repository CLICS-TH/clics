'use client';
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { getSupabaseBrowser, isSupabaseConfigured } from '@/lib/supabase-browser';
import { Eye, EyeOff } from 'lucide-react';

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

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const oauthEnabled = isSupabaseConfigured();

  useEffect(() => {
    const token = params.get('token');
    if (token) {
      localStorage.setItem('clics_token', token);
      apiFetch<{ user: ClicsUser }>('/auth/me').then(({ user }) => {
        localStorage.setItem('clics_user', JSON.stringify(user));
        redirectByRole(user, router);
      });
    }
  }, [params, router]);

  // Finish a Google sign-in after Supabase redirects back here with a session in
  // the URL hash. The browser client (detectSessionInUrl:true) parses it; we hand
  // the access_token to the backend, which validates it and returns our CLICS user.
  useEffect(() => {
    if (!oauthEnabled) return;
    let cancelled = false;
    const sb = (() => { try { return getSupabaseBrowser(); } catch { return null; } })();
    if (!sb) return;

    async function complete(accessToken: string) {
      // The backend ignores council_id for an existing professional, but its schema
      // still requires a UUID — pass the first known council to satisfy validation.
      const councils = await apiFetch<{ id: string }[]>('/auth/councils').catch(() => []);
      const council_id = councils?.[0]?.id;
      const res: any = await apiFetch('/auth/oauth/google/complete', {
        method: 'POST', body: JSON.stringify({ access_token: accessToken, council_id }),
      });
      if (cancelled) return;
      if (res?.access_token) {
        localStorage.setItem('clics_token', res.access_token);
        localStorage.setItem('clics_user', JSON.stringify(res.user));
        await sb!.auth.signOut().catch(() => {});
        redirectByRole(res.user, router);
      } else {
        setError(typeof res?.error === 'string' ? res.error : 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ / Google sign-in failed.');
      }
    }

    sb.auth.getSession().then(({ data }) => {
      if (!cancelled && data?.session?.access_token) complete(data.session.access_token);
    });
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session?.access_token) complete(session.access_token);
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthEnabled, router]);

  async function handleLogin() {
    setError(''); setLoading(true);
    const data: any = await apiFetch('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    setLoading(false);
    if (data?.access_token) {
      localStorage.setItem('clics_token', data.access_token);
      localStorage.setItem('clics_user', JSON.stringify(data.user));
      redirectByRole(data.user, router);
    } else {
      setError(data?.error ?? 'เข้าสู่ระบบไม่สำเร็จ');
    }
  }

  async function handleGoogle() {
    setError(''); setGoogleBusy(true);
    try {
      const sb = getSupabaseBrowser();
      const redirectTo = `${window.location.origin}/login`;
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
      if (error) { setError(error.message); setGoogleBusy(false); }
      // On success the browser navigates away to Google; no further code runs here.
    } catch (e: any) {
      setError(e?.message ?? 'ไม่สามารถเริ่ม Google ได้ / Could not start Google sign-in.');
      setGoogleBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-6">
      <div className="w-full max-w-sm space-y-5 p-8 bg-card rounded-xl shadow border border-border animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-primary">Audit Dashboard</p>
          <h1 className="mt-2 text-3xl font-semibold text-primary font-heading tracking-tight">CLICS</h1>
          <p className="mt-1 text-sm text-muted-foreground">Admin · Superadmin · Auditor</p>
        </div>
        <input className="w-full border rounded-lg px-3 py-2 text-sm" type="email"
          placeholder="อีเมล / Email" value={email} onChange={e => setEmail(e.target.value)} />
        <div className="relative">
          <input className="w-full border rounded-lg px-3 py-2 pr-10 text-sm" type={showPw ? 'text' : 'password'}
            placeholder="รหัสผ่าน / Password" value={password} onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()} />
          <button type="button" onClick={() => setShowPw(s => !s)}
            aria-label={showPw ? 'ซ่อนรหัสผ่าน / Hide password' : 'แสดงรหัสผ่าน / Show password'}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground">
            {showPw ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
          </button>
        </div>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <Button className="w-full" onClick={handleLogin} disabled={loading}>
          {loading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ / Login'}
        </Button>

        {oauthEnabled && (
          <>
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">หรือ / or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button variant="outline" className="w-full" onClick={handleGoogle} disabled={googleBusy}>
              {googleBusy ? 'กำลังเปิด Google…' : 'เข้าสู่ระบบด้วย Google / Sign in with Google'}
            </Button>
          </>
        )}

        <p className="text-center">
          <Link href="/forgot" className="text-sm text-primary underline-offset-4 hover:underline">
            ลืมรหัสผ่าน? / Forgot password?
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
