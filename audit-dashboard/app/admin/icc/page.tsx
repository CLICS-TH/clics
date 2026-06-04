'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { IccPanel } from '@/components/IccPanel';
import { BlandAltmanPlot } from '@/components/BlandAltmanPlot';

const DOMAIN_LABELS = ['CQI','RD','CI','II','CA','RS','ALPS'];

export default function IccPage() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { apiFetch<any>('/admin/icc').then(setData); }, []);

  if (!data) return <div className="p-8 text-slate-400">กำลังโหลด...</div>;
  if (!data.overall) return <div className="p-8 text-slate-400">ยังไม่มีข้อมูล ICC — รอให้ Auditors ส่งคะแนน</div>;

  const { overall, per_domain } = data;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <h1 className="text-xl font-bold">ICC Dashboard</h1>
      <IccPanel {...overall} />
      {per_domain && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-4">ICC รายโดเมน</h2>
          <div className="space-y-3">
            {Object.entries(per_domain).map(([key, d]: any, i) => (
              <div key={key} className="flex items-center gap-3">
                <span className="w-12 text-xs text-slate-500">{DOMAIN_LABELS[i]}</span>
                <div className="flex-1 bg-slate-100 rounded-full h-4 relative overflow-hidden">
                  <div className={`h-full rounded-full ${(d?.icc??0) >= 0.75 ? 'bg-green-500' : 'bg-red-400'}`}
                    style={{ width: `${Math.max(0, (d?.icc ?? 0)) * 100}%` }} />
                </div>
                <span className="text-sm font-mono w-14">{d?.icc?.toFixed(3) ?? '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
