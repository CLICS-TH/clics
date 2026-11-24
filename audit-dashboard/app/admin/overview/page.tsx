'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { DOMAIN_KEYS, DOMAIN_LABELS, ROLE_LABELS, pleStatusCards, budgetToneHex } from '@/lib/labels';
import { useChartColors } from '@/lib/chart-colors';
import { PageIntro } from '@/components/PageIntro';
import { RoleBadge } from '@/components/RoleBadge';
import { Badge } from '@/components/ui/badge';
import { StatStrip, type Stat } from '@/components/StatStrip';
import { IccPanel } from '@/components/IccPanel';
import { StateMessage } from '@/components/ui/state-message';
import { Skeleton, CardGridSkeleton } from '@/components/Skeleton';
import { useAuthUser } from '@/lib/client-store';
import { type ApiResult, type CleStats, type UsageSettings, formatApiError } from '@/lib/types';

// ---- API shapes (verified against backend/src/routes/admin.js + superadmin.js) ----
type IccStat = { icc: number; lower: number; upper: number; n: number; interpretation: string } | null;
type IccData = {
  overall: IccStat;
  per_domain: Record<string, IccStat>;
  per_council: Record<string, { council: { id: string; code: string; name_th: string; name_en: string } | null; overall: IccStat; n: number }>;
  n: number;
};
type Council = { id: string; code: string; name_th: string; name_en: string; active?: boolean };
type Slot = { role: string; capacity: number; used: number; remaining: number };
// UsageSettings lives in lib/types.ts — one definition shared with the users page + the capacity card.
type CountRow = { council_id: string; role: string; n: number };
type Invite = { id: string; email: string; status: string };

const BUDGET_ERROR = 'โหลดงบประมาณไม่สำเร็จ / Could not load the budget.';

