'use client';
// Governance: data retention and the monthly security review (CREC082 DMP §8, ICF §11,
// Infrastructure Statement "Security review"). Superadmin only — the endpoints 403 for admins.
//
// The retention half is deliberately hard to fire. It clears the identity vault, the national IDs,
// the PII maps and the patient references, and it cannot be undone. So this screen leads with what
// WOULD happen and what is explicitly excluded, and the button stays disabled until the deadline has
// passed and the confirmation phrase has been typed exactly.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';
import { toast } from '@/components/Overlays';
import type { ApiResult } from '@/lib/types';
import { ShieldAlert, CalendarClock, Lock } from 'lucide-react';

interface Target { table: string; action: 'delete' | 'nullify'; columns?: string[]; why: string; rows: number | null }
interface Excluded { table: string; why: string }
interface Plan {
  project_end_date: string | null; retention_years: number; due_at: string | null; due: boolean;
  targets: Target[]; excluded: Excluded[]; confirm_phrase: string;
}
interface Review {
  id: string; period_month: string; reviewed_at: string;
  access_review?: string | null; audit_review?: string | null; incident_review?: string | null;
  incidents_found: boolean; notes?: string | null;
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function GovernancePage() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [endDate, setEndDate] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ period_month: thisMonth(), access_review: '', audit_review: '', incident_review: '', incidents_found: false, notes: '' });

  const load = useCallback(() => {
    apiFetch<Plan>('/superadmin/retention').then(d => { setPlan(d); setEndDate(d?.project_end_date ?? ''); }).catch(() => {});
    apiFetch<{ reviews: Review[] }>('/superadmin/security-reviews?limit=24')
      .then(d => setReviews(Array.isArray(d?.reviews) ? d.reviews : [])).catch(() => setReviews([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function savePolicy() {
    setBusy(true);
    try {
      const res = await apiFetch<ApiResult<unknown>>('/superadmin/retention', {
        method: 'PATCH', body: JSON.stringify({ project_end_date: endDate || null }),
      });
      if (res?.error) { toast(String(res.error), 'error'); return; }
      toast('บันทึกแล้ว / Saved', 'success'); load();
    } finally { setBusy(false); }
  }

  async function runDeidentify() {
    setBusy(true);
    try {
      const res = await apiFetch<ApiResult<unknown>>('/superadmin/retention/deidentify', {
        method: 'POST', body: JSON.stringify({ confirm }),
      });
      if (res?.error) { toast(String(res.error), 'error'); return; }
      toast('ดำเนินการแล้ว / Completed', 'success'); setConfirm(''); load();
    } finally { setBusy(false); }
  }

  async function saveReview() {
    if (!form.access_review && !form.audit_review && !form.incident_review) {
      toast('บันทึกสิ่งที่ตรวจอย่างน้อยหนึ่งด้าน / Record at least one of the three parts', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<ApiResult<unknown>>('/superadmin/security-reviews', { method: 'POST', body: JSON.stringify(form) });
      if (res?.error) { toast(String(res.error), 'error'); return; }
      toast('บันทึกแล้ว / Recorded', 'success');
      setForm({ period_month: thisMonth(), access_review: '', audit_review: '', incident_review: '', incidents_found: false, notes: '' });
      load();
    } finally { setBusy(false); }
  }

  const armed = !!plan?.due && confirm === plan.confirm_phrase;
  const field = 'mt-1.5 w-full rounded-lg border bg-background p-2.5 text-sm';

  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <PageIntro eyebrow="Superadmin · Governance" title="การเก็บรักษาข้อมูลและการทบทวนความปลอดภัย"
        subtitle="Retention, de-identification, and the monthly security review (CREC082 §8, §11)" />

      {/* ---- Retention ---------------------------------------------------------------------- */}
      <section className="border rounded-xl p-5 mb-6">
        <h2 className="flex items-center gap-2 font-semibold"><CalendarClock className="size-4" /> การเก็บรักษาข้อมูล <span className="text-muted-foreground font-normal">/ Retention</span></h2>
        <p className="mt-1 text-sm text-muted-foreground">
          ข้อมูลวิจัยเก็บไม่เกิน {plan?.retention_years ?? 5} ปีหลังสิ้นสุดโครงการ แล้วทำให้ไม่สามารถเชื่อมโยงกลับได้ / Research data is kept for at most {plan?.retention_years ?? 5} years after the project ends, then de-identified.
        </p>

        <label className="mt-4 block text-sm font-medium" htmlFor="endDate">วันสิ้นสุดโครงการ / Project end date</label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <input id="endDate" type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            className="rounded-lg border bg-background p-2.5 text-sm" />
          <Button size="sm" variant="outline" disabled={busy} onClick={savePolicy}>บันทึก / Save</Button>
        </div>
        <p className="mt-2 text-sm">
          {plan?.due_at
            ? <>ครบกำหนด / Due: <b className="tabular-nums">{plan.due_at}</b>{plan.due ? ' — ถึงกำหนดแล้ว / due now' : ''}</>
            : <span className="text-muted-foreground">ยังไม่ได้ตั้งวันสิ้นสุดโครงการ — ยังไม่มีอะไรครบกำหนด / No project end date set, so nothing is due.</span>}
        </p>

        {plan && (
          <>
            <h3 className="mt-5 text-sm font-medium">จะถูกลบหรือล้างค่า / What would be cleared</h3>
            <ul className="mt-1.5 space-y-1.5">
              {plan.targets.map(t => (
                <li key={t.table} className="text-xs">
                  <span className="font-mono">{t.table}</span>{' '}
                  <span className={t.action === 'delete' ? 'text-danger' : 'text-muted-foreground'}>
                    {t.action === 'delete' ? 'ลบทั้งแถว / delete' : `ล้างค่า / clear: ${t.columns?.join(', ')}`}
                  </span>{' '}
                  <span className="text-muted-foreground tabular-nums">({t.rows ?? '?'} rows)</span>
                  <p className="text-muted-foreground">{t.why}</p>
                </li>
              ))}
            </ul>

            <h3 className="mt-4 flex items-center gap-1.5 text-sm font-medium"><Lock className="size-3.5" /> ไม่ถูกแตะต้อง / Excluded by policy</h3>
            <ul className="mt-1.5 space-y-1">
              {plan.excluded.map(e => (
                <li key={e.table} className="text-xs">
                  <span className="font-mono">{e.table}</span>
                  <p className="text-muted-foreground">{e.why}</p>
                </li>
              ))}
            </ul>

            <div className="mt-5 rounded-lg border border-destructive/40 p-4">
              <p className="flex items-center gap-2 text-sm font-medium text-danger">
                <ShieldAlert className="size-4 shrink-0" /> ย้อนกลับไม่ได้ / This cannot be undone
              </p>
              <label className="mt-3 block text-xs text-muted-foreground" htmlFor="confirmPhrase">
                พิมพ์ข้อความยืนยันให้ตรงทุกตัวอักษร / Type the confirmation phrase exactly:
                <code className="ml-1 select-all font-mono text-foreground">{plan.confirm_phrase}</code>
              </label>
              <input id="confirmPhrase" value={confirm} onChange={e => setConfirm(e.target.value)}
                autoComplete="off" spellCheck={false} className={field} />
              <Button size="sm" variant="destructive" className="mt-3" disabled={!armed || busy} onClick={runDeidentify}>
                ดำเนินการ / Run de-identification
              </Button>
              {!plan.due && <p className="mt-2 text-xs text-muted-foreground">ยังไม่ถึงกำหนด — ปุ่มจะเปิดใช้งานเมื่อครบกำหนด / Not due yet; the button unlocks on the due date.</p>}
            </div>
          </>
        )}
      </section>

      {/* ---- Monthly security review -------------------------------------------------------- */}
      <section className="border rounded-xl p-5">
        <h2 className="font-semibold">การทบทวนความปลอดภัยรายเดือน <span className="text-muted-foreground font-normal">/ Monthly security review</span></h2>
        <p className="mt-1 text-sm text-muted-foreground">
          สามส่วนตามที่ระบุไว้: การเข้าถึง · audit log · เหตุการณ์ / The three parts the protocol names: access, audit log, incidents.
        </p>

        <label className="mt-4 block text-sm font-medium" htmlFor="pm">เดือน / Month</label>
        <input id="pm" type="month" value={form.period_month} onChange={e => setForm(f => ({ ...f, period_month: e.target.value }))}
          className="mt-1.5 rounded-lg border bg-background p-2.5 text-sm" />

        {([
          ['access_review', 'การทบทวนสิทธิ์การเข้าถึง', 'Access review — who holds what role; accounts that should have been removed'],
          ['audit_review', 'การทบทวน audit log', 'Audit review — anything anomalous in the log'],
          ['incident_review', 'การทบทวนเหตุการณ์', 'Incident review — privacy/security incidents this period and their disposition'],
        ] as const).map(([key, th, en]) => (
          <div key={key}>
            <label className="mt-3 block text-sm font-medium" htmlFor={key}>{th}<span className="block text-xs font-normal text-muted-foreground">{en}</span></label>
            <textarea id={key} rows={2} maxLength={4000} value={form[key]}
              onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} className={field} />
          </div>
        ))}

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.incidents_found} onChange={e => setForm(f => ({ ...f, incidents_found: e.target.checked }))} />
          พบเหตุการณ์ในเดือนนี้ / Incidents were found this period
        </label>

        <Button size="sm" className="mt-4" disabled={busy} onClick={saveReview}>บันทึกการทบทวน / Record review</Button>

        <h3 className="mt-6 text-sm font-medium">ประวัติ / History</h3>
        {reviews === null ? <p className="mt-2 text-sm text-muted-foreground">กำลังโหลด… / Loading…</p>
          : reviews.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">ยังไม่มีบันทึกการทบทวน / No reviews recorded yet.</p>
          : (
            <ul className="mt-2 space-y-2">
              {reviews.map(r => (
                <li key={r.id} className="rounded-lg border p-3 text-xs">
                  <span className="font-medium tabular-nums">{r.period_month.slice(0, 7)}</span>
                  {r.incidents_found
                    ? <span className="ml-2 rounded-full bg-destructive/10 px-2 py-0.5 text-danger">พบเหตุการณ์ / incidents</span>
                    : <span className="ml-2 text-muted-foreground">ไม่พบเหตุการณ์ / none found</span>}
                  {r.access_review && <p className="mt-1 text-muted-foreground">Access: {r.access_review}</p>}
                  {r.audit_review && <p className="text-muted-foreground">Audit: {r.audit_review}</p>}
                  {r.incident_review && <p className="text-muted-foreground">Incidents: {r.incident_review}</p>}
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}
