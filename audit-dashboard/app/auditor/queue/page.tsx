'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { getUser, canAudit } from '@/lib/auth';
import { Badge } from '@/components/ui/badge';
import { Check } from 'lucide-react';
import { PageIntro } from '@/components/PageIntro';
import { Input } from '@/components/ui/input';
import { StateMessage } from '@/components/ui/state-message';

interface CleItem {
  id: string; ended_at: string; turn_count: number; token_count: number; scored?: boolean;
  // Optional case/pseudonym fields — included in the client-side filter when the API sends them.
  pseudonym?: string | null; title?: string | null; chief_complaint?: string | null;
}

export default function AuditorQueue() {
  const [ples, setPlEs] = useState<CleItem[] | null>(null); // null = still loading
  const [err, setErr] = useState(false);
  const [filter, setFilter] = useState(''); // client-side only — the queue is small
  const router = useRouter();

  // Fetch only sets state in its async callbacks — keeping the synchronous loading-reset out of the
  // mount effect (react-hooks/set-state-in-effect). Defensive: a 500 resolves with a non-array error
  // body, so guard the spread (it used to throw and blank the page); .catch surfaces a network reject
  // as an error, not a false "empty".
  const fetchQueue = useCallback(() => {
    apiFetch<CleItem[]>('/auditor/queue')
      .then(d => setPlEs(Array.isArray(d) ? [...d].sort((a, b) => Number(!!a.scored) - Number(!!b.scored)) : []))
      .catch(() => setErr(true));
  }, []);

  // Retry is a user event (setState here is fine): reset to the loading state, then refetch.
  const retry = () => { setErr(false); setPlEs(null); fetchQueue(); };

  useEffect(() => {
    if (!canAudit(getUser())) { router.push('/login'); return; }
    fetchQueue();
  }, [fetchQueue, router]);

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
        subtitle="Blind PIS-7 scoring — เลือก PLE เพื่อให้คะแนน (คะแนน AI ถูกซ่อนไว้)"
      />
      {list.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            เหลือ <span className="font-semibold text-foreground">{toScore}</span> รอประเมิน / {toScore} to score
            {toScore === 0 && ' — ประเมินครบแล้ว / all scored'}
          </p>
          <Input
            className="mb-4 max-w-sm"
            placeholder="ค้นหา / Filter…"
            aria-label="ค้นหาในคิว / Filter the queue"
            value={filter} onChange={e => setFilter(e.target.value)} />
        </>
      )}
      {err
        ? <StateMessage kind="error" center onRetry={retry} title="โหลดคิวไม่สำเร็จ / Could not load the queue.">
            ติดต่อเซิร์ฟเวอร์ไม่ได้ ลองอีกครั้ง หากยังไม่สำเร็จให้แจ้งผู้ดูแลระบบ /
            The server could not be reached. Try again, and tell your administrator if it keeps failing.
          </StateMessage>
        : ples === null
        ? <StateMessage kind="loading" center title="กำลังโหลด… / Loading…" />
        : list.length === 0
        ? <StateMessage kind="empty" center title="ยังไม่มี PLE ที่ได้รับมอบหมาย / No PLEs assigned yet." />
        : visible.length === 0
        ? <StateMessage kind="empty" center title="ไม่พบรายการที่ตรงกับคำค้น / No items match the filter." />
        : visible.map(p => (
          // role + tabIndex + keydown: a bare <div onClick> is not in the tab order, so an auditor
          // could not open a queued PLE without a pointer. Mirrors the fix already in the physician
          // portal (physician-ui/public/js/dashboard.js:308 and its keydown handler).
          <div key={p.id} role="button" tabIndex={0}
            aria-label={`เปิด PLE วันที่ ${new Date(p.ended_at).toLocaleDateString('th-TH')} / Open PLE`}
            className={`border rounded-xl p-5 mb-3 cursor-pointer transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transform-none motion-reduce:transition-none ${p.scored ? 'bg-muted/50' : ''}`}
            onClick={() => router.push(`/auditor/ples/${p.id}`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); router.push(`/auditor/ples/${p.id}`); }
            }}>
            <div className="flex justify-between items-center">
              <div>
                <p className="font-semibold">PLE — {new Date(p.ended_at).toLocaleDateString('th-TH')}</p>
                <p className="text-xs text-muted-foreground">{p.turn_count} รอบ · {p.token_count} tokens</p>
              </div>
              {p.scored
                ? <Badge variant="default"><Check className="size-3.5" /> ให้คะแนนแล้ว</Badge>
                : <Badge variant="outline">รอประเมิน</Badge>}
            </div>
          </div>
        ))
      }
    </div>
    </>
  );
}
