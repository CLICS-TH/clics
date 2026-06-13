'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { getUser, canAudit } from '@/lib/auth';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';

interface PleItem {
  id: string; ended_at: string; turn_count: number; token_count: number; scored?: boolean;
  // Optional case/pseudonym fields — included in the client-side filter when the API sends them.
  pseudonym?: string | null; title?: string | null; chief_complaint?: string | null;
}

export default function AuditorQueue() {
  const [ples, setPlEs] = useState<PleItem[] | null>(null); // null = still loading
  const [err, setErr] = useState(false);
  const [filter, setFilter] = useState(''); // client-side only — the queue is small
  const router = useRouter();

  const load = () => {
    setErr(false); setPlEs(null);
    // Defensive: a 500 resolves with a non-array error body — guard the spread (it used to throw and
    // blank the page), and .catch a network reject so the auditor sees an error, not a false "empty".
    apiFetch<PleItem[]>('/auditor/queue')
      .then(d => setPlEs(Array.isArray(d) ? [...d].sort((a, b) => Number(!!a.scored) - Number(!!b.scored)) : []))
      .catch(() => setErr(true));
  };

  useEffect(() => {
    if (!canAudit(getUser())) { router.push('/login'); return; }
    load();
  }, [router]);

  const list = ples ?? [];
  const toScore = list.filter(p => !p.scored).length;

  // Narrow the visible rows by pseudonym / case text (plus the row's visible date/counts).
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? list.filter(p =>
        [p.pseudonym, p.title, p.chief_complaint, p.id,
         new Date(p.ended_at).toLocaleDateString('th-TH'),
         `${p.turn_count} รอบ`, `${p.token_count} tokens`]
          .filter(Boolean).join(' ').toLowerCase().includes(needle))
    : list;

  return (
    <>
      <div className="max-w-2xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Auditor · Scoring Queue"
        title="คิวการประเมิน"
        subtitle="Blind PIS-7 scoring — เลือก CLE เพื่อให้คะแนน (คะแนน AI ถูกซ่อนไว้)"
      />
      {list.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            เหลือ <span className="font-semibold text-foreground">{toScore}</span> รอประเมิน / {toScore} to score
            {toScore === 0 && ' — ประเมินครบแล้ว ✓'}
          </p>
          <input
            className="w-full max-w-sm border rounded-lg px-3 py-2 text-sm mb-4 bg-background"
            placeholder="ค้นหา / Filter…"
            value={filter} onChange={e => setFilter(e.target.value)} />
        </>
      )}
      {err
        ? <div className="text-center py-10">
            <p className="text-muted-foreground mb-3">โหลดคิวไม่สำเร็จ / Could not load the queue.</p>
            <button className="text-sm text-primary underline" onClick={load}>ลองใหม่ / Retry</button>
          </div>
        : ples === null
        ? <p className="text-muted-foreground text-center py-10">กำลังโหลด… / Loading…</p>
        : list.length === 0
        ? <p className="text-muted-foreground text-center py-10">ยังไม่มี CLE ที่ได้รับมอบหมาย / No CLEs assigned yet.</p>
        : visible.length === 0
        ? <p className="text-muted-foreground text-center py-10">ไม่พบรายการที่ตรงกับคำค้น / No items match the filter.</p>
        : visible.map(p => (
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
