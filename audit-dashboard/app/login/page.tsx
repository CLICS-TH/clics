'use client';
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = params.get('token');
    if (token) {
      localStorage.setItem('clics_token', token);
      apiFetch<{ user: ClicsUser }>('/auth/me').then(({ user }) => {
        localStorage.setItem('clics_user', JSON.stringify(user));
        redirectByRole(user.role, router);
      });
    }
  }, [params, router]);

  async function handleLogin() {
    setError(''); setLoading(true);
    const data: any = await apiFetch('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    setLoading(false);
    if (data?.access_token) {
      localStorage.setItem('clics_token', data.access_token);
      localStorage.setItem('clics_user', JSON.stringify(data.user));
      redirectByRole(data.user.role, router);
    } else {
      setError(data?.error ?? 'เข้าสู่ระบบไม่สำเร็จ');
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="w-full max-w-sm space-y-4 p-8 bg-card rounded-xl shadow border border-border">
        <h1 className="text-2xl font-bold text-center text-primary font-heading">CLICS</h1>
        <p className="text-center text-sm text-muted-foreground">Audit Dashboard</p>
        <input className="w-full border rounded-lg px-3 py-2 text-sm" type="email"
          placeholder="อีเมล / Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input className="w-full border rounded-lg px-3 py-2 text-sm" type="password"
          placeholder="รหัสผ่าน / Password" value={password} onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleLogin()} />
        {error && <p className="text-destructive text-sm">{error}</p>}
        <Button className="w-full" onClick={handleLogin} disabled={loading}>
          {loading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ / Login'}
        </Button>
      </div>
    </div>
  );
}

interface ClicsUser { id: string; role: string; full_name_th: string; full_name_en: string; }

function redirectByRole(role: string, router: ReturnType<typeof useRouter>) {
  if (role === 'auditor') router.push('/auditor/queue');
  else if (role === 'admin') router.push('/admin/ples');
  else if (role === 'superadmin') router.push('/admin/icc');
  else router.push('/login');
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
