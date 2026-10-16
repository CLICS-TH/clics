'use client';
// Identity verification queue (CREC082 ICF §4).
//
// The licence lookup attached to each submission is EVIDENCE, not a verdict: it can show that a
// licence exists and that the name on it matches, never that the person who typed it is that
// person. So this screen asks a human to decide, and shows the lookup result as one input to that
// decision rather than as an answer.
//
// Note what is NOT on this page: the national ID. Only its last four digits appear, which is enough
// to confirm you are looking at the right record and not enough to be the identifier. The backend
// does not expose the rest, encrypted or otherwise.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';
import { toast } from '@/components/Overlays';
import type { ApiResult } from '@/lib/types';
import { BadgeCheck, XCircle, ShieldQuestion } from 'lucide-react';

interface Verification {
  id: string;
  professional_id: string;
  method: 'national_id_license' | 'thaid';
  status: 'pending' | 'verified' | 'rejected';
  national_id_last4?: string | null;
  license_number?: string | null;
  license_check_status?: string | null;
  license_check_source?: string | null;
  submitted_at: string;
  decided_at?: string | null;
  reject_reason?: string | null;
  professionals?: { full_name_th?: string | null; full_name_en?: string | null; pseudonym?: string | null } | null;
}

// How much weight the lookup deserves, said plainly. 'verified' is the only encouraging one, and
// even that is not a decision — hence the neutral wording rather than a green tick.
const CHECK_VIEW: Record<string, { label: string; tone: string }> = {
  verified:      { label: 'ใบอนุญาตตรงกับชื่อ / Licence found, name matches', tone: 'text-ok' },
  name_mismatch: { label: 'ชื่อไม่ตรงกับใบอนุญาต / Licence found, name does NOT match', tone: 'text-danger' },
  not_found:     { label: 'ไม่พบใบอนุญาตนี้ / Licence not found', tone: 'text-danger' },
  unavailable:   { label: 'ตรวจสอบอัตโนมัติไม่สำเร็จ — ต้องตรวจด้วยตนเอง / Automatic check unavailable — verify manually', tone: 'text-muted-foreground' },
};

const FILTERS = [
  { key: 'pending',  th: 'รอตรวจสอบ', en: 'Pending' },
  { key: 'verified', th: 'ยืนยันแล้ว', en: 'Verified' },
  { key: 'rejected', th: 'ไม่ผ่าน',   en: 'Rejected' },
];

