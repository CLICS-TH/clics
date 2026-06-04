'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NavBar } from '@/components/NavBar';

const ROLE_LABELS: Record<string,string> = { superadmin:'Superadmin', admin:'Admin', physician:'แพทย์', auditor:'Auditor' };

export default function UsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ email:'', password:'', role:'physician', full_name_th:'', full_name_en:'', specialty:'', license_number:'' });
  const [err, setErr] = useState('');
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
      <NavBar />
      <div className="max-w-4xl mx-auto p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl font-bold">จัดการผู้ใช้งาน / User Management</h1>
        <Button onClick={() => setShowForm(v => !v)}>+ เพิ่มผู้ใช้ / Add User</Button>
      </div>
      {showForm && (
        <div className="border rounded-xl p-5 mb-6 space-y-3">
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
          {err && <p className="text-red-500 text-sm">{err}</p>}
          <Button className="w-full" onClick={createUser}>สร้างผู้ใช้</Button>
        </div>
      )}
      <div className="border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr>
            <th className="px-4 py-3 text-left">ชื่อ (TH)</th>
            <th className="px-4 py-3 text-left">ชื่อ (EN)</th>
            <th className="px-4 py-3 text-left">Role</th>
          </tr></thead>
          <tbody>{users.map(u => (
            <tr key={u.id} className="border-t hover:bg-slate-50">
              <td className="px-4 py-3">{u.full_name_th}</td>
              <td className="px-4 py-3 text-slate-500">{u.full_name_en}</td>
              <td className="px-4 py-3"><Badge variant="outline">{ROLE_LABELS[u.role]??u.role}</Badge></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
    </>
  );
}
