'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiFetchPaged } from '@/lib/api';
import { PageIntro } from '@/components/PageIntro';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StateMessage } from '@/components/ui/state-message';
import type { BoothQueueItem } from '@/lib/types';

const playedOn = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });
// The backend serves the queue 50 plays a page.
const PER_PAGE = 50;

export default function BoothQueuePage() {
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [queue, setQueue] = useState<{ plays: BoothQueueItem[]; total: number } | null>(null);
  const [err, setErr] = useState(false);
  const [turning, setTurning] = useState(false);
  const countLine = useRef<HTMLParagraphElement>(null);
  const shownPage = useRef(1);

  useEffect(() => {
    let live = true;
    apiFetchPaged<BoothQueueItem>(`/auditor/booth?page=${page}`).then(({ items, total, failed }) => {
      if (!live) return;
      if (failed) setErr(true); else setQueue({ plays: items, total });
      setTurning(false);
    });
    return () => { live = false; };
  }, [page, attempt]);
  // The list stays mounted while the next page loads; once it lands, focus moves to the count line, which names the
  // page, so a keyboard user is not dropped back at the top of the document.
  const go = (n: number) => { setTurning(true); setPage(n); };
  useEffect(() => {
    if (!turning && queue && page !== shownPage.current) { shownPage.current = page; countLine.current?.focus(); }
  }, [turning, queue, page]);
  const retry = () => { setErr(false); setQueue(null); setAttempt((a) => a + 1); };
  const pages = queue ? Math.max(1, Math.ceil(queue.total / PER_PAGE)) : 1;

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
        : queue === null
        ? <StateMessage kind="loading" center title="กำลังโหลด… / Loading…" />
        : queue.total === 0
        ? <StateMessage kind="empty" center title="ยังไม่มีกรณีศึกษาจากบูธ / No booth case studies yet." />
        : (
          <>
            <p ref={countLine} tabIndex={-1} aria-live="polite" className="mb-3 text-sm text-muted-foreground tabular-nums focus-visible:outline-none">
              {queue.total} การเล่น / plays{pages > 1 ? ` · หน้า ${page} จาก ${pages} / page ${page} of ${pages}` : ''}
            </p>
            <ul className="space-y-3" aria-busy={turning}>
              {queue.plays.map((p) => (
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
            {pages > 1 && (
              <nav aria-label="หน้า / Pages" className="mt-6 flex items-center justify-center gap-3">
                <Button variant="outline" size="icon" aria-label="หน้าที่แล้ว / Previous page" disabled={turning || page <= 1} onClick={() => go(page - 1)}>
                  <ChevronLeft />
                </Button>
                <span className="min-w-0 text-center text-sm text-muted-foreground tabular-nums">
                  หน้า {page} จาก {pages} / Page {page} of {pages}
                </span>
                <Button variant="outline" size="icon" aria-label="หน้าถัดไป / Next page" disabled={turning || page >= pages} onClick={() => go(page + 1)}>
                  <ChevronRight />
                </Button>
              </nav>
            )}
          </>
        )}
    </div>
  );
}
