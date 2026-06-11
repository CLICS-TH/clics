'use client';
import { useEffect, useState } from 'react';
import { apiFetch, apiFetchPaged } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';
import { useIsMobile } from '@/components/ViewportProvider';
import { ROLE_LABELS, ACCOUNT_STATUS_MAP, budgetToneHex } from '@/lib/labels';

const PAGE_SIZE = 50;

type User = {
  id: string; role: string; full_name_th: string; full_name_en: string;
  specialty?: string | null; license_number?: string | null;
  status?: string; pseudonym?: string | null; council_id?: string | null;
  usage_cost_usd?: number | null; usage_limit_usd?: number | null;
  can_audit?: boolean | null;          // "Special" dual role: physician + auditor rights
};
type Slot = { role: string; capacity: number; used: number; remaining: number };
type Council = { id: string; code: string; name_th: string; name_en: string };
type AuditorRequest = {
  id: string; email?: string | null; created_at: string;
  full_name_th?: string | null; full_name_en?: string | null;
};

// Account-status filter chips (server-side ?status= on /admin/users; '' = all).
const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: 'active', label: ACCOUNT_STATUS_MAP.active },
  { key: 'deactivated', label: ACCOUNT_STATUS_MAP.deactivated },
  { key: '', label: 'ทั้งหมด / All' },
];

