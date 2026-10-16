'use client';
import { useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function ForgotPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError('');
    const e = email.trim();
    if (!EMAIL_RE.test(e)) { setError('กรุณากรอกอีเมลที่ถูกต้อง / Please enter a valid email.'); return; }
    setBusy(true);
    // Backend ALWAYS returns 200 { ok:true } — it never reveals whether the account
    // exists. Show the same neutral success regardless of the response body.
    await apiFetch('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: e }) }).catch(() => {});
    setBusy(false);
    setSent(true);
  }

  return (
    <div className="flex items-center justify-center min-h-dvh bg-background p-6">
      <div className="w-full max-w-sm space-y-5 p-8 bg-card rounded-xl shadow border border-border animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-link">Audit Dashboard</p>
          <h1 className="mt-2 text-3xl font-semibold text-primary font-heading tracking-tight">CLICS</h1>
          <p className="mt-1 text-sm text-muted-foreground">ตั้งรหัสผ่านใหม่ / Reset your password</p>
        </div>

        {sent ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-foreground">
              หากมีบัญชีที่ใช้อีเมลนี้ เราได้ส่งลิงก์ตั้งรหัสผ่านให้แล้ว
            </p>
            <p className="text-sm text-muted-foreground">
              If an account exists for that email, a reset link is on its way. Check your inbox.
            </p>
            <Link href="/login" className="inline-block text-sm text-link underline-offset-4 hover:underline">
              ← กลับไปเข้าสู่ระบบ / Back to login
            </Link>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              กรอกอีเมลของคุณ เราจะส่งลิงก์สำหรับตั้งรหัสผ่านใหม่ / Enter your email and we&apos;ll send a reset link.
            </p>
            <input className="w-full border rounded-lg px-3 py-2 text-sm" type="email"
              placeholder="อีเมล / Email" value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()} />
            {error && <p className="text-danger text-sm">{error}</p>}
            <Button className="w-full" onClick={submit} disabled={busy}>
              {busy ? 'กำลังส่ง...' : 'ส่งลิงก์ตั้งรหัสผ่าน / Send reset link'}
            </Button>
            <p className="text-center">
              <Link href="/login" className="text-sm text-link underline-offset-4 hover:underline">
                ← กลับไปเข้าสู่ระบบ / Back to login
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
