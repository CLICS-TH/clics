'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';
import { toast, confirmDialog } from '@/components/Overlays';
import { Check, X } from 'lucide-react';

export default function FlaggedPage() {
  const [ples, setPlEs] = useState<any[] | null>(null); // null = loading
  const [err, setErr] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null); // approve/reject in flight
  // Guard the spread/map: a non-401 error resolves with the error object (not an array); .catch a reject.
  const load = () => { setErr(false); apiFetch<any[]>('/admin/ples/flagged').then(d => setPlEs(Array.isArray(d) ? d : [])).catch(() => setErr(true)); };
  useEffect(() => { load(); }, []);

  async function approve(id: string) {
    setActingId(id);
    try {
      const res: any = await apiFetch(`/admin/ples/${id}/approve`, { method: 'POST' });
      // A second approve now 409s with { error: 'Already processed' } — surface it, then
      // refresh so the stale row leaves the queue.
      if (res?.error) { toast(`ไม่สำเร็จ / Failed: ${res.error}`, 'error'); load(); return; }
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
      const res: any = await apiFetch(`/admin/ples/${id}/reject`, { method: 'POST' });
      if (res?.error) { toast(`ไม่สำเร็จ / Failed: ${res.error}`, 'error'); load(); return; }
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
        ? <div className="text-center py-10">
            <p className="text-muted-foreground mb-3">โหลดคิวไม่สำเร็จ / Could not load the queue.</p>
            <button className="text-sm text-primary underline" onClick={load}>ลองใหม่ / Retry</button>
          </div>
        : ples === null
        ? <p className="text-muted-foreground text-center py-10">กำลังโหลด… / Loading…</p>
        : ples.length === 0
        ? <p className="text-muted-foreground text-center py-10">ไม่มี session รอตรวจสอบ / No sessions awaiting review.</p>
        : ples.map(p => (
          <div key={p.id} className="border rounded-xl p-5 mb-3">
            <div className="flex justify-between items-start">
              <div>
                <p className="font-semibold">{p.professionals?.full_name_th ?? 'Unknown'}</p>
                <p className="text-xs text-muted-foreground">{p.turn_count} รอบ · {p.token_count} tokens</p>
                <div className="flex gap-3 mt-2 text-xs">
                  {['c4','c5','c6'].map(c => (
                    <span key={c} className={`inline-flex items-center gap-1 ${p[c+'_pass'] ? 'text-[var(--ok)]' : 'text-destructive'}`}>
                      {c.toUpperCase()}: {p[c+'_pass'] ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
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
