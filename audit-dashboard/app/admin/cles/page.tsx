'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiFetch, apiFetchPaged } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';
import { useIsMobile } from '@/components/ViewportProvider';
import { STATUS_MAP } from '@/lib/labels';
import { BiLabel } from '@/components/BiLabel';
import { toast } from '@/components/Overlays';
import type { CleRow, Auditor, Council, ApiResult } from '@/lib/types';
import { Check } from 'lucide-react';

const PAGE_SIZE = 50;

// Color-code status so admins can triage at a glance (was a monochrome outline badge).
// cle_pass and evaluated share the "passing" tone — keep it single-sourced so they can't drift.
const PASS_TONE = 'border-transparent bg-[var(--chart-pass-bg)] text-[var(--chart-pass-text)]';
const STATUS_TONE: Record<string, string> = {
  cle_pass: PASS_TONE,
  evaluated: PASS_TONE,
  cle_flag_t2: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  cle_fail_t1: 'border-transparent bg-destructive/10 text-destructive',
};
function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status];
  return <Badge variant="outline" className={tone}>{STATUS_MAP[status] ?? status}</Badge>;
}

function AdminClesContent() {
  // The ?status= drill-down (from the Stats cards) seeds the initial filter. useSearchParams is
  // SSR-consistent, so this avoids a setState-in-effect and the hydration mismatch a window read
  // would cause — the component is wrapped in <Suspense> below (Next requires it for useSearchParams).
  const searchParams = useSearchParams();
  const [cles, setPlEs] = useState<CleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState(searchParams.get('status') || '');
  const [auditors, setAuditors] = useState<Auditor[]>([]);
  const [councils, setCouncils] = useState<Record<string, string>>({});
  const mobile = useIsMobile();

  // Fetch one page (newest-first), filtered SERVER-side by the active status, then append (offset>0)
  // or replace (offset 0). The backend maps the 'in_progress' bucket to its three live statuses, so
  // a Stats drill-down stays correct across pages (not just over already-loaded rows).
  // Monotonic request token: a fast filter change (or Load-more mid-change) fires overlapping GETs;
  // only the most recently-issued one may apply, so a slow stale response can't overwrite the list.
  const reqSeq = useRef(0);
  async function loadPage(offset: number) {
    const my = ++reqSeq.current;
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (filter) qs.set('status', filter);
    const { items, total } = await apiFetchPaged<CleRow>(`/admin/cles?${qs.toString()}`);
    if (my !== reqSeq.current) return; // superseded by a newer filter/page — drop this response
    setTotal(total);
    setPlEs(prev => (offset === 0 ? items : [...prev, ...items]));
  }

  async function loadMore() {
    setLoadingMore(true);
    try { await loadPage(cles.length); }
    finally { setLoadingMore(false); }
  }

  // Auditors + councils once (the ?status= drill-down seeds the initial filter via useSearchParams above).
  useEffect(() => {
    apiFetch<Auditor[]>('/admin/auditors').then(d => setAuditors(Array.isArray(d) ? d : []));
    apiFetch<Council[]>('/admin/councils').then(d =>
      setCouncils(Object.fromEntries((Array.isArray(d) ? d : []).map((c: Council) => [c.id, c.name_th]))));
  }, []);

  // (Re)load page 0 whenever the status filter changes (incl. on mount).
  useEffect(() => { loadPage(0); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [filter]);

  const councilName = (p: CleRow) => (p.council_id && councils[p.council_id]) || '—';

  // Filter chips mirror the Stats page categories so the drill-down highlights the right one.
  const FILTERS: { key: string; label: string }[] = [
    { key: '', label: 'ทั้งหมด / All' },
    { key: 'in_progress', label: 'กำลังดำเนินการ / In progress' },
    { key: 'evaluated', label: STATUS_MAP.evaluated },
    { key: 'cle_flag_t2', label: STATUS_MAP.cle_flag_t2 },
    { key: 'cle_fail_t1', label: STATUS_MAP.cle_fail_t1 },
  ];

  // Shared assign control (used by both the desktop table and the mobile card list).
  const assignControl = (p: CleRow) =>
    p.status === 'evaluated' && !p.auditor_id
      ? <select className="min-w-0 max-w-[200px] rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          onChange={e => e.target.value && assign(p.id, e.target.value)}>
          <option value="">เลือก Auditor...</option>
          {auditors.map((a: Auditor) => <option key={a.id} value={a.id}>{a.full_name_th}</option>)}
        </select>
      : p.auditor_id ? <span className="inline-flex items-center gap-1 text-xs text-[var(--ok)]"><Check className="size-3.5" /> Assigned</span> : <span className="text-xs text-muted-foreground">—</span>;

  async function assign(cleId: string, auditorId: string) {
    try {
      const res = await apiFetch<ApiResult<unknown>>(`/admin/cles/${cleId}/assign`, { method: 'POST', body: JSON.stringify({ auditor_id: auditorId }) });
      if (res?.error) { toast(`ไม่สำเร็จ / Failed: ${String(res.error)}`, 'error'); return; }
      // Re-fetch the currently-loaded range (newest-first, same filter) to reflect the assignment.
      const lim = Math.min(Math.max(cles.length, PAGE_SIZE), 200);
      const qs = new URLSearchParams({ limit: String(lim), offset: '0' });
      if (filter) qs.set('status', filter);
      const { items, total } = await apiFetchPaged<CleRow>(`/admin/cles?${qs.toString()}`);
      setTotal(total);
      setPlEs(items);
    } catch { toast('เกิดข้อผิดพลาด / Error assigning auditor', 'error'); }
  }

  return (
    <>
      <div className="max-w-5xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · CLE Management"
        title="จัดการ CLEs ทั้งหมด"
        subtitle="Manage all Continuous Learning Episodes — มอบหมายให้ผู้ตรวจประเมินเมื่อประเมินผลแล้ว"
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
        แสดง {cles.length} จาก {total} / Showing {cles.length} of {total}
      </p>

      {mobile ? (
        /* Mobile: stacked cards (full text, no squeezed columns) */
        <div className="space-y-3">
          {cles.map(p => (
            <div key={p.id} className="rounded-xl border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{p.professionals?.full_name_th ?? '—'}{p.is_test && <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1">test</span>}</p>
                <StatusBadge status={p.status} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{new Date(p.started_at).toLocaleDateString('th-TH')} · {councilName(p)}</p>
              <p className="mt-3 text-xs text-muted-foreground">มอบหมาย / Assign</p>
              <div className="mt-1 flex items-center justify-between gap-2">
                {assignControl(p)}
                <a href={`/admin/cles/${p.id}`} className="text-xs underline text-primary">ดูบทสนทนา / View</a>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Desktop: table */
        <div className="border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary"><tr>
              <th className="px-4 py-3 text-left"><BiLabel th="แพทย์" en="Physician" tooltip /></th>
              <th className="px-4 py-3 text-left"><BiLabel th="สภา" en="Council" tooltip /></th>
              <th className="px-4 py-3 text-left"><BiLabel th="วันที่" en="Date" tooltip /></th>
              <th className="px-4 py-3 text-left"><BiLabel th="สถานะ" en="Status" tooltip /></th>
              <th className="px-4 py-3 text-left"><BiLabel th="มอบหมายผู้ตรวจ" en="Assign Auditor" tooltip /></th>
              <th className="px-4 py-3 text-left"><BiLabel th="บทสนทนา" en="Session" tooltip /></th>
            </tr></thead>
            <tbody>{cles.map(p => (
              <tr key={p.id} className="border-t hover:bg-secondary">
                <td className="px-4 py-3">{p.professionals?.full_name_th ?? '—'}{p.is_test && <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1">test</span>}</td>
                <td className="px-4 py-3 text-muted-foreground">{councilName(p)}</td>
                <td className="px-4 py-3">{new Date(p.started_at).toLocaleDateString('th-TH')}</td>
                <td className="px-4 py-3"><StatusBadge status={p.status} /></td>
                <td className="px-4 py-3">{assignControl(p)}</td>
                <td className="px-4 py-3"><a href={`/admin/cles/${p.id}`} className="text-xs underline text-primary">ดู / View</a></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {cles.length < total && (
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

export default function AdminClesPage() {
  // useSearchParams (in AdminClesContent) requires a Suspense boundary in the App Router.
  return (
    <Suspense>
      <AdminClesContent />
    </Suspense>
  );
}
