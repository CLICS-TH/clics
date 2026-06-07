'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';
import { useIsMobile } from '@/components/ViewportProvider';
import { ROLE_LABELS, ACCOUNT_STATUS_MAP } from '@/lib/labels';

type User = {
  id: string; role: string; full_name_th: string; full_name_en: string;
  specialty?: string | null; license_number?: string | null;
  status?: string; pseudonym?: string | null;
};
type Slot = { role: string; capacity: number; used: number; remaining: number };

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [cap, setCap] = useState<Record<string, string>>({});
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ email:'', password:'', role:'physician', full_name_th:'', full_name_en:'', specialty:'', license_number:'' });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState<User | null>(null);
  const mobile = useIsMobile();

  const loadUsers = () => apiFetch<User[]>('/admin/users').then(d => setUsers(d ?? []));
  const loadSlots = () => apiFetch<Slot[]>('/admin/slots').then(d => {
    setSlots(d ?? []);
    setCap(Object.fromEntries((d ?? []).map(s => [s.role, String(s.capacity)])));
  });
  useEffect(() => { loadUsers(); loadSlots(); }, []);

  async function createUser() {
    setErr('');
    const res: any = await apiFetch('/admin/users', { method:'POST', body: JSON.stringify(form) });
    if (res?.id) { setShowForm(false); loadUsers(); loadSlots(); }
    else setErr(res?.error?.fieldErrors ? JSON.stringify(res.error.fieldErrors) : res?.error ?? 'Error');
  }

  async function saveEdit() {
    if (!editing) return;
    setMsg('');
    const body: any = {
      full_name_th: editing.full_name_th, full_name_en: editing.full_name_en,
      specialty: editing.specialty ?? '', license_number: editing.license_number ?? '', role: editing.role,
    };
    const res: any = await apiFetch(`/admin/users/${editing.id}`, { method:'PATCH', body: JSON.stringify(body) });
    if (res?.id) { setEditing(null); setMsg('บันทึกแล้ว / Saved.'); loadUsers(); loadSlots(); }
    else setMsg(res?.error ?? 'แก้ไขไม่สำเร็จ / Update failed.');
  }

  async function toggleStatus(u: User) {
    const next = u.status === 'deactivated' ? 'active' : 'deactivated';
    if (!confirm(next === 'deactivated' ? 'ปิดใช้งานบัญชีนี้? / Deactivate this account?' : 'เปิดใช้งานอีกครั้ง? / Reactivate?')) return;
    setMsg('');
    const res: any = await apiFetch(`/admin/users/${u.id}/status`, { method:'PATCH', body: JSON.stringify({ status: next }) });
    if (res?.id) { setMsg('อัปเดตสถานะแล้ว / Status updated.'); loadUsers(); loadSlots(); }
    else setMsg(res?.error ?? 'อัปเดตไม่สำเร็จ / Failed.');
  }

  async function saveCap(role: string) {
    setMsg('');
    const capacity = parseInt(cap[role] ?? '', 10);
    if (!Number.isFinite(capacity) || capacity < 0) { setMsg('จำนวนช่องไม่ถูกต้อง / Invalid capacity.'); return; }
    const res: any = await apiFetch(`/admin/slots/${role}`, { method:'PATCH', body: JSON.stringify({ capacity }) });
    if (res?.role) { setMsg('บันทึกจำนวนช่องแล้ว / Capacity saved.'); loadSlots(); }
    else setMsg(res?.error ?? 'บันทึกไม่สำเร็จ / Failed.');
  }

  const StatusBadge = ({ s }: { s?: string }) => (
    <span className={`text-xs px-2 py-0.5 rounded-full ${s === 'deactivated' ? 'bg-muted text-muted-foreground' : 'bg-[#5db872]/20 text-foreground'}`}>
      {ACCOUNT_STATUS_MAP[s ?? 'active'] ?? s}
    </span>
  );

  const FIELD_PLACEHOLDERS: Record<string, string> = {
    full_name_th: 'ชื่อภาษาไทย / Thai Name', full_name_en: 'Full Name (English)',
    email: 'Email', password: 'Password',
    specialty: 'สาขาวิชา / Specialty', license_number: 'เลขใบอนุญาต / License No.',
  };

  return (
    <div className="max-w-4xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Users"
        title="จัดการผู้ใช้งาน"
        subtitle="User Management — สมาชิก, สถานะบัญชี และจำนวนช่องต่อบทบาท · Members, account status, and role slot pools."
        action={<Button onClick={() => setShowForm(v => !v)}>+ เพิ่มผู้ใช้ / Add User</Button>}
      />

      {/* Role slot pools */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {slots.map(s => {
          const locked = s.role === 'superadmin';
          const full = s.remaining <= 0;
          return (
            <div key={s.role} className="rounded-xl border border-border p-4">
              <p className="text-sm font-medium">{ROLE_LABELS[s.role] ?? s.role}</p>
              <p className={`text-2xl font-heading mt-1 ${full ? 'text-destructive' : ''}`}>{s.used}<span className="text-muted-foreground text-base">/{s.capacity}</span></p>
              <p className="text-xs text-muted-foreground">เหลือ {s.remaining} ช่อง / {s.remaining} left</p>
              <div className="flex items-center gap-1 mt-2">
                <input type="number" min={0} disabled={locked}
                  className="w-16 border rounded-md px-2 py-1 text-sm bg-background disabled:opacity-50"
                  value={cap[s.role] ?? ''} onChange={e => setCap(c => ({ ...c, [s.role]: e.target.value }))} />
                <Button variant="outline" className="text-xs px-2 py-1 h-auto" disabled={locked} onClick={() => saveCap(s.role)}>
                  {locked ? 'locked' : 'ตั้งค่า'}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {msg && <p className="mb-4 text-sm rounded-lg border border-border bg-secondary px-3 py-2">{msg}</p>}

      {showForm && (
        <div className="border rounded-xl p-5 mb-6 space-y-4">
          {(['full_name_th','full_name_en','email','password','specialty','license_number'] as const).map(f => (
            <input key={f} className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder={FIELD_PLACEHOLDERS[f]} value={(form as any)[f]}
              type={f==='password'?'password':'text'}
              onChange={e => setForm(s => ({ ...s, [f]: e.target.value }))} />
          ))}
          <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
            value={form.role} onChange={e => setForm(s => ({ ...s, role: e.target.value }))}>
            {Object.entries(ROLE_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {err && <p className="text-destructive text-sm">{err}</p>}
          <Button className="w-full" onClick={createUser}>สร้างผู้ใช้ (active ทันที)</Button>
        </div>
      )}

      {/* Edit panel */}
      {editing && (
        <div className="border rounded-xl p-5 mb-6 space-y-3">
          <p className="font-medium">แก้ไข / Edit — {editing.full_name_en}</p>
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={editing.full_name_th}
            placeholder="ชื่อภาษาไทย" onChange={e => setEditing(u => u && ({ ...u, full_name_th: e.target.value }))} />
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={editing.full_name_en}
            placeholder="Full Name (English)" onChange={e => setEditing(u => u && ({ ...u, full_name_en: e.target.value }))} />
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={editing.specialty ?? ''}
            placeholder="สาขาวิชา / Specialty" onChange={e => setEditing(u => u && ({ ...u, specialty: e.target.value }))} />
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={editing.license_number ?? ''}
            placeholder="เลขใบอนุญาต / License No." onChange={e => setEditing(u => u && ({ ...u, license_number: e.target.value }))} />
          <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
            value={editing.role} onChange={e => setEditing(u => u && ({ ...u, role: e.target.value }))}>
            {Object.entries(ROLE_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <div className="flex gap-2">
            <Button onClick={saveEdit}>บันทึก / Save</Button>
            <Button variant="outline" onClick={() => setEditing(null)}>ยกเลิก</Button>
          </div>
        </div>
      )}

      {mobile ? (
        <div className="space-y-3">
          {users.map(u => (
            <div key={u.id} className="rounded-xl border border-border p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{u.full_name_th}{u.pseudonym ? ` · ${u.pseudonym}` : ''}</p>
                <Badge variant="outline">{ROLE_LABELS[u.role] ?? u.role}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{u.full_name_en}</p>
              <div className="flex items-center justify-between pt-1">
                <StatusBadge s={u.status} />
                <div className="flex gap-2">
                  <Button variant="outline" className="text-xs px-2 py-1 h-auto" onClick={() => setEditing(u)}>แก้ไข</Button>
                  <Button variant="outline" className="text-xs px-2 py-1 h-auto" onClick={() => toggleStatus(u)}>
                    {u.status === 'deactivated' ? 'เปิดใช้' : 'ปิดใช้'}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary"><tr>
              <th className="px-4 py-3 text-left">ชื่อ (TH)</th>
              <th className="px-4 py-3 text-left">ชื่อ (EN)</th>
              <th className="px-4 py-3 text-left">Role</th>
              <th className="px-4 py-3 text-left">สถานะ / Status</th>
              <th className="px-4 py-3 text-right">การจัดการ</th>
            </tr></thead>
            <tbody>{users.map(u => (
              <tr key={u.id} className="border-t hover:bg-secondary/60">
                <td className="px-4 py-3">{u.full_name_th}{u.pseudonym ? <span className="text-muted-foreground text-xs"> · {u.pseudonym}</span> : ''}</td>
                <td className="px-4 py-3 text-muted-foreground">{u.full_name_en}</td>
                <td className="px-4 py-3"><Badge variant="outline">{ROLE_LABELS[u.role] ?? u.role}</Badge></td>
                <td className="px-4 py-3"><StatusBadge s={u.status} /></td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <Button variant="outline" className="text-xs px-2 py-1 h-auto mr-2" onClick={() => setEditing(u)}>แก้ไข</Button>
                  <Button variant="outline" className="text-xs px-2 py-1 h-auto" onClick={() => toggleStatus(u)}>
                    {u.status === 'deactivated' ? 'เปิดใช้' : 'ปิดใช้'}
                  </Button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
