'use client';
import { useEffect, useState } from 'react';
import { apiFetch, apiFetchPaged } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';
import { useIsMobile } from '@/components/ViewportProvider';
import { STATUS_MAP } from '@/lib/labels';

const PAGE_SIZE = 50;

export default function AdminPlesPage() {
  const [ples, setPlEs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState('');
  const [auditors, setAuditors] = useState<any[]>([]);
  const [councils, setCouncils] = useState<Record<string, string>>({});
  const mobile = useIsMobile();

  // Fetch one page (newest-first), filtered SERVER-side by the active status, then append (offset>0)
  // or replace (offset 0). The backend maps the 'in_progress' bucket to its three live statuses, so
  // a Stats drill-down stays correct across pages (not just over already-loaded rows).
  async function loadPage(offset: number) {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (filter) qs.set('status', filter);
    const { items, total } = await apiFetchPaged<any>(`/admin/ples?${qs.toString()}`);
    setTotal(total);
    setPlEs(prev => (offset === 0 ? items : [...prev, ...items]));
  }

  async function loadMore() {
    setLoadingMore(true);
    try { await loadPage(ples.length); }
    finally { setLoadingMore(false); }
  }

  // Auditors + councils once; read a ?status= drill-down from the URL into the filter.
  useEffect(() => {
    apiFetch<any[]>('/admin/auditors').then(d => setAuditors(d ?? []));
    apiFetch<any[]>('/admin/councils').then(d =>
      setCouncils(Object.fromEntries((d ?? []).map((c: any) => [c.id, c.name_th]))));
    const s = new URLSearchParams(window.location.search).get('status');
    if (s) setFilter(s);
  }, []);

  // (Re)load page 0 whenever the status filter changes (incl. on mount).
  useEffect(() => { loadPage(0); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [filter]);

  const councilName = (p: any) => (p.council_id && councils[p.council_id]) || '—';

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
      // Re-fetch the currently-loaded range (newest-first, same filter) to reflect the assignment.
      const lim = Math.min(Math.max(ples.length, PAGE_SIZE), 200);
      const qs = new URLSearchParams({ limit: String(lim), offset: '0' });
      if (filter) qs.set('status', filter);
      const { items, total } = await apiFetchPaged<any>(`/admin/ples?${qs.toString()}`);
      setTotal(total);
      setPlEs(items);
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
      <div className="flex gap-2 mb-3 flex-wrap">
        {FILTERS.map(f => (
          <Button key={f.key} variant={filter===f.key?'default':'outline'} size="sm" onClick={() => setFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      {/* Loaded-vs-total for the active (server-side) filter. */}
      <p className="mb-5 text-xs text-muted-foreground">
        แสดง {ples.length} จาก {total} / Showing {ples.length} of {total}
      </p>

      {mobile ? (
        /* Mobile: stacked cards (full text, no squeezed columns) */
        <div className="space-y-3">
          {ples.map(p => (
            <div key={p.id} className="rounded-xl border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{p.professionals?.full_name_th ?? '—'}{p.is_test && <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1">test</span>}</p>
                <Badge variant="outline">{STATUS_MAP[p.status]??p.status}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{new Date(p.started_at).toLocaleDateString('th-TH')} · {councilName(p)}</p>
              <p className="mt-3 text-xs text-muted-foreground">มอบหมาย / Assign</p>
              <div className="mt-1 flex items-center justify-between gap-2">
                {assignControl(p)}
                <a href={`/admin/ples/${p.id}`} className="text-xs underline text-primary">ดูบทสนทนา / View</a>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Desktop: table */
        <div className="border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary"><tr>
              <th className="px-4 py-3 text-left">แพทย์ / Physician</th>
              <th className="px-4 py-3 text-left">สภา / Council</th>
              <th className="px-4 py-3 text-left">วันที่ / Date</th>
              <th className="px-4 py-3 text-left">สถานะ / Status</th>
              <th className="px-4 py-3 text-left">มอบหมาย / Assign Auditor</th>
              <th className="px-4 py-3 text-left">บทสนทนา / Session</th>
            </tr></thead>
            <tbody>{ples.map(p => (
              <tr key={p.id} className="border-t hover:bg-secondary">
                <td className="px-4 py-3">{p.professionals?.full_name_th ?? '—'}{p.is_test && <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1">test</span>}</td>
                <td className="px-4 py-3 text-muted-foreground">{councilName(p)}</td>
                <td className="px-4 py-3">{new Date(p.started_at).toLocaleDateString('th-TH')}</td>
                <td className="px-4 py-3"><Badge variant="outline">{STATUS_MAP[p.status]??p.status}</Badge></td>
                <td className="px-4 py-3">{assignControl(p)}</td>
                <td className="px-4 py-3"><a href={`/admin/ples/${p.id}`} className="text-xs underline text-primary">ดู / View</a></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {ples.length < total && (
        <div className="mt-5 flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'กำลังโหลด… / Loading…' : 'โหลดเพิ่ม / Load more'}
          </Button>
        </div>
      )}
    </div>
    </>
  );
}
