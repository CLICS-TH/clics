'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';

interface PleItem { id: string; ended_at: string; turn_count: number; token_count: number; scored?: boolean; }

export default function AuditorQueue() {
  const [ples, setPlEs] = useState<PleItem[]>([]);
  const router = useRouter();

  useEffect(() => {
    const user = getUser();
    const allowed = user && (user.role === 'auditor' || (user.role === 'physician' && user.can_audit));
    if (!allowed) { router.push('/login'); return; }
    // Unscored first, so the items still to do sit at the top.
    apiFetch<PleItem[]>('/auditor/queue').then(d =>
      setPlEs([...(d ?? [])].sort((a, b) => Number(!!a.scored) - Number(!!b.scored)))
    );
  }, [router]);

  const toScore = ples.filter(p => !p.scored).length;

  return (
    <>
      <div className="max-w-2xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Auditor · Scoring Queue"
        title="คิวการประเมิน"
        subtitle="Blind PIS-7 scoring — เลือก CLE เพื่อให้คะแนน (คะแนน AI ถูกซ่อนไว้)"
      />
      {ples.length > 0 && (
        <p className="text-sm text-muted-foreground mb-4">
          เหลือ <span className="font-semibold text-foreground">{toScore}</span> รอประเมิน / {toScore} to score
          {toScore === 0 && ' — ประเมินครบแล้ว ✓'}
        </p>
      )}
      {ples.length === 0
        ? <p className="text-muted-foreground text-center py-10">ยังไม่มี CLE ที่ได้รับมอบหมาย</p>
        : ples.map(p => (
          <div key={p.id} className={`border rounded-xl p-5 mb-3 cursor-pointer transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-md motion-reduce:transform-none motion-reduce:transition-none ${p.scored ? 'opacity-60' : ''}`}
            onClick={() => router.push(`/auditor/ples/${p.id}`)}>
            <div className="flex justify-between items-center">
              <div>
                <p className="font-semibold">CLE — {new Date(p.ended_at).toLocaleDateString('th-TH')}</p>
                <p className="text-xs text-muted-foreground">{p.turn_count} รอบ · {p.token_count} tokens</p>
              </div>
              {p.scored
                ? <Badge variant="default">✓ ให้คะแนนแล้ว</Badge>
                : <Badge variant="outline">รอประเมิน</Badge>}
            </div>
          </div>
        ))
      }
    </div>
    </>
  );
}
