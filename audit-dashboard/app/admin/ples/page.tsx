'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';
import { useIsMobile } from '@/components/ViewportProvider';
import { STATUS_MAP } from '@/lib/labels';

export default function AdminPlesPage() {
  const [ples, setPlEs] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [auditors, setAuditors] = useState<any[]>([]);
  const mobile = useIsMobile();

  useEffect(() => {
    apiFetch<any[]>('/admin/ples').then(d => setPlEs(d ?? []));
    apiFetch<any[]>('/admin/auditors').then(d => setAuditors(d ?? []));
    // Honor a ?status= deep-link from the Stats page drill-down.
    const s = new URLSearchParams(window.location.search).get('status');
    if (s) setFilter(s);
  }, []);

  // 'in_progress' is a stats bucket spanning three live statuses; others map 1:1.
  const STATUS_SETS: Record<string, string[]> = { in_progress: ['active', 'ended', 'cle_pass'] };
  const filtered = !filter ? ples
    : STATUS_SETS[filter] ? ples.filter(p => STATUS_SETS[filter].includes(p.status))
    : ples.filter(p => p.status === filter);

  // Filter chips mirror the Stats page categories so the drill-down highlights the right one.
  const FILTERS: { key: string; label: string }[] = [
    { key: '', label: 'ทั้งหมด / All' },
    { key: 'in_progress', label: 'กำลังดำเนินการ / In progress' },
    { key: 'evaluated', label: STATUS_MAP.evaluated },
    { key: 'cle_flag_t2', label: STATUS_MAP.cle_flag_t2 },
    { key: 'cle_fail_t1', label: STATUS_MAP.cle_fail_t1 },
  ];

  // Shared assign control (used by both the desktop table and the mobile card list).
  const assignControl = (p: any) =>
    p.status === 'evaluated' && !p.auditor_id
      ? <select className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          onChange={e => e.target.value && assign(p.id, e.target.value)}>
          <option value="">เลือก Auditor...</option>
          {auditors.map((a:any) => <option key={a.id} value={a.id}>{a.full_name_th}</option>)}
        </select>
      : p.auditor_id ? <span className="text-xs text-[#5db872]">✓ Assigned</span> : <span className="text-xs text-muted-foreground">—</span>;

  async function assign(pleId: string, auditorId: string) {
    try {
      const res: any = await apiFetch(`/admin/ples/${pleId}/assign`, { method: 'POST', body: JSON.stringify({ auditor_id: auditorId }) });
      if (res?.error) { alert(`ไม่สำเร็จ: ${res.error}`); return; }
      apiFetch<any[]>('/admin/ples').then(d => setPlEs(d ?? []));
    } catch { alert('เกิดข้อผิดพลาด / Error assigning auditor'); }
  }

  return (
    <>
      <div className="max-w-5xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · PLE Management"
        title="จัดการ PLEs ทั้งหมด"
        subtitle="Manage all Clinical Learning Episodes — มอบหมายให้ผู้ตรวจประเมินเมื่อประเมินผลแล้ว"
      />
      <div className="flex gap-2 mb-5 flex-wrap">
        {FILTERS.map(f => (
          <Button key={f.key} variant={filter===f.key?'default':'outline'} size="sm" onClick={() => setFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      {mobile ? (
        /* Mobile: stacked cards (full text, no squeezed columns) */
        <div className="space-y-3">
          {filtered.map(p => (
            <div key={p.id} className="rounded-xl border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{p.professionals?.full_name_th ?? '—'}</p>
                <Badge variant="outline">{STATUS_MAP[p.status]??p.status}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{new Date(p.started_at).toLocaleDateString('th-TH')}</p>
              <p className="mt-3 text-xs text-muted-foreground">มอบหมาย / Assign</p>
              <div className="mt-1">{assignControl(p)}</div>
            </div>
          ))}
        </div>
      ) : (
        /* Desktop: table */
        <div className="border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary"><tr>
              <th className="px-4 py-3 text-left">แพทย์ / Physician</th>
              <th className="px-4 py-3 text-left">วันที่ / Date</th>
              <th className="px-4 py-3 text-left">สถานะ / Status</th>
              <th className="px-4 py-3 text-left">มอบหมาย / Assign Auditor</th>
            </tr></thead>
            <tbody>{filtered.map(p => (
              <tr key={p.id} className="border-t hover:bg-secondary">
                <td className="px-4 py-3">{p.professionals?.full_name_th ?? '—'}</td>
                <td className="px-4 py-3">{new Date(p.started_at).toLocaleDateString('th-TH')}</td>
                <td className="px-4 py-3"><Badge variant="outline">{STATUS_MAP[p.status]??p.status}</Badge></td>
                <td className="px-4 py-3">{assignControl(p)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
    </>
  );
}
