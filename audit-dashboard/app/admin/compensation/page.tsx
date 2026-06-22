'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { PageIntro } from '@/components/PageIntro';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/components/ViewportProvider';

// Compensation report (CLICS §12): ฿500 per completed CLE, capped at 3 (฿1500). Reporting only.
type Recipient = { physician: string | null; completed_cles: number; amount_thb: number };
type Report = { rate_thb_per_cle: number; cap_cles: number; n: number; total_thb: number; recipients: Recipient[] };

export default function CompensationPage() {
  const router = useRouter();
  const mobile = useIsMobile();
  const [data, setData] = useState<Report | null>(null);
  useEffect(() => {
    const role = getUser()?.role;
    if (role !== 'admin' && role !== 'superadmin') { router.push('/home'); return; }
    apiFetch<Report>('/admin/compensation').then(setData).catch(() => setData({ rate_thb_per_cle: 500, cap_cles: 3, n: 0, total_thb: 0, recipients: [] }));
  }, [router]);

  function downloadCsv() {
    if (!data) return;
    const head = 'physician,completed_cles,amount_thb';
    const lines = data.recipients.map((r) => `${r.physician ?? ''},${r.completed_cles},${r.amount_thb}`);
    const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'clics-compensation.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10 space-y-6">
      <PageIntro
        eyebrow="Compensation · Reporting"
        title="ค่าตอบแทนผู้เข้าร่วม"
        subtitle="฿500 per completed CLE, capped at 3 (฿1500). Reporting only — no payment is processed."
        action={<Button variant="outline" onClick={downloadCsv} disabled={!data || data.n === 0}>CSV</Button>}
      />
      {!data ? <Skeleton className="h-64 w-full" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 @min-[640px]:grid-cols-3">
            <div className="rounded-xl border p-4"><p className="text-2xl font-bold tabular-nums">{data.n}</p><p className="text-xs text-muted-foreground">ผู้รับ / Recipients</p></div>
            <div className="rounded-xl border p-4"><p className="text-2xl font-bold tabular-nums">฿{data.total_thb.toLocaleString()}</p><p className="text-xs text-muted-foreground">รวม / Total</p></div>
            <div className="rounded-xl border p-4"><p className="text-2xl font-bold tabular-nums">฿{data.rate_thb_per_cle}</p><p className="text-xs text-muted-foreground">ต่อ CLE / per CLE</p></div>
          </div>
          {data.recipients.length === 0 ? (
            <div className="text-muted-foreground">ยังไม่มีผู้ทำ CLE ครบเกณฑ์ / No physician has a passed CLE yet.</div>
          ) : mobile ? (
            /* Phone: stacked cards instead of a side-scrolling table. */
            <div className="space-y-3">
              {data.recipients.map((r, i) => (
                <div key={r.physician ?? i} className="flex items-center justify-between gap-3 rounded-xl border border-border p-4">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">{r.physician ?? '—'}</p>
                    <p className="text-xs tabular-nums text-muted-foreground">{r.completed_cles}/{data.cap_cles} CLE</p>
                  </div>
                  <p className="shrink-0 font-semibold tabular-nums">฿{r.amount_thb.toLocaleString()}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="border rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary text-left">
                  <tr><th className="p-3 font-medium">แพทย์ / Physician</th><th className="p-3 font-medium">CLE</th><th className="p-3 font-medium text-right">฿</th></tr>
                </thead>
                <tbody>
                  {data.recipients.map((r, i) => (
                    <tr key={r.physician ?? i} className="border-t">
                      <td className="p-3 font-mono">{r.physician ?? '—'}</td>
                      <td className="p-3 tabular-nums">{r.completed_cles}/{data.cap_cles}</td>
                      <td className="p-3 tabular-nums text-right">฿{r.amount_thb.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