// Read only. Every control that used to sit here (the AI provider switch, Local AI capacity, the minimum
// auditors, the five rules, the XLSX export) is on /admin/settings, and Booth Mode has its own page, so this
// page can be read without a stray tap changing the pilot.
export default function OverviewPage() {
  const CHART = useChartColors();
  const router = useRouter();
  const me = useAuthUser();
  const [stats, setStats] = useState<CleStats | null>(null);
  const [icc, setIcc] = useState<IccData | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [usage, setUsage] = useState<UsageSettings | null>(null);
  const [usageError, setUsageError] = useState('');
  const [counts, setCounts] = useState<CountRow[] | null>(null);
  const [councils, setCouncils] = useState<Council[] | null>(null);
  const [pendingInvites, setPendingInvites] = useState<Invite[] | null>(null);

  // apiFetch never rejects: a failed read resolves to {error}, which is truthy. Treated as data it drew a $0.00 /
  // $0.00 pool, "not set". Only a response without `error` is the budget.
  const loadUsage = useCallback(() => apiFetch<ApiResult<UsageSettings>>('/admin/usage-settings').then((r) => {
    if (!r) return;
    if (r.error) { setUsageError(formatApiError(r.error, BUDGET_ERROR)); return; }
    setUsageError('');
    setUsage(r as UsageSettings);
  }), []);

  useEffect(() => {
    // Executive overview is superadmin-only; everyone else lands back on /home.
    if (getUser()?.role !== 'superadmin') { router.push('/home'); return; }
    apiFetch<CleStats>('/admin/stats').then(setStats).catch(() => setStats({}));
    apiFetch<IccData>('/admin/icc').then(setIcc).catch(() => setIcc({ overall: null, per_domain: {}, per_council: {}, n: 0 }));
    apiFetch<Slot[]>('/admin/slots').then(d => setSlots(Array.isArray(d) ? d : [])).catch(() => setSlots([]));
    void loadUsage();
    apiFetch<CountRow[]>('/admin/overview-counts').then(d => setCounts(Array.isArray(d) ? d : [])).catch(() => setCounts([]));
    apiFetch<Council[]>('/admin/councils').then(d => setCouncils(Array.isArray(d) ? d : [])).catch(() => setCouncils([]));
    apiFetch<Invite[]>('/admin/invites?status=pending').then(d => setPendingInvites(Array.isArray(d) ? d : [])).catch(() => setPendingInvites([]));
  }, [router, loadUsage]);

  // ---- ① Headline cards — the shared /admin/stats card set (reconciles to the total) ----
  const greeting = `สวัสดี, ${me ? (me.full_name_th || me.full_name_en) : ''}`;
  const headlineStats: Stat[] = pleStatusCards(stats).map(c => ({
    value: c.value,
    label: c.label,
    href: `/admin/ples${c.key ? `?status=${c.key}` : ''}`,
  }));

  // ---- ② Per-domain chart data ----
  const domainData = icc
    ? DOMAIN_KEYS.map((k, i) => ({ domain: DOMAIN_LABELS[i], icc: icc.per_domain?.[k]?.icc ?? null }))
    : [];

  // ---- ③ Active-member counts per council × role ----
  const countOf = (councilId: string, role: string) =>
    (counts ?? []).find(r => r.council_id === councilId && r.role === role)?.n ?? 0;
  const activeCouncils = (councils ?? []).filter(c => c.active !== false);

  // ---- ④ Budget ----
  const pool = usage?.api_budget_pool_usd ?? 0;
  const used = usage?.total_used_usd ?? 0;
  const budgetPct = pool > 0 ? Math.min(used / pool, 1) : 0;
  const budgetColor = budgetToneHex(budgetPct, CHART);

  return (
    <div className="mx-auto w-full max-w-5xl p-6 md:p-10 space-y-8">
      <PageIntro
        eyebrow="Superadmin · Executive Overview"
        title={greeting}
        subtitle="สถานะ pilot ทั้งระบบในหน้าเดียว อ่านอย่างเดียว การตั้งค่าอยู่ที่หน้าการตั้งค่า / The whole pilot on one page, read only. The controls are on Settings."
        action={<RoleBadge />}
      />

      {/* ① Headline PLE cards — each drills into /admin/ples filtered by its bucket. */}
      <section>
        {stats
          ? <StatStrip stats={headlineStats} className="grid grid-cols-2 gap-4 @min-[480px]:grid-cols-3 @min-[768px]:grid-cols-5" />
          : <CardGridSkeleton cards={5} />}
      </section>

      {/* ② Calibration hero — overall ICC + gate badge beside the per-domain bar chart. */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-heading text-xl text-foreground">Calibration — ICC(2,1)</h2>
          <Link href="/admin/icc" className="text-sm text-link underline-offset-4 hover:underline">
            ดูรายละเอียด / Open ICC dashboard →
          </Link>
        </div>
        {!icc ? (
          <div className="grid gap-4 @min-[768px]:grid-cols-2">
            <Skeleton className="h-44 w-full" />
            <div className="rounded-xl border p-5">
              <p className="text-sm text-muted-foreground">กำลังโหลดข้อมูล calibration… / Loading calibration data…</p>
            </div>
          </div>
        ) : !icc.overall ? (
          <div className="rounded-xl border p-5 text-sm text-muted-foreground">
            ยังไม่มีข้อมูล ICC — รอให้ Auditors ส่งคะแนน / No ICC data yet — awaiting auditor scores.
          </div>
        ) : (
          <div className="grid gap-4 @min-[768px]:grid-cols-2">
            <IccPanel {...icc.overall} />
            {/* Chart renders only after data arrives — ResponsiveContainer measures post-mount
                (same pattern as components/LpdpChart.tsx). */}
            <div className="rounded-xl border p-5">
              <h3 className="mb-3 font-semibold">ICC รายโดเมน / Per-domain (d1–d7)</h3>
              {/* text-muted-foreground sets `color`, so currentColor grid/ticks track the theme
                  (mirror components/LpdpChart.tsx) — the hardcoded light hex was invisible in dark mode. */}
              <div className="text-muted-foreground">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={domainData}>
                  <CartesianGrid stroke="currentColor" strokeOpacity={0.18} />
                  <XAxis dataKey="domain" tick={{ fill: 'currentColor', fontSize: 12 }} />
                  <YAxis domain={[0, 1]} tick={{ fill: 'currentColor', fontSize: 12 }} />
                  <Tooltip />
                  {/* A bare-string label takes recharts' own #808080 (3.75:1 on the light card); currentColor
                      is the muted-foreground this wrapper sets, same as the ticks. */}
                  <ReferenceLine y={0.75} stroke={CHART.threshold} strokeDasharray="4 4" label={{ value: 'เกณฑ์ 0.75', fill: 'currentColor' }} />
                  <Bar dataKey="icc" radius={[4, 4, 0, 0]}>
                    {domainData.map(d => (
                      <Cell key={d.domain} fill={(d.icc ?? 0) >= 0.75 ? CHART.pass : CHART.fail} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ③ Council cards — active member counts by role + each council's ICC chip. */}
      <section className="space-y-3">
        <h2 className="font-heading text-xl text-foreground">สภาวิชาชีพ / Councils</h2>
        {!councils || !counts ? (
          <CardGridSkeleton cards={4} />
        ) : activeCouncils.length === 0 ? (
          <p className="rounded-xl border p-5 text-sm text-muted-foreground">ยังไม่มีสภาที่เปิดใช้งาน / No active councils.</p>
        ) : (
          <div className="grid gap-4 @min-[640px]:grid-cols-2">
            {activeCouncils.map(c => {
              const cIcc = icc?.per_council?.[c.id]?.overall ?? null;
              return (
                <div key={c.id} className="rounded-xl border border-border p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{c.name_th}</p>
                      <p className="text-xs text-muted-foreground">{c.name_en}</p>
                    </div>
                    <Badge
                      variant={cIcc ? (cIcc.icc >= 0.75 ? 'ok' : 'error') : 'secondary'}
                      className="h-auto shrink-0 px-2.5 font-semibold tabular-nums"
                      title="ICC ของสภานี้ / This council's ICC">
                      ICC {cIcc ? cIcc.icc.toFixed(3) : '—'}
                    </Badge>
                  </div>
                  <p className="mt-3 text-sm text-foreground tabular-nums">
                    แพทย์ {countOf(c.id, 'physician')} · Auditor {countOf(c.id, 'auditor')} · Admin {countOf(c.id, 'admin')}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ④ Capacity & budget — global role slot pools + the org-wide API budget pool. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="font-heading text-xl text-foreground">Capacity &amp; budget</h2>
          {/* Token ceilings and the evaluation queue's settings moved to Settings with the other controls. */}
          <Link href="/admin/settings" className="text-sm text-link underline-offset-4 hover:underline">
            ตั้งค่าความจุ AI / Open Settings →
          </Link>
        </div>
        <div className="grid gap-4 @min-[768px]:grid-cols-2">
          <div className="rounded-xl border p-5">
            <h3 className="mb-3 font-semibold">Slot ตามบทบาท / Role slots</h3>
            {!slots ? <Skeleton className="h-24 w-full" /> : (
              <div className="space-y-3">
                {slots.map(s => {
                  const full = s.capacity > 0 && s.used >= s.capacity;
                  const pct = s.capacity > 0 ? Math.min(s.used / s.capacity, 1) : 0;
                  return (
                    <div key={s.role} className="flex items-center gap-3">
                      <span className="w-36 shrink-0 text-xs text-muted-foreground">{ROLE_LABELS[s.role] ?? s.role}</span>
                      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className={`h-full rounded-full ${full ? 'bg-destructive' : 'bg-primary'}`}
                          style={{ width: `${pct * 100}%` }} />
                      </div>
                      <span className={`w-20 text-right font-mono text-xs tabular-nums ${full ? 'text-danger font-semibold' : 'text-muted-foreground'}`}>
                        {s.used}/{s.capacity}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="rounded-xl border p-5">
            <h3 className="mb-3 font-semibold">งบประมาณ AI / API budget pool</h3>
            {usageError && !usage ? (
              <StateMessage kind="error" title={BUDGET_ERROR} onRetry={() => { setUsageError(''); void loadUsage(); }}>
                {usageError !== BUDGET_ERROR ? usageError : null}
              </StateMessage>
            ) : !usage ? <Skeleton className="h-24 w-full" /> : (
              <>
                <p className="text-2xl font-bold tabular-nums" style={{ color: budgetColor }}>
                  ${used.toFixed(2)}
                  <span className="text-sm font-normal text-muted-foreground"> / ${pool.toFixed(2)}</span>
                </p>
                <div className="relative mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full" style={{ width: `${budgetPct * 100}%`, backgroundColor: budgetColor }} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  ใช้ไปแล้วทั้งระบบเทียบกับ pool / Total spent across all members vs the org-wide pool
                  {pool <= 0 && ' · ยังไม่ได้ตั้ง pool / pool not set'}
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      {/* ⑤ Onboarding pulse — pending invites (the request-access queue was retired). */}
      <section className="space-y-3">
        <h2 className="font-heading text-xl text-foreground">Onboarding</h2>
        <Link href="/admin/invites"
          className="flex items-center justify-between rounded-xl border p-5 transition-colors hover:bg-secondary hover:border-primary/40">
          <div>
            <p className="text-sm font-medium">คำเชิญที่รอตอบรับ / Pending invites</p>
            <p className="text-xs text-muted-foreground">คลิกเพื่อจัดการคำเชิญ / Manage invites →</p>
          </div>
          {pendingInvites === null
            ? <Skeleton className="h-8 w-12" />
            // text-coral-on-tint: bright --primary on its own /10 tint is 2.81:1, under even the 3:1 large-text bar.
            : <span className="rounded-full bg-primary/10 px-4 py-1.5 text-xl font-bold text-coral-on-tint tabular-nums">{pendingInvites.length}</span>}
        </Link>
      </section>
    </div>
  );
}
