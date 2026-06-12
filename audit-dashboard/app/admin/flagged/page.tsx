'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';

export default function FlaggedPage() {
  const [ples, setPlEs] = useState<any[]>([]);
  const [actingId, setActingId] = useState<string | null>(null); // approve/reject in flight
  const load = () => apiFetch<any[]>('/admin/ples/flagged').then(d => setPlEs(d ?? []));
  useEffect(() => { load(); }, []);

  async function approve(id: string) {
    setActingId(id);
    try {
      const res: any = await apiFetch(`/admin/ples/${id}/approve`, { method: 'POST' });
      // A second approve now 409s with { error: 'Already processed' } — surface it, then
      // refresh so the stale row leaves the queue.
      if (res?.error) { alert(`ไม่สำเร็จ: ${res.error}`); load(); return; }
      load();
    } catch { alert('เกิดข้อผิดพลาด / Error approving session'); }
    finally { setActingId(null); }
  }

  async function reject(id: string) {
    setActingId(id);
    try {
      const res: any = await apiFetch(`/admin/ples/${id}/reject`, { method: 'POST' });
      if (res?.error) { alert(`ไม่สำเร็จ: ${res.error}`); load(); return; }
      load();
    } catch { alert('เกิดข้อผิดพลาด / Error rejecting session'); }
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
      {ples.length === 0
        ? <p className="text-muted-foreground text-center py-10">ไม่มี session รอตรวจสอบ ✅</p>
        : ples.map(p => (
          <div key={p.id} className="border rounded-xl p-5 mb-3">
            <div className="flex justify-between items-start">
              <div>
                <p className="font-semibold">{p.professionals?.full_name_th ?? 'Unknown'}</p>
                <p className="text-xs text-muted-foreground">{p.turn_count} รอบ · {p.token_count} tokens</p>
                <div className="flex gap-3 mt-2 text-xs">
                  {['c4','c5','c6'].map(c => (
                    <span key={c} className={p[c+'_pass'] ? 'text-[var(--ok)]' : 'text-destructive'}>
                      {c.toUpperCase()}: {p[c+'_pass'] ? '✓' : '✗'}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={actingId !== null} onClick={() => approve(p.id)}>
                  {actingId === p.id ? 'กำลังบันทึก…' : '✅ อนุมัติ'}
                </Button>
                <Button size="sm" variant="destructive" disabled={actingId !== null} onClick={() => reject(p.id)}>❌ ปฏิเสธ</Button>
              </div>
            </div>
          </div>
        ))
      }
    </div>
    </>
  );
}
