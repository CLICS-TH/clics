'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { DOMAIN_KEYS, DOMAIN_LABELS, ROLE_LABELS, pleStatusCards, budgetToneHex } from '@/lib/labels';
import { PageIntro } from '@/components/PageIntro';
import { IccPanel } from '@/components/IccPanel';
import { Skeleton, CardGridSkeleton } from '@/components/Skeleton';

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
type UsageSettings = { standard_limit_usd: number; api_budget_pool_usd: number; total_used_usd: number };
type CountRow = { council_id: string; role: string; n: number };
type Invite = { id: string; email: string; status: string };


export default function OverviewPage() {
  const router = useRouter();
  const [stats, setStats] = useState<any>(null);
  const [icc, setIcc] = useState<IccData | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [usage, setUsage] = useState<UsageSettings | null>(null);
  const [counts, setCounts] = useState<CountRow[] | null>(null);
  const [councils, setCouncils] = useState<Council[] | null>(null);
  const [pendingInvites, setPendingInvites] = useState<Invite[] | null>(null);

  useEffect(() => {
    // Executive overview is superadmin-only; everyone else lands back on /home.
    if (getUser()?.role !== 'superadmin') { router.push('/home'); return; }
    apiFetch<any>('/admin/stats').then(setStats).catch(() => setStats({}));
    apiFetch<IccData>('/admin/icc').then(setIcc).catch(() => setIcc({ overall: null, per_domain: {}, per_council: {}, n: 0 }));
    apiFetch<Slot[]>('/admin/slots').then(d => setSlots(Array.isArray(d) ? d : [])).catch(() => setSlots([]));
    apiFetch<UsageSettings>('/admin/usage-settings').then(setUsage).catch(() => setUsage(null));
    apiFetch<CountRow[]>('/admin/overview-counts').then(d => setCounts(Array.isArray(d) ? d : [])).catch(() => setCounts([]));
    apiFetch<Council[]>('/admin/councils').then(d => setCouncils(Array.isArray(d) ? d : [])).catch(() => setCouncils([]));
    apiFetch<Invite[]>('/admin/invites?status=pending').then(d => setPendingInvites(Array.isArray(d) ? d : [])).catch(() => setPendingInvites([]));
  }, [router]);

  // ---- ① Headline cards — the shared /admin/stats card set (reconciles to the total) ----
  const headline = pleStatusCards(stats);

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
  const budgetColor = budgetToneHex(budgetPct);

  return (
    <div className="mx-auto w-full max-w-5xl p-6 md:p-10 space-y-8">
      <PageIntro
        eyebrow="Superadmin · Executive Overview"
        title="ภาพรวมผู้บริหาร"
        subtitle="Executive overview — สถานะ pilot ทั้งระบบในหน้าเดียว: PLEs · calibration · สภาวิชาชีพ · capacity · budget"
      />

      {/* ① Headline PLE cards — each drills into /admin/ples filtered by its bucket. */}
      <section>
        {stats ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            {headline.map(c => (
              <a key={c.label} href={`/admin/ples${c.key ? `?status=${c.key}` : ''}`}
                className="block rounded-xl border p-5 text-center transition-colors hover:bg-secondary hover:border-primary/40 cursor-pointer"
                title="คลิกเพื่อดูรายชื่อในหมวดนี้ / Click to explore this category">
                <p className="text-4xl font-bold text-primary tabular-nums">{c.value}</p>
                <p className="mt-1 text-xs text-muted-foreground">{c.label}</p>
              </a>
            ))}
          </div>
        ) : <CardGridSkeleton cards={5} />}
      </section>

      {/* ② Calibration hero — overall ICC + gate badge beside the per-domain bar chart. */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-heading text-xl text-foreground">Calibration — ICC(2,1)</h2>
          <a href="/admin/icc" className="text-sm text-primary underline-offset-4 hover:underline">
            ดูรายละเอียด / Open ICC dashboard →
          </a>
        </div>
        {!icc ? (
          <div className="grid gap-4 md:grid-cols-2">
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
          <div className="grid gap-4 md:grid-cols-2">
            <IccPanel {...icc.overall} />
            {/* Chart renders only after data arrives — ResponsiveContainer measures post-mount
                (same pattern as components/LpdpChart.tsx). */}
            <div className="rounded-xl border p-5">
              <h3 className="mb-3 font-semibold">ICC รายโดเมน / Per-domain (d1–d7)</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={domainData}>
                  <CartesianGrid stroke="#e6dfd8" />
                  <XAxis dataKey="domain" tick={{ fill: '#6c6a64', fontSize: 11 }} />
                  <YAxis domain={[0, 1]} tick={{ fill: '#6c6a64', fontSize: 11 }} />
                  <Tooltip />
                  <ReferenceLine y={0.75} stroke="#e8a55a" strokeDasharray="4 4" label="เกณฑ์ 0.75" />
                  <Bar dataKey="icc" radius={[4, 4, 0, 0]}>
                    {domainData.map(d => (
                      <Cell key={d.domain} fill={(d.icc ?? 0) >= 0.75 ? '#5db872' : '#c64545'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
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
          <div className="grid gap-4 sm:grid-cols-2">
            {activeCouncils.map(c => {
              const cIcc = icc?.per_council?.[c.id]?.overall ?? null;
              return (
                <div key={c.id} className="rounded-xl border border-border p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{c.name_th}</p>
                      <p className="text-xs text-muted-foreground">{c.name_en}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums ${
                        cIcc ? (cIcc.icc >= 0.75 ? 'bg-[#d1f5dc] text-[#1a6630]' : 'bg-destructive/10 text-destructive') : 'bg-secondary text-muted-foreground'
                      }`}
                      title="ICC ของสภานี้ / This council's ICC">
                      ICC {cIcc ? cIcc.icc.toFixed(3) : '—'}
                    </span>
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
        <h2 className="font-heading text-xl text-foreground">Capacity &amp; budget</h2>
        <div className="grid gap-4 md:grid-cols-2">
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
                      <span className={`w-20 text-right font-mono text-xs tabular-nums ${full ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
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
            {!usage ? <Skeleton className="h-24 w-full" /> : (
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
        <a href="/admin/invites"
          className="flex items-center justify-between rounded-xl border p-5 transition-colors hover:bg-secondary hover:border-primary/40">
          <div>
            <p className="text-sm font-medium">คำเชิญที่รอตอบรับ / Pending invites</p>
            <p className="text-xs text-muted-foreground">คลิกเพื่อจัดการคำเชิญ / Manage invites →</p>
          </div>
          {pendingInvites === null
            ? <Skeleton className="h-8 w-12" />
            : <span className="rounded-full bg-primary/10 px-4 py-1.5 text-xl font-bold text-primary tabular-nums">{pendingInvites.length}</span>}
        </a>
      </section>
    </div>
  );
}
