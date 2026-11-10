'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { PageIntro } from '@/components/PageIntro';
import { Badge } from '@/components/ui/badge';
import { StateMessage } from '@/components/ui/state-message';
import type { BoothQueueItem } from '@/lib/types';

const playedOn = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });

export default function BoothQueuePage() {
  const [plays, setPlays] = useState<BoothQueueItem[] | null>(null);
  const [err, setErr] = useState(false);

  const fetchQueue = useCallback(() => {
    apiFetch<BoothQueueItem[]>('/auditor/booth').then((d) => {
      if (Array.isArray(d)) setPlays(d); else setErr(true);
    });
  }, []);
  useEffect(() => { fetchQueue(); }, [fetchQueue]);
  const retry = () => { setErr(false); setPlays(null); fetchQueue(); };

  return (
    <div className="mx-auto max-w-2xl p-6 md:p-10">
      <PageIntro
        eyebrow="Auditor · Booth case studies"
        title="กรณีศึกษาจากบูธ"
        subtitle="ฝึกให้คะแนน ไม่นับในงานวิจัยนำร่อง / Practice scoring, not counted in the pilot. Score blind, then compare with the demo score."
        action={<Link href="/auditor/queue" className="text-sm font-medium text-link underline underline-offset-2">← คิว / Queue</Link>}
      />
      {err
        ? <StateMessage kind="error" center onRetry={retry} title="โหลดกรณีศึกษาไม่สำเร็จ / Could not load the case studies." />
        : plays === null
        ? <StateMessage kind="loading" center title="กำลังโหลด… / Loading…" />
        : plays.length === 0
        ? <StateMessage kind="empty" center title="ยังไม่มีกรณีศึกษาจากบูธ / No booth case studies yet." />
        : (
          <ul className="space-y-3">
            {plays.map((p) => (
              <li key={p.id}>
                <Link href={`/auditor/booth/${p.id}`}
                  className={`block rounded-xl border p-5 hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${p.audited ? 'bg-muted/50' : ''}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-[1_1_14rem] space-y-1">
                      <p className="font-medium text-foreground [overflow-wrap:anywhere]">{p.case.teaser.th}</p>
                      <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{p.case.teaser.en}</p>
                      <p className="text-sm text-muted-foreground tabular-nums">เล่นเมื่อ / Played {playedOn(p.played_on)}</p>
                    </div>
                    {p.audited
                      ? <Badge variant="default" className="shrink-0"><Check className="size-3.5" /> ให้คะแนนแล้ว / Scored</Badge>
                      : <Badge variant="outline" className="shrink-0">รอประเมิน / To score</Badge>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
