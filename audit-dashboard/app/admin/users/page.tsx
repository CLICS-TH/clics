'use client';
import { useEffect, useRef, useState } from 'react';
import { apiFetch, apiFetchPaged } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';
import { useIsMobile, useIsTableCompact } from '@/components/ViewportProvider';
import { useChartColors } from '@/lib/chart-colors';
import { ROLE_LABELS, ACCOUNT_STATUS_MAP, budgetToneHex, roleToUi, roleToWire, POSITION_OPTIONS, positionLabel, fmtTokens } from '@/lib/labels';
import { type ApiResult, type UsageSettings, formatApiError } from '@/lib/types';
import { UsageMeter } from '@/components/UsageMeter';
import { confirmDialog } from '@/components/Overlays';
import { BarChart3, RotateCcw, Pencil, Power, Trash2, Building2, Eye, EyeOff, Stethoscope } from 'lucide-react';

const PAGE_SIZE = 50;

type User = {
  id: string; role: string; full_name_th: string; full_name_en: string;
  specialty?: string | null; license_number?: string | null;
  specialty_id?: string | null; position?: string | null;
  specialties?: { name_th: string; name_en: string; code?: string } | null;  // embedded for display
  status?: string; pseudonym?: string | null; council_id?: string | null;
  usage_cost_usd?: number | null; usage_limit_usd?: number | null;
  // Separate AUDITOR budget pool (auditors + dual-role "Special"); independent of the physician meter.
  auditor_usage_cost_usd?: number | null; auditor_usage_limit_usd?: number | null;
  // Token meters (input + output accumulate per pool) and the per-user TOKEN ceiling override:
  // null = the org ceiling applies, 0 = no cap for this user (backend/src/lib/usage.js effectiveTokenLimit).
  usage_input_tokens?: number | null; usage_output_tokens?: number | null; usage_limit_tokens?: number | null;
  auditor_usage_input_tokens?: number | null; auditor_usage_output_tokens?: number | null; auditor_usage_limit_tokens?: number | null;
  can_audit?: boolean | null;          // "Special" dual role: physician + auditor rights
};

// Per-user token override as typed → what PATCH /admin/users/:id receives. '' clears (null → the org
// ceiling), 0 = no cap for this user; anything else must be a whole number the backend will accept
// (≤ 50,000,000 — the same bound that keeps a mistyped value from silently un-capping someone).
// `false` = invalid. Exported for nothing; module-level so it is not re-created per render.
const MAX_TOKEN_OVERRIDE = 50_000_000;
const parseTokenOverride = (raw: string): number | null | false => {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= MAX_TOKEN_OVERRIDE ? n : false;
};
type Slot = { role: string; capacity: number; used: number; remaining: number };
type Council = { id: string; code: string; name_th: string; name_en: string };
// Per-council admin/auditor usage (the "active per council" breakdown from /admin/council-slots).
type CouncilSlots = { council_id: string; code: string; name_th: string; name_en: string; slots: Slot[] };
type Specialty = { id: string; council_id: string; code: string; name_th: string; name_en: string };

// Council-scoped roles carry a specialty (after roleToWire, 'special' → physician); global roles don't.
const roleNeedsSpecialty = (role: string) => ['admin', 'physician', 'auditor', 'special'].includes(role);
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

// Role filter chips (admin + superadmin; server-side ?role= on /admin/users, council-scoped for
// admins; '' = all). Reuses the EDIT_ROLE_OPTIONS labels (incl. 'special' = physician + can_audit)
// and adds Superadmin (the Superadmin chip is shown only to superadmin — see render).
const ROLE_FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'ทุกบทบาท / All roles' },
  ...EDIT_ROLE_OPTIONS,
  { key: 'superadmin', label: 'Superadmin' },
];

