'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Badge } from '@/components/ui/badge';

interface PleItem { id: string; ended_at: string; turn_count: number; token_count: number; }

export default function AuditorQueue() {
  const [ples, setPlEs] = useState<PleItem[]>([]);
  const router = useRouter();

  useEffect(() => {
    const user = getUser();
    if (!user || user.role !== 'auditor') { router.push('/login'); return; }
    apiFetch<PleItem[]>('/auditor/queue').then(d => setPlEs(d ?? []));
  }, [router]);

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-6">คิวการประเมิน / Scoring Queue</h1>
      {ples.length === 0
        ? <p className="text-slate-400 text-center py-10">ยังไม่มี CLE ที่ได้รับมอบหมาย</p>
        : ples.map(p => (
          <div key={p.id} className="border rounded-xl p-4 mb-3 cursor-pointer hover:bg-slate-50"
            onClick={() => router.push(`/auditor/ples/${p.id}`)}>
            <div className="flex justify-between items-center">
              <div>
                <p className="font-semibold">CLE — {new Date(p.ended_at).toLocaleDateString('th-TH')}</p>
                <p className="text-xs text-slate-500">{p.turn_count} รอบ · {p.token_count} tokens</p>
              </div>
              <Badge variant="outline">รอประเมิน</Badge>
            </div>
          </div>
        ))
      }
    </div>
  );
}
