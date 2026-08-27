'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, apiDownload } from '@/lib/api';
import { useAuthUser } from '@/lib/client-store';
import { PageIntro } from '@/components/PageIntro';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/components/ViewportProvider';
import { toast } from '@/components/Overlays';
import type { PayoutReport, PayoutRecipient, ApiResult } from '@/lib/types';

// Compensation payout pipeline (CLICS §12): ฿/CLE rate + cap are superadmin-configurable. The superadmin
// sees real names + masked account, marks each physician paid (a reference), and exports a payout file.
// Admins (council-scoped) see the pseudonymized report only.
type Recipient = { physician: string | null; completed_cles: number; amount_thb: number };
type Report = { rate_thb_per_cle: number; cap_cles: number; n: number; total_thb: number; recipients: Recipient[] };
type Settings = { comp_rate_thb: number; comp_cap_cles: number };

const baht = (n: number) => `฿${n.toLocaleString()}`;

export default function CompensationPage() {
  const router = useRouter();
  const mobile = useIsMobile();
  const user = useAuthUser();
  const role = user?.role;
  const [report, setReport] = useState<Report | null>(null);          // admin (pseudonymized)
  const [payouts, setPayouts] = useState<PayoutReport | null>(null);  // superadmin (real names)
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rateInput, setRateInput] = useState('');
  const [capInput, setCapInput] = useState('');
  const [payingId, setPayingId] = useState<string | null>(null);

  const isSuper = role === 'superadmin';

  const loadSuper = useCallback(() => {
    apiFetch<PayoutReport>('/admin/payouts').then(d => setPayouts(d ?? null)).catch(() => setPayouts(null));
  }, []);

  useEffect(() => {
    if (!role) return; // wait for the auth store to hydrate
    if (role !== 'admin' && role !== 'superadmin') { router.push('/home'); return; }
    if (role === 'superadmin') {
      loadSuper();
      apiFetch<Settings>('/admin/usage-settings').then(s => {
        if (s) { setSettings(s); setRateInput(String(s.comp_rate_thb)); setCapInput(String(s.comp_cap_cles)); }
      }).catch(() => {});
    } else {
      apiFetch<Report>('/admin/compensation').then(setReport).catch(() => setReport({ rate_thb_per_cle: 500, cap_cles: 3, n: 0, total_thb: 0, recipients: [] }));
    }
  }, [role, router, loadSuper]);

  async function saveSettings() {
    const rate = Number(rateInput), cap = Number(capInput);
    if (!Number.isFinite(rate) || rate < 0 || !Number.isInteger(cap) || cap < 0) {
      toast('กรอกตัวเลขที่ถูกต้อง / Enter valid numbers.', 'error'); return;
    }
    const res = await apiFetch<ApiResult<Settings>>('/admin/usage-settings', {
      method: 'PATCH', body: JSON.stringify({ comp_rate_thb: rate, comp_cap_cles: cap }),
    });
    if ((res as { error?: unknown })?.error) { toast('บันทึกไม่สำเร็จ / Save failed.', 'error'); return; }
    setSettings({ comp_rate_thb: rate, comp_cap_cles: cap });
    toast('บันทึกแล้ว / Saved. อัตรา/เพดานใหม่จะใช้กับยอดที่ค้าง', 'success');
    loadSuper();
  }

  async function markPaid(r: PayoutRecipient, amount: number, ref: string) {
    if (!Number.isFinite(amount) || amount <= 0) { toast('จำนวนเงินไม่ถูกต้อง / Invalid amount.', 'error'); return; }
    const res = await apiFetch<ApiResult<unknown>>(`/admin/payouts/${r.physician_id}/pay`, {
      method: 'POST', body: JSON.stringify({ amount_thb: amount, paid_ref: ref }),
    });
    if ((res as { error?: unknown })?.error) { toast('บันทึกการจ่ายไม่สำเร็จ / Could not record payment.', 'error'); return; }
    toast(`บันทึกการจ่าย ${baht(amount)} แล้ว / Recorded ${baht(amount)}.`, 'success');
    setPayingId(null);
    loadSuper();
  }

  async function exportPayouts() {
    const res = await apiDownload('/admin/payouts/export', 'clics-payouts.csv');
    if (res.error) toast(res.error, 'error');
  }

  // ---- Admin (pseudonymized report) ----
  function downloadReportCsv() {
    if (!report) return;
    const head = 'physician,completed_cles,amount_thb';
    const lines = report.recipients.map((r) => `${r.physician ?? ''},${r.completed_cles},${r.amount_thb}`);
    const blob = new Blob(['﻿' + [head, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'clics-compensation.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  if (role && !isSuper) {
    return (
      <div className="max-w-3xl mx-auto p-6 md:p-10 space-y-6">
        <PageIntro
          eyebrow="Compensation · Reporting"
          title="ค่าตอบแทนผู้เข้าร่วม"
          subtitle="รายงานแบบไม่ระบุตัวตน / Pseudonymized report. การจ่ายเงินจัดการโดยผู้ดูแลระบบสูงสุด"
          action={<Button variant="outline" onClick={downloadReportCsv} disabled={!report || report.n === 0}>CSV</Button>}
        />
        {!report ? <Skeleton className="h-64 w-full" /> : (
          <>
            <div className="grid grid-cols-2 gap-3 @min-[640px]:grid-cols-3">
              <Stat value={String(report.n)} label="ผู้รับ / Recipients" />
              <Stat value={baht(report.total_thb)} label="รวม / Total" />
              <Stat value={baht(report.rate_thb_per_cle)} label="ต่อ CLE / per CLE" />
            </div>
            {report.recipients.length === 0 ? (
              <Empty />
            ) : mobile ? (
              <div className="space-y-3">
                {report.recipients.map((r, i) => (
                  <div key={r.physician ?? i} className="flex items-center justify-between gap-3 rounded-xl border border-border p-4">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm">{r.physician ?? '—'}</p>
                      <p className="text-sm tabular-nums text-muted-foreground">{r.completed_cles}/{report.cap_cles || '∞'} CLE</p>
                    </div>
                    <p className="shrink-0 font-semibold tabular-nums">{baht(r.amount_thb)}</p>
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
                    {report.recipients.map((r, i) => (
                      <tr key={r.physician ?? i} className="border-t">
                        <td className="p-3 font-mono">{r.physician ?? '—'}</td>
                        <td className="p-3 tabular-nums">{r.completed_cles}/{report.cap_cles || '∞'}</td>
                        <td className="p-3 tabular-nums text-right">{baht(r.amount_thb)}</td>
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

  // ---- Superadmin (payout pipeline) ----
  const recipients = payouts?.recipients ?? [];
  const totalOutstanding = recipients.reduce((a, r) => a + r.outstanding_thb, 0);
  const totalPaid = recipients.reduce((a, r) => a + r.paid_thb, 0);

  return (
    <div className="max-w-4xl mx-auto p-6 md:p-10 space-y-6">
      <PageIntro
        eyebrow="Compensation · Payout pipeline"
        title="ค่าตอบแทนผู้เข้าร่วม / Participant payouts"
        subtitle="฿ ต่อ CLE ที่ทำสำเร็จ · จ่ายเงินตามข้อมูลที่แพทย์ให้ไว้ / Pay physicians per completed CLE using the details they provide."
        action={<Button variant="outline" onClick={exportPayouts} disabled={!payouts || payouts.n === 0}>ไฟล์จ่ายเงิน / Payout file</Button>}
      />

      {/* Rate + cap (superadmin-configurable). Cap 0 = no cap. */}
      <div className="rounded-xl border p-5 space-y-3">
        <h2 className="font-sans text-base font-semibold">อัตราค่าตอบแทน / Compensation rate</h2>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="block text-muted-foreground mb-1">฿ ต่อ CLE / per CLE</span>
            <input type="number" min={0} className="w-32 rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums"
              value={rateInput} onChange={e => setRateInput(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="block text-muted-foreground mb-1">เพดาน (CLE) / Cap — 0 = ไม่จำกัด</span>
            <input type="number" min={0} step={1} className="w-32 rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums"
              value={capInput} onChange={e => setCapInput(e.target.value)} />
          </label>
          <Button onClick={saveSettings} disabled={!settings}>บันทึก / Save</Button>
        </div>
      </div>

      {!payouts ? <Skeleton className="h-64 w-full" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 @min-[640px]:grid-cols-4">
            <Stat value={String(payouts.n)} label="ผู้รับ / Recipients" />
            <Stat value={baht(totalOutstanding)} label="ค้างจ่าย / Outstanding" tone="warn" />
            <Stat value={baht(totalPaid)} label="จ่ายแล้ว / Paid" />
            <Stat value={baht(payouts.rate_thb_per_cle)} label={`ต่อ CLE${payouts.cap_cles ? ` · cap ${payouts.cap_cles}` : ''}`} />
          </div>

          {recipients.length === 0 ? <Empty /> : (
            <div className="space-y-3">
              {recipients.map((r) => (
                // Key includes outstanding so a row remounts after a payment → the inline amount field
                // re-initializes to the new outstanding (no setState-in-effect needed).
                <PayoutRow key={`${r.physician_id}:${r.outstanding_thb}`} r={r} expanded={payingId === r.physician_id}
                  onToggle={() => setPayingId(payingId === r.physician_id ? null : r.physician_id)}
                  onPay={(amt, ref) => markPaid(r, amt, ref)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: 'warn' }) {
  return (
    <div className="rounded-xl border p-4">
      <p className={`text-2xl font-bold tabular-nums ${tone === 'warn' ? 'text-warn' : ''}`}>{value}</p>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

function Empty() {
  return <div className="text-muted-foreground">ยังไม่มีผู้ทำ CLE ครบเกณฑ์ / No physician has a completed CLE yet.</div>;
}

// One physician row with an inline "mark paid" editor (amount prefilled to outstanding + a reference).
function PayoutRow({ r, expanded, onToggle, onPay }: {
  r: PayoutRecipient; expanded: boolean; onToggle: () => void; onPay: (amount: number, ref: string) => void;
}) {
  const [amount, setAmount] = useState(String(r.outstanding_thb));
  const [ref, setRef] = useState('');

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{r.name ?? r.pseudonym ?? '—'}</p>
          <p className="text-sm text-muted-foreground tabular-nums">
            {r.completed_cles} CLE · ค้าง {baht(r.outstanding_thb)} · จ่ายแล้ว {baht(r.paid_thb)}
          </p>
          <p className="text-sm mt-0.5">
            {r.has_payment_info
              ? <span className="text-muted-foreground">{r.account_masked ?? 'มีข้อมูลการรับเงิน / payment info on file'}</span>
              : <span className="text-warn">ยังไม่ได้ให้ข้อมูลการรับเงิน / no payment info yet</span>}
          </p>
        </div>
        <Button variant={expanded ? 'outline' : 'default'} size="sm" onClick={onToggle} disabled={r.outstanding_thb <= 0}>
          {r.outstanding_thb <= 0 ? 'จ่ายครบแล้ว / Settled' : (expanded ? 'ยกเลิก / Cancel' : 'บันทึกการจ่าย / Mark paid')}
        </Button>
      </div>
      {expanded && (
        <div className="mt-3 flex flex-wrap items-end gap-3 border-t pt-3">
          <label className="text-sm">
            <span className="block text-muted-foreground mb-1">จำนวน ฿ / Amount</span>
            <input type="number" min={0} className="w-32 rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums"
              value={amount} onChange={e => setAmount(e.target.value)} />
          </label>
          <label className="text-sm flex-1 min-w-[180px]">
            <span className="block text-muted-foreground mb-1">อ้างอิง / Reference (optional)</span>
            <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="เลขที่โอน / transfer ref" value={ref} onChange={e => setRef(e.target.value)} />
          </label>
          <Button size="sm" onClick={() => onPay(Number(amount), ref)}>ยืนยัน / Confirm</Button>
        </div>
      )}
    </div>
  );
}