export default function UsersPage() {
  const CHART = useChartColors();
  const [users, setUsers] = useState<User[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [cap, setCap] = useState<Record<string, string>>({});
  // Per-council admin/auditor capacity (the pool actually enforced — the global admin/auditor row is
  // display-only). Editing was impossible via any API before /admin/councils/:id/slots.
  const [slotCouncil, setSlotCouncil] = useState('');
  const [councilSlots, setCouncilSlots] = useState<Slot[]>([]);
  const [ccap, setCcap] = useState<Record<string, string>>({});
  // Admin/auditor usage for EVERY council at once — the read-only "active per council" breakdown.
  const [councilSlotsAll, setCouncilSlotsAll] = useState<CouncilSlots[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [showPw, setShowPw] = useState(false);                 // create-form password reveal (eye icon)
  const [councils, setCouncils] = useState<Council[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);  // all specialties; filtered per council in the dropdowns
  const [form, setForm] = useState({ email:'', password:'', role:'physician', council_id:'', full_name_th:'', full_name_en:'', specialty_id:'', position:'', license_number:'' });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState<User | null>(null);
  const [editLimit, setEditLimit] = useState('');           // per-user usage limit override ($), '' = standard
  const [editAuditorLimit, setEditAuditorLimit] = useState(''); // per-user AUDITOR-pool override ($), '' = standard
  const [editTokens, setEditTokens] = useState('');            // per-user TOKEN ceiling override, '' = org ceiling, '0' = no cap
  const [editAuditorTokens, setEditAuditorTokens] = useState(''); // same, for the auditor pool
  const [stdLimit, setStdLimit] = useState('');             // org standard usage limit ($)
  const [auditorStdLimit, setAuditorStdLimit] = useState(''); // org standard AUDITOR usage limit ($)
  const [stdTokens, setStdTokens] = useState(0);              // org token ceiling per physician (0 = no cap); set on /admin/overview
  const [auditorStdTokens, setAuditorStdTokens] = useState(0); // org token ceiling per auditor (0 = no cap)
  const [poolLimit, setPoolLimit] = useState('');           // total API budget pool ($)
  const [totalUsed, setTotalUsed] = useState(0);            // total spent across all members ($)
  const [auditorTotalUsed, setAuditorTotalUsed] = useState(0); // total auditor-pool spend across members ($)
  const [total, setTotal] = useState(0);                    // total user count (X-Total-Count)
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);          // create-user request in flight
  const [saving, setSaving] = useState(false);              // edit-panel save in flight
  const [statusFilter, setStatusFilter] = useState('active'); // default hides deactivated; '' = all
  const [roleFilter, setRoleFilter] = useState('');           // server-side ?role= (superadmin only); '' = all
  const [councilFilter, setCouncilFilter] = useState('');     // server-side ?council= (superadmin only); '' = all
  const [specialtyFilter, setSpecialtyFilter] = useState<string[]>([]); // server-side ?specialty= (superadmin only), multi-select; [] = all
  const [positionFilter, setPositionFilter] = useState<string[]>([]);   // server-side ?position= medical-training-level (superadmin only), multi-select; [] = all
  const [q, setQ] = useState('');             // search box (live value)
  const [searchQ, setSearchQ] = useState(''); // debounced value sent as ?q= (server-side filter)
  const [requests, setRequests] = useState<AuditorRequest[]>([]); // pending auditor-role requests
  const mobile = useIsMobile();
  // The dense 8-column users list needs the card fallback through tablet/iPad (≤1024px), not just
  // phones — otherwise 768/812px side-scroll it. Other table↔card switches stay on `mobile` (≤767px).
  const tableAsCards = useIsTableCompact();

  // Admins get a read-only view (the dual-role GET /admin/users is council-scoped for them);
  // all mutations + /admin/slots + /admin/usage-settings remain superadmin-only.
  const isSuper = getUser()?.role === 'superadmin';

  // Query string for /admin/users — server-side status filter (omitted for All) + name/email
  // search (?q=, omitted when empty) + pagination. URLSearchParams handles the encoding.
  const usersQS = (limit: number, offset: number) => {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (statusFilter) qs.set('status', statusFilter);
    if (searchQ) qs.set('q', searchQ);
    if (roleFilter) qs.set('role', roleFilter);
    if (councilFilter) qs.set('council', councilFilter);
    if (specialtyFilter.length) qs.set('specialty', specialtyFilter.join(','));
    if (positionFilter.length) qs.set('position', positionFilter.join(','));
    return qs.toString();
  };

  // Monotonic request token: rapid filter/search changes (and a Load-more mid-change) fire overlapping
  // GETs; if an earlier/slower one resolves last it would overwrite the current filter's list with
  // stale rows. Only the most recently-issued request is allowed to apply its result.
  const reqSeq = useRef(0);

  // The Add-User form renders BELOW the slot/budget admin panels, so on a superadmin screen it opens
  // off-screen — clicking "+ Add User" at the top looked like nothing happened. Scroll it into view.
  const addFormRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showForm) addFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [showForm]);

  // Fetch one page (newest-first) and append, or replace from offset 0.
  const loadUsersPage = (offset: number) => {
    const my = ++reqSeq.current;
    return apiFetchPaged<User>(`/admin/users?${usersQS(PAGE_SIZE, offset)}`).then(({ items, total }) => {
      if (my !== reqSeq.current) return; // a newer filter/search superseded this response — drop it
      setTotal(total);
      setUsers(prev => (offset === 0 ? items : [...prev, ...items]));
    });
  };

  // Reload the currently-loaded range from the top so mutations don't drop rows
  // (used by create/edit/status/reset handlers below).
  const loadUsers = () => {
    const my = ++reqSeq.current;
    const count = Math.min(Math.max(users.length, PAGE_SIZE), 200);
    return apiFetchPaged<User>(`/admin/users?${usersQS(count, 0)}`).then(({ items, total }) => {
      if (my !== reqSeq.current) return;
      setTotal(total);
      setUsers(items);
    });
  };

  const loadMore = async () => {
    setLoadingMore(true);
    try { await loadUsersPage(users.length); }
    finally { setLoadingMore(false); }
  };
  const loadSlots = () => Promise.all([
    apiFetch<Slot[]>('/admin/slots'),
    apiFetch<CouncilSlots[]>('/admin/council-slots'),  // per-council breakdown, refreshed with the pools
  ]).then(([s, cs]) => {
    setSlots(s ?? []);
    setCap(Object.fromEntries((s ?? []).map(x => [x.role, String(x.capacity)])));
    setCouncilSlotsAll(Array.isArray(cs) ? cs : []);
  });
  const loadUsageSettings = () => apiFetch<UsageSettings>('/admin/usage-settings')
    .then(d => {
      setStdLimit(d?.standard_limit_usd != null ? String(d.standard_limit_usd) : '');
      setAuditorStdLimit(d?.auditor_standard_limit_usd != null ? String(d.auditor_standard_limit_usd) : '');
      setPoolLimit(d?.api_budget_pool_usd ? String(d.api_budget_pool_usd) : '');
      setTotalUsed(Number(d?.total_used_usd ?? 0));
      setAuditorTotalUsed(Number(d?.auditor_total_used_usd ?? 0));
      // Token ceilings: absent/0 = no cap. Edited on /admin/overview (Local AI capacity), read here for the meters.
      setStdTokens(Math.max(0, Number(d?.standard_limit_tokens ?? 0) || 0));
      setAuditorStdTokens(Math.max(0, Number(d?.auditor_standard_limit_tokens ?? 0) || 0));
    });
  const loadCouncils = () => apiFetch<Council[]>('/admin/councils').then(d => setCouncils(Array.isArray(d) ? d : []));
  // All specialties (every council) — filtered per-council in each dropdown; small set, fetched once.
  const loadSpecialties = () => apiFetch<Specialty[]>('/admin/specialties').then(d => setSpecialties(Array.isArray(d) ? d : []));
  // Pending auditor-role requests (admin: own council; superadmin: all) — section hides when empty.
  const loadRequests = () => apiFetch<AuditorRequest[]>('/admin/auditor-requests').then(d => setRequests(Array.isArray(d) ? d : []));
  useEffect(() => {
    loadCouncils(); loadSpecialties(); loadRequests();
    // Slot pools and usage settings are superadmin-only endpoints — skip for admins.
    if (isSuper) { loadSlots(); loadUsageSettings(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce the search box (~350ms) into searchQ, which drives the refetch below.
  useEffect(() => {
    const t = setTimeout(() => setSearchQ(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  // (Re)load page 0 whenever the status filter or the (debounced) search changes (incl. on
  // mount) — resets pagination to offset 0.
  // (Changing the council filter clears the specialty selection at the chip onClick — see the Council
  // filter row — so selected specialties can never outlive their council.)
  useEffect(() => { loadUsersPage(0); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [statusFilter, searchQ, roleFilter, councilFilter, specialtyFilter.join(','), positionFilter.join(',')]);

  // Edit modal a11y: Escape closes it (the overlay is role=dialog/aria-modal; backdrop click already
  // closes). Keyboard users could otherwise only reach Cancel by tabbing the whole form.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditing(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);

  const councilName = (id?: string | null) => councils.find(c => c.id === id)?.name_th ?? '—';
  // Active specialties belonging to a council (drives the cascading dropdowns).
  const specialtiesFor = (cid?: string | null) => specialties.filter(s => s.council_id === cid);

  function openEdit(u: User) {
    setEditing(u);
    setEditLimit(u.usage_limit_usd != null ? String(u.usage_limit_usd) : '');
    setEditAuditorLimit(u.auditor_usage_limit_usd != null ? String(u.auditor_usage_limit_usd) : '');
    setEditTokens(u.usage_limit_tokens != null ? String(u.usage_limit_tokens) : '');
    setEditAuditorTokens(u.auditor_usage_limit_tokens != null ? String(u.auditor_usage_limit_tokens) : '');
  }

  // Effective limit shown in the list: per-user override if set, else the org standard (per pool).
  const effLimit = (u: User) => u.usage_limit_usd != null ? u.usage_limit_usd : (parseFloat(stdLimit) || 0);
  const effAuditorLimit = (u: User) => u.auditor_usage_limit_usd != null ? u.auditor_usage_limit_usd : (parseFloat(auditorStdLimit) || 0);
  // Effective TOKEN ceiling per pool: the per-user override if set (0 = no cap), else the org ceiling
  // (0 = no cap). Mirrors backend/src/lib/usage.js effectiveTokenLimit — 0 here means "uncapped",
  // and the meter draws no bar for it. Not in the list payload, so computed client-side.
  const effTokens = (u: User) => u.usage_limit_tokens != null ? Math.max(0, Number(u.usage_limit_tokens) || 0) : stdTokens;
  const effAuditorTokens = (u: User) => u.auditor_usage_limit_tokens != null ? Math.max(0, Number(u.auditor_usage_limit_tokens) || 0) : auditorStdTokens;
  const tokensUsed = (u: User) => (Number(u.usage_input_tokens) || 0) + (Number(u.usage_output_tokens) || 0);
  const auditorTokensUsed = (u: User) => (Number(u.auditor_usage_input_tokens) || 0) + (Number(u.auditor_usage_output_tokens) || 0);

  async function createUser() {
    setErr('');
    if (!form.council_id) { setErr('เลือกสภาวิชาชีพ / Select a council.'); return; }
    // Specialty is required for council-scoped roles when the council has any (matches the backend).
    if (roleNeedsSpecialty(form.role) && specialtiesFor(form.council_id).length > 0 && !form.specialty_id) {
      setErr('เลือกความเชี่ยวชาญ / Select a specialty.'); return;
    }
    setCreating(true);
    try {
      // 'special' is a UI-only role value; roleToWire turns it into {role:'physician', can_audit:true}.
      // Empty specialty_id/position would fail the uuid/enum schema — omit them.
      const body: Record<string, unknown> = { ...form, ...roleToWire(form.role) };
      if (!body.specialty_id) delete body.specialty_id;
      if (!body.position) delete body.position;
      const res = await apiFetch<ApiResult<User>>('/admin/users', { method:'POST', body: JSON.stringify(body) });
      if (res?.id) {
        setShowForm(false); setShowPw(false);
        // Reset the WHOLE form — leaving email/password/names behind pre-filled the next "+ Add User"
        // with the previous person's credentials (incl. their password).
        setForm({ email:'', password:'', role:'physician', council_id:'', full_name_th:'', full_name_en:'', specialty_id:'', position:'', license_number:'' });
        loadUsers(); loadSlots();
      }
      else setErr(formatApiError(res?.error, 'Error'));
    } finally { setCreating(false); }
  }

  async function saveEdit() {
    if (!editing) return;
    setMsg('');
    // PATCH /admin/users/:id body — name/specialty/license always; role/council/can_audit only for
    // non-superadmins; usage_limit_usd is a number (cap) or null (clear → standard default).
    const body: {
      full_name_th: string; full_name_en: string; specialty: string; license_number: string;
      role?: string; council_id?: string | null; can_audit?: boolean; usage_limit_usd?: number | null;
      auditor_usage_limit_usd?: number | null; specialty_id?: string; position?: string;
      usage_limit_tokens?: number | null; auditor_usage_limit_tokens?: number | null;
    } = {
      full_name_th: editing.full_name_th, full_name_en: editing.full_name_en,
      specialty: editing.specialty ?? '', license_number: editing.license_number ?? '',
    };
    // The superadmin role is immutable — never send a role change for it (backend rejects it too).
    // can_audit travels with the role: 'Special' = {role:'physician', can_audit:true}; any other role clears it.
    if (editing.role !== 'superadmin') {
      body.role = editing.role; body.council_id = editing.council_id; body.can_audit = editing.can_audit === true;
      // Specialty/position only apply to council-scoped roles. Empty → omitted (JSON.stringify drops
      // undefined), so an unrelated edit never clears them; the backend clears them on a move to a global role.
      if (['admin', 'physician', 'auditor'].includes(editing.role)) {
        if (specialtiesFor(editing.council_id).length > 0 && !editing.specialty_id) {
          setMsg('เลือกความเชี่ยวชาญ / Select a specialty.'); return;
        }
        body.specialty_id = editing.specialty_id || undefined;
        body.position = editing.position || undefined;
      }
    }
    // Usage limit override: a number sets a per-user cap; empty clears it (null => standard default).
    const trimmed = editLimit.trim();
    body.usage_limit_usd = trimmed === '' ? null : Number(trimmed);
    if (body.usage_limit_usd != null && (!Number.isFinite(body.usage_limit_usd) || body.usage_limit_usd < 0)) {
      setMsg('ขีดจำกัดไม่ถูกต้อง / Invalid usage limit.'); return;
    }
    // Token ceiling override — same nullable shape: blank clears (null → org ceiling), 0 = no cap.
    const tok = parseTokenOverride(editTokens);
    if (tok === false) { setMsg('เพดานโทเคนไม่ถูกต้อง (จำนวนเต็ม 0–50,000,000) / Invalid token limit (whole number 0–50,000,000).'); return; }
    body.usage_limit_tokens = tok;
    // Auditor-pool override — only meaningful for auditors / dual-role "Special"; same number-or-clear rule.
    if (editing.role === 'auditor' || editing.can_audit === true) {
      const at = editAuditorLimit.trim();
      body.auditor_usage_limit_usd = at === '' ? null : Number(at);
      if (body.auditor_usage_limit_usd != null && (!Number.isFinite(body.auditor_usage_limit_usd) || body.auditor_usage_limit_usd < 0)) {
        setMsg('ขีดจำกัดผู้ตรวจไม่ถูกต้อง / Invalid auditor usage limit.'); return;
      }
      const atok = parseTokenOverride(editAuditorTokens);
      if (atok === false) { setMsg('เพดานโทเคนผู้ตรวจไม่ถูกต้อง (จำนวนเต็ม 0–50,000,000) / Invalid auditor token limit (whole number 0–50,000,000).'); return; }
      body.auditor_usage_limit_tokens = atok;
    }
    setSaving(true);
    try {
      const res = await apiFetch<ApiResult<User>>(`/admin/users/${editing.id}`, { method:'PATCH', body: JSON.stringify(body) });
      if (res?.id) { setEditing(null); setMsg('บันทึกแล้ว / Saved.'); loadUsers(); loadSlots(); }
      // res.error can be a zod-flatten OBJECT — rendering an object in JSX throws, so stringify it.
      else setMsg(formatApiError(res?.error, 'แก้ไขไม่สำเร็จ / Update failed.'));
    } finally { setSaving(false); }
  }

  async function saveStdLimit() {
    setMsg('');
    const v = parseFloat(stdLimit);
    if (!Number.isFinite(v) || v < 0) { setMsg('ขีดจำกัดมาตรฐานไม่ถูกต้อง / Invalid standard limit.'); return; }
    const res = await apiFetch<ApiResult<{ standard_limit_usd: number }>>('/admin/usage-settings', { method:'PATCH', body: JSON.stringify({ standard_limit_usd: v }) });
    if (res?.standard_limit_usd != null) { setMsg('บันทึกขีดจำกัดมาตรฐานแล้ว / Standard limit saved.'); loadUsageSettings(); loadUsers(); }
    else setMsg(formatApiError(res?.error, 'บันทึกไม่สำเร็จ / Failed.'));
  }

  async function saveAuditorStdLimit() {
    setMsg('');
    const v = parseFloat(auditorStdLimit);
    if (!Number.isFinite(v) || v < 0) { setMsg('ขีดจำกัดผู้ตรวจมาตรฐานไม่ถูกต้อง / Invalid auditor standard limit.'); return; }
    const res = await apiFetch<ApiResult<{ auditor_standard_limit_usd: number }>>('/admin/usage-settings', { method:'PATCH', body: JSON.stringify({ auditor_standard_limit_usd: v }) });
    if (res?.auditor_standard_limit_usd != null) { setMsg('บันทึกขีดจำกัดผู้ตรวจแล้ว / Auditor standard limit saved.'); loadUsageSettings(); loadUsers(); }
    else setMsg(formatApiError(res?.error, 'บันทึกไม่สำเร็จ / Failed.'));
  }

  async function savePool() {
    setMsg('');
    const v = parseFloat(poolLimit);
    if (!Number.isFinite(v) || v < 0) { setMsg('งบประมาณรวมไม่ถูกต้อง / Invalid API budget pool.'); return; }
    const res = await apiFetch<ApiResult<{ api_budget_pool_usd: number }>>('/admin/usage-settings', { method:'PATCH', body: JSON.stringify({ api_budget_pool_usd: v }) });
    if (res?.api_budget_pool_usd != null) { setMsg('บันทึกงบประมาณรวมแล้ว / API budget pool saved.'); loadUsageSettings(); }
    else setMsg(formatApiError(res?.error, 'บันทึกไม่สำเร็จ / Failed.'));
  }

  async function resetUsage(u: User) {
    // Reset every AI pool the member holds — same split as the usage meters: a physician/"Special"
    // owns the physician pool, an auditor/"Special" owns the auditor pool. A dual-role "Special"
    // (role=physician + can_audit) carries BOTH, so both meters reset together.
    const resetPhysician = u.role === 'physician';                 // includes "Special" (role=physician)
    const resetAuditor = u.role === 'auditor' || u.can_audit === true;
    const ok = await confirmDialog({
      title: 'รีเซ็ตการใช้งาน? / Reset usage?',
      body: `รีเซ็ตการใช้งาน AI ของ ${u.full_name_en} เป็น $0? / Reset this member's AI usage to $0?`,
      confirmLabel: 'รีเซ็ต / Reset',
    });
    if (!ok) return;
    setMsg('');
    const endpoints: string[] = [];
    if (resetPhysician) endpoints.push(`/admin/users/${u.id}/reset-usage`);
    if (resetAuditor) endpoints.push(`/admin/users/${u.id}/reset-auditor-usage`);
    const results = await Promise.all(endpoints.map(e => apiFetch<ApiResult<User>>(e, { method:'POST', body: JSON.stringify({}) })));
    loadUsers();                                                   // refresh from the server either way
    if (results.length > 0 && results.every(r => r?.id)) setMsg('รีเซ็ตการใช้งานแล้ว / Usage reset.');
    else setMsg(formatApiError(results.find(r => !r?.id)?.error, 'รีเซ็ตไม่สำเร็จ / Reset failed.'));
  }

  async function toggleStatus(u: User) {
    const next = u.status === 'deactivated' ? 'active' : 'deactivated';
    const deact = next === 'deactivated';
    const ok = await confirmDialog({
      title: deact ? 'ปิดใช้งานบัญชี? / Deactivate account?' : 'เปิดใช้งานอีกครั้ง? / Reactivate account?',
      body: deact
        ? 'ผู้ใช้จะเข้าสู่ระบบไม่ได้จนกว่าจะเปิดใช้งานใหม่ / The user won\'t be able to sign in until reactivated.'
        : 'ผู้ใช้จะกลับมาเข้าสู่ระบบได้ / The user will be able to sign in again.',
      danger: deact, confirmLabel: deact ? 'ปิดใช้งาน / Deactivate' : 'เปิดใช้งาน / Reactivate',
    });
    if (!ok) return;
    setMsg('');
    const res = await apiFetch<ApiResult<User>>(`/admin/users/${u.id}/status`, { method:'PATCH', body: JSON.stringify({ status: next }) });
    if (res?.id) { setMsg('อัปเดตสถานะแล้ว / Status updated.'); loadUsers(); loadSlots(); }
    else setMsg(formatApiError(res?.error, 'อัปเดตไม่สำเร็จ / Failed.'));
  }

  // PURGE — irreversibly delete a deactivated user and ALL their data (IRB right-to-erasure /
  // consent withdrawal). Distinct from deactivate (which keeps history). Two safety gates: the
  // backend requires the user to be deactivated first, and here the superadmin must type the
  // person's exact name to confirm.
  async function purgeUser(u: User) {
    // Native prompt is kept ONLY here: a typed-name match is a deliberate high-friction gate for an
    // irreversible IRB erasure (superadmin-only, rare). Routine confirms use the themed dialog.
    const typed = window.prompt(
      `ลบผู้ใช้และประวัติทั้งหมดอย่างถาวร (กู้คืนไม่ได้) — พิมพ์ชื่อให้ตรงเพื่อยืนยัน\n` +
      `PERMANENTLY delete this user and ALL their sessions/scores (cannot be undone). Type the name to confirm:\n\n${u.full_name_en}`,
    );
    if (typed == null) return; // cancelled
    if (typed.trim() !== u.full_name_en) { setMsg('ชื่อยืนยันไม่ตรง — ยกเลิกการลบ / Name did not match — purge cancelled.'); return; }
    setMsg('');
    const res = await apiFetch<ApiResult<{ purged: boolean; deleted_ples: number }>>(`/admin/users/${u.id}/purge`, { method: 'DELETE', body: JSON.stringify({ confirm_name: u.full_name_en }) });
    if (res?.purged) {
      setUsers(s => s.filter(x => x.id !== u.id));
      setMsg(`ลบผู้ใช้ถาวรแล้ว (${res.deleted_ples} เซสชัน) / User purged — ${res.deleted_ples} session(s) removed.`);
      loadSlots();
    } else setMsg(formatApiError(res?.error, 'ลบไม่สำเร็จ / Purge failed.'));
  }

  // Approve/reject a pending auditor-role request, then refresh both the section and the
  // users list (approve flips can_audit on the professional, so the Special chip appears).
  async function decideRequest(r: AuditorRequest, action: 'approve' | 'reject') {
    setMsg('');
    const res = await apiFetch<ApiResult<{ ok: boolean }>>(`/admin/auditor-requests/${r.id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
    if (res?.ok) {
      setMsg(action === 'approve' ? 'อนุมัติคำขอแล้ว / Request approved.' : 'ปฏิเสธคำขอแล้ว / Request rejected.');
      loadRequests(); loadUsers();
    } else setMsg(formatApiError(res?.error, 'ดำเนินการไม่สำเร็จ / Failed.'));
  }

  const loadCouncilSlots = (cid: string) => {
    if (!cid) { setCouncilSlots([]); setCcap({}); return; }
    apiFetch<Slot[]>(`/admin/councils/${cid}/slots`).then(d => {
      const arr = Array.isArray(d) ? d : [];
      setCouncilSlots(arr);
      setCcap(Object.fromEntries(arr.map(s => [s.role, String(s.capacity)])));
    }).catch(() => { setCouncilSlots([]); setCcap({}); });
  };

  async function saveCouncilCap(role: string) {
    const capacity = parseInt(ccap[role] ?? '', 10);
    if (!slotCouncil) return;
    if (!Number.isFinite(capacity) || capacity < 0) { setMsg('จำนวนช่องไม่ถูกต้อง / Invalid capacity.'); return; }
    const res = await apiFetch<ApiResult<Slot>>(`/admin/councils/${slotCouncil}/slots/${role}`, { method:'PATCH', body: JSON.stringify({ capacity }) });
    if (res?.role) { setMsg('บันทึกจำนวนช่องของสภาแล้ว / Council capacity saved.'); loadCouncilSlots(slotCouncil); loadUsers(); }
    else setMsg(formatApiError(res?.error, 'บันทึกไม่สำเร็จ / Failed.'));
  }

  async function saveCap(role: string) {
    setMsg('');
    const capacity = parseInt(cap[role] ?? '', 10);
    if (!Number.isFinite(capacity) || capacity < 0) { setMsg('จำนวนช่องไม่ถูกต้อง / Invalid capacity.'); return; }
    const res = await apiFetch<ApiResult<Slot>>(`/admin/slots/${role}`, { method:'PATCH', body: JSON.stringify({ capacity }) });
    if (res?.role) { setMsg('บันทึกจำนวนช่องแล้ว / Capacity saved.'); loadSlots(); }
    else setMsg(formatApiError(res?.error, 'บันทึกไม่สำเร็จ / Failed.'));
  }

  const StatusBadge = ({ s }: { s?: string }) => (
    <span className={`text-xs px-2 py-0.5 rounded-full ${s === 'deactivated' ? 'bg-muted text-muted-foreground' : 'bg-[var(--chart-pass)]/20 text-foreground'}`}>
      {ACCOUNT_STATUS_MAP[s ?? 'active'] ?? s}
    </span>
  );

  // Dual-role marker: a physician who also holds auditor rights (professionals.can_audit).
  const SpecialChip = () => (
    <span title="แพทย์ที่เป็นผู้ตรวจด้วย / Physician with auditor rights"
      className="text-xs px-1.5 py-0.5 rounded-full border border-primary/40 bg-primary/10 text-foreground whitespace-nowrap">
      Special
    </span>
  );

  // AI usage: physician rows show the physician pool; auditor rows show the SEPARATE auditor pool; a
  // dual-role "Special" (role=physician + can_audit) holds BOTH budgets, so show both stacked + labelled.
  // Each pool has a $ meter (cloud spend) and a token meter (the ceiling that throttles the $0-priced
  // local model) — components/UsageMeter.tsx; admins (no /admin/usage-settings) get used-only figures.
  const UsageCell = ({ u }: { u: User }) => {
    const showPhysician = u.role === 'physician';            // includes "Special" (role=physician)
    const showAuditor = u.role === 'auditor' || u.can_audit === true;
    if (!showPhysician && !showAuditor) return <span className="text-xs text-muted-foreground">—</span>;
    const both = showPhysician && showAuditor;               // label each pool only when both are present
    return (
      <div className="min-w-[120px] space-y-1.5">
        {showPhysician && <>
          <UsageMeter used={Number(u.usage_cost_usd ?? 0)} limit={effLimit(u)} hasOverride={u.usage_limit_usd != null} label={both ? 'ผู้ใช้/User' : undefined} showLimit={isSuper} />
          <UsageMeter unit="tokens" used={tokensUsed(u)} limit={effTokens(u)} hasOverride={u.usage_limit_tokens != null} label="โทเคน/Tokens" showLimit={isSuper} />
        </>}
        {showAuditor && <>
          <UsageMeter used={Number(u.auditor_usage_cost_usd ?? 0)} limit={effAuditorLimit(u)} hasOverride={u.auditor_usage_limit_usd != null} label={both ? 'ผู้ตรวจ/Auditor' : undefined} showLimit={isSuper} />
          <UsageMeter unit="tokens" used={auditorTokensUsed(u)} limit={effAuditorTokens(u)} hasOverride={u.auditor_usage_limit_tokens != null} label="โทเคน/Tokens" showLimit={isSuper} />
        </>}
      </div>
    );
  };

  // Compact square icon button for dense table rows (tooltip carries the bilingual label).
  const IconBtn = ({ icon, title, onClick, disabled, href }: { icon: React.ReactNode; title: string; onClick?: () => void; disabled?: boolean; href?: string }) => {
    const cls = 'w-8 h-8 inline-flex items-center justify-center border border-border rounded-md leading-none hover:bg-secondary disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-4';
    return href
      ? <a href={href} title={title} aria-label={title} className={cls}>{icon}</a>
      : <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled} className={cls}>{icon}</button>;
  };

  // Inline row actions, shared by the desktop table and the mobile cards.
  const RowActions = ({ u }: { u: User }) => (
    <div className="inline-flex items-center gap-1.5">
      {u.role === 'physician' && <IconBtn icon={<BarChart3 />} title="คะแนน / Scores" href={`/admin/lpdp/${u.id}`} />}
      {isSuper && (u.role === 'physician' || u.role === 'auditor') && <IconBtn icon={<RotateCcw />} title="รีเซ็ตการใช้งาน / Reset usage" onClick={() => resetUsage(u)} />}
      {isSuper && <IconBtn icon={<Pencil />} title="แก้ไข / Edit" onClick={() => openEdit(u)} />}
      {isSuper && <IconBtn icon={<Power />} title={u.status === 'deactivated' ? 'เปิดใช้ / Activate' : 'ปิดใช้ / Deactivate'}
        disabled={u.role === 'superadmin'} onClick={() => toggleStatus(u)} />}
      {/* Purge appears ONLY on already-deactivated, non-superadmin users — a deliberate second step. */}
      {isSuper && u.status === 'deactivated' && u.role !== 'superadmin' &&
        <IconBtn icon={<Trash2 />} title="ลบถาวร / Purge (delete all data)" onClick={() => purgeUser(u)} />}
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
  const poolToneColor = budgetToneHex(poolPct / 100, CHART); // shared thresholds/colors (lib/labels.ts)

  return (
    <div className="p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Users"
        title="จัดการผู้ใช้งาน"
        subtitle="User Management — สมาชิก, สถานะบัญชี และจำนวนช่องต่อบทบาท · Members, account status, and role slot pools."
        action={isSuper ? <Button onClick={() => setShowForm(v => !v)}>+ เพิ่มผู้ใช้ / Add User</Button> : undefined}
      />

      {/* Role slot pools — superadmin-only (admins can't read /admin/slots). Columns track the CONTAINER
          (@container on AppShell), not the viewport — so this is correct in real-phone, auto, AND the
          forced-mobile 460px frame without needing the JS mobile flag (a container query, unlike md:,
          shrinks with the frame). */}
      {isSuper && (<>
      <div className="grid grid-cols-2 gap-3 mb-6 @min-[768px]:grid-cols-4">
        {slots.map(s => {
          // admin/auditor capacity is enforced PER-COUNCIL (council_slots). The card now shows the
          // truthful aggregate: used = cross-council count, capacity = SUM of every council's pool
          // (backend slotUsage), e.g. 16/36 instead of the old 16/5. There's nothing to edit globally
          // for them (the backend rejects it) — so we drop the input and point at the per-council panel.
          const perCouncil = s.role === 'admin' || s.role === 'auditor';
          const locked = s.role === 'superadmin';              // physician editable; superadmin = fixed singleton
          const full = !perCouncil && s.remaining <= 0;
          return (
            <div key={s.role} className="rounded-xl border border-border p-4">
              <p className="text-sm font-medium">{ROLE_LABELS[s.role] ?? s.role}</p>
              <p className={`text-2xl font-semibold tabular-nums mt-1 ${full ? 'text-destructive' : ''}`}>{s.used}<span className="text-muted-foreground text-base">/{s.capacity}</span></p>
              <p className="text-xs text-muted-foreground">
                {perCouncil
                  ? `เหลือ ${s.remaining} ช่อง · รวมทุกสภา / ${s.remaining} left · across all councils`
                  : `เหลือ ${s.remaining} ช่อง / ${s.remaining} left`}
              </p>
              {perCouncil ? (
                <p className="text-xs text-muted-foreground mt-2">ตั้งค่าต่อสภาด้านล่าง / set per-council below</p>
              ) : (
                <div className="flex items-center gap-1.5 mt-2">
                  <input type="number" min={0} disabled={locked}
                    className="flex-1 min-w-0 border rounded-md px-2 py-1 text-sm bg-background disabled:opacity-50"
                    value={cap[s.role] ?? ''} onChange={e => setCap(c => ({ ...c, [s.role]: e.target.value }))} />
                  <Button variant="outline" className="text-xs px-2 py-1 h-auto shrink-0" disabled={locked} onClick={() => saveCap(s.role)}>
                    {locked ? '🔒' : 'ตั้งค่า'}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Per-council admin/auditor capacity — the pool actually enforced (the global admin/auditor
          card above is display-only). Pick a council to edit its real capacity. */}
      <div className="rounded-xl border border-border p-4 mb-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm font-medium">ความจุต่อสภา (Admin/Auditor) / Per-council capacity</p>
          <select className="border rounded-md px-2 py-1 text-sm bg-background"
            value={slotCouncil} onChange={e => { setSlotCouncil(e.target.value); loadCouncilSlots(e.target.value); }}>
            <option value="">— เลือกสภา / Select a council —</option>
            {councils.map(c => <option key={c.id} value={c.id}>{c.name_th} / {c.name_en}</option>)}
          </select>
        </div>

        {/* Read-only breakdown: how many admins/auditors are ACTIVE in each council (used/capacity). */}
        {councilSlotsAll.length > 0 && mobile && (
          <div className="mt-3 space-y-2">
            {councilSlotsAll.map(c => {
              const cell = (role: string) => {
                const s = c.slots.find(x => x.role === role);
                if (!s) return '—';
                return <span className={s.remaining <= 0 ? 'text-destructive' : ''}>{s.used}<span className="text-muted-foreground">/{s.capacity}</span></span>;
              };
              return (
                <div key={c.council_id} className="rounded-lg border border-border p-3 text-sm">
                  <p><span className="font-medium">{c.code}</span> <span className="text-xs text-muted-foreground">{c.name_th}</span></p>
                  <div className="mt-1 flex gap-5 text-xs tabular-nums">
                    <span className="text-muted-foreground">ผู้ดูแล / Admin: <span className="text-foreground">{cell('admin')}</span></span>
                    <span className="text-muted-foreground">ผู้ตรวจ / Auditor: <span className="text-foreground">{cell('auditor')}</span></span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {councilSlotsAll.length > 0 && !mobile && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground text-left">
                  <th className="font-medium py-1 pr-3">สภา / Council</th>
                  <th className="font-medium py-1 px-2 text-right">ผู้ดูแล / Admin</th>
                  <th className="font-medium py-1 px-2 text-right">ผู้ตรวจ / Auditor</th>
                </tr>
              </thead>
              <tbody>
                {councilSlotsAll.map(c => {
                  const cell = (role: string) => {
                    const s = c.slots.find(x => x.role === role);
                    if (!s) return <span className="text-muted-foreground">—</span>;
                    return <span className={s.remaining <= 0 ? 'text-destructive' : ''}>{s.used}<span className="text-muted-foreground">/{s.capacity}</span></span>;
                  };
                  return (
                    <tr key={c.council_id} className="border-t border-border">
                      <td className="py-1.5 pr-3"><span className="font-medium">{c.code}</span> <span className="text-xs text-muted-foreground">{c.name_th}</span></td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{cell('admin')}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{cell('auditor')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {slotCouncil && (
          <div className="grid grid-cols-1 gap-3 mt-3 @min-[520px]:grid-cols-2">
            {councilSlots.map(s => {
              const full = s.remaining <= 0;
              return (
                <div key={s.role} className="rounded-lg border border-border p-3">
                  <p className="text-sm font-medium">{ROLE_LABELS[s.role] ?? s.role}</p>
                  <p className={`text-xl font-semibold tabular-nums mt-1 ${full ? 'text-destructive' : ''}`}>{s.used}<span className="text-muted-foreground text-base">/{s.capacity}</span></p>
                  <p className="text-xs text-muted-foreground">เหลือ {s.remaining} ช่อง / {s.remaining} left</p>
                  <div className="flex items-center gap-1.5 mt-2">
                    <input type="number" min={0}
                      className="flex-1 min-w-0 border rounded-md px-2 py-1 text-sm bg-background"
                      value={ccap[s.role] ?? ''} onChange={e => setCcap(c => ({ ...c, [s.role]: e.target.value }))} />
                    <Button variant="outline" className="text-xs px-2 py-1 h-auto shrink-0" onClick={() => saveCouncilCap(s.role)}>ตั้งค่า / Set</Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
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
        {/* Say what it DOES. Until 2026-09-07 this field was stored, rendered here, and enforced
            nowhere — an operator who typed 12 believed spend stopped at $12 while the only real
            ceiling was the Anthropic balance. It now pauses the evaluation drain, which is the
            largest single spend; per-turn chat keeps its own per-user ceilings. Saying so matters
            because pausing scoring is a consequence someone should choose deliberately. */}
        <p className="text-xs text-muted-foreground mt-1">
          เมื่อใช้ครบ ระบบจะ<strong>หยุดคิวให้คะแนน PIS-7</strong>ชั่วคราวจนกว่าจะเพิ่มงบ งานในคิวไม่หาย
          และ <span className="font-mono">/health/deep</span> จะรายงานว่า degraded • ตั้ง <span className="font-mono">0</span> = ไม่จำกัด •
          When the pool is spent the PIS-7 scoring queue <strong>pauses</strong> until it is raised — queued work is
          untouched and <span className="font-mono">/health/deep</span> reports degraded. <span className="font-mono">0</span> means no cap.
        </p>
        <div className="flex items-baseline justify-between gap-2 mt-2">
          <span className="text-sm text-muted-foreground">ใช้ไปแล้ว / Used</span>
          <span className={`text-lg font-semibold tabular-nums ${poolPct >= 90 ? 'text-destructive' : ''}`}>
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
        <p className="text-xs text-muted-foreground mt-1.5">
          * ตัวเลขนี้คือยอดที่ระบบคำนวณ — ยอดคงเหลือจริงดูได้ที่ Anthropic Console / This is the amount metered by CLICS; the real remaining balance lives in the Anthropic Console (linked above).
        </p>
      </div>

      {/* Standard AI usage limit — default budget per physician (per-user overrides set in Edit). */}
      <div className="rounded-xl border border-border p-4 mb-4">
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

      {/* Standard AUDITOR AI usage limit — the separate auditor pool's default (per-user overrides in Edit).
          Auditors get their own $0.50 credit for the AI discussion chat, independent of physician spend. */}
      <div className="rounded-xl border border-border p-4 mb-6">
        <p className="text-sm font-medium">ขีดจำกัด AI ของผู้ตรวจ (มาตรฐาน) / Standard Auditor AI limit</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          พูลแยกสำหรับผู้ตรวจ — ใช้กับผู้ตรวจทุกคนที่ไม่ได้ตั้งค่าเฉพาะราย (ยอดรวมปัจจุบัน ${auditorTotalUsed.toFixed(4)}) / Separate auditor pool; applies to every auditor without an override (total spent so far ${auditorTotalUsed.toFixed(4)}).
        </p>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-sm text-muted-foreground">$</span>
          <input type="number" min={0} step="0.05"
            className="w-24 border rounded-md px-2 py-1 text-sm bg-background"
            value={auditorStdLimit} onChange={e => setAuditorStdLimit(e.target.value)} />
          <Button variant="outline" className="text-xs px-3 py-1 h-auto" onClick={saveAuditorStdLimit}>บันทึก / Save</Button>
        </div>
      </div>
      </>)}

      {msg && <p className="mb-4 text-sm rounded-lg border border-border bg-secondary px-3 py-2">{msg}</p>}

      {isSuper && showForm && (
        <div ref={addFormRef} className="border rounded-xl p-5 mb-6 space-y-4">
          {(['full_name_th','full_name_en','email'] as const).map(f => (
            <input key={f} className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder={FIELD_PLACEHOLDERS[f]} value={form[f]}
              type="text"
              onChange={e => setForm(s => ({ ...s, [f]: e.target.value }))} />
          ))}
          {/* Password with an eye toggle so the superadmin can verify what they typed before creating. */}
          <div className="relative">
            <input className="w-full border rounded-lg px-3 py-2 pr-10 text-sm"
              placeholder={FIELD_PLACEHOLDERS.password} value={form.password}
              type={showPw ? 'text' : 'password'}
              onChange={e => setForm(s => ({ ...s, password: e.target.value }))} />
            <button type="button" onClick={() => setShowPw(v => !v)}
              title={showPw ? 'ซ่อนรหัสผ่าน / Hide password' : 'แสดงรหัสผ่าน / Show password'}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground [&_svg]:size-4">
              {showPw ? <EyeOff /> : <Eye />}
            </button>
          </div>
          <input className="w-full border rounded-lg px-3 py-2 text-sm"
            placeholder={FIELD_PLACEHOLDERS.license_number} value={form.license_number} type="text"
            onChange={e => setForm(s => ({ ...s, license_number: e.target.value }))} />
          {/* Same options as the edit panel — 'special' (User+Auditor) maps to physician+can_audit via roleToWire. */}
          <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
            value={form.role} onChange={e => setForm(s => ({ ...s, role: e.target.value }))}>
            {EDIT_ROLE_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          {/* Council → specialty cascade: changing council clears the (now-foreign) specialty. */}
          <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
            value={form.council_id} onChange={e => setForm(s => ({ ...s, council_id: e.target.value, specialty_id: '' }))}>
            <option value="">— เลือกสภาวิชาชีพ / Select council —</option>
            {councils.map(c => <option key={c.id} value={c.id}>{c.name_th} / {c.name_en}</option>)}
          </select>
          <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background disabled:opacity-50"
            value={form.specialty_id} disabled={!form.council_id || specialtiesFor(form.council_id).length === 0}
            onChange={e => setForm(s => ({ ...s, specialty_id: e.target.value }))}>
            <option value="">— เลือกความเชี่ยวชาญ / Select specialty —</option>
            {specialtiesFor(form.council_id).map(s => <option key={s.id} value={s.id}>{s.name_th} / {s.name_en}</option>)}
          </select>
          <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
            value={form.position} onChange={e => setForm(s => ({ ...s, position: e.target.value }))}>
            <option value="">— ระดับการฝึกอบรม / Medical Training Level —</option>
            {POSITION_OPTIONS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          {err && <p className="text-destructive text-sm">{err}</p>}
          <Button className="w-full" onClick={createUser} disabled={creating}>
            {creating ? 'กำลังสร้าง… / Creating…' : 'สร้างผู้ใช้ (active ทันที)'}
          </Button>
        </div>
      )}

      {/* Edit panel — a centered modal overlay so it's always in view (the ✎ button can be far
          down a long table; an inline panel would open above the fold and look like it did nothing).
          Click the backdrop or Cancel to close. */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
          onClick={() => setEditing(null)}>
        <div role="dialog" aria-modal="true" aria-label={`แก้ไขผู้ใช้ / Edit user — ${editing.full_name_en}`}
          className="w-full max-w-lg my-8 border rounded-xl bg-card p-5 space-y-3 shadow-xl animate-in fade-in zoom-in-95 duration-150"
          onClick={e => e.stopPropagation()}>
          <p className="font-medium">แก้ไข / Edit — {editing.full_name_en}</p>
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={editing.full_name_th}
            placeholder="ชื่อภาษาไทย" onChange={e => setEditing(u => u && ({ ...u, full_name_th: e.target.value }))} />
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={editing.full_name_en}
            placeholder="Full Name (English)" onChange={e => setEditing(u => u && ({ ...u, full_name_en: e.target.value }))} />
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={editing.license_number ?? ''}
            placeholder="เลขใบอนุญาต / License No." onChange={e => setEditing(u => u && ({ ...u, license_number: e.target.value }))} />
          {/* Per-user ceilings, $ beside tokens. grid-cols-1 first: a bare `grid` overflows a phone. */}
          {editing.role === 'physician' && (
            <div className="grid grid-cols-1 gap-3 @min-[520px]:grid-cols-2">
              <div>
                <label htmlFor="edit-limit-usd" className="block text-xs text-muted-foreground mb-1">ขีดจำกัด AI ($) / AI usage limit ($)</label>
                <input id="edit-limit-usd" className="w-full border rounded-lg px-3 py-2 text-sm" type="number" min={0} step="0.05"
                  value={editLimit}
                  placeholder="ขีดจำกัดการใช้งาน AI ($) — เว้นว่าง = ใช้ค่ามาตรฐาน / AI usage limit ($) — blank = standard"
                  onChange={e => setEditLimit(e.target.value)} />
                <p className="text-xs text-muted-foreground mt-1">เว้นว่างเพื่อใช้ค่ามาตรฐาน (${parseFloat(stdLimit) || 0}) / Leave blank to use the standard limit.</p>
              </div>
              <div>
                <label htmlFor="edit-limit-tokens" className="block text-xs text-muted-foreground mb-1">เพดานโทเคน / Token ceiling</label>
                <input id="edit-limit-tokens" className="w-full border rounded-lg px-3 py-2 text-sm tabular-nums" type="number" inputMode="numeric" min={0} max={MAX_TOKEN_OVERRIDE} step={1}
                  value={editTokens}
                  placeholder="เช่น 300000 / e.g. 300000"
                  onChange={e => setEditTokens(e.target.value)} />
                <p className="text-xs text-muted-foreground mt-1">
                  0 = ไม่จำกัด · เว้นว่าง = ใช้เพดานองค์กร ({stdTokens > 0 ? fmtTokens(stdTokens) : 'ไม่จำกัด'}) /
                  0 = no cap, blank = org ceiling ({stdTokens > 0 ? fmtTokens(stdTokens) : 'no cap'}).
                </p>
              </div>
            </div>
          )}
          {(editing.role === 'auditor' || editing.can_audit === true) && (
            <div className="grid grid-cols-1 gap-3 @min-[520px]:grid-cols-2">
              <div>
                <label htmlFor="edit-auditor-limit-usd" className="block text-xs text-muted-foreground mb-1">ขีดจำกัด AI ผู้ตรวจ ($) / Auditor AI limit ($)</label>
                <input id="edit-auditor-limit-usd" className="w-full border rounded-lg px-3 py-2 text-sm" type="number" min={0} step="0.05"
                  value={editAuditorLimit}
                  placeholder="ขีดจำกัด AI ผู้ตรวจ ($) — เว้นว่าง = ใช้ค่ามาตรฐาน / Auditor AI limit ($) — blank = standard"
                  onChange={e => setEditAuditorLimit(e.target.value)} />
                <p className="text-xs text-muted-foreground mt-1">พูลผู้ตรวจแยกต่างหาก — เว้นว่างเพื่อใช้ค่ามาตรฐาน (${parseFloat(auditorStdLimit) || 0}) / Separate auditor pool; blank = standard.</p>
              </div>
              <div>
                <label htmlFor="edit-auditor-limit-tokens" className="block text-xs text-muted-foreground mb-1">เพดานโทเคนผู้ตรวจ / Auditor token ceiling</label>
                <input id="edit-auditor-limit-tokens" className="w-full border rounded-lg px-3 py-2 text-sm tabular-nums" type="number" inputMode="numeric" min={0} max={MAX_TOKEN_OVERRIDE} step={1}
                  value={editAuditorTokens}
                  placeholder="เช่น 300000 / e.g. 300000"
                  onChange={e => setEditAuditorTokens(e.target.value)} />
                <p className="text-xs text-muted-foreground mt-1">
                  0 = ไม่จำกัด · เว้นว่าง = ใช้เพดานองค์กร ({auditorStdTokens > 0 ? fmtTokens(auditorStdTokens) : 'ไม่จำกัด'}) /
                  0 = no cap, blank = org ceiling ({auditorStdTokens > 0 ? fmtTokens(auditorStdTokens) : 'no cap'}).
                </p>
              </div>
            </div>
          )}
          {editing.role === 'superadmin' ? (
            <input className="w-full border rounded-lg px-3 py-2 text-sm bg-muted text-muted-foreground"
              value="Superadmin (locked)" disabled readOnly />
          ) : (
            <>
              {/* 'special' is UI-only — roleToUi/roleToWire (lib/labels) encode the physician+can_audit pair. */}
              <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
                value={roleToUi(editing.role, editing.can_audit)}
                onChange={e => setEditing(u => u && ({ ...u, ...roleToWire(e.target.value) }))}>
                {EDIT_ROLE_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
                value={editing.council_id ?? ''} onChange={e => setEditing(u => u && ({ ...u, council_id: e.target.value, specialty_id: '' }))}>
                <option value="">— เลือกสภาวิชาชีพ / Select council —</option>
                {councils.map(c => <option key={c.id} value={c.id}>{c.name_th} / {c.name_en}</option>)}
              </select>
              {/* Specialty + position apply only to council-scoped roles (not analyst/ethics). */}
              {['admin', 'physician', 'auditor'].includes(editing.role) && (<>
                <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background disabled:opacity-50"
                  value={editing.specialty_id ?? ''} disabled={!editing.council_id || specialtiesFor(editing.council_id).length === 0}
                  onChange={e => setEditing(u => u && ({ ...u, specialty_id: e.target.value }))}>
                  <option value="">— เลือกความเชี่ยวชาญ / Select specialty —</option>
                  {specialtiesFor(editing.council_id).map(s => <option key={s.id} value={s.id}>{s.name_th} / {s.name_en}</option>)}
                </select>
                <select className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
                  value={editing.position ?? ''} onChange={e => setEditing(u => u && ({ ...u, position: e.target.value }))}>
                  <option value="">— ระดับการฝึกอบรม / Medical Training Level —</option>
                  {POSITION_OPTIONS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </>)}
            </>
          )}
          <div className="flex gap-2">
            <Button onClick={saveEdit} disabled={saving}>{saving ? 'กำลังบันทึก… / Saving…' : 'บันทึก / Save'}</Button>
            <Button variant="outline" onClick={() => setEditing(null)}>ยกเลิก</Button>
          </div>
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

      {/* Name search — debounced server-side ?q= (professionals carries no email column);
          composes with the status chips below. */}
      <input
        className="w-full max-w-sm border rounded-lg px-3 py-2 text-sm mb-3 bg-background"
        placeholder="ค้นหาชื่อ / Search name…"
        value={q} onChange={e => setQ(e.target.value)} />

      {/* Account-status filter (server-side; default hides deactivated members). */}
      <div className="flex gap-2 mb-2 flex-wrap">
        {STATUS_FILTERS.map(f => (
          <Button key={f.key} variant={statusFilter === f.key ? 'default' : 'outline'} size="sm" onClick={() => setStatusFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      {/* Role filter — admin + superadmin. Backend ?role= is council-scoped for admins (admin.js),
          so an admin filters within their own council; superadmin filters across all. The Superadmin
          chip is hidden for admins (a council-scoped query never returns the global superadmin). All
          filter rows compose server-side, so "Showing X of Y" stays correct. */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="mr-1 text-xs text-muted-foreground">Role</span>
        {(isSuper ? ROLE_FILTERS : ROLE_FILTERS.filter(f => f.key !== 'superadmin')).map(f => (
          <Button key={f.key || 'all'} variant={roleFilter === f.key ? 'default' : 'outline'} size="sm" onClick={() => setRoleFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      {/* Council filter — superadmin only (admins are already pinned to one council). Changing council
          clears the specialty filter (its options are council-scoped). */}
      {isSuper && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="mr-1 text-xs text-muted-foreground">สภา / Council</span>
          <Button variant={councilFilter === '' ? 'default' : 'outline'} size="sm" onClick={() => { setCouncilFilter(''); setSpecialtyFilter([]); }}>ทุกสภา / All</Button>
          {councils.map(c => (
            <Button key={c.id} variant={councilFilter === c.id ? 'default' : 'outline'} size="sm" onClick={() => { setCouncilFilter(c.id); setSpecialtyFilter([]); }}>
              {c.name_th}
            </Button>
          ))}
        </div>
      )}

      {/* Specialty filter — superadmin only (the layer under council). Lists the selected council's
          specialties, or all when no council is chosen. */}
      {isSuper && (councilFilter ? specialtiesFor(councilFilter) : specialties).length > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="mr-1 text-xs text-muted-foreground">ความเชี่ยวชาญ / Specialty</span>
          <Button variant={specialtyFilter.length === 0 ? 'default' : 'outline'} size="sm" onClick={() => setSpecialtyFilter([])}>ทั้งหมด / All</Button>
          {(councilFilter ? specialtiesFor(councilFilter) : specialties).map(s => (
            <Button key={s.id} variant={specialtyFilter.includes(s.id) ? 'default' : 'outline'} size="sm"
              onClick={() => setSpecialtyFilter(f => f.includes(s.id) ? f.filter(x => x !== s.id) : [...f, s.id])}>
              {s.name_th}
            </Button>
          ))}
        </div>
      )}

      {/* Medical Training Level filter — superadmin only. Includes gp (admin-set accounts can be GPs). */}
      {isSuper && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="mr-1 text-xs text-muted-foreground">ระดับการฝึกอบรม / Medical Training Level</span>
          <Button variant={positionFilter.length === 0 ? 'default' : 'outline'} size="sm" onClick={() => setPositionFilter([])}>ทั้งหมด / All</Button>
          {POSITION_OPTIONS.map(p => (
            <Button key={p.key} variant={positionFilter.includes(p.key) ? 'default' : 'outline'} size="sm"
              onClick={() => setPositionFilter(f => f.includes(p.key) ? f.filter(x => x !== p.key) : [...f, p.key])}>
              {p.label}
            </Button>
          ))}
        </div>
      )}

      {/* Loaded-vs-total count for the user list (respects the active status filter). */}
      <p className="mb-3 text-xs text-muted-foreground">
        แสดง {users.length} จาก {total} / Showing {users.length} of {total}
      </p>

      {tableAsCards ? (
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
              {u.role !== 'superadmin' && <p className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Building2 className="size-3.5" /> {councilName(u.council_id)}</p>}
              {u.specialties?.name_th && <p className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Stethoscope className="size-3.5" /> {u.specialties.name_th}{u.position ? ` · ${positionLabel(u.position)}` : ''}</p>}
              {(u.role === 'physician' || u.role === 'auditor' || u.can_audit) && <div className="pt-1"><UsageCell u={u} /></div>}
              <div className="flex items-center justify-between pt-1">
                <StatusBadge s={u.status} />
                <RowActions u={u} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        // Natural auto-layout table: every header and cell is whitespace-nowrap (one line, full text, no
        // truncation), so each column sizes to its content. The page is full-width (no max-w cap) so wide
        // monitors show the whole table without scrolling; the overflow-x-auto wrapper lets laptops too
        // narrow to fit all 8 columns scroll horizontally instead of wrapping. (≤767px uses the cards above.)
        <div className="border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary"><tr>
              <th className="px-3 py-3 text-left whitespace-nowrap">ชื่อ (TH)</th>
              <th className="px-3 py-3 text-left whitespace-nowrap">ชื่อ (EN)</th>
              <th className="px-3 py-3 text-left whitespace-nowrap">Role</th>
              <th className="px-3 py-3 text-left whitespace-nowrap">สภา / Council</th>
              <th className="px-3 py-3 text-left whitespace-nowrap">ความเชี่ยวชาญ / Specialty</th>
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
                <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">{u.role === 'superadmin' ? '— ทุกสภา / All' : councilName(u.council_id)}</td>
                <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                  {u.specialties?.name_th ?? '—'}{u.position ? <span className="text-xs"> · {positionLabel(u.position)}</span> : ''}
                </td>
                <td className="px-3 py-3 whitespace-nowrap"><UsageCell u={u} /></td>
                <td className="px-3 py-3 whitespace-nowrap"><StatusBadge s={u.status} /></td>
                <td className="px-3 py-3 text-right whitespace-nowrap"><RowActions u={u} /></td>
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
