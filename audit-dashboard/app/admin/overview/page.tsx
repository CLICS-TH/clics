'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { apiFetch, apiDownload } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { DOMAIN_KEYS, DOMAIN_LABELS, ROLE_LABELS, pleStatusCards, budgetToneHex } from '@/lib/labels';
import { CHART } from '@/lib/chart-colors';
import { PageIntro } from '@/components/PageIntro';
import { RoleBadge } from '@/components/RoleBadge';
import { StatStrip, type Stat } from '@/components/StatStrip';
import { IccPanel } from '@/components/IccPanel';
import { AiProviderPanel } from '@/components/AiProviderPanel';
import { LocalAiCapacityCard } from '@/components/LocalAiCapacityCard';
import { Skeleton, CardGridSkeleton } from '@/components/Skeleton';
import { useAuthUser } from '@/lib/client-store';
import type { CleStats, UsageSettings } from '@/lib/types';

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


export default function OverviewPage() {
  const router = useRouter();
  const me = useAuthUser();
  const [stats, setStats] = useState<CleStats | null>(null);
  const [icc, setIcc] = useState<IccData | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [usage, setUsage] = useState<UsageSettings | null>(null);
  const [counts, setCounts] = useState<CountRow[] | null>(null);
  const [councils, setCouncils] = useState<Council[] | null>(null);
  const [pendingInvites, setPendingInvites] = useState<Invite[] | null>(null);

  useEffect(() => {
    // Executive overview is superadmin-only; everyone else lands back on /home.
    if (getUser()?.role !== 'superadmin') { router.push('/home'); return; }
    apiFetch<CleStats>('/admin/stats').then(setStats).catch(() => setStats({}));
    apiFetch<IccData>('/admin/icc').then(setIcc).catch(() => setIcc({ overall: null, per_domain: {}, per_council: {}, n: 0 }));
    apiFetch<Slot[]>('/admin/slots').then(d => setSlots(Array.isArray(d) ? d : [])).catch(() => setSlots([]));
    apiFetch<UsageSettings>('/admin/usage-settings').then(setUsage).catch(() => setUsage(null));
    apiFetch<CountRow[]>('/admin/overview-counts').then(d => setCounts(Array.isArray(d) ? d : [])).catch(() => setCounts([]));
    apiFetch<Council[]>('/admin/councils').then(d => setCouncils(Array.isArray(d) ? d : [])).catch(() => setCouncils([]));
    apiFetch<Invite[]>('/admin/invites?status=pending').then(d => setPendingInvites(Array.isArray(d) ? d : [])).catch(() => setPendingInvites([]));
  }, [router]);

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

  // ---- Pilot Test Mode toggle ----
  const [pilotSaving, setPilotSaving] = useState(false);
  const pilotOn = usage?.pilot_test_mode === true;
  async function togglePilot() {
    if (!usage) return;
    setPilotSaving(true);
    try {
      const next = await apiFetch<UsageSettings>('/admin/usage-settings', {
        method: 'PATCH', body: JSON.stringify({ pilot_test_mode: !pilotOn }),
      });
      setUsage(u => (u ? { ...u, pilot_test_mode: next.pilot_test_mode } : u));
    } catch { /* leave state unchanged on failure */ }
    setPilotSaving(false);
  }

  // ---- Clinical Artifacts toggle ----
  const [artifactsSaving, setArtifactsSaving] = useState(false);
  const artifactsOn = usage?.clinical_artifacts_enabled === true;
  async function toggleArtifacts() {
    if (!usage) return;
    setArtifactsSaving(true);
    try {
      const next = await apiFetch<UsageSettings>('/admin/usage-settings', {
        method: 'PATCH', body: JSON.stringify({ clinical_artifacts_enabled: !artifactsOn }),
      });
      setUsage(u => (u ? { ...u, clinical_artifacts_enabled: next.clinical_artifacts_enabled } : u));
    } catch { /* leave state unchanged on failure */ }
    setArtifactsSaving(false);
  }

  const [peerSaving, setPeerSaving] = useState(false);
  const peerOn = usage?.peer_calibration_enabled === true;
  async function togglePeer() {
    if (!usage) return;
    setPeerSaving(true);
    try {
      const next = await apiFetch<UsageSettings>('/admin/usage-settings', {
        method: 'PATCH', body: JSON.stringify({ peer_calibration_enabled: !peerOn }),
      });
      setUsage(u => (u ? { ...u, peer_calibration_enabled: next.peer_calibration_enabled } : u));
    } catch { /* leave state unchanged on failure */ }
    setPeerSaving(false);
  }

  const [holdSaving, setHoldSaving] = useState(false);
  const holdOn = usage?.hold_result_until_audited === true;
  async function toggleHold() {
    if (!usage) return;
    setHoldSaving(true);
    try {
      const next = await apiFetch<UsageSettings>('/admin/usage-settings', {
        method: 'PATCH', body: JSON.stringify({ hold_result_until_audited: !holdOn }),
      });
      setUsage(u => (u ? { ...u, hold_result_until_audited: next.hold_result_until_audited } : u));
    } catch { /* leave state unchanged on failure */ }
    setHoldSaving(false);
  }

  // ---- Minimum auditors per PLE ----
  // A TARGET, not a gate. The manuscript describes >= 3 blinded auditors per PLE; 3 auditors
  // currently cover 3 of 19 physician specialties, so a blocking rule would strand credit for the
  // other 16. Raising this badges PLEs below target in the queue and states the rater distribution
  // in the ICC report — it never withholds a score.
  const [minAudSaving, setMinAudSaving] = useState(false);
  const minAuditors = usage?.min_auditors_per_cle ?? 1;
  async function setMinAuditors(n: number) {
    if (!usage || n === minAuditors || n < 1 || n > 10) return;
    setMinAudSaving(true);
    try {
      const next = await apiFetch<UsageSettings>('/admin/usage-settings', {
        method: 'PATCH', body: JSON.stringify({ min_auditors_per_cle: n }),
      });
      setUsage(u => (u ? { ...u, min_auditors_per_cle: next.min_auditors_per_cle } : u));
    } catch { /* leave state unchanged on failure */ }
    setMinAudSaving(false);
  }

  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState('');
  async function exportXlsx() {
    setExporting(true); setExportErr('');
    const res = await apiDownload('/admin/export.xlsx', 'clics-export.xlsx');
    if (res.error) setExportErr(res.error);
    setExporting(false);
  }

  // ---- ④ Budget ----
  const pool = usage?.api_budget_pool_usd ?? 0;
  const used = usage?.total_used_usd ?? 0;
  const budgetPct = pool > 0 ? Math.min(used / pool, 1) : 0;
  const budgetColor = budgetToneHex(budgetPct);

  return (
    <div className="mx-auto w-full max-w-5xl p-6 md:p-10 space-y-8">
      <PageIntro
        eyebrow="Superadmin · Executive Overview"
        title={greeting}
        subtitle="ภาพรวมผู้บริหาร — สถานะ pilot ทั้งระบบในหน้าเดียว: PLEs · calibration · สภาวิชาชีพ · capacity · budget / Executive overview — the whole pilot on one page."
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
          <a href="/admin/icc" className="text-sm text-primary underline-offset-4 hover:underline">
            ดูรายละเอียด / Open ICC dashboard →
          </a>
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
                  <XAxis dataKey="domain" tick={{ fill: 'currentColor', fontSize: 11 }} />
                  <YAxis domain={[0, 1]} tick={{ fill: 'currentColor', fontSize: 11 }} />
                  <Tooltip />
                  <ReferenceLine y={0.75} stroke={CHART.threshold} strokeDasharray="4 4" label="เกณฑ์ 0.75" />
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
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums ${
                        cIcc ? (cIcc.icc >= 0.75 ? 'bg-[var(--chart-pass-bg)] text-[var(--chart-pass-text)]' : 'bg-destructive/10 text-destructive') : 'bg-secondary text-muted-foreground'
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

      {/* Local AI capacity — token ceilings, transcript cap, evaluation drain + a glance at the queue.
          Its own component: seven bounded fields and a health probe do not belong inline beside the
          plain toggles below. It saves through the same PATCH /admin/usage-settings and hands the
          re-read settings back here, so the $ budget card above stays in step. */}
      <LocalAiCapacityCard usage={usage} onChange={setUsage} />

      {/* Minimum auditors per PLE — a target the queue badges against, never a gate. */}
      <section className="space-y-3">
        <h2 className="font-heading text-xl text-foreground">ผู้ตรวจขั้นต่ำต่อ PLE / Minimum auditors per PLE</h2>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-5">
          <div className="min-w-0 flex-1 pr-4">
            <p className="text-sm font-medium">👥 จำนวนผู้ตรวจเป้าหมาย / Target auditor count</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              PLE ที่มีผู้ตรวจน้อยกว่าเป้าหมายจะถูกทำเครื่องหมายในคิว แต่ <strong>ยังปล่อยผลตามปกติ</strong> —
              ไม่บล็อก เพราะบางสาขายังไม่มีผู้ตรวจเลย • PLEs below target are badged in the admin queue and
              counted separately in the ICC report, but their score still releases. Blocking would strand
              credit for the specialties that have no eligible auditor at all.
            </p>
          </div>
          <div role="radiogroup" aria-label="Minimum auditors per PLE" className="inline-flex shrink-0 overflow-hidden rounded-lg border">
            {[1, 2, 3].map(n => {
              const on = n === minAuditors;
              return (
                <button
                  key={n}
                  role="radio"
                  aria-checked={on}
                  disabled={!usage || minAudSaving}
                  onClick={() => setMinAuditors(n)}
                  className={`px-4 py-2 text-sm tabular-nums transition-colors disabled:opacity-50
                    ${on ? 'bg-primary/15 font-semibold text-foreground ring-2 ring-inset ring-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  {n}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Which model serves each AI purpose (Claude cloud ↔ the on-prem DGX). Its own component:
          the evaluator half carries a typed confirmation and a pilot lock, which does not belong
          inline beside the plain on/off toggles below. */}
      <AiProviderPanel />

      {/* Pilot Test Mode — when on, new PLEs are TEST sessions, the 3-PLE cap is bypassed, and the
          physician can pick Natural/Socratic directly to exercise the experiment. */}
      <section className="space-y-3">
        <h2 className="font-heading text-xl text-foreground">Pilot Test Mode</h2>
        <div className="flex items-center justify-between rounded-xl border p-5">
          <div className="pr-4">
            <p className="text-sm font-medium">🧪 โหมดทดสอบ Pilot / Pilot test mode</p>
            <p className="text-xs text-muted-foreground">
              เปิดเพื่อทดสอบ Socratic mode: PLE ที่สร้างจะเป็น test session (ไม่นับในข้อมูลจริง), ข้ามลิมิต 3 PLE,
              และแพทย์เลือก Natural/Socratic ได้เอง • When on: new PLEs are test sessions, the 3-PLE cap is bypassed,
              and the physician picks Natural/Socratic directly.
            </p>
          </div>
          <button
            onClick={togglePilot}
            disabled={!usage || pilotSaving}
            aria-pressed={pilotOn}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${pilotOn ? 'bg-primary' : 'bg-muted'}`}
            title={pilotOn ? 'Pilot test mode is ON' : 'Pilot test mode is OFF'}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${pilotOn ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </section>

      {/* Clinical Artifacts — when on, the AI may emit `:::artifact{…}` side-panel blocks (DDx tables,
          care plans, algorithms). A research-stimulus change, so it's off by default. */}
      <section className="space-y-3">
        <h2 className="font-heading text-xl text-foreground">Clinical Artifacts</h2>
        <div className="flex items-center justify-between rounded-xl border p-5">
          <div className="pr-4">
            <p className="text-sm font-medium">📋 Clinical Artifacts / รายงานคลินิกแบบ artifact</p>
            <p className="text-xs text-muted-foreground">
              เปิดให้ AI สร้าง artifact (ตาราง DDx, แผนการรักษา, อัลกอริทึม) แสดงใน side panel •
              When on: the AI wraps substantial structured output (differential tables, care plans, algorithms,
              evidence summaries) in side-panel artifacts. This changes the stimulus every physician sees — enable deliberately.
            </p>
          </div>
          <button
            onClick={toggleArtifacts}
            disabled={!usage || artifactsSaving}
            aria-pressed={artifactsOn}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${artifactsOn ? 'bg-primary' : 'bg-muted'}`}
            title={artifactsOn ? 'Clinical artifacts are ON' : 'Clinical artifacts are OFF'}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${artifactsOn ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </section>

      {/* Peer Calibration — when on, a PLE may be assigned to several auditors and each auditor sees a
          you-vs-auditor-average PIS-7 radar (alongside vs-AI). A pilot calibration aid, off by default. */}
      <section className="space-y-3">
        <h2 className="font-heading text-xl text-foreground">Peer Calibration</h2>
        <div className="flex items-center justify-between rounded-xl border p-5">
          <div className="pr-4">
            <p className="text-sm font-medium">👥 Peer Calibration / การปรับเทียบระหว่างผู้ประเมิน</p>
            <p className="text-xs text-muted-foreground">
              เปิดให้มอบหมาย PLE เดียวกันแก่ผู้ประเมินหลายคน และแสดงเรดาร์เทียบคะแนนของผู้ประเมินกับค่าเฉลี่ยของผู้ประเมินทั้งหมด •
              When on: a PLE can be assigned to multiple auditors, and after submitting each auditor sees a radar
              comparing their PIS-7 scores to the average of all auditors (the vs-AI radar is kept).
            </p>
          </div>
          <button
            onClick={togglePeer}
            disabled={!usage || peerSaving}
            aria-pressed={peerOn}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${peerOn ? 'bg-primary' : 'bg-muted'}`}
            title={peerOn ? 'Peer calibration is ON' : 'Peer calibration is OFF'}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${peerOn ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </section>

      {/* Hold Result Until Audited — for a blinded test round: physicians can't see their PIS-7 score
          (result page + LPDP trend) until an expert auditor has submitted one for that PLE. Off by default. */}
      <section className="space-y-3">
        <h2 className="font-heading text-xl text-foreground">Hold Result Until Audited</h2>
        <div className="flex items-center justify-between rounded-xl border p-5">
          <div className="pr-4">
            <p className="text-sm font-medium">🔒 ระงับผลจนกว่าผู้ตรวจจะให้คะแนน / Hold result until audited</p>
            <p className="text-xs text-muted-foreground">
              สำหรับรอบทดสอบแบบปิดบัง: แพทย์จะไม่เห็นคะแนน PIS-7 (ทั้งหน้าผลและกราฟความก้าวหน้า) จนกว่าผู้ตรวจประเมินจะส่งคะแนนของ PLE นั้นแล้ว •
              For a blinded test round: physicians can&apos;t see their PIS-7 score (result page + LPDP trend) until an
              expert auditor has submitted a score for that PLE. Keep it ON only during the test.
            </p>
          </div>
          <button
            onClick={toggleHold}
            disabled={!usage || holdSaving}
            aria-pressed={holdOn}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${holdOn ? 'bg-primary' : 'bg-muted'}`}
            title={holdOn ? 'Hold result until audited is ON' : 'Hold result until audited is OFF'}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${holdOn ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </section>

      {/* Data export — one XLSX workbook, a sheet per category (PLEs / AI evaluations / Auditor scores /
          Compensation / Participants). Pseudonymized (no names) so it honors the PII boundary. */}
      <section className="space-y-3">
        <h2 className="font-heading text-xl text-foreground">Export data</h2>
        <div className="flex items-center justify-between gap-4 rounded-xl border p-5">
          <div className="pr-4">
            <p className="text-sm font-medium">📊 ส่งออกข้อมูล (XLSX) / Export data (XLSX)</p>
            <p className="text-xs text-muted-foreground">
              ดาวน์โหลดสมุดงาน Excel หนึ่งไฟล์ แยกชีตตามหมวด (PLEs · AI evaluations · Auditor scores · Compensation · Participants) •
              One workbook, a sheet per category. Pseudonymized (P-NNN / EXP-NNN) — no names leave the system.
            </p>
            {exportErr && <p className="mt-1 text-xs text-destructive">{exportErr}</p>}
          </div>
          <button
            onClick={exportXlsx}
            disabled={exporting}
            className="shrink-0 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
          >
            {exporting ? 'กำลังสร้าง… / Building…' : 'ดาวน์โหลด / Download'}
          </button>
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
