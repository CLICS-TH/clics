'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { NavBar } from '@/components/NavBar';
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
      <NavBar />
      <div className="mx-auto max-w-4xl space-y-8 p-6 md:p-8">
        <div className="h-7 w-72 animate-pulse rounded bg-muted" />
        <CardGridSkeleton />
      </div>
    </>
  );
  const cards = [
    { label: 'PLEs ทั้งหมด', value: stats.total },
    { label: 'ผ่าน CLE', value: stats.cle_pass ?? 0 },
    { label: 'ประเมินแล้ว', value: stats.evaluated ?? 0 },
    { label: 'รอ QA', value: stats.cle_flag_t2 ?? 0 },
  ];
  return (
    <>
      <NavBar />
      <div className="max-w-4xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Pilot Statistics"
        title="สถิติ Pilot Study"
        subtitle="Pilot Study Statistics — ภาพรวมความคืบหน้าและคุณภาพ"
      />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {cards.map(c => (
          <div key={c.label} className="border rounded-xl p-4 text-center">
            <p className="text-3xl font-bold text-primary">{c.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{c.label}</p>
          </div>
        ))}
      </div>
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
