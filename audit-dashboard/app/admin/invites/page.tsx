'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';
import { StateMessage } from '@/components/ui/state-message';
import { useIsMobile } from '@/components/ViewportProvider';
import { ROLE_LABELS, INVITE_STATUS_MAP, roleToWire, POSITION_OPTIONS } from '@/lib/labels';
import { type ApiResult, formatApiError } from '@/lib/types';
import { confirmDialog } from '@/components/Overlays';
import { Check, Copy, Mail, Building2 } from 'lucide-react';

type Council = { id: string; code: string; name_th: string; name_en: string; active?: boolean };
type Specialty = { id: string; council_id: string; code: string; name_th: string; name_en: string };
type Invite = {
  id: string; email: string; role: string; council_id: string | null;
  status: string; expires_at: string | null; accepted_at: string | null; created_at: string;
  email_sent_at?: string | null; // optional — backend may not return it
  can_audit?: boolean; // physician invite that ALSO grants auditor access ("Special")
};
type CreatedInvite = Invite & { accept_url?: string; email_sent?: boolean };

// th-TH to match every other dashboard page (admin/ples, users, lpdp, auditor/queue all use th-TH /
// Buddhist-era). en-GB here showed Gregorian 2026 next to 2569 elsewhere — confusing + off-by-543.
const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default function InvitesPage() {
  const [invites, setInvites] = useState<Invite[] | null>(null); // null = loading
  const [loadErr, setLoadErr] = useState(false);
  const [councils, setCouncils] = useState<Council[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [form, setForm] = useState({ email: '', role: 'physician', council_id: '', specialty_id: '', position: '' });
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null); // invite id with a revoke/delete in flight
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const mobile = useIsMobile();

  const me = getUser();
  const isSuper = me?.role === 'superadmin';

  // Guard the .map: a non-401 error resolves with the error object (not an array); .catch a reject.
  // fetchInvites only sets state asynchronously (mount effect stays free of synchronous setState); the
  // `load` wrapper adds the error-reset for the Retry button + post-action refresh (event handlers).
  const fetchInvites = useCallback(() => {
    // apiFetch never rejects — a failed load is a non-array {error} body (not "no invites yet").
    apiFetch<Invite[]>('/admin/invites').then(d => { if (Array.isArray(d)) setInvites(d); else setLoadErr(true); }).catch(() => setLoadErr(true));
  }, []);
  const load = () => { setLoadErr(false); fetchInvites(); };

  useEffect(() => {
    fetchInvites();
    apiFetch<Specialty[]>('/admin/specialties').then(d => setSpecialties(Array.isArray(d) ? d : []));
    apiFetch<Council[]>('/admin/councils').then(d => {
      const list = d ?? [];
      setCouncils(list);
      // An admin can only invite into their own council — lock + preselect it.
      // Fall back to /auth/me when the cached user has no council_id.
      if (!isSuper) {
        const ownFromCache = me?.council_id ?? null;
        if (ownFromCache) setForm(s => ({ ...s, council_id: ownFromCache }));
        else apiFetch<{ user: { council_id?: string | null } }>('/auth/me')
          .then(({ user }) => user?.council_id && setForm(s => ({ ...s, council_id: user.council_id! })));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const councilName = (id?: string | null) => councils.find(c => c.id === id)?.name_th ?? '—';
  const specialtiesFor = (cid?: string | null) => specialties.filter(s => s.council_id === cid);

  async function createInvite() {
    setErr(''); setMsg(''); setCreated(null); setCopied(false);
    if (!form.email.trim()) { setErr('กรอกอีเมล / Enter an email.'); return; }
    if (!form.council_id) { setErr('เลือกสภาวิชาชีพ / Select a council.'); return; }
    // All invited roles are council-scoped — specialty is required when the council has any.
    if (specialtiesFor(form.council_id).length > 0 && !form.specialty_id) {
      setErr('เลือกความเชี่ยวชาญ / Select a specialty.'); return;
    }
    setBusy(true);
    // Empty specialty_id/position would fail the uuid/enum schema — omit them.
    const body: Record<string, unknown> = { email: form.email.trim(), council_id: form.council_id, ...roleToWire(form.role) };
    if (form.specialty_id) body.specialty_id = form.specialty_id;
    if (form.position) body.position = form.position;
    const res = await apiFetch<ApiResult<CreatedInvite>>('/admin/invites', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res?.id) {
      setCreated(res as CreatedInvite);
      setForm(s => ({ ...s, email: '' }));
      load();
    } else {
      setErr(formatApiError(res?.error, 'สร้างคำเชิญไม่สำเร็จ / Could not create invite.'));
    }
  }

  async function copyLink(url?: string) {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setMsg('คัดลอกไม่สำเร็จ — คัดลอกด้วยตนเอง / Copy failed — select and copy manually.'); }
  }

  async function revoke(inv: Invite) {
    const ok = await confirmDialog({
      title: 'เพิกถอนคำเชิญ? / Revoke invite?',
      body: `เพิกถอนคำเชิญของ ${inv.email}? / Revoke the invite for ${inv.email}?`,
      danger: true, confirmLabel: 'เพิกถอน / Revoke',
    });
    if (!ok) return;
    setMsg(''); setErr('');
    setRowBusy(inv.id);
    try {
      const res = await apiFetch<ApiResult<{ ok: boolean }>>(`/admin/invites/${inv.id}`, { method: 'DELETE' });
      if (res?.ok) { setMsg('เพิกถอนคำเชิญแล้ว / Invite revoked.'); load(); }
      // Plain DELETE on a row that is no longer pending now 409s ("already processed") —
      // the row went stale under us, so just refresh the list.
      else if (typeof res?.error === 'string' && res.error.toLowerCase().includes('already processed')) {
        setMsg('คำเชิญไม่อยู่ในสถานะรอแล้ว — รีเฟรชรายการ / Invite is no longer pending — refreshing the list.');
        load();
      }
      else setMsg(typeof res?.error === 'string' ? res.error : 'เพิกถอนไม่สำเร็จ / Revoke failed.');
    } finally { setRowBusy(null); }
  }

  // Hard-delete a non-pending (history) row — the DELETE endpoint requires the explicit
  // ?purge=1 flag for hard-delete and answers { deleted: true }.
  async function removeInvite(inv: Invite) {
    const ok = await confirmDialog({
      title: 'ลบประวัติคำเชิญ? / Delete invite history?',
      body: `ลบประวัติคำเชิญของ ${inv.email}? / Delete the invite history for ${inv.email}?`,
      danger: true, confirmLabel: 'ลบ / Delete',
    });
    if (!ok) return;
    setMsg(''); setErr('');
    setRowBusy(inv.id);
    try {
      const res = await apiFetch<ApiResult<{ deleted: boolean }>>(`/admin/invites/${inv.id}?purge=1`, { method: 'DELETE' });
      if (res?.deleted) { setMsg('ลบคำเชิญแล้ว / Invite deleted.'); setInvites(s => (s ?? []).filter(i => i.id !== inv.id)); }
      else setMsg(typeof res?.error === 'string' ? res.error : 'ลบไม่สำเร็จ / Delete failed.');
    } finally { setRowBusy(null); }
  }

  // Small chip marking a physician invite that also grants auditor access.
  const SpecialChip = () => (
    <span className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-foreground">
      Special
    </span>
  );

  const StatusBadge = ({ s }: { s: string }) => (
    <Badge variant={s === 'accepted' ? 'default' : s === 'revoked' || s === 'expired' ? 'destructive' : 'outline'}>
      {INVITE_STATUS_MAP[s] ?? s}
    </Badge>
  );

  // Lock the council select for an admin; superadmin chooses any active council.
  const CouncilSelect = (
    <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background disabled:opacity-60"
      disabled={!isSuper}
      value={form.council_id} onChange={e => setForm(s => ({ ...s, council_id: e.target.value, specialty_id: '' }))}>
      <option value="">— เลือกสภาวิชาชีพ / Select council —</option>
      {councils.map(c => <option key={c.id} value={c.id}>{c.name_th} / {c.name_en}</option>)}
    </select>
  );
  // Specialty (under council) + position — the invitee inherits these on accept.
  const SpecialtySelect = (
    <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background disabled:opacity-50"
      value={form.specialty_id} disabled={!form.council_id || specialtiesFor(form.council_id).length === 0}
      onChange={e => setForm(s => ({ ...s, specialty_id: e.target.value }))}>
      <option value="">— เลือกความเชี่ยวชาญ / Select specialty —</option>
      {specialtiesFor(form.council_id).map(s => <option key={s.id} value={s.id}>{s.name_th} / {s.name_en}</option>)}
    </select>
  );
  const PositionSelect = (
    <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
      value={form.position} onChange={e => setForm(s => ({ ...s, position: e.target.value }))}>
      <option value="">— ระดับการฝึกอบรม / Medical Training Level —</option>
      {POSITION_OPTIONS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
    </select>
  );

  return (
    <div className="max-w-4xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Invites"
        title="คำเชิญเข้าร่วม"
        subtitle="Invites — เชิญแพทย์หรือผู้ตรวจประเมินเข้าสภาวิชาชีพ · Invite a physician or auditor into a council; share the one-time accept link."
      />

      {/* Create-invite form */}
      <div className="border rounded-xl p-5 mb-6 space-y-3">
        <input className="w-full border rounded-lg px-3 py-2 text-sm" type="email"
          placeholder="อีเมลผู้รับ / Recipient email" value={form.email}
          onChange={e => setForm(s => ({ ...s, email: e.target.value }))} />
        <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
          value={form.role} onChange={e => setForm(s => ({ ...s, role: e.target.value }))}>
          <option value="physician">{ROLE_LABELS.physician} / Physician</option>
          <option value="auditor">{ROLE_LABELS.auditor} / Auditor</option>
          <option value="special">พิเศษ (User+Auditor) / Special</option>
          {/* Council-admin invites are a superadmin-only power. Maps to {role:'admin'} (no can_audit). */}
          {isSuper && <option value="admin">ผู้ดูแลสภา / Admin</option>}
        </select>
        {CouncilSelect}
        {!isSuper && (
          <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Building2 className="size-3.5" /> ล็อกไว้ที่สภาของคุณ / Locked to your council: {councilName(form.council_id)}
          </p>
        )}
        {SpecialtySelect}
        {PositionSelect}
        {err && <p className="text-danger text-sm">{err}</p>}
        <Button onClick={createInvite} disabled={busy}>
          {busy ? 'กำลังสร้าง…' : '+ สร้างคำเชิญ / Create invite'}
        </Button>
      </div>

      {/* One-time accept link returned on create — shown ONCE with a copy button. */}
      {created?.accept_url && (
        <div className="border border-primary/40 bg-primary/5 rounded-xl p-5 mb-6 space-y-2">
          <p className="text-sm font-medium">
            ลิงก์คำเชิญสำหรับ {created.email} / Accept link for {created.email}
            {created.can_audit && ' — พิเศษ / Special (User+Auditor)'}
            {created.role === 'admin' && ' — ผู้ดูแลสภา / Admin'}
          </p>
          <p className="text-xs text-muted-foreground">
            แสดงเพียงครั้งเดียว — คัดลอกและส่งให้ผู้รับ / Shown once only — copy it and send it to the recipient.
          </p>
          {/* Email-delivery status — only when the backend reported it (backward compatible). */}
          {created.email_sent !== undefined && (
            <p className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium ${
              created.email_sent
                ? 'border-chart-pass-text/30 bg-chart-pass-bg text-chart-pass-text'
                : 'border-notice-text/30 bg-notice-bg text-notice-text'
            }`}>
              {created.email_sent
                ? 'ส่งอีเมลถึงผู้รับแล้ว / Invite email sent'
                : 'ยังไม่ได้ส่งอีเมล — คัดลอกลิงก์ด้านล่างไปส่งเอง / Email not sent — share the link below'}
            </p>
          )}
          <div className="flex items-center gap-2">
            <input readOnly value={created.accept_url}
              onFocus={e => e.currentTarget.select()}
              className="flex-1 min-w-0 border rounded-lg px-3 py-2 text-xs bg-background font-mono" />
            <Button variant="outline" className="shrink-0" onClick={() => copyLink(created.accept_url)}>
              {copied ? <><Check className="size-4" /> คัดลอกแล้ว / Copied</> : <><Copy className="size-4" /> คัดลอก / Copy</>}
            </Button>
          </div>
        </div>
      )}

      {msg && <p className="mb-4 text-sm rounded-lg border border-border bg-secondary px-3 py-2">{msg}</p>}

      {/* Invite list */}
      {loadErr ? (
        <StateMessage kind="error" center onRetry={load} title="โหลดรายการไม่สำเร็จ / Could not load invites." />
      ) : invites === null ? (
        <StateMessage kind="loading" center title="กำลังโหลด… / Loading…" />
      ) : invites.length === 0 ? (
        <StateMessage kind="empty" center title="ยังไม่มีคำเชิญ / No invites yet." />
      ) : mobile ? (
        <div className="space-y-3">
          {invites.map(inv => (
            <div key={inv.id} className="rounded-xl border border-border p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium break-all">{inv.email}</p>
                <StatusBadge s={inv.status} />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{ROLE_LABELS[inv.role] ?? inv.role}</Badge>
                {inv.can_audit && <SpecialChip />}
                <span className="inline-flex items-center gap-1"><Building2 className="size-3.5" /> {councilName(inv.council_id)}</span>
                {inv.email_sent_at && <span className="inline-flex items-center gap-1" title={fmt(inv.email_sent_at)}><Mail className="size-3.5" /> sent</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                สร้าง / Created {fmt(inv.created_at)} · หมดอายุ / Expires {fmt(inv.expires_at)}
              </p>
              {inv.status === 'pending'
                ? <Button variant="outline" size="sm" disabled={rowBusy !== null} onClick={() => revoke(inv)}>
                    {rowBusy === inv.id ? 'กำลังเพิกถอน… / Revoking…' : 'เพิกถอน / Revoke'}
                  </Button>
                : <Button variant="destructive" size="sm" disabled={rowBusy !== null} onClick={() => removeInvite(inv)}>
                    {rowBusy === inv.id ? 'กำลังลบ… / Deleting…' : 'ลบ / Delete'}
                  </Button>}
            </div>
          ))}
        </div>
      ) : (
        <div className="border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary"><tr>
              <th className="px-4 py-3 text-left">Email</th>
              <th className="px-4 py-3 text-left">บทบาท / Role</th>
              <th className="px-4 py-3 text-left">สภา / Council</th>
              <th className="px-4 py-3 text-left">สถานะ / Status</th>
              <th className="px-4 py-3 text-left">หมดอายุ / Expires</th>
              <th className="px-4 py-3 text-right">การจัดการ / Actions</th>
            </tr></thead>
            <tbody>{invites.map(inv => (
              <tr key={inv.id} className="border-t align-middle hover:bg-secondary/60">
                <td className="px-4 py-3">
                  {inv.email}
                  {inv.email_sent_at && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground" title={fmt(inv.email_sent_at)}><Mail className="size-3.5" /> sent</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1.5">
                    <Badge variant="outline">{ROLE_LABELS[inv.role] ?? inv.role}</Badge>
                    {inv.can_audit && <SpecialChip />}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{councilName(inv.council_id)}</td>
                <td className="px-4 py-3"><StatusBadge s={inv.status} /></td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmt(inv.expires_at)}</td>
                <td className="px-4 py-3 text-right">
                  {inv.status === 'pending'
                    ? <Button variant="outline" size="sm" disabled={rowBusy !== null} onClick={() => revoke(inv)}>
                        {rowBusy === inv.id ? 'กำลังเพิกถอน… / Revoking…' : 'เพิกถอน / Revoke'}
                      </Button>
                    : <Button variant="destructive" size="sm" disabled={rowBusy !== null} onClick={() => removeInvite(inv)}>
                        {rowBusy === inv.id ? 'กำลังลบ… / Deleting…' : 'ลบ / Delete'}
                      </Button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