export default function IdentityQueuePage() {
  const [filter, setFilter] = useState('pending');
  const [rows, setRows] = useState<Verification[] | null>(null);
  const [err, setErr] = useState(false);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);

  const fetchQueue = useCallback(() => {
    apiFetch<{ verifications: Verification[] }>(`/admin/identity-queue?status=${filter}&limit=100`)
      .then(d => setRows(Array.isArray(d?.verifications) ? d.verifications : []))
      .catch(() => setErr(true));
  }, [filter]);
  const load = () => { setErr(false); fetchQueue(); };
  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  async function decide(id: string, decision: 'verified' | 'rejected') {
    const why = (reason[id] ?? '').trim();
    if (decision === 'rejected' && !why) {
      // Mirrors the server rule. A rejection with no reason sends the physician back to resubmit the
      // same thing, which is a loop rather than a decision.
      toast('กรุณาระบุเหตุผลที่ไม่ผ่าน / Please give a reason before rejecting', 'error');
      return;
    }
    setActing(id);
    try {
      const res = await apiFetch<ApiResult<unknown>>(`/admin/identity/${id}/decide`, {
        method: 'POST', body: JSON.stringify({ decision, reason: why || undefined }),
      });
      if (res?.error) { toast(`ไม่สำเร็จ / Failed: ${String(res.error)}`, 'error'); return; }
      toast('บันทึกแล้ว / Recorded', 'success');
      setReason(r => ({ ...r, [id]: '' }));
      load();
    } catch { toast('เกิดข้อผิดพลาด / Error saving the decision', 'error'); }
    finally { setActing(null); }
  }

  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Identity"
        title="ยืนยันตัวตนวิชาชีพ"
        subtitle="National ID + medical licence, confirmed by a person before the first PLE (CREC082 §4)"
      />

      <div className="flex flex-wrap gap-2 mb-5">
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
            className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
              filter === f.key ? 'bg-coral-active text-primary-foreground border-coral-active' : 'text-muted-foreground hover:bg-secondary'}`}>
            {f.th} <span className="text-[length:max(0.84em,12px)] font-normal">/ {f.en}</span>
          </button>
        ))}
      </div>

      {err ? (
        <div className="text-center py-10">
          <p className="text-muted-foreground mb-3">โหลดคิวไม่สำเร็จ / Could not load the queue.</p>
          <button className="text-sm text-link underline" onClick={load}>ลองใหม่ / Retry</button>
        </div>
      ) : rows === null ? (
        <p className="text-muted-foreground text-center py-10">กำลังโหลด… / Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-center py-10">
          {filter === 'pending' ? 'ไม่มีคำขอรอตรวจสอบ / Nothing waiting for review.' : 'ไม่มีรายการในสถานะนี้ / No records in this state.'}
        </p>
      ) : rows.map(v => {
        const check = CHECK_VIEW[v.license_check_status ?? ''] ?? CHECK_VIEW.unavailable;
        return (
          <div key={v.id} className="border rounded-xl p-5 mb-3">
            <p className="font-semibold break-words">
              {v.professionals?.full_name_th || v.professionals?.full_name_en || v.professionals?.pseudonym || v.professional_id.slice(0, 8)}
            </p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">เลขบัตร / National ID</dt>
              <dd className="tabular-nums">•••• •••• • {v.national_id_last4 ?? '—'}</dd>
              <dt className="text-muted-foreground">ใบอนุญาต / Licence</dt>
              <dd className="break-words">{v.license_number ?? '—'}</dd>
              <dt className="text-muted-foreground">ส่งเมื่อ / Submitted</dt>
              <dd>{new Date(v.submitted_at).toLocaleString('th-TH')}</dd>
            </dl>

            <p className={`mt-3 inline-flex items-center gap-1.5 text-xs ${check.tone}`}>
              <ShieldQuestion className="size-3.5 shrink-0" /> {check.label}
            </p>
            {/* WHERE the claim came from. The backend has always sent license_check_source and this
                card has always dropped it, so "Licence found, name matches" appeared in green with
                nothing to say whether a registry was actually consulted. A source of `stub` is a
                deterministic answer derived from the licence number, and an administrator has to be
                able to see that before deciding. Rendered for every source, not only the bad one:
                a warning that appears only when something is wrong teaches people to read its
                absence as a guarantee. */}
            <p className="mt-0.5 text-sm text-muted-foreground">
              ที่มาของการตรวจ / Source: <span className="font-mono">{v.license_check_source || 'none'}</span>
              {v.license_check_source === 'stub' && (
                <span className="text-danger"> — ค่าจำลองสำหรับทดสอบ ไม่ได้ตรวจกับทะเบียนจริง / test stub, no registry was consulted</span>
              )}
              {v.license_check_source === 'manual' && (
                <span> — ระบบไม่ได้ตั้งการตรวจอัตโนมัติไว้ ต้องตรวจด้วยตนเอง / no automatic lookup is configured; verify by hand</span>
              )}
            </p>
            {/* text-sm, not the text-xs used for metadata elsewhere: this line is the reason the
                screen exists, and 12px Thai sits below the legibility floor where the loop detail closes. */}
            <p className="mt-1 text-sm text-muted-foreground">
              การตรวจอัตโนมัติเป็นเพียงหลักฐานประกอบ ไม่ใช่การยืนยันตัวบุคคล / The automatic check is supporting evidence, not proof of identity.
            </p>

            {v.status === 'pending' ? (
              <>
                <label className="mt-4 block text-sm font-medium" htmlFor={`why-${v.id}`}>
                  เหตุผล / Reason <span className="font-normal text-muted-foreground">— จำเป็นเมื่อไม่ผ่าน / required to reject</span>
                </label>
                <input id={`why-${v.id}`} value={reason[v.id] ?? ''} maxLength={500}
                  onChange={e => setReason(r => ({ ...r, [v.id]: e.target.value }))}
                  placeholder="เช่น ชื่อไม่ตรงกับใบอนุญาต / e.g. name does not match the licence"
                  className="mt-1.5 w-full rounded-lg border bg-background p-2.5 text-sm" />
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" disabled={acting !== null} onClick={() => decide(v.id, 'verified')}>
                    <BadgeCheck className="size-4" /> ยืนยัน <span className="text-[length:max(0.84em,12px)] font-normal">/ Verify</span>
                  </Button>
                  <Button size="sm" variant="destructive" disabled={acting !== null} onClick={() => decide(v.id, 'rejected')}>
                    <XCircle className="size-4" /> ไม่ผ่าน <span className="text-[length:max(0.84em,12px)] font-normal">/ Reject</span>
                  </Button>
                </div>
              </>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                {v.status === 'verified' ? 'ยืนยันแล้ว / Verified' : 'ไม่ผ่าน / Rejected'}
                {v.decided_at ? ` · ${new Date(v.decided_at).toLocaleString('th-TH')}` : ''}
                {v.reject_reason ? ` · ${v.reject_reason}` : ''}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
