'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';

export default function FlaggedPage() {
  const [ples, setPlEs] = useState<any[]>([]);
  const load = () => apiFetch<any[]>('/admin/ples/flagged').then(d => setPlEs(d ?? []));
  useEffect(() => { load(); }, []);

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-6">QA Queue — Tier 2 Flagged Sessions</h1>
      {ples.length === 0
        ? <p className="text-slate-400 text-center py-10">ไม่มี session รอตรวจสอบ ✅</p>
        : ples.map(p => (
          <div key={p.id} className="border rounded-xl p-4 mb-3">
            <div className="flex justify-between items-start">
              <div>
                <p className="font-semibold">{p.professionals?.full_name_th ?? 'Unknown'}</p>
                <p className="text-xs text-slate-500">{p.turn_count} รอบ · {p.token_count} tokens</p>
                <div className="flex gap-3 mt-2 text-xs">
                  {['c4','c5','c6'].map(c => (
                    <span key={c} className={p[c+'_pass'] ? 'text-green-600' : 'text-red-500'}>
                      {c.toUpperCase()}: {p[c+'_pass'] ? '✓' : '✗'}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={async () => { await apiFetch(`/admin/ples/${p.id}/approve`, { method: 'POST' }); load(); }}>✅ อนุมัติ</Button>
                <Button size="sm" variant="destructive" onClick={async () => { await apiFetch(`/admin/ples/${p.id}/reject`, { method: 'POST' }); load(); }}>❌ ปฏิเสธ</Button>
              </div>
            </div>
          </div>
        ))
      }
    </div>
  );
}
