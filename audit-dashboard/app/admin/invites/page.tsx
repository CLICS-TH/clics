'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';
import { useIsMobile } from '@/components/ViewportProvider';
import { ROLE_LABELS, INVITE_STATUS_MAP } from '@/lib/labels';

type Council = { id: string; code: string; name_th: string; name_en: string; active?: boolean };
type Invite = {
  id: string; email: string; role: string; council_id: string | null;
  status: string; expires_at: string | null; accepted_at: string | null; created_at: string;
  email_sent_at?: string | null; // optional — backend may not return it
};
type CreatedInvite = Invite & { accept_url?: string; email_sent?: boolean };

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default function InvitesPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [councils, setCouncils] = useState<Council[]>([]);
  const [form, setForm] = useState({ email: '', role: 'physician', council_id: '' });
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const mobile = useIsMobile();

  const me = getUser();
  const isSuper = me?.role === 'superadmin';

  const load = () => apiFetch<Invite[]>('/admin/invites').then(d => setInvites(d ?? []));

  useEffect(() => {
    load();
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

  async function createInvite() {
    setErr(''); setMsg(''); setCreated(null); setCopied(false);
    if (!form.email.trim()) { setErr('กรอกอีเมล / Enter an email.'); return; }
    if (!form.council_id) { setErr('เลือกสภาวิชาชีพ / Select a council.'); return; }
    setBusy(true);
    const res: any = await apiFetch('/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ email: form.email.trim(), role: form.role, council_id: form.council_id }),
    });
    setBusy(false);
    if (res?.id) {
      setCreated(res as CreatedInvite);
      setForm(s => ({ ...s, email: '' }));
      load();
    } else {
      setErr(typeof res?.error === 'string' ? res.error
        : res?.error?.fieldErrors ? JSON.stringify(res.error.fieldErrors)
        : 'สร้างคำเชิญไม่สำเร็จ / Could not create invite.');
    }
  }

  async function copyLink(url?: string) {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setMsg('คัดลอกไม่สำเร็จ — คัดลอกด้วยตนเอง / Copy failed — select and copy manually.'); }
  }

  async function revoke(inv: Invite) {
    if (!confirm(`เพิกถอนคำเชิญของ ${inv.email}? / Revoke the invite for ${inv.email}?`)) return;
    setMsg(''); setErr('');
    const res: any = await apiFetch(`/admin/invites/${inv.id}`, { method: 'DELETE' });
    if (res?.ok) { setMsg('เพิกถอนคำเชิญแล้ว / Invite revoked.'); load(); }
    else setMsg(typeof res?.error === 'string' ? res.error : 'เพิกถอนไม่สำเร็จ / Revoke failed.');
  }

  const StatusBadge = ({ s }: { s: string }) => (
    <Badge variant={s === 'accepted' ? 'default' : s === 'revoked' || s === 'expired' ? 'destructive' : 'outline'}>
      {INVITE_STATUS_MAP[s] ?? s}
    </Badge>
  );

  // Lock the council select for an admin; superadmin chooses any active council.
  const CouncilSelect = (
    <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background disabled:opacity-60"
      disabled={!isSuper}
      value={form.council_id} onChange={e => setForm(s => ({ ...s, council_id: e.target.value }))}>
      <option value="">— เลือกสภาวิชาชีพ / Select council —</option>
      {councils.map(c => <option key={c.id} value={c.id}>{c.name_th} / {c.name_en}</option>)}
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
        </select>
        {CouncilSelect}
        {!isSuper && (
          <p className="text-xs text-muted-foreground">
            🏛 ล็อกไว้ที่สภาของคุณ / Locked to your council: {councilName(form.council_id)}
          </p>
        )}
        {err && <p className="text-destructive text-sm">{err}</p>}
        <Button onClick={createInvite} disabled={busy}>
          {busy ? 'กำลังสร้าง…' : '+ สร้างคำเชิญ / Create invite'}
        </Button>
      </div>

      {/* One-time accept link returned on create — shown ONCE with a copy button. */}
      {created?.accept_url && (
        <div className="border border-primary/40 bg-primary/5 rounded-xl p-5 mb-6 space-y-2">
          <p className="text-sm font-medium">
            ลิงก์คำเชิญสำหรับ {created.email} / Accept link for {created.email}
          </p>
          <p className="text-xs text-muted-foreground">
            แสดงเพียงครั้งเดียว — คัดลอกและส่งให้ผู้รับ / Shown once only — copy it and send it to the recipient.
          </p>
          {/* Email-delivery status — only when the backend reported it (backward compatible). */}
          {created.email_sent === true && (
            <p className="inline-flex items-center gap-1 rounded-full border border-green-300 bg-green-50 px-3 py-1 text-xs font-medium text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
              ส่งอีเมลถึงผู้รับแล้ว ✓ / Invite email sent
            </p>
          )}
          {created.email_sent === false && (
            <p className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
              ยังไม่ได้ส่งอีเมล — คัดลอกลิงก์ด้านล่างไปส่งเอง / Email not sent — share the link below
            </p>
          )}
          <div className="flex items-center gap-2">
            <input readOnly value={created.accept_url}
              onFocus={e => e.currentTarget.select()}
              className="flex-1 min-w-0 border rounded-lg px-3 py-2 text-xs bg-background font-mono" />
            <Button variant="outline" className="shrink-0" onClick={() => copyLink(created.accept_url)}>
              {copied ? '✓ คัดลอกแล้ว / Copied' : '📋 คัดลอก / Copy'}
            </Button>
          </div>
        </div>
      )}

      {msg && <p className="mb-4 text-sm rounded-lg border border-border bg-secondary px-3 py-2">{msg}</p>}

      {/* Invite list */}
      {invites.length === 0 ? (
        <p className="text-muted-foreground text-sm py-10 text-center">ยังไม่มีคำเชิญ / No invites yet.</p>
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
                <span>🏛 {councilName(inv.council_id)}</span>
                {inv.email_sent_at && <span title={fmt(inv.email_sent_at)}>✉ sent</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                สร้าง / Created {fmt(inv.created_at)} · หมดอายุ / Expires {fmt(inv.expires_at)}
              </p>
              {inv.status === 'pending' && (
                <Button variant="outline" size="sm" onClick={() => revoke(inv)}>เพิกถอน / Revoke</Button>
              )}
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
                    <span className="ml-2 text-xs text-muted-foreground" title={fmt(inv.email_sent_at)}>✉ sent</span>
                  )}
                </td>
                <td className="px-4 py-3"><Badge variant="outline">{ROLE_LABELS[inv.role] ?? inv.role}</Badge></td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{councilName(inv.council_id)}</td>
                <td className="px-4 py-3"><StatusBadge s={inv.status} /></td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmt(inv.expires_at)}</td>
                <td className="px-4 py-3 text-right">
                  {inv.status === 'pending'
                    ? <Button variant="outline" size="sm" onClick={() => revoke(inv)}>เพิกถอน / Revoke</Button>
                    : <span className="text-xs text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
