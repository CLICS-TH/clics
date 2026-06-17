'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { IccPanel } from '@/components/IccPanel';
import { PageIntro } from '@/components/PageIntro';
import { Skeleton } from '@/components/Skeleton';
import { DOMAIN_LABELS } from '@/lib/labels';
import type { IccData } from '@/lib/types';

// A per-council ICC block, narrowed to the case where it carries an `overall` stat (the filter below
// guarantees it), so the render can read c.overall.icc/lower/upper/n without re-checking for null.
type RawCouncilIcc = NonNullable<NonNullable<IccData['per_council']>[string]>;
type CouncilIcc = Omit<RawCouncilIcc, 'overall'> & { overall: NonNullable<RawCouncilIcc['overall']> };

export default function IccPage() {
  const router = useRouter();
  const [data, setData] = useState<IccData | null>(null);
  useEffect(() => {
    // /admin/icc is superadmin-only (the API 403s silently otherwise) — same client gate
    // as /admin/overview: everyone else lands back on /home.
    if (getUser()?.role !== 'superadmin') { router.push('/home'); return; }
    // .catch so a network failure renders the "no data" branch instead of stranding on the skeleton
    // forever (the error boundary doesn't catch async-effect rejections). Sibling overview/stats catch too.
    apiFetch<IccData>('/admin/icc').then(setData).catch(() => setData({ overall: null }));
  }, [router]);

  if (!data) return (
    <>
      <div className="mx-auto max-w-4xl space-y-6 p-6 md:p-8">
        <div className="h-7 w-48 animate-pulse rounded bg-muted" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </>
  );
  if (!data.overall) return (
    <>
      <div className="mx-auto max-w-4xl p-6 md:p-8 text-muted-foreground">ยังไม่มีข้อมูล ICC — รอให้ Auditors ส่งคะแนน</div>
    </>
  );

  const { overall, per_domain, per_council } = data;
  const councils: CouncilIcc[] = per_council
    ? Object.values(per_council).filter((c): c is CouncilIcc => !!c?.overall)
    : [];

  return (
    <>
      <div className="max-w-4xl mx-auto p-6 md:p-10 space-y-6">
      <PageIntro
        eyebrow="Superadmin · Calibration"
        title="ICC Dashboard"
        subtitle="Inter-rater reliability (AI vs Expert Auditor) — gate ≥ 0.75"
      />
      <IccPanel {...overall} />

      {councils.length > 0 && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-1">ICC แยกตามสภาวิชาชีพ / By professional council</h2>
          <p className="text-xs text-muted-foreground mb-4">ดูความน่าเชื่อถือของแต่ละวิชาชีพแยกกัน / Each profession&apos;s calibration, separately.</p>
          <div className="grid gap-3 @min-[640px]:grid-cols-2">
            {councils.map((c) => {
              const icc = c.overall.icc; // may be null (degenerate / insufficient variance)
              const ok = icc != null && icc >= 0.75;
              return (
                <div key={c.council?.id ?? c.council?.code} className="rounded-xl border border-border p-4">
                  <p className="text-sm font-medium">{c.council?.name_th ?? '—'}</p>
                  <p className="text-xs text-muted-foreground">{c.council?.name_en ?? ''}</p>
                  <p className={`text-2xl font-bold mt-1 ${icc == null ? 'text-muted-foreground' : ok ? 'text-[var(--ok)]' : 'text-destructive'}`}>{icc?.toFixed(3) ?? '—'}</p>
                  <p className="text-xs text-muted-foreground">95% CI [{c.overall.lower?.toFixed(2) ?? '—'}, {c.overall.upper?.toFixed(2) ?? '—'}] · n = {c.overall.n}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {per_domain && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-4">ICC รายโดเมน</h2>
          <div className="space-y-3">
            {Object.entries(per_domain).map(([key, d], i) => (
              <div key={key} className="flex items-center gap-3">
                <span className="w-12 text-xs text-muted-foreground">{DOMAIN_LABELS[i]}</span>
                <div className="flex-1 bg-muted rounded-full h-4 relative overflow-hidden">
                  <div className={`h-full rounded-full ${(d?.icc??0) >= 0.75 ? 'bg-[var(--chart-pass)]' : 'bg-destructive'}`}
                    style={{ width: `${Math.max(0, (d?.icc ?? 0)) * 100}%` }} />
                </div>
                <span className="text-sm font-mono w-14">{d?.icc?.toFixed(3) ?? '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
    </>
  );
}
