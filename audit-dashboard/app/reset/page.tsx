'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { getSupabaseBrowser, isSupabaseConfigured } from '@/lib/supabase-browser';
import { Eye, EyeOff } from 'lucide-react';

type Phase = 'loading' | 'form' | 'invalid' | 'success';
const PW_OK = (p: string) => p.length >= 10 && /[A-Za-z]/.test(p) && /[0-9]/.test(p);
const NOT_CONFIGURED = 'การตั้งรหัสผ่านยังไม่ถูกตั้งค่าในระบบนี้ / Password reset is not configured for this deployment.';

export default function ResetPage() {
  // Whether Supabase is configured is known at render time (build-inlined env, identical on server +
  // client), so derive the initial phase from it via a lazy initializer instead of setting state in
  // the mount effect (react-hooks/set-state-in-effect).
  const [phase, setPhase] = useState<Phase>(() => (isSupabaseConfigured() ? 'loading' : 'invalid'));
  const [invalidMsg, setInvalidMsg] = useState(() => (isSupabaseConfigured() ? '' : NOT_CONFIGURED));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // The recovery link from Supabase lands here with a recovery token in the URL hash.
  // The browser client (detectSessionInUrl:true) parses it and emits PASSWORD_RECOVERY /
  // SIGNED_IN. Once a recovery session exists we show the form; otherwise the link is bad.
  useEffect(() => {
    if (!isSupabaseConfigured()) return; // initial state is already 'invalid'
    let resolved = false;
    const sb = (() => { try { return getSupabaseBrowser(); } catch { return null; } })();
    const ready = () => { if (!resolved) { resolved = true; setPhase('form'); } };

    const sub = sb?.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') ready();
    });
    sb?.auth.getSession().then(({ data }) => { if (data?.session) ready(); });

    // Resolve to 'invalid' asynchronously (never a synchronous setState in the effect): immediately if
    // the client couldn't be constructed, otherwise after the recovery session fails to arrive in time.
    const t = setTimeout(() => {
      if (!resolved) {
        setInvalidMsg(sb
          ? 'ลิงก์ไม่ถูกต้องหรือหมดอายุ กรุณาขอลิงก์ใหม่ / This reset link is invalid or expired. Please request a new one.'
          : NOT_CONFIGURED);
        setPhase('invalid');
      }
    }, sb ? 1500 : 0);

    return () => { clearTimeout(t); sub?.data.subscription.unsubscribe(); };
  }, []);

  async function save() {
    setError('');
    if (!PW_OK(password)) {
      setError('รหัสผ่านต้องยาว ≥ 10 ตัว และมีทั้งตัวอักษรและตัวเลข / Password must be 10+ chars with a letter and a digit.');
      return;
    }
    if (password !== confirm) { setError('รหัสผ่านไม่ตรงกัน / Passwords do not match.'); return; }
    setBusy(true);
    const sb = getSupabaseBrowser();
    const { error } = await sb.auth.updateUser({ password });
    setBusy(false);
    if (error) { setError(error.message || 'ไม่สามารถบันทึกได้ กรุณาลองใหม่ / Could not save. Please try again.'); return; }
    // Don't leave a half-authenticated recovery session lying around.
    await sb.auth.signOut().catch(() => {});
    setPhase('success');
  }

  return (
    <div className="flex items-center justify-center min-h-dvh bg-background p-6">
      <div className="w-full max-w-sm space-y-5 p-8 bg-card rounded-xl shadow border border-border animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-link">Audit Dashboard</p>
          <h1 className="mt-2 text-3xl font-semibold text-primary font-heading tracking-tight">CLICS</h1>
          <p className="mt-1 text-sm text-muted-foreground">ตั้งรหัสผ่านใหม่ / Set a new password</p>
        </div>

        {phase === 'loading' && (
          <p className="text-center text-sm text-muted-foreground">กำลังตรวจสอบลิงก์… / Verifying link…</p>
        )}

        {phase === 'invalid' && (
          <div className="space-y-4 text-center">
            <p className="text-sm text-destructive">{invalidMsg}</p>
            <Link href="/forgot" className="inline-block text-sm text-link underline-offset-4 hover:underline">
              ขอลิงก์ใหม่ / Request a new link
            </Link>
          </div>
        )}

        {phase === 'form' && (
          <>
            <div className="relative">
              <input className="w-full border rounded-lg px-3 py-2 pr-10 text-sm" type={showPw ? 'text' : 'password'}
                placeholder="รหัสผ่านใหม่ / New password" value={password}
                onChange={e => setPassword(e.target.value)} />
              <button type="button" onClick={() => setShowPw(s => !s)}
                aria-label={showPw ? 'ซ่อนรหัสผ่าน / Hide password' : 'แสดงรหัสผ่าน / Show password'}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground">
                {showPw ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
              </button>
            </div>
            <div className="relative">
              <input className="w-full border rounded-lg px-3 py-2 pr-10 text-sm" type={showConfirm ? 'text' : 'password'}
                placeholder="ยืนยันรหัสผ่าน / Confirm password" value={confirm}
                onChange={e => setConfirm(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && save()} />
              <button type="button" onClick={() => setShowConfirm(s => !s)}
                aria-label={showConfirm ? 'ซ่อนรหัสผ่าน / Hide password' : 'แสดงรหัสผ่าน / Show password'}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground">
                {showConfirm ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
              </button>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <Button className="w-full" onClick={save} disabled={busy}>
              {busy ? 'กำลังบันทึก...' : 'บันทึกรหัสผ่านใหม่ / Save new password'}
            </Button>
          </>
        )}

        {phase === 'success' && (
          <div className="space-y-4 text-center">
            <p className="text-sm text-foreground">ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว / Your password has been updated.</p>
            <Link href="/login" className="inline-block text-sm text-link underline-offset-4 hover:underline">
              ไปเข้าสู่ระบบ / Go to login
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
