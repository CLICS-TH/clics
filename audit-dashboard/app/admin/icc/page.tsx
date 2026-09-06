'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { IccPanel } from '@/components/IccPanel';
import { ThreeWayIcc } from '@/components/ThreeWayIcc';
import { PageIntro } from '@/components/PageIntro';
import { Skeleton } from '@/components/Skeleton';
import { DOMAIN_LABELS } from '@/lib/labels';
import type { IccData } from '@/lib/types';

// A per-council ICC block, narrowed to the case where it carries an `overall` stat (the filter below
// guarantees it), so the render can read c.overall.icc/lower/upper/n without re-checking for null.
type RawCouncilIcc = NonNullable<NonNullable<IccData['per_council']>[string]>;
type CouncilIcc = Omit<RawCouncilIcc, 'overall'> & { overall: NonNullable<RawCouncilIcc['overall']> };

export default function IccPage() {
  const router = useRouter();
  const [data, setData] = useState<IccData | null>(null);
  useEffect(() => {
    // /admin/icc is superadmin-only (the API 403s silently otherwise) — same client gate
    // as /admin/overview: everyone else lands back on /home.
    if (getUser()?.role !== 'superadmin') { router.push('/home'); return; }
    // .catch so a network failure renders the "no data" branch instead of stranding on the skeleton
    // forever (the error boundary doesn't catch async-effect rejections). Sibling overview/stats catch too.
    apiFetch<IccData>('/admin/icc').then(setData).catch(() => setData({ overall: null }));
  }, [router]);

  if (!data) return (
    <>
      <div className="mx-auto max-w-4xl space-y-6 p-6 md:p-8">
        <div className="h-7 w-48 animate-pulse rounded bg-muted" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </>
  );
  // No AI-vs-auditor ICC yet — but the shadow comparison has its own endpoint and its own empty
  // state, so it still renders here rather than disappearing with the primary panel.
  if (!data.overall) return (
    <div className="mx-auto max-w-4xl space-y-6 p-6 md:p-8">
      <p className="text-muted-foreground">ยังไม่มีข้อมูล ICC — รอให้ Auditors ส่งคะแนน</p>
      <ThreeWayIcc />
    </div>
  );

  const { overall, per_domain, per_council, inter_auditor, inter_auditor_average, inter_auditor_note, inter_auditor_per_domain, weighted_kappa, auditors_per_cle, n_at_target, n_below_target, min_auditors } = data;
  const councils: CouncilIcc[] = per_council
    ? Object.values(per_council).filter((c): c is CouncilIcc => !!c?.overall)
    : [];

  return (
    <>
      <div className="max-w-4xl mx-auto p-6 md:p-10 space-y-6">
      <PageIntro
        eyebrow="Superadmin · Calibration"
        title="ICC Dashboard"
        subtitle="Inter-rater reliability (AI vs Expert Auditor) — gate ≥ 0.75"
      />
      <IccPanel {...overall} />

      {councils.length > 0 && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-1">ICC แยกตามสภาวิชาชีพ / By professional council</h2>
          <p className="text-xs text-muted-foreground mb-4">ดูความน่าเชื่อถือของแต่ละวิชาชีพแยกกัน / Each profession&apos;s calibration, separately.</p>
          <div className="grid gap-3 @min-[640px]:grid-cols-2">
            {councils.map((c) => {
              const icc = c.overall.icc; // may be null (degenerate / insufficient variance)
              const ok = icc != null && icc >= 0.75;
              return (
                <div key={c.council?.id ?? c.council?.code} className="rounded-xl border border-border p-4">
                  <p className="text-sm font-medium">{c.council?.name_th ?? '—'}</p>
                  <p className="text-xs text-muted-foreground">{c.council?.name_en ?? ''}</p>
                  <p className={`text-2xl font-bold mt-1 ${icc == null ? 'text-muted-foreground' : ok ? 'text-[var(--ok)]' : 'text-destructive'}`}>{icc?.toFixed(3) ?? '—'}</p>
                  <p className="text-xs text-muted-foreground">95% CI [{c.overall.lower?.toFixed(2) ?? '—'}, {c.overall.upper?.toFixed(2) ?? '—'}] · n = {c.overall.n}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {per_domain && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-4">ICC รายโดเมน</h2>
          <div className="space-y-3">
            {Object.entries(per_domain).map(([key, d], i) => (
              <div key={key} className="flex items-center gap-3">
                <span className="w-12 text-xs text-muted-foreground">{DOMAIN_LABELS[i]}</span>
                <div className="flex-1 bg-muted rounded-full h-4 relative overflow-hidden">
                  <div className={`h-full rounded-full ${(d?.icc??0) >= 0.75 ? 'bg-[var(--chart-pass)]' : 'bg-destructive'}`}
                    style={{ width: `${Math.max(0, (d?.icc ?? 0)) * 100}%` }} />
                </div>
                <span className="text-sm font-mono w-14">{d?.icc?.toFixed(3) ?? '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Human interrater reliability — the SAP's ICC(A,3), shown next to ICC(1,1) rather than
          instead of it. Which one is legitimate depends on how assignment actually ran, and
          publishing whichever is larger without saying so is the failure this pairing prevents. */}
      {(inter_auditor || inter_auditor_average) && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-1">ความสอดคล้องระหว่างผู้ตรวจ / Human interrater agreement</h2>
          <p className="text-xs text-muted-foreground mb-4">
            เป้าหมายตามโปรโตคอล: ผู้ตรวจ ≥ {min_auditors ?? 3} คนต่อ PLE / Protocol target: ≥ {min_auditors ?? 3} raters per PLE
          </p>
          <div className="grid gap-3 @min-[640px]:grid-cols-2">
            {[
              { r: inter_auditor, sub: 'ผู้ตรวจหนึ่งคน / one rater — conservative; assumes raters drawn per PLE' },
              { r: inter_auditor_average, sub: 'ค่าเฉลี่ยของผู้ตรวจ / the raters\u2019 mean — assumes a fixed panel' },
            ].filter(x => x.r).map(({ r, sub }) => (
              <div key={r!.model ?? 'icc'} className="rounded-xl border p-4">
                <p className="text-sm font-medium">{r!.model ?? 'ICC'}{r!.model_alt ? <span className="text-muted-foreground font-normal"> · {r!.model_alt}</span> : null}</p>
                <p className="text-xs text-muted-foreground">{sub}</p>
                <p className={`mt-1 text-2xl font-bold ${r!.icc == null ? 'text-muted-foreground' : r!.icc >= 0.75 ? 'text-[var(--ok)]' : 'text-destructive'}`}>
                  {r!.icc?.toFixed(3) ?? '—'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r!.icc != null ? <>95% CI [{r!.lower?.toFixed(2)}, {r!.upper?.toFixed(2)}] · </> : null}n = {r!.n}
                </p>
                {r!.icc == null && <p className="mt-1 text-xs text-muted-foreground">{r!.interpretation}</p>}
              </div>
            ))}
          </div>
          {/* Per domain. The composite above says whether raters rank episodes alike; only this says
              WHICH anchor they read differently, which is the calibration workshop's output. Read as
              a map, not seven verdicts: per-domain ICC at pilot n is unstable, and a flat bar means
              the raters all chose the same value — a fact about the cohort, not agreement. */}
          {inter_auditor_per_domain && Object.values(inter_auditor_per_domain).some(Boolean) && (
            <div className="mt-4 border-t pt-4">
              <h3 className="text-sm font-medium mb-1">รายโดเมน / by PIS-7 domain</h3>
              <p className="text-xs text-muted-foreground mb-3">
                โดเมนที่ผู้ตรวจให้คะแนนเท่ากันทุกคนจะไม่มีค่า ICC เพราะไม่มีความแปรปรวนให้วัด ไม่ใช่เพราะไม่สอดคล้อง •
                A domain every rater scored identically has no ICC because there is no variance to measure — that is not disagreement.
              </p>
              <div className="space-y-2">
                {DOMAIN_LABELS.map((label, i) => {
                  const d = inter_auditor_per_domain[`d${i + 1}`];
                  return (
                    <div key={label} className="flex items-center gap-3">
                      <span className="w-12 text-xs text-muted-foreground">{label}</span>
                      <div className="flex-1 bg-muted rounded-full h-3 relative overflow-hidden">
                        {d?.icc != null && (
                          <div className={`h-full rounded-full ${d.icc >= 0.75 ? 'bg-[var(--chart-pass)]' : 'bg-destructive'}`}
                            style={{ width: `${Math.max(0, d.icc) * 100}%` }} />
                        )}
                      </div>
                      <span className="text-sm font-mono w-14 tabular-nums">{d?.icc?.toFixed(3) ?? '—'}</span>
                      {/* n travels with every figure: an ICC without its count is not reportable. */}
                      {/* Hidden below 480px. `flex-1` is `flex: 1 1 0%`, so at 320-390px this fixed
                          160px sibling (plus w-12 + w-14 + gaps) exceeds the row and shrinks the bar
                          to exactly 0px — the at-a-glance comparison disappears while the page still
                          passes the overflow-based responsive audit. */}
                      <span className="hidden @min-[480px]:inline w-40 text-xs text-muted-foreground truncate" title={d?.interpretation ?? ''}>
                        {d == null ? 'ไม่มีข้อมูล / no data' : d.icc == null ? d.interpretation : `n = ${d.n}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {inter_auditor_note && <p className="mt-3 text-xs text-muted-foreground">{inter_auditor_note}</p>}
          {auditors_per_cle && (
            // Cohort transparency, not a filter. This project has been burnt once by a headline ICC
            // that was partly an artifact of cases dropping out (n 33 → 30).
            <p className="mt-2 text-xs text-muted-foreground">
              ผู้ตรวจต่อ PLE / raters per PLE: {Object.entries(auditors_per_cle).map(([k, v]) => `${k}→${v}`).join(' · ')}
              {n_at_target != null && <> · ถึงเป้าหมาย / at target: {n_at_target}, ต่ำกว่า / below: {n_below_target}</>}
            </p>
          )}
        </div>
      )}

      {/* Weighted kappa — SAP "Additional agreement". Ordinal-aware where ICC is not: it asks how
          often two raters land on the SAME 0–5 category, corrected for chance. */}
      {weighted_kappa?.pooled && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-1">Weighted kappa (quadratic)</h2>
          <p className="text-xs text-muted-foreground mb-4">
            แก้ค่าความบังเอิญ — ต่างกัน 1 ระดับถูกหักน้อยกว่าต่างกัน 2 ระดับสี่เท่า / Chance-corrected; an adjacent miss costs a quarter of a two-band miss.
          </p>
          <div className="mb-4 rounded-xl border p-4">
            <p className="text-sm font-medium">รวมทุกโดเมน / Pooled</p>
            <p className="mt-1 text-2xl font-bold">{weighted_kappa.pooled.kappa?.toFixed(3) ?? '—'}</p>
            <p className="text-xs text-muted-foreground">
              {weighted_kappa.pooled.interpretation} · n = {weighted_kappa.pooled.n}
              {weighted_kappa.pooled.exact_agreement != null && <> · ตรงกันพอดี / exact: {(weighted_kappa.pooled.exact_agreement * 100).toFixed(0)}%</>}
            </p>
          </div>
          <div className="space-y-3">
            {Object.entries(weighted_kappa.domains).map(([key, d], i) => (
              <div key={key} className="flex items-center gap-3">
                <span className="w-12 text-xs text-muted-foreground">{DOMAIN_LABELS[i]}</span>
                <div className="relative h-4 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full ${(d?.kappa ?? 0) >= 0.61 ? 'bg-[var(--chart-pass)]' : 'bg-destructive'}`}
                    style={{ width: `${Math.max(0, (d?.kappa ?? 0)) * 100}%` }} />
                </div>
                <span className="w-14 font-mono text-sm">{d?.kappa?.toFixed(3) ?? '—'}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            โดเมนที่ต่ำผิดปกติคือโดเมนที่ควรทบทวนคำอธิบายเกณฑ์ / A domain that stands out low is the one whose anchors need rewriting.
          </p>
        </div>
      )}

      {/* Shadow-evaluator three-way agreement (superadmin sees it here; analysts on /analyst).
          Blinding: this panel must never appear on an auditor-reachable route. */}
      <ThreeWayIcc />
    </div>
    </>
  );
}
