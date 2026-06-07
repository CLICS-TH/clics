'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';
import { useIsMobile } from '@/components/ViewportProvider';
import { ROLE_LABELS, PROVIDER_LABELS } from '@/lib/labels';

type Req = {
  id: string; email: string | null; full_name_th: string | null; full_name_en: string | null;
  specialty: string | null; provider: string; requested_role: string; created_at: string;
};

export default function RequestsPage() {
  const [reqs, setReqs] = useState<Req[]>([]);
  const [grant, setGrant] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const mobile = useIsMobile();

  // Only a superadmin may grant the admin role (backend enforces this too).
  const isSuper = getUser()?.role === 'superadmin';
  const grantable = isSuper ? ['physician', 'auditor', 'admin'] : ['physician', 'auditor'];

  const load = () => apiFetch<Req[]>('/admin/access-requests').then(d => setReqs(d ?? []));
  useEffect(() => { load(); }, []);

  async function approve(id: string) {
    setBusy(id); setMsg('');
    const res: any = await apiFetch(`/admin/access-requests/${id}/approve`, {
      method: 'POST', body: JSON.stringify({ granted_role: grant[id] ?? 'physician' }),
    });
    setBusy(null);
    if (res?.ok) { setMsg(`อนุมัติแล้ว / Approved${res.pseudonym ? ` (${res.pseudonym})` : ''}.`); load(); }
    else setMsg(res?.error ?? 'อนุมัติไม่สำเร็จ / Approval failed.');
  }

  async function reject(id: string) {
    if (!confirm('ปฏิเสธคำขอนี้? / Reject this request?')) return;
    setBusy(id); setMsg('');
    const res: any = await apiFetch(`/admin/access-requests/${id}/reject`, {
      method: 'POST', body: JSON.stringify({}),
    });
    setBusy(null);
    if (res?.ok) { setMsg('ปฏิเสธแล้ว / Rejected.'); load(); }
    else setMsg(res?.error ?? 'ทำรายการไม่สำเร็จ / Failed.');
  }

  const RoleSelect = ({ id }: { id: string }) => (
    <select className="border rounded-lg px-2 py-1.5 text-sm bg-background"
      value={grant[id] ?? 'physician'} onChange={e => setGrant(s => ({ ...s, [id]: e.target.value }))}>
      {grantable.map(r => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>)}
    </select>
  );

  return (
    <div className="max-w-4xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Access Requests"
        title="คำขอเข้าใช้งาน"
        subtitle="Access Requests — อนุมัติผู้สมัครเข้าสู่บทบาทตามจำนวนช่องที่เหลือ · Approve requesters into an available role slot."
      />
      {msg && <p className="mb-4 text-sm rounded-lg border border-border bg-secondary px-3 py-2">{msg}</p>}

      {reqs.length === 0 ? (
        <p className="text-muted-foreground text-sm py-10 text-center">ไม่มีคำขอที่รออนุมัติ / No pending requests.</p>
      ) : mobile ? (
        <div className="space-y-3">
          {reqs.map(r => (
            <div key={r.id} className="rounded-xl border border-border p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{r.full_name_th || r.full_name_en || '—'}</p>
                <Badge variant="outline">{PROVIDER_LABELS[r.provider] ?? r.provider}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{r.full_name_en}</p>
              {r.email && <p className="text-sm text-muted-foreground">{r.email}</p>}
              {r.specialty && <p className="text-xs text-muted-foreground">{r.specialty}</p>}
              <div className="flex items-center gap-2 pt-2">
                <RoleSelect id={r.id} />
                <Button onClick={() => approve(r.id)} disabled={busy === r.id}>อนุมัติ / Approve</Button>
                <Button variant="outline" onClick={() => reject(r.id)} disabled={busy === r.id}>ปฏิเสธ</Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary"><tr>
              <th className="px-4 py-3 text-left">ชื่อ / Name</th>
              <th className="px-4 py-3 text-left">Email</th>
              <th className="px-4 py-3 text-left">ช่องทาง / Via</th>
              <th className="px-4 py-3 text-left">อนุมัติเป็น / Grant role</th>
              <th className="px-4 py-3 text-right">การจัดการ</th>
            </tr></thead>
            <tbody>{reqs.map(r => (
              <tr key={r.id} className="border-t align-middle">
                <td className="px-4 py-3">
                  <div className="font-medium">{r.full_name_th || r.full_name_en || '—'}</div>
                  <div className="text-muted-foreground text-xs">{r.full_name_en}{r.specialty ? ` · ${r.specialty}` : ''}</div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{r.email ?? '—'}</td>
                <td className="px-4 py-3"><Badge variant="outline">{PROVIDER_LABELS[r.provider] ?? r.provider}</Badge></td>
                <td className="px-4 py-3"><RoleSelect id={r.id} /></td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <Button onClick={() => approve(r.id)} disabled={busy === r.id} className="mr-2">อนุมัติ / Approve</Button>
                  <Button variant="outline" onClick={() => reject(r.id)} disabled={busy === r.id}>ปฏิเสธ</Button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
