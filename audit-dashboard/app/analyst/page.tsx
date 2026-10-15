'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { IccPanel } from '@/components/IccPanel';
import { ThreeWayIcc } from '@/components/ThreeWayIcc';
import { RaterSpreadPanel } from '@/components/RaterSpread';
import { PageIntro } from '@/components/PageIntro';
import { Skeleton } from '@/components/Skeleton';
import { DOMAIN_LABELS } from '@/lib/labels';
import type { IccData, RaterSpread } from '@/lib/types';

// Tier-3 analyst: aggregated de-identified data only — status counts + ICC. No transcripts.
type Stats = { counts: Record<string, number>; total: number };
const STATUS_LABEL: Record<string, string> = {
  ple_pass: 'ผ่านเกณฑ์ / Passed', ple_fail_t1: 'ไม่ผ่าน Tier-1', ple_flag_t2: 'รอ QA (Tier-2)',
  evaluated: 'ประเมินแล้ว / Evaluated', ended: 'จบ (รอประเมิน)', active: 'กำลังทำ / Active',
};

export default function AnalystPage() {
  const router = useRouter();
  const [icc, setIcc] = useState<IccData | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [spread, setSpread] = useState<RaterSpread | null>(null);
  useEffect(() => {
    const role = getUser()?.role;
    if (role !== 'analyst' && role !== 'superadmin') { router.push('/home'); return; }
    apiFetch<IccData>('/oversight/icc').then(setIcc).catch(() => setIcc({ overall: null }));
    apiFetch<Stats>('/oversight/stats').then(setStats).catch(() => setStats({ counts: {}, total: 0 }));
    // Beside the ICC deliberately: the ICC says something is wrong, this says what.
    apiFetch<RaterSpread>('/oversight/rater-spread').then(setSpread).catch(() => setSpread(null));
  }, [router]);

  return (
    <div className="max-w-4xl mx-auto p-6 md:p-10 space-y-6">
      <PageIntro
        eyebrow="Analyst · Aggregate (de-identified)"
        title="ภาพรวมเชิงวิเคราะห์"
        subtitle="Aggregate study analytics — PLE status + AI/Expert reliability. No transcripts."
      />

      <div className="border rounded-xl p-5">
        <h2 className="text-lg font-semibold mb-3">สถานะ PLE / PLE status {stats ? <span className="text-muted-foreground text-sm">· n = {stats.total}</span> : null}</h2>
        {!stats ? <Skeleton className="h-20 w-full" /> : (
          <div className="grid grid-cols-2 gap-3 @min-[640px]:grid-cols-3">
            {Object.entries(STATUS_LABEL).map(([k, label]) => (
              <div key={k} className="rounded-xl border p-4">
                <p className="text-2xl font-bold tabular-nums">{stats.counts[k] ?? 0}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {!icc ? <Skeleton className="h-32 w-full" />
        : !icc.overall ? <div className="text-muted-foreground">ยังไม่มีข้อมูล ICC — รอให้ Auditors ส่งคะแนน</div>
        : (
          <>
            <IccPanel {...icc.overall} />
            {icc.per_domain && (
              <div className="border rounded-xl p-5">
                <h2 className="text-lg font-semibold mb-4">ICC รายโดเมน / Per-domain</h2>
                <div className="space-y-3">
                  {Object.entries(icc.per_domain).map(([key, d], i) => (
                    <div key={key} className="flex items-center gap-3">
                      <span className="w-12 text-xs text-muted-foreground">{DOMAIN_LABELS[i]}</span>
                      <div className="flex-1 bg-muted rounded-full h-4 relative overflow-hidden">
                        <div className={`h-full rounded-full ${(d?.icc ?? 0) >= 0.75 ? 'bg-[var(--chart-pass)]' : 'bg-destructive'}`}
                          style={{ width: `${Math.max(0, (d?.icc ?? 0)) * 100}%` }} />
                      </div>
                      <span className="text-sm font-mono w-14">{d?.icc?.toFixed(3) ?? '—'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

      {/* Rendered ABOVE the three-way comparison and immediately after the ICC, because it is the
          explanation of the number just shown. An ICC of -0.315 read alone says the AI is wrong
          about the episodes; this says the episodes barely differ from one another, which is a
          different problem with a different fix. */}
      <RaterSpreadPanel data={spread} />

      {/* Shadow-evaluator three-way agreement. Rendered outside the /oversight/icc branch above
          because it has its OWN endpoint and its own empty state (the candidate model may not be
          collecting yet). Analyst/ethics/superadmin only — never an auditor-reachable page. */}
      <ThreeWayIcc />
    </div>
  );
}
