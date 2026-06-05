'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';
import { useIsMobile } from '@/components/ViewportProvider';
import { ROLE_LABELS } from '@/lib/labels';

export default function UsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ email:'', password:'', role:'physician', full_name_th:'', full_name_en:'', specialty:'', license_number:'' });
  const [err, setErr] = useState('');
  const mobile = useIsMobile();
  const load = () => apiFetch<any[]>('/admin/users').then(d => setUsers(d ?? []));
  useEffect(() => { load(); }, []);

  async function createUser() {
    setErr('');
    const res: any = await apiFetch('/admin/users', { method:'POST', body: JSON.stringify(form) });
    if (res?.id) { setShowForm(false); load(); }
    else setErr(res?.error?.fieldErrors ? JSON.stringify(res.error.fieldErrors) : res?.error ?? 'Error');
  }

  const FIELD_PLACEHOLDERS: Record<string, string> = {
    full_name_th: 'ชื่อภาษาไทย / Thai Name',
    full_name_en: 'Full Name (English)',
    email: 'Email',
    password: 'Password',
    specialty: 'สาขาวิชา / Specialty',
    license_number: 'เลขใบอนุญาต / License No.',
  };

  return (
    <>
      <div className="max-w-4xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Users"
        title="จัดการผู้ใช้งาน"
        subtitle="User Management — บัญชีผู้ใช้ทั้งหมดในระบบ"
        action={<Button onClick={() => setShowForm(v => !v)}>+ เพิ่มผู้ใช้ / Add User</Button>}
      />
      {showForm && (
        <div className="border rounded-xl p-5 mb-6 space-y-4">
          {(['full_name_th','full_name_en','email','password','specialty','license_number'] as const).map(f => (
            <input key={f} className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder={FIELD_PLACEHOLDERS[f]} value={(form as any)[f]}
              type={f==='password'?'password':'text'}
              onChange={e => setForm(s => ({ ...s, [f]: e.target.value }))} />
          ))}
          <select className="w-full border rounded-lg px-3 py-2 text-sm"
            value={form.role} onChange={e => setForm(s => ({ ...s, role: e.target.value }))}>
            {Object.entries(ROLE_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {err && <p className="text-destructive text-sm">{err}</p>}
          <Button className="w-full" onClick={createUser}>สร้างผู้ใช้</Button>
        </div>
      )}
      {mobile ? (
        /* Mobile: stacked cards */
        <div className="space-y-3">
          {users.map(u => (
            <div key={u.id} className="rounded-xl border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{u.full_name_th}</p>
                <Badge variant="outline">{ROLE_LABELS[u.role]??u.role}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{u.full_name_en}</p>
            </div>
          ))}
        </div>
      ) : (
        /* Desktop: table */
        <div className="border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary"><tr>
              <th className="px-4 py-3 text-left">ชื่อ (TH)</th>
              <th className="px-4 py-3 text-left">ชื่อ (EN)</th>
              <th className="px-4 py-3 text-left">Role</th>
            </tr></thead>
            <tbody>{users.map(u => (
              <tr key={u.id} className="border-t hover:bg-secondary">
                <td className="px-4 py-3">{u.full_name_th}</td>
                <td className="px-4 py-3 text-muted-foreground">{u.full_name_en}</td>
                <td className="px-4 py-3"><Badge variant="outline">{ROLE_LABELS[u.role]??u.role}</Badge></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
    </>
  );
}
