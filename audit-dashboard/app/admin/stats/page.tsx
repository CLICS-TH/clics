'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { PageIntro } from '@/components/PageIntro';
import { CardGridSkeleton } from '@/components/Skeleton';

export default function StatsPage() {
  const [stats, setStats] = useState<any>(null);
  const [icc, setIcc] = useState<any>(null);
  useEffect(() => {
    apiFetch('/admin/stats').then(setStats);
    apiFetch('/admin/icc').then(setIcc);
  }, []);
  if (!stats) return (
    <>
      <div className="mx-auto max-w-4xl space-y-8 p-6 md:p-8">
        <div className="h-7 w-72 animate-pulse rounded bg-muted" />
        <CardGridSkeleton />
      </div>
    </>
  );
  // Cover EVERY status so the cards reconcile to the total (Evaluated + Awaiting QA + Did-not-pass
  // + In-progress = Total). Previously cle_fail_t1 had no card, so the numbers never added up.
  const inProgress = (stats.active ?? 0) + (stats.ended ?? 0) + (stats.cle_pass ?? 0);
  // Each card drills into /admin/ples filtered by that category (key '' = all).
  const cards = [
    { label: 'PLEs ทั้งหมด / Total', value: stats.total, key: '' },
    { label: 'ประเมินแล้ว / Evaluated', value: stats.evaluated ?? 0, key: 'evaluated' },
    { label: 'รอ QA / Awaiting QA', value: stats.cle_flag_t2 ?? 0, key: 'cle_flag_t2' },
    { label: 'ไม่ผ่านเกณฑ์ / Did not pass', value: stats.cle_fail_t1 ?? 0, key: 'cle_fail_t1' },
    { label: 'กำลังดำเนินการ / In progress', value: inProgress, key: 'in_progress' },
  ];
  return (
    <>
      <div className="max-w-4xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Pilot Statistics"
        title="สถิติ Pilot Study"
        subtitle="Pilot Study Statistics — ภาพรวมความคืบหน้าและคุณภาพ"
      />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-2">
        {cards.map(c => (
          <a key={c.label} href={`/admin/ples${c.key ? `?status=${c.key}` : ''}`}
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
          <p className={`text-sm font-medium mt-1 ${icc.overall.icc >= 0.75 ? 'text-[#5db872]' : 'text-destructive'}`}>
            {icc.overall.interpretation}
          </p>
        </div>
      )}
    </div>
    </>
  );
}
