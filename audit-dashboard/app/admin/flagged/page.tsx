'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';
import { StateMessage } from '@/components/ui/state-message';
import { toast, confirmDialog } from '@/components/Overlays';
import type { CleRow, ApiResult } from '@/lib/types';
import { Check, X } from 'lucide-react';

export default function FlaggedPage() {
  const [ples, setPlEs] = useState<CleRow[] | null>(null); // null = loading
  const [err, setErr] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null); // approve/reject in flight
  // Guard the spread/map: a non-401 error resolves with the error object (not an array); .catch a reject.
  // The fetch only sets state asynchronously (keeps the mount effect free of synchronous setState); the
  // `load` wrapper adds the error-reset for the Retry button + post-action refresh (both event handlers).
  const fetchFlagged = useCallback(() => {
    // apiFetch never rejects — a failed load is a non-array {error} body, which must read as an error,
    // not as "no sessions awaiting review".
    apiFetch<CleRow[]>('/admin/ples/flagged').then(d => { if (Array.isArray(d)) setPlEs(d); else setErr(true); }).catch(() => setErr(true));
  }, []);
  const load = () => { setErr(false); fetchFlagged(); };
  useEffect(() => { fetchFlagged(); }, [fetchFlagged]);

  async function approve(id: string) {
    setActingId(id);
    try {
      const res = await apiFetch<ApiResult<unknown>>(`/admin/ples/${id}/approve`, { method: 'POST' });
      // A second approve now 409s with { error: 'Already processed' } — surface it, then
      // refresh so the stale row leaves the queue.
      if (res?.error) { toast(`ไม่สำเร็จ / Failed: ${String(res.error)}`, 'error'); load(); return; }
      load();
    } catch { toast('เกิดข้อผิดพลาด / Error approving session', 'error'); }
    finally { setActingId(null); }
  }

  async function reject(id: string) {
    // Rejecting denies the physician credit for this session — confirm before the irreversible action.
    const ok = await confirmDialog({
      title: 'ปฏิเสธ session นี้? / Reject this session?',
      body: 'ผู้เรียนจะไม่ได้รับเครดิตสำหรับเซสชันนี้ / The physician will not receive credit for this session.',
      danger: true, confirmLabel: 'ปฏิเสธ / Reject',
    });
    if (!ok) return;
    setActingId(id);
    try {
      const res = await apiFetch<ApiResult<unknown>>(`/admin/ples/${id}/reject`, { method: 'POST' });
      if (res?.error) { toast(`ไม่สำเร็จ / Failed: ${String(res.error)}`, 'error'); load(); return; }
      load();
    } catch { toast('เกิดข้อผิดพลาด / Error rejecting session', 'error'); }
    finally { setActingId(null); }
  }

  return (
    <>
      <div className="max-w-3xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · QA Queue"
        title="ตรวจสอบ Tier 2"
        subtitle="QA Queue — sessions flagged for manual review (C4–C6)"
      />
      {err
        ? <StateMessage kind="error" center onRetry={load} title="โหลดคิวไม่สำเร็จ / Could not load the queue." />
        : ples === null
        ? <StateMessage kind="loading" center title="กำลังโหลด… / Loading…" />
        : ples.length === 0
        ? <StateMessage kind="empty" center title="ไม่มี session รอตรวจสอบ / No sessions awaiting review." />
        : ples.map(p => (
          <div key={p.id} className="border rounded-xl p-5 mb-3">
            <div className="flex flex-col gap-3 @min-[520px]:flex-row @min-[520px]:items-start @min-[520px]:justify-between">
              <div className="min-w-0">
                <p className="font-semibold break-words">{p.professionals?.full_name_th ?? 'Unknown'}</p>
                <p className="text-xs text-muted-foreground">{p.turn_count} รอบ · {p.token_count} tokens</p>
                <div className="flex gap-3 mt-2 text-xs">
                  {['c4','c5','c6'].map(c => (
                    <span key={c} className={`inline-flex items-center gap-1 ${p[c+'_pass'] ? 'text-ok' : 'text-danger'}`}>
                      {c.toUpperCase()}: {p[c+'_pass'] ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button size="sm" disabled={actingId !== null} onClick={() => approve(p.id)}>
                  {actingId === p.id ? 'กำลังบันทึก…' : <><Check className="size-4" /> อนุมัติ / Approve</>}
                </Button>
                <Button size="sm" variant="destructive" disabled={actingId !== null} onClick={() => reject(p.id)}>
                  {actingId === p.id ? 'กำลังบันทึก…' : <><X className="size-4" /> ปฏิเสธ / Reject</>}
                </Button>
              </div>
            </div>
          </div>
        ))
      }
    </div>
    </>
  );
}