// Edit-panel role options — 'special' is a UI-only value that maps to {role:'physician', can_audit:true}.
const EDIT_ROLE_OPTIONS: { key: string; label: string }[] = [
  { key: 'admin', label: 'Admin' },
  { key: 'physician', label: 'แพทย์ Physician' },
  { key: 'auditor', label: 'Auditor' },
  { key: 'special', label: 'พิเศษ Special (User+Auditor)' },
];

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [cap, setCap] = useState<Record<string, string>>({});
  const [showForm, setShowForm] = useState(false);
  const [councils, setCouncils] = useState<Council[]>([]);
  const [form, setForm] = useState({ email:'', password:'', role:'physician', council_id:'', full_name_th:'', full_name_en:'', specialty:'', license_number:'' });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState<User | null>(null);
  const [editLimit, setEditLimit] = useState('');           // per-user usage limit override ($), '' = standard
  const [stdLimit, setStdLimit] = useState('');             // org standard usage limit ($)
  const [poolLimit, setPoolLimit] = useState('');           // total API budget pool ($)
  const [totalUsed, setTotalUsed] = useState(0);            // total spent across all members ($)
  const [total, setTotal] = useState(0);                    // total user count (X-Total-Count)
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState('active'); // default hides deactivated; '' = all
  const [requests, setRequests] = useState<AuditorRequest[]>([]); // pending auditor-role requests
  const mobile = useIsMobile();

  // Admins get a read-only view (the dual-role GET /admin/users is council-scoped for them);
  // all mutations + /admin/slots + /admin/usage-settings remain superadmin-only.
  const isSuper = getUser()?.role === 'superadmin';

  // Query string for /admin/users — server-side status filter (omitted for All) + pagination.
  const usersQS = (limit: number, offset: number) => {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (statusFilter) qs.set('status', statusFilter);
    return qs.toString();
  };

  // Fetch one page (newest-first) and append, or replace from offset 0.
  const loadUsersPage = (offset: number) =>
    apiFetchPaged<User>(`/admin/users?${usersQS(PAGE_SIZE, offset)}`).then(({ items, total }) => {
      setTotal(total);
      setUsers(prev => (offset === 0 ? items : [...prev, ...items]));
    });

  // Reload the currently-loaded range from the top so mutations don't drop rows
  // (used by create/edit/status/reset handlers below).
  const loadUsers = () => {
    const count = Math.min(Math.max(users.length, PAGE_SIZE), 200);
    return apiFetchPaged<User>(`/admin/users?${usersQS(count, 0)}`).then(({ items, total }) => {
      setTotal(total);
      setUsers(items);
    });
  };

  const loadMore = async () => {
    setLoadingMore(true);
    try { await loadUsersPage(users.length); }
    finally { setLoadingMore(false); }
  };
  const loadSlots = () => apiFetch<Slot[]>('/admin/slots').then(d => {
    setSlots(d ?? []);
    setCap(Object.fromEntries((d ?? []).map(s => [s.role, String(s.capacity)])));
  });
  const loadUsageSettings = () => apiFetch<{ standard_limit_usd: number; api_budget_pool_usd: number; total_used_usd: number }>('/admin/usage-settings')
    .then(d => {
      setStdLimit(d?.standard_limit_usd != null ? String(d.standard_limit_usd) : '');
      setPoolLimit(d?.api_budget_pool_usd ? String(d.api_budget_pool_usd) : '');
      setTotalUsed(Number(d?.total_used_usd ?? 0));
    });
  const loadCouncils = () => apiFetch<Council[]>('/admin/councils').then(d => setCouncils(d ?? []));
  // Pending auditor-role requests (admin: own council; superadmin: all) — section hides when empty.
  const loadRequests = () => apiFetch<AuditorRequest[]>('/admin/auditor-requests').then(d => setRequests(Array.isArray(d) ? d : []));
  useEffect(() => {
    loadCouncils(); loadRequests();
    // Slot pools and usage settings are superadmin-only endpoints — skip for admins.
    if (isSuper) { loadSlots(); loadUsageSettings(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (Re)load page 0 whenever the status filter changes (incl. on mount) — resets pagination to offset 0.
  useEffect(() => { loadUsersPage(0); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [statusFilter]);

  const councilName = (id?: string | null) => councils.find(c => c.id === id)?.name_th ?? '—';

  function openEdit(u: User) {
    setEditing(u);
    setEditLimit(u.usage_limit_usd != null ? String(u.usage_limit_usd) : '');
  }

  // Effective limit shown in the list: per-user override if set, else the org standard.
  const effLimit = (u: User) => u.usage_limit_usd != null ? u.usage_limit_usd : (parseFloat(stdLimit) || 0);

  async function createUser() {
    setErr('');
    if (!form.council_id) { setErr('เลือกสภาวิชาชีพ / Select a council.'); return; }
    const res: any = await apiFetch('/admin/users', { method:'POST', body: JSON.stringify(form) });
    if (res?.id) { setShowForm(false); setForm(s => ({ ...s, council_id:'' })); loadUsers(); loadSlots(); }
    else setErr(res?.error?.fieldErrors ? JSON.stringify(res.error.fieldErrors) : res?.error ?? 'Error');
  }

  async function saveEdit() {
    if (!editing) return;
    setMsg('');
    const body: any = {
      full_name_th: editing.full_name_th, full_name_en: editing.full_name_en,
      specialty: editing.specialty ?? '', license_number: editing.license_number ?? '',
    };
    // The superadmin role is immutable — never send a role change for it (backend rejects it too).
    // can_audit travels with the role: 'Special' = {role:'physician', can_audit:true}; any other role clears it.
    if (editing.role !== 'superadmin') { body.role = editing.role; body.council_id = editing.council_id; body.can_audit = editing.can_audit === true; }
    // Usage limit override: a number sets a per-user cap; empty clears it (null => standard default).
    const trimmed = editLimit.trim();
    body.usage_limit_usd = trimmed === '' ? null : Number(trimmed);
    if (body.usage_limit_usd != null && (!Number.isFinite(body.usage_limit_usd) || body.usage_limit_usd < 0)) {
      setMsg('ขีดจำกัดไม่ถูกต้อง / Invalid usage limit.'); return;
    }
    const res: any = await apiFetch(`/admin/users/${editing.id}`, { method:'PATCH', body: JSON.stringify(body) });
    if (res?.id) { setEditing(null); setMsg('บันทึกแล้ว / Saved.'); loadUsers(); loadSlots(); }
    else setMsg(res?.error ?? 'แก้ไขไม่สำเร็จ / Update failed.');
  }

  async function saveStdLimit() {
    setMsg('');
    const v = parseFloat(stdLimit);
    if (!Number.isFinite(v) || v < 0) { setMsg('ขีดจำกัดมาตรฐานไม่ถูกต้อง / Invalid standard limit.'); return; }
    const res: any = await apiFetch('/admin/usage-settings', { method:'PATCH', body: JSON.stringify({ standard_limit_usd: v }) });
    if (res?.standard_limit_usd != null) { setMsg('บันทึกขีดจำกัดมาตรฐานแล้ว / Standard limit saved.'); loadUsageSettings(); loadUsers(); }
    else setMsg(res?.error ?? 'บันทึกไม่สำเร็จ / Failed.');
  }

  async function savePool() {
    setMsg('');
    const v = parseFloat(poolLimit);
    if (!Number.isFinite(v) || v < 0) { setMsg('งบประมาณรวมไม่ถูกต้อง / Invalid API budget pool.'); return; }
    const res: any = await apiFetch('/admin/usage-settings', { method:'PATCH', body: JSON.stringify({ api_budget_pool_usd: v }) });
    if (res?.api_budget_pool_usd != null) { setMsg('บันทึกงบประมาณรวมแล้ว / API budget pool saved.'); loadUsageSettings(); }
    else setMsg(res?.error ?? 'บันทึกไม่สำเร็จ / Failed.');
  }

  async function resetUsage(u: User) {
    if (!confirm(`รีเซ็ตการใช้งานของ ${u.full_name_en} เป็น $0? / Reset this member's AI usage to $0?`)) return;
    setMsg('');
    const res: any = await apiFetch(`/admin/users/${u.id}/reset-usage`, { method:'POST', body: JSON.stringify({}) });
    if (res?.id) { setMsg('รีเซ็ตการใช้งานแล้ว / Usage reset.'); loadUsers(); }
    else setMsg(res?.error ?? 'รีเซ็ตไม่สำเร็จ / Reset failed.');
  }

  async function toggleStatus(u: User) {
    const next = u.status === 'deactivated' ? 'active' : 'deactivated';
    if (!confirm(next === 'deactivated' ? 'ปิดใช้งานบัญชีนี้? / Deactivate this account?' : 'เปิดใช้งานอีกครั้ง? / Reactivate?')) return;
    setMsg('');
    const res: any = await apiFetch(`/admin/users/${u.id}/status`, { method:'PATCH', body: JSON.stringify({ status: next }) });
    if (res?.id) { setMsg('อัปเดตสถานะแล้ว / Status updated.'); loadUsers(); loadSlots(); }
    else setMsg(res?.error ?? 'อัปเดตไม่สำเร็จ / Failed.');
  }

  // Approve/reject a pending auditor-role request, then refresh both the section and the
  // users list (approve flips can_audit on the professional, so the Special chip appears).
  async function decideRequest(r: AuditorRequest, action: 'approve' | 'reject') {
    setMsg('');
    const res: any = await apiFetch(`/admin/auditor-requests/${r.id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
    if (res?.ok) {
      setMsg(action === 'approve' ? 'อนุมัติคำขอแล้ว / Request approved.' : 'ปฏิเสธคำขอแล้ว / Request rejected.');
      loadRequests(); loadUsers();
    } else setMsg(res?.error ?? 'ดำเนินการไม่สำเร็จ / Failed.');
  }

  async function saveCap(role: string) {
    setMsg('');
    const capacity = parseInt(cap[role] ?? '', 10);
    if (!Number.isFinite(capacity) || capacity < 0) { setMsg('จำนวนช่องไม่ถูกต้อง / Invalid capacity.'); return; }
    const res: any = await apiFetch(`/admin/slots/${role}`, { method:'PATCH', body: JSON.stringify({ capacity }) });
    if (res?.role) { setMsg('บันทึกจำนวนช่องแล้ว / Capacity saved.'); loadSlots(); }
    else setMsg(res?.error ?? 'บันทึกไม่สำเร็จ / Failed.');
  }

  const StatusBadge = ({ s }: { s?: string }) => (
    <span className={`text-xs px-2 py-0.5 rounded-full ${s === 'deactivated' ? 'bg-muted text-muted-foreground' : 'bg-[#5db872]/20 text-foreground'}`}>
      {ACCOUNT_STATUS_MAP[s ?? 'active'] ?? s}
    </span>
  );

  // Dual-role marker: a physician who also holds auditor rights (professionals.can_audit).
  const SpecialChip = () => (
    <span title="แพทย์ที่เป็นผู้ตรวจด้วย / Physician with auditor rights"
      className="text-[10px] px-1.5 py-0.5 rounded-full border border-border bg-secondary text-muted-foreground whitespace-nowrap">
      🩺+🔍 Special
    </span>
  );

  // AI usage meter for a physician: $used / $effective-limit + a thin bar.
  const UsageCell = ({ u }: { u: User }) => {
    if (u.role !== 'physician') return <span className="text-xs text-muted-foreground">—</span>;
    const used = Number(u.usage_cost_usd ?? 0);
    // Admins can't read /admin/usage-settings, so there is no effective limit — show spend only.
    if (!isSuper) return <p className="text-xs tabular-nums text-muted-foreground">${used.toFixed(4)}</p>;
    const limit = effLimit(u);
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const over = limit > 0 && used >= limit;
    const tone = over ? 'bg-destructive' : pct >= 80 ? 'bg-[#e08a1e]' : 'bg-[#5db872]';
    return (
      <div className="min-w-[120px]">
        <p className={`text-xs tabular-nums ${over ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
          ${used.toFixed(4)} / ${limit.toFixed(2)}{u.usage_limit_usd != null ? ' *' : ''}
        </p>
        <div className="h-1.5 mt-1 rounded-full bg-muted overflow-hidden"><div className={`h-full ${tone}`} style={{ width: `${pct}%` }} /></div>
      </div>
    );
  };

  // Compact square icon button for dense table rows (tooltip carries the bilingual label).
  const IconBtn = ({ icon, title, onClick, disabled, href }: { icon: string; title: string; onClick?: () => void; disabled?: boolean; href?: string }) => {
    const cls = 'w-8 h-8 inline-flex items-center justify-center border border-border rounded-md text-base leading-none hover:bg-secondary disabled:opacity-40 disabled:hover:bg-transparent';
    return href
      ? <a href={href} title={title} aria-label={title} className={cls}>{icon}</a>
      : <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled} className={cls}>{icon}</button>;
  };

  // Inline row actions, shared by the desktop table and the mobile cards.
  const RowActions = ({ u }: { u: User }) => (
    <div className="inline-flex items-center gap-1.5">
      {u.role === 'physician' && <IconBtn icon="📊" title="คะแนน / Scores" href={`/admin/lpdp/${u.id}`} />}
      {isSuper && u.role === 'physician' && <IconBtn icon="↺" title="รีเซ็ตการใช้งาน / Reset usage" onClick={() => resetUsage(u)} />}
      {isSuper && <IconBtn icon="✎" title="แก้ไข / Edit" onClick={() => openEdit(u)} />}
      {isSuper && <IconBtn icon="⏻" title={u.status === 'deactivated' ? 'เปิดใช้ / Activate' : 'ปิดใช้ / Deactivate'}
        disabled={u.role === 'superadmin'} onClick={() => toggleStatus(u)} />}
    </div>
  );

  const FIELD_PLACEHOLDERS: Record<string, string> = {
    full_name_th: 'ชื่อภาษาไทย / Thai Name', full_name_en: 'Full Name (English)',
    email: 'Email', password: 'Password',
    specialty: 'สาขาวิชา / Specialty', license_number: 'เลขใบอนุญาต / License No.',
  };

  const poolPctNum = parseFloat(poolLimit);
  const poolHasValue = Number.isFinite(poolPctNum) && poolPctNum > 0;
  const poolPct = poolHasValue ? Math.min(100, Math.round((totalUsed / poolPctNum) * 100)) : 0;
  const poolToneColor = budgetToneHex(poolPct / 100); // shared thresholds/colors (lib/labels.ts)

  return (
    <div className="max-w-7xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Users"
        title="จัดการผู้ใช้งาน"
        subtitle="User Management — สมาชิก, สถานะบัญชี และจำนวนช่องต่อบทบาท · Members, account status, and role slot pools."
        action={isSuper ? <Button onClick={() => setShowForm(v => !v)}>+ เพิ่มผู้ใช้ / Add User</Button> : undefined}
      />

      {/* Role slot pools — superadmin-only (admins can't read /admin/slots).
          Drive columns off the mobile flag (the view toggle shrinks the
          container but not the viewport, so Tailwind md: would wrongly stay 4-up). */}
      {isSuper && (<>
      <div className={`grid gap-3 mb-6 ${mobile ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-4'}`}>
        {slots.map(s => {
          const locked = s.role === 'superadmin';
          const full = s.remaining <= 0;
          return (
            <div key={s.role} className="rounded-xl border border-border p-4">
              <p className="text-sm font-medium">{ROLE_LABELS[s.role] ?? s.role}</p>
              <p className={`text-2xl font-heading mt-1 ${full ? 'text-destructive' : ''}`}>{s.used}<span className="text-muted-foreground text-base">/{s.capacity}</span></p>
              <p className="text-xs text-muted-foreground">เหลือ {s.remaining} ช่อง / {s.remaining} left</p>
              <div className="flex items-center gap-1.5 mt-2">
                <input type="number" min={0} disabled={locked}
                  className="flex-1 min-w-0 border rounded-md px-2 py-1 text-sm bg-background disabled:opacity-50"
                  value={cap[s.role] ?? ''} onChange={e => setCap(c => ({ ...c, [s.role]: e.target.value }))} />
                <Button variant="outline" className="text-xs px-2 py-1 h-auto shrink-0" disabled={locked} onClick={() => saveCap(s.role)}>
                  {locked ? '🔒' : 'ตั้งค่า'}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Total API budget pool — the org-wide Anthropic key allocation; tracks total spend vs pool. */}
      <div className="rounded-xl border border-border p-4 mb-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm font-medium">งบประมาณ API รวม / Total API budget pool</p>
          <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener noreferrer"
            className="text-xs px-2 py-1 border rounded-lg inline-flex items-center hover:bg-secondary">
            🔑 API key / Anthropic Console ↗
          </a>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          ยอดใช้รวมทุกสมาชิกเทียบกับงบของคีย์ API / Total spent across all members vs the API key&apos;s budget.
        </p>
        <div className="flex items-baseline justify-between gap-2 mt-2">
          <span className="text-sm text-muted-foreground">ใช้ไปแล้ว / Used</span>
          <span className={`text-lg font-heading tabular-nums ${poolPct >= 90 ? 'text-destructive' : ''}`}>
            ${totalUsed.toFixed(4)}{poolHasValue ? <span className="text-muted-foreground text-sm"> / ${poolPctNum.toFixed(2)} ({poolPct}%)</span> : null}
          </span>
        </div>
        {poolHasValue && (
          <div className="h-2 mt-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full" style={{ width: `${poolPct}%`, backgroundColor: poolToneColor }} /></div>
        )}
        <div className="flex items-center gap-2 mt-3">
          <span className="text-sm text-muted-foreground">ตั้งงบรวม $ / Set pool $</span>
          <input type="number" min={0} step="1"
            className="w-28 border rounded-md px-2 py-1 text-sm bg-background"
            placeholder="เช่น 50" value={poolLimit} onChange={e => setPoolLimit(e.target.value)} />
          <Button variant="outline" className="text-xs px-3 py-1 h-auto" onClick={savePool}>บันทึก / Save</Button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1.5">
          * ตัวเลขนี้คือยอดที่ระบบคำนวณ — ยอดคงเหลือจริงดูได้ที่ Anthropic Console / This is the amount metered by CLICS; the real remaining balance lives in the Anthropic Console (linked above).
        </p>
      </div>

      {/* Standard AI usage limit — default budget per physician (per-user overrides set in Edit). */}
      <div className="rounded-xl border border-border p-4 mb-6">
        <p className="text-sm font-medium">ขีดจำกัดการใช้งาน AI มาตรฐาน / Standard AI usage limit</p>
        <p className="text-xs text-muted-foreground mt-0.5">ใช้กับแพทย์ทุกคนที่ไม่ได้ตั้งค่าเฉพาะราย / Applies to every physician without a per-user override.</p>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-sm text-muted-foreground">$</span>
          <input type="number" min={0} step="0.05"
            className="w-24 border rounded-md px-2 py-1 text-sm bg-background"
            value={stdLimit} onChange={e => setStdLimit(e.target.value)} />
          <Button variant="outline" className="text-xs px-3 py-1 h-auto" onClick={saveStdLimit}>บันทึก / Save</Button>
        </div>
      </div>
      </>)}

      {msg && <p className="mb-4 text-sm rounded-lg border border-border bg-secondary px-3 py-2">{msg}</p>}

      {isSuper && showForm && (
        <div className="border rounded-xl p-5 mb-6 space-y-4">
          {(['full_name_th','full_name_en','email','password','specialty','license_number'] as const).map(f => (
            <input key={f} className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder={FIELD_PLACEHOLDERS[f]} value={(form as any)[f]}
              type={f==='password'?'password':'text'}
              onChange={e => setForm(s => ({ ...s, [f]: e.target.value }))} />
          ))}
          <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
            value={form.role} onChange={e => setForm(s => ({ ...s, role: e.target.value }))}>
            {Object.entries(ROLE_LABELS).filter(([v]) => v !== 'superadmin').map(([v,l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
            value={form.council_id} onChange={e => setForm(s => ({ ...s, council_id: e.target.value }))}>
            <option value="">— เลือกสภาวิชาชีพ / Select council —</option>
            {councils.map(c => <option key={c.id} value={c.id}>{c.name_th} / {c.name_en}</option>)}
          </select>
          {err && <p className="text-destructive text-sm">{err}</p>}
          <Button className="w-full" onClick={createUser}>สร้างผู้ใช้ (active ทันที)</Button>
        </div>
      )}

      {/* Edit panel */}
      {editing && (
        <div className="border rounded-xl p-5 mb-6 space-y-3">
          <p className="font-medium">แก้ไข / Edit — {editing.full_name_en}</p>
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={editing.full_name_th}
            placeholder="ชื่อภาษาไทย" onChange={e => setEditing(u => u && ({ ...u, full_name_th: e.target.value }))} />
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={editing.full_name_en}
            placeholder="Full Name (English)" onChange={e => setEditing(u => u && ({ ...u, full_name_en: e.target.value }))} />
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={editing.specialty ?? ''}
            placeholder="สาขาวิชา / Specialty" onChange={e => setEditing(u => u && ({ ...u, specialty: e.target.value }))} />
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={editing.license_number ?? ''}
            placeholder="เลขใบอนุญาต / License No." onChange={e => setEditing(u => u && ({ ...u, license_number: e.target.value }))} />
          {editing.role === 'physician' && (
            <div>
              <input className="w-full border rounded-lg px-3 py-2 text-sm" type="number" min={0} step="0.05"
                value={editLimit}
                placeholder="ขีดจำกัดการใช้งาน AI ($) — เว้นว่าง = ใช้ค่ามาตรฐาน / AI usage limit ($) — blank = standard"
                onChange={e => setEditLimit(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">เว้นว่างเพื่อใช้ค่ามาตรฐาน (${parseFloat(stdLimit) || 0}) / Leave blank to use the standard limit.</p>
            </div>
          )}
          {editing.role === 'superadmin' ? (
            <input className="w-full border rounded-lg px-3 py-2 text-sm bg-muted text-muted-foreground"
              value="Superadmin (locked)" disabled readOnly />
          ) : (
            <>
              {/* 'special' is UI-only: it selects when role=physician + can_audit, and maps back on change. */}
              <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
                value={editing.role === 'physician' && editing.can_audit ? 'special' : editing.role}
                onChange={e => {
                  const v = e.target.value;
                  setEditing(u => u && (v === 'special'
                    ? { ...u, role: 'physician', can_audit: true }
                    : { ...u, role: v, can_audit: false }));
                }}>
                {EDIT_ROLE_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
                value={editing.council_id ?? ''} onChange={e => setEditing(u => u && ({ ...u, council_id: e.target.value }))}>
                <option value="">— เลือกสภาวิชาชีพ / Select council —</option>
                {councils.map(c => <option key={c.id} value={c.id}>{c.name_th} / {c.name_en}</option>)}
              </select>
            </>
          )}
          <div className="flex gap-2">
            <Button onClick={saveEdit}>บันทึก / Save</Button>
            <Button variant="outline" onClick={() => setEditing(null)}>ยกเลิก</Button>
          </div>
        </div>
      )}

      {/* Pending auditor-role requests — admin (council-scoped) + superadmin; renders nothing when empty. */}
      {requests.length > 0 && (
        <div className="border rounded-xl p-4 mb-6">
          <p className="text-sm font-medium">คำขอเป็นผู้ตรวจ / Auditor-role requests <span className="text-muted-foreground font-normal">({requests.length})</span></p>
          <div className="mt-2 space-y-2">
            {requests.map(r => (
              <div key={r.id} className="flex items-center justify-between gap-3 flex-wrap border-t border-border pt-2 first:border-t-0 first:pt-0">
                <div className="min-w-0">
                  <p className="text-sm">
                    {r.full_name_th || r.full_name_en || '—'}
                    {r.full_name_th && r.full_name_en ? <span className="text-xs text-muted-foreground"> · {r.full_name_en}</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{r.email ?? '—'} · {new Date(r.created_at).toLocaleDateString('th-TH')}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Admins see pending requests read-only; only superadmin can decide them. */}
                  {isSuper ? (
                    <>
                      <Button size="sm" onClick={() => decideRequest(r, 'approve')}>อนุมัติ / Approve</Button>
                      <Button size="sm" variant="outline" onClick={() => decideRequest(r, 'reject')}>ปฏิเสธ / Reject</Button>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">รอ Superadmin อนุมัติ / Awaiting superadmin approval</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Account-status filter (server-side; default hides deactivated members). */}
      <div className="flex gap-2 mb-3 flex-wrap">
        {STATUS_FILTERS.map(f => (
          <Button key={f.key} variant={statusFilter === f.key ? 'default' : 'outline'} size="sm" onClick={() => setStatusFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      {/* Loaded-vs-total count for the user list (respects the active status filter). */}
      <p className="mb-3 text-xs text-muted-foreground">
        แสดง {users.length} จาก {total} / Showing {users.length} of {total}
      </p>

      {mobile ? (
        <div className="space-y-3">
          {users.map(u => (
            <div key={u.id} className="rounded-xl border border-border p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{u.full_name_th}{u.pseudonym ? ` · ${u.pseudonym}` : ''}</p>
                <span className="inline-flex items-center gap-1.5 shrink-0">
                  <Badge variant="outline">{ROLE_LABELS[u.role] ?? u.role}</Badge>
                  {u.can_audit && <SpecialChip />}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">{u.full_name_en}</p>
              {u.role !== 'superadmin' && <p className="text-xs text-muted-foreground">🏛 {councilName(u.council_id)}</p>}
              {u.role === 'physician' && <div className="pt-1"><UsageCell u={u} /></div>}
              <div className="flex items-center justify-between pt-1">
                <StatusBadge s={u.status} />
                <RowActions u={u} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary"><tr>
              <th className="px-3 py-3 text-left whitespace-nowrap">ชื่อ (TH)</th>
              <th className="px-3 py-3 text-left whitespace-nowrap">ชื่อ (EN)</th>
              <th className="px-3 py-3 text-left whitespace-nowrap">Role</th>
              <th className="px-3 py-3 text-left whitespace-nowrap">สภา / Council</th>
              <th className="px-3 py-3 text-left whitespace-nowrap">การใช้งาน AI / Usage</th>
              <th className="px-3 py-3 text-left whitespace-nowrap">สถานะ / Status</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">การจัดการ / Actions</th>
            </tr></thead>
            <tbody>{users.map(u => (
              <tr key={u.id} className="border-t hover:bg-secondary/60">
                <td className="px-3 py-3 whitespace-nowrap">{u.full_name_th}{u.pseudonym ? <span className="text-muted-foreground text-xs"> · {u.pseudonym}</span> : ''}</td>
                <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">{u.full_name_en}</td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <Badge variant="outline">{ROLE_LABELS[u.role] ?? u.role}</Badge>
                    {u.can_audit && <SpecialChip />}
                  </span>
                </td>
                <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">{u.role === 'superadmin' ? '— ทุกสภา / All' : councilName(u.council_id)}</td>
                <td className="px-3 py-3"><UsageCell u={u} /></td>
                <td className="px-3 py-3 whitespace-nowrap"><StatusBadge s={u.status} /></td>
                <td className="px-3 py-3 text-right"><RowActions u={u} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {users.length < total && (
        <div className="mt-5 flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'กำลังโหลด… / Loading…' : 'โหลดเพิ่ม / Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
