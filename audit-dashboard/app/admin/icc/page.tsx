'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { IccPanel } from '@/components/IccPanel';
import { BlandAltmanPlot } from '@/components/BlandAltmanPlot';
import { PageIntro } from '@/components/PageIntro';
import { Skeleton } from '@/components/Skeleton';

const DOMAIN_LABELS = ['CQI','RD','CI','II','CA','RS','ALPS'];

export default function IccPage() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { apiFetch<any>('/admin/icc').then(setData); }, []);

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

  const { overall, per_domain } = data;

  return (
    <>
      <div className="max-w-4xl mx-auto p-6 md:p-10 space-y-6">
      <PageIntro
        eyebrow="Superadmin · Calibration"
        title="ICC Dashboard"
        subtitle="Inter-rater reliability (AI vs Expert Auditor) — gate ≥ 0.75"
      />
      <IccPanel {...overall} />
      {per_domain && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-4">ICC รายโดเมน</h2>
          <div className="space-y-3">
            {Object.entries(per_domain).map(([key, d]: any, i) => (
              <div key={key} className="flex items-center gap-3">
                <span className="w-12 text-xs text-muted-foreground">{DOMAIN_LABELS[i]}</span>
                <div className="flex-1 bg-muted rounded-full h-4 relative overflow-hidden">
                  <div className={`h-full rounded-full ${(d?.icc??0) >= 0.75 ? 'bg-[#5db872]' : 'bg-destructive'}`}
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
