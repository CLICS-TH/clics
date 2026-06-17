'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { cleStatusCards } from '@/lib/labels';
import { PageIntro } from '@/components/PageIntro';
import { CardGridSkeleton } from '@/components/Skeleton';
import type { CleStats, IccData } from '@/lib/types';

export default function StatsPage() {
  const [stats, setStats] = useState<CleStats | null>(null);
  const [icc, setIcc] = useState<IccData | null>(null);
  const [statsErr, setStatsErr] = useState(false);
  useEffect(() => {
    // .catch so a failed load shows an error instead of hanging on the skeleton forever.
    apiFetch<CleStats>('/admin/stats').then(setStats).catch(() => setStatsErr(true));
    // /admin/icc is superadmin-only — for admins it 403s and the section silently hides,
    // so don't fire the request at all unless the viewer is a superadmin.
    if (getUser()?.role === 'superadmin') apiFetch<IccData>('/admin/icc').then(setIcc).catch(() => {});
  }, []);
  if (statsErr) return (
    <div className="mx-auto max-w-4xl p-6 md:p-8 text-center">
      <p className="text-muted-foreground mb-3">โหลดสถิติไม่สำเร็จ / Could not load stats.</p>
      <button className="text-sm text-primary underline" onClick={() => location.reload()}>ลองใหม่ / Retry</button>
    </div>
  );
  if (!stats) return (
    <>
      <div className="mx-auto max-w-4xl space-y-8 p-6 md:p-8">
        <div className="h-7 w-72 animate-pulse rounded bg-muted" />
        <CardGridSkeleton />
      </div>
    </>
  );
  // Shared card set (lib/labels.ts) — every status covered so the cards reconcile to the total.
  // Each card drills into /admin/cles filtered by that category (key '' = all).
  const cards = cleStatusCards(stats);
  return (
    <>
      <div className="max-w-4xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Pilot Statistics"
        title="สถิติ Pilot Study"
        subtitle="Pilot Study Statistics — ภาพรวมความคืบหน้าและคุณภาพ"
      />
      <div className="grid grid-cols-2 @min-[768px]:grid-cols-5 gap-4 mb-2">
        {cards.map(c => (
          <a key={c.label} href={`/admin/cles${c.key ? `?status=${c.key}` : ''}`}
            className="border rounded-xl p-4 text-center block hover:bg-secondary hover:border-primary/40 transition-colors cursor-pointer"
            title="คลิกเพื่อดูรายชื่อในหมวดนี้ / Click to explore this category">
            <p className="text-3xl font-bold text-primary">{c.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{c.label}</p>
          </a>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mb-8">
        คลิกการ์ดเพื่อดูรายการในหมวดนั้น · Click a card to explore its sessions · ประเมินแล้ว + รอ QA + ไม่ผ่านเกณฑ์ + กำลังดำเนินการ = ทั้งหมด
      </p>
      {icc?.overall && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-2">ICC ปัจจุบัน (AI vs Auditor)</h2>
          <p className="text-3xl font-bold text-primary">{icc.overall.icc}</p>
          <p className="text-sm text-muted-foreground">95% CI: [{icc.overall.lower}, {icc.overall.upper}] · n={icc.overall.n}</p>
          <p className={`text-sm font-medium mt-1 ${(icc.overall.icc ?? 0) >= 0.75 ? 'text-[var(--ok)]' : 'text-destructive'}`}>
            {icc.overall.interpretation}
          </p>
        </div>
      )}
    </div>
    </>
  );
}
