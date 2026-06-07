'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';
import { useIsMobile } from '@/components/ViewportProvider';
import { ROLE_LABELS, PROVIDER_LABELS, REQUEST_STATUS_MAP } from '@/lib/labels';

type Reviewer = { full_name_en: string | null; full_name_th: string | null; pseudonym: string | null };
type Req = {
  id: string; email: string | null; full_name_th: string | null; full_name_en: string | null;
  specialty: string | null; provider: string; requested_role: string; created_at: string;
  status: string; reviewed_at: string | null; note: string | null; reviewer?: Reviewer | null;
};

type Filter = 'pending' | 'approved' | 'all';
const TABS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'รออนุมัติ / Pending' },
  { key: 'approved', label: 'อนุมัติแล้ว / Approved' },
  { key: 'all', label: 'ทั้งหมด / All' },
];
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export default function RequestsPage() {
  const [reqs, setReqs] = useState<Req[]>([]);
  const [filter, setFilter] = useState<Filter>('pending');
  const [grant, setGrant] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const mobile = useIsMobile();

  // Only a superadmin may grant the admin role (backend enforces this too).
  const isSuper = getUser()?.role === 'superadmin';
  const grantable = isSuper ? ['physician', 'auditor', 'admin'] : ['physician', 'auditor'];

  const load = (f: Filter = filter) =>
    apiFetch<Req[]>(`/admin/access-requests?status=${f}`).then(d => setReqs(d ?? []));
  useEffect(() => { load(filter); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [filter]);

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

  const StatusBadge = ({ s }: { s: string }) => (
    <Badge variant={s === 'approved' ? 'default' : s === 'rejected' ? 'destructive' : 'outline'}>
      {REQUEST_STATUS_MAP[s] ?? s}
    </Badge>
  );

  const isPending = filter === 'pending';
  const emptyMsg = isPending
    ? 'ไม่มีคำขอที่รออนุมัติ / No pending requests.'
    : filter === 'approved'
      ? 'ยังไม่มีคำขอที่อนุมัติ / No approved requests yet.'
      : 'ยังไม่มีคำขอ / No requests yet.';

  return (
    <div className="max-w-4xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Access Requests"
        title="คำขอเข้าใช้งาน"
        subtitle="Access Requests — อนุมัติผู้สมัคร และดูประวัติการอนุมัติ · Approve requesters and review the onboarding history."
      />

      {/* filter tabs */}
      <div className="flex gap-2 mb-5">
        {TABS.map(t => (
          <Button key={t.key} size="sm" variant={filter === t.key ? 'default' : 'outline'}
            onClick={() => { setMsg(''); setFilter(t.key); }}>
            {t.label}
          </Button>
        ))}
      </div>

      {msg && <p className="mb-4 text-sm rounded-lg border border-border bg-secondary px-3 py-2">{msg}</p>}

      {reqs.length === 0 ? (
        <p className="text-muted-foreground text-sm py-10 text-center">{emptyMsg}</p>
      ) : isPending ? (
        /* ---- PENDING: approve / reject queue ---- */
        mobile ? (
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
        )
      ) : (
        /* ---- APPROVED / ALL: read-only onboarding trail ---- */
        mobile ? (
          <div className="space-y-3">
            {reqs.map(r => (
              <div key={r.id} className="rounded-xl border border-border p-4 space-y-1.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium">{r.full_name_th || r.full_name_en || '—'}</p>
                  <StatusBadge s={r.status} />
                </div>
                {r.email && <p className="text-sm text-muted-foreground">{r.email}</p>}
                <p className="text-xs text-muted-foreground">บทบาทที่ขอ / Requested: {ROLE_LABELS[r.requested_role] ?? r.requested_role}</p>
                <p className="text-xs text-muted-foreground">
                  {r.reviewed_at ? `ดำเนินการโดย / By ${r.reviewer?.full_name_en || r.reviewer?.pseudonym || '—'} · ${fmt(r.reviewed_at)}` : `ขอเมื่อ / Requested ${fmt(r.created_at)}`}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-secondary"><tr>
                <th className="px-4 py-3 text-left">ชื่อ / Name</th>
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">บทบาทที่ขอ / Requested</th>
                <th className="px-4 py-3 text-left">สถานะ / Status</th>
                <th className="px-4 py-3 text-left">ดำเนินการโดย / Reviewed by</th>
                <th className="px-4 py-3 text-left">เมื่อ / When</th>
              </tr></thead>
              <tbody>{reqs.map(r => (
                <tr key={r.id} className="border-t align-middle">
                  <td className="px-4 py-3">
                    <div className="font-medium">{r.full_name_th || r.full_name_en || '—'}</div>
                    <div className="text-muted-foreground text-xs">{r.full_name_en}{r.specialty ? ` · ${r.specialty}` : ''}</div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{r.email ?? '—'}</td>
                  <td className="px-4 py-3">{ROLE_LABELS[r.requested_role] ?? r.requested_role}</td>
                  <td className="px-4 py-3"><StatusBadge s={r.status} /></td>
                  <td className="px-4 py-3 text-muted-foreground">{r.reviewer?.full_name_en || r.reviewer?.pseudonym || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmt(r.reviewed_at ?? r.created_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
