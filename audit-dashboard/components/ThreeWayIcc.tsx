'use client';
// Three-way PIS-7 agreement — sibling of IccPanel (same card language, same 0.75 gate, same bands):
//   1. Claude  vs human auditor   — the arm that decides whether the served evaluator is trustworthy
//   2. On-prem candidate vs human auditor — the acceptance test for moving the evaluator on-premise
//   3. Claude  vs on-prem candidate — a cheap early signal AND a correlated-error check, NOT a gate
//
// The human auditor is the reference standard; Claude is not. Arms 1–2 are rendered as the primary
// pair; arm 3 is deliberately subordinate and is NOT coloured against the 0.75 gate, because "the two
// models agree" is not an acceptance criterion — they can be similarly wrong.
//
// ⚠️ BLINDING: auditors score blind. A second AI score reaching an auditor anchors them and destroys
// the very ICC this panel measures. GET /oversight/icc/three-way is guarded by
// requireRole('analyst','ethics','superadmin'); this component ALSO refuses to render for any other
// role, so mounting it on the wrong page renders nothing instead of leaking. Never mount it under
// app/auditor/**.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { DOMAIN_KEYS, DOMAIN_LABELS } from '@/lib/labels';
import { PIS7_RUBRIC } from '@/lib/pis7-rubric';
import { Skeleton } from '@/components/Skeleton';
import type { IccStat, IccVerdict, ThreeWayArm, ThreeWayIccData } from '@/lib/types';

// Mirrors the backend route guard. Anything else (auditor, admin, physician) gets nothing.
const OVERSIGHT_ROLES = ['analyst', 'ethics', 'superadmin'];

// The signed-in role, read during RENDER (not from an effect — see the set-state-in-effect gate) via
// useSyncExternalStore: it never changes within a mounted page, so the store never notifies, and the
// server snapshot is `null` so SSR and hydration both start from "not permitted".
const neverChanges = () => () => {};
const readRole = (): string | null => getUser()?.role ?? null;
const serverRole = (): string | null => null;

// The acceptance gate for inter-rater reliability — the same figure IccPanel prints.
const GATE = 0.75;
// Display-only heuristics: they pick a colour and a caption, they are NOT spec thresholds. Their job
// is to stop a thin sample or a leaky contract rate from hiding behind a healthy point estimate.
const SMALL_SAMPLE = 10;
const CONTRACT_OK = 0.99;
const CONTRACT_WARN = 0.95;

// Thai has no inter-word spaces, so the browser's dictionary line-breaker is free to split a
// compound term — it renders "ผู้ตรวจสอบ" as "ผู้ตรวจ / สอบ" in a narrow card, which reads as two
// different words. NoBreak keeps a term whole. Only short terms go in here (< ~140px at 14px), so it
// can never be the thing that overflows the narrowest container.
const NoBreak = ({ children }: { children: React.ReactNode }) => (
  <span className="whitespace-nowrap">{children}</span>
);

const fmt = (v: number | null | undefined, d = 3) =>
  v == null || !Number.isFinite(v) ? '—' : v.toFixed(d);
const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;

// --destructive (#c64545) clears 4.5:1 on the light canvas (4.59:1) but only 3.7:1 on the dark one,
// so it is used ONLY for the display-size figures (large text, 3:1 bar — and it keeps IccPanel's
// look). Small red text is the shared --danger token (text-danger), pinned in contrast.test.ts —
// this file used to carry its own raw red-700/red-400 pair, a third red beside destructive and danger.
// --ok clears 4.5:1 in BOTH modes at any size, so the pass tone needs no split.
const FAIL_SMALL = 'text-danger';

// Interpretation-band chip, same ladder as IccPanel so the two panels never disagree.
function bandClass(icc: number | null | undefined): string {
  if (icc == null) return 'bg-muted text-muted-foreground';
  if (icc >= 0.95) return 'bg-chart-pass-bg text-chart-pass-text';
  if (icc >= 0.85) return 'bg-secondary text-foreground';
  if (icc >= GATE) return 'bg-notice-bg text-notice-text';
  return 'bg-error-bg text-error-text';
}
// Display-size figures only (text-2xl and up).
const gateClass = (icc: number | null | undefined) =>
  icc == null ? 'text-muted-foreground' : icc >= GATE ? 'text-[var(--ok)]' : 'text-destructive';
// Body-size figures (table cells).
const gateClassSmall = (icc: number | null | undefined) =>
  icc == null ? 'text-muted-foreground' : icc >= GATE ? 'text-[var(--ok)]' : FAIL_SMALL;

// A 0→1 axis with the 0.75 gate drawn as a hard line: bar = the 95% CI, notch = the point estimate.
// Showing the interval is the honest form — a point estimate above the gate whose CI straddles it has
// not cleared anything.
function GateBar({ stat }: { stat: IccStat }) {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const point = stat?.icc ?? null;
  const lo = stat?.lower != null ? clamp(stat.lower) : null;
  const hi = stat?.upper != null ? clamp(stat.upper) : null;
  const ok = point != null && point >= GATE;
  const tone = ok ? 'var(--chart-pass)' : 'var(--chart-fail)';
  return (
    <div className="mt-3">
      <div className="relative h-2.5 w-full rounded-full bg-muted" aria-hidden="true">
        {lo != null && hi != null && hi > lo && (
          <div
            className="absolute inset-y-0 rounded-full opacity-45"
            style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%`, background: tone }}
          />
        )}
        {point != null && (
          <div
            className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-sm"
            style={{ left: `${clamp(point) * 100}%`, background: tone }}
          />
        )}
        <div className="absolute -top-1 -bottom-1 left-[75%] w-px bg-[var(--chart-threshold)]" />
      </div>
      <div className="relative mt-1 h-4 text-xs text-muted-foreground" aria-hidden="true">
        <span className="absolute left-0">0</span>
        <span className="absolute left-[75%] -translate-x-1/2 font-semibold whitespace-nowrap text-foreground">
          {GATE}
        </span>
        <span className="absolute right-0">1.0</span>
      </div>
    </div>
  );
}

// One primary (vs-auditor) arm. `commonN` = coverage.ples_all_three, the shared denominator; when an
// arm's own n falls short of it the shortfall is stated rather than quietly averaged away.
// The server's verdict, rendered so the third state cannot be mistaken for the second.
//
// `fail` and `insufficient` must not look alike. One says the candidate missed the bar; the other
// says nobody knows yet. Colouring them the same way would present the absence of evidence as
// evidence against — and early in a study, `insufficient` is the honest answer almost every time.
function VerdictBadge({ verdict }: { verdict: IccVerdict | null | undefined }) {
  if (!verdict) return null;
  const { state, threshold, why } = verdict;
  const look =
    state === 'pass' ? 'border-ok/40 text-ok'
    : state === 'fail' ? 'border-danger/40 text-danger'
    : 'border-border text-muted-foreground';   // deliberately neutral: no verdict has been reached
  const label =
    state === 'pass' ? `ผ่านเกณฑ์ ≥ ${threshold} / Meets ≥ ${threshold}`
    : state === 'fail' ? `ไม่ผ่านเกณฑ์ ≥ ${threshold} / Below ≥ ${threshold}`
    : `ยังตัดสินไม่ได้ / Not yet decidable`;
  return (
    <p className={`mt-2 rounded-lg border px-3 py-2 text-xs ${look}`}>
      <span className="font-semibold">{label}</span>
      <span className="mt-0.5 block text-muted-foreground">{why}</span>
    </p>
  );
}

function ArmCard({
  arm,
  th,
  en,
  accent,
  commonN,
}: {
  arm: ThreeWayArm | null | undefined;
  th: React.ReactNode;
  en: string;
  accent: string;
  commonN: number | null;
}) {
  const s = arm?.overall ?? null;
  const n = arm?.n ?? s?.n ?? 0;
  return (
    <div className="rounded-xl border border-l-4 p-5" style={{ borderLeftColor: accent }}>
      <h3 className="leading-snug font-semibold break-words">{th}</h3>
      <p className="mt-0.5 text-xs break-words text-muted-foreground">{en}</p>
      <p className={`mt-3 text-3xl font-bold tabular-nums sm:text-4xl ${gateClass(s?.icc)}`}>
        {fmt(s?.icc)}
      </p>
      <p className="mt-1 text-sm tabular-nums text-muted-foreground">
        95% CI [{fmt(s?.lower)}, {fmt(s?.upper)}] · n = {n}
      </p>
      <span
        className={`mt-2 inline-block rounded-full px-3 py-1 text-xs font-semibold ${bandClass(s?.icc)}`}
      >
        {s?.interpretation ?? 'ยังไม่มีข้อมูล / No data yet'}
      </span>
      <GateBar stat={s} />
      <VerdictBadge verdict={arm?.verdict} />
      {commonN != null && commonN > 0 && n !== commonN && (
        <p className="mt-2 text-sm text-muted-foreground">
          คำนวณจาก {n} PLE จากชุดร่วม {commonN} PLE / computed on {n} of the {commonN} shared PLEs.
        </p>
      )}
    </div>
  );
}

// A coverage denominator. `tone` only recolours the figure; the label always says what it counts.
function CoverageTile({
  value,
  th,
  en,
  tone = 'text-foreground',
  emphasis = false,
}: {
  value: string | number;
  th: React.ReactNode;
  en: string;
  tone?: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-4 ${emphasis ? 'border-primary/40 bg-secondary' : ''}`}>
      <p className={`text-2xl font-bold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-1 text-sm leading-snug break-words">{th}</p>
      <p className="text-xs text-muted-foreground break-words">{en}</p>
    </div>
  );
}

// One per-domain cell. `neutral` = the model-vs-model column, which is deliberately NOT scored
// against the human-agreement gate.
function DomainCell({ stat, neutral = false }: { stat: IccStat; neutral?: boolean }) {
  return (
    <td className="px-3 py-2 align-top whitespace-nowrap">
      <span
        className={`block text-sm font-semibold tabular-nums ${neutral ? 'text-foreground' : gateClassSmall(stat?.icc)}`}
      >
        {fmt(stat?.icc)}
      </span>
      <span className="block text-xs tabular-nums text-muted-foreground">
        [{fmt(stat?.lower, 2)}, {fmt(stat?.upper, 2)}]
      </span>
    </td>
  );
}

// Shared frame so every state (loading / unavailable / ready) reads as the same panel.
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section className="space-y-5 rounded-xl border p-5">
      <div>
        <h2 className="text-lg font-semibold">เปรียบเทียบความสอดคล้องสามทาง / Three-way agreement</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          ICC(2,1) ระหว่างผู้ให้คะแนนสองรายต่อหนึ่งคู่ · Claude, <NoBreak>โมเดลผู้ท้าชิงภายในองค์กร</NoBreak> และ
          <NoBreak>ผู้ตรวจสอบที่เป็นมนุษย์</NoBreak>
        </p>
      </div>
      {children}
    </section>
  );
}

export function ThreeWayIcc({ includeTest = false }: { includeTest?: boolean }) {
  // Client-side half of the blinding guard (the API route enforces the real one).
  const role = useSyncExternalStore(neverChanges, readRole, serverRole);
  const permitted = !!role && OVERSIGHT_ROLES.includes(role);
  const [data, setData] = useState<ThreeWayIccData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!permitted) return; // don't even ask for shadow data
    let alive = true;
    apiFetch<ThreeWayIccData>(`/oversight/icc/three-way?include_test=${includeTest}`)
      .then((d) => {
        if (!alive) return;
        // apiFetch resolves an {error} envelope rather than rejecting; a body without `shadow` is a
        // failure too (a missing shadow TABLE still returns shadow.available=false, never a 500).
        if (!d || d.error || !d.shadow) setFailed(true);
        else setData(d);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [permitted, includeTest]);

  if (!permitted) return null; // never render shadow data outside the oversight roles
  if (failed)
    return (
      <Frame>
        <p className="text-sm text-muted-foreground">
          โหลดข้อมูลเปรียบเทียบไม่สำเร็จ กรุณาลองใหม่ / Could not load the comparison. Please try again.
        </p>
      </Frame>
    );
  if (!data?.shadow) return <Skeleton className="h-64 w-full" />;
  const { shadow } = data;
  const cov = data.coverage ?? null;

  // A candidate can be "unavailable" for two OPPOSITE reasons, and they must never read the same.
  // available=false only means no SCORED row exists — which is also what a candidate that failed
  // every single run looks like. Showing "not collecting yet" there would present the single most
  // disqualifying result about the model as an absence of data.
  const everFailed = (cov?.shadow_failed_corpus ?? cov?.shadow_failed ?? 0) > 0;

  if (!shadow.available && everFailed) {
    const failed = cov?.shadow_failed_corpus ?? cov?.shadow_failed ?? 0;
    const attempts = failed + (cov?.shadow_scored_corpus ?? 0);
    return (
      <Frame>
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-5">
          <p className="text-sm font-medium">โมเดลผู้ท้าชิงยังให้คะแนนไม่สำเร็จเลยสักครั้ง</p>
          <p className="mt-2 text-4xl font-semibold tabular-nums text-destructive">0%</p>
          <p className="mt-1 text-sm">
            <NoBreak>โมเดลภายในองค์กร</NoBreak>พยายามให้คะแนน {attempts} ครั้ง และ
            <NoBreak>ไม่สำเร็จ</NoBreak> {failed} ครั้ง จึงยังไม่มีคะแนนที่ใช้เปรียบเทียบได้
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            This is not missing data — the candidate model attempted {attempts} evaluation
            {attempts === 1 ? '' : 's'} and produced a valid PIS-7 score set {'0'} times. A model that cannot hold
            the scoring contract cannot be accepted regardless of how it would have scored.
          </p>
        </div>
      </Frame>
    );
  }

  // Calm empty state — the candidate model simply is not collecting yet. Reached ONLY when nothing
  // has been attempted; the expected state before the shadow migration is applied. Not an error.
  if (!shadow.available)
    return (
      <Frame>
        <div className="rounded-xl border border-dashed bg-muted/40 p-5">
          <p className="text-sm font-medium">ยังไม่มีการเก็บคะแนนจากโมเดลผู้ท้าชิง</p>
          <p className="mt-1 text-sm">
            <NoBreak>โมเดลภายในองค์กร</NoBreak>ยังไม่เริ่มให้คะแนนคู่ขนาน จึงมีเพียงคู่ Claude เทียบ
            <NoBreak>ผู้ตรวจสอบ</NoBreak>เท่านั้น เมื่อเริ่มเก็บแล้ว อีกสองคู่จะปรากฏที่นี่โดยอัตโนมัติ
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            The on-prem candidate model is not collecting scores yet, so only the Claude-vs-auditor arm exists. The
            other two arms appear here automatically once shadow scoring starts.
          </p>
          {cov && (
            <p className="mt-3 text-sm tabular-nums text-muted-foreground">
              PLE ที่มีคะแนน<NoBreak>ผู้ตรวจสอบ</NoBreak> {cov.ples_with_human} · Claude {cov.ples_with_ai} ·{' '}
              <NoBreak>โมเดลภายในองค์กร</NoBreak> {cov.ples_with_shadow}
            </p>
          )}
        </div>
      </Frame>
    );

  const arms = data.arms ?? { ai_vs_human: null, shadow_vs_human: null, ai_vs_shadow: null };
  const commonN = cov?.ples_all_three ?? null;
  const rate = cov?.shadow_contract_rate ?? null;
  const rateTone =
    rate == null
      ? 'text-muted-foreground'
      : rate >= CONTRACT_OK
        ? 'text-[var(--ok)]'
        : rate >= CONTRACT_WARN
          ? 'text-warn'
          : 'text-destructive';
  const secondary = arms.ai_vs_shadow;
  const secondaryN = secondary?.n ?? secondary?.overall?.n ?? 0;

  return (
    <Frame>
      {/* The reference standard, stated before any number is read. */}
      <div className="rounded-xl border border-primary/40 bg-secondary p-4">
        <p className="text-sm font-semibold">
          <NoBreak>ผู้ตรวจสอบที่เป็นมนุษย์</NoBreak> คือ<NoBreak>มาตรฐานอ้างอิง</NoBreak> — Claude ไม่ใช่
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Human auditors are the reference standard; Claude is not. เกณฑ์ผ่านคือ ICC ≥ {GATE} เฉพาะสองคู่ที่เทียบกับ
          <NoBreak>ผู้ตรวจสอบ</NoBreak> / the ICC ≥ {GATE} gate applies only to the two vs-auditor arms.
        </p>
        {(shadow.provider || shadow.model_version) && (
          <p className="mt-2 font-mono text-xs break-all text-muted-foreground">
            candidate: {shadow.provider ?? '—'} · {shadow.model_version ?? '—'}
          </p>
        )}
      </div>

      {/* Coverage first: an ICC on a thin or biased subset is misleading, so the denominators and the
          contract-failure rate carry the same weight as the point estimates. */}
      {cov && (
        <div>
          <h3 className="mb-2 text-base font-semibold">ความครอบคลุมของข้อมูล / Coverage</h3>
          {/* One column at 320px: the Thai labels are unspaced runs and a 2-up grid crushes them. */}
          <div className="grid grid-cols-1 gap-3 @min-[420px]:grid-cols-2 @min-[720px]:grid-cols-4">
            <CoverageTile
              emphasis
              value={cov.ples_all_three}
              th="ครบทั้งสามคะแนน"
              en="Scored by all three — the shared set every arm below uses"
            />
            <CoverageTile value={cov.ples_with_human} th={<NoBreak>มีคะแนนผู้ตรวจสอบ</NoBreak>} en="With auditor scores" />
            <CoverageTile value={cov.ples_with_ai} th="มีคะแนน Claude" en="With Claude scores" />
            <CoverageTile
              value={cov.ples_with_shadow}
              th="มีคะแนนโมเดลภายใน"
              en="With on-prem candidate scores"
            />
          </div>

          {/* The contract-failure rate is a first-class result, not a footnote: a candidate that
              cannot emit a valid score set some of the time is disqualified however high its ICC. */}
          <div className="mt-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className={`text-2xl font-bold tabular-nums ${rateTone}`}>{pct(rate)}</span>
              <span className="text-sm font-medium break-words">
                <NoBreak>อัตราการออกคะแนนสำเร็จ</NoBreak>ของ<NoBreak>โมเดลผู้ท้าชิง</NoBreak> / Candidate valid-score
                rate
              </span>
            </div>
            <p className="mt-1 text-sm break-words text-muted-foreground">
              ล้มเหลว {cov.shadow_failed} ครั้ง — รอบที่ล้มเหลวไม่มีคะแนนจึงไม่ถูกนำไปคำนวณ ICC แต่ถือเป็นผลลัพธ์สำคัญในตัวเอง /
              {' '}
              {cov.shadow_failed} failed run(s). They carry no scores, so they are excluded from every ICC — but the rate
              itself is a result: a model that cannot produce a valid score set is disqualified however high its ICC.
            </p>
          </div>
          {commonN != null && commonN > 0 && commonN < SMALL_SAMPLE && (
            <p className="mt-3 rounded-lg bg-notice-bg px-3 py-2 text-sm text-notice-text">
              ชุดข้อมูลร่วมยังเล็ก ({commonN} PLE) ค่า ICC และช่วงความเชื่อมั่นยังไม่เสถียร / Small shared sample — these ICCs
              and their intervals are unstable.
            </p>
          )}
          {commonN === 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              ยังไม่มี PLE ที่มีคะแนนครบทั้งสามแหล่ง จึงยังเปรียบเทียบไม่ได้ / No PLE yet carries all three scores, so no arm
              is comparable.
            </p>
          )}
        </div>
      )}

      {/* The two arms that matter — measured against the human reference standard. */}
      <div>
        <h3 className="mb-2 text-base font-semibold">
          เทียบกับ<NoBreak>ผู้ตรวจสอบ</NoBreak> (<NoBreak>มาตรฐานอ้างอิง</NoBreak>) / Measured against the human auditor
        </h3>
        <div className="grid grid-cols-1 gap-4 @min-[640px]:grid-cols-2">
          <ArmCard
            arm={arms.ai_vs_human}
            th={<>Claude เทียบ<NoBreak>ผู้ตรวจสอบ</NoBreak></>}
            en="Claude vs human auditor — the evaluator in production today"
            accent="var(--chart-ai)"
            commonN={commonN}
          />
          <ArmCard
            arm={arms.shadow_vs_human}
            th={
              <>
                <NoBreak>โมเดลภายในองค์กร</NoBreak> เทียบ<NoBreak>ผู้ตรวจสอบ</NoBreak>
              </>
            }
            en="On-prem candidate vs human auditor — the acceptance test for moving on-premise"
            accent="var(--chart-peer)"
            commonN={commonN}
          />
        </div>
      </div>

      {/* Subordinate by design: no gate colouring, no gate bar, smaller figure. */}
      <div>
        <h3 className="mb-2 text-base font-semibold text-muted-foreground">
          สัญญาณรอง / Secondary signal — model vs model
        </h3>
        <div className="rounded-xl border border-dashed bg-muted/40 p-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-2xl font-bold tabular-nums text-foreground">
              {fmt(secondary?.overall?.icc)}
            </span>
            <span className="text-sm tabular-nums text-muted-foreground">
              95% CI [{fmt(secondary?.overall?.lower)}, {fmt(secondary?.overall?.upper)}] · n = {secondaryN}
            </span>
          </div>
          <p className="mt-1 text-sm font-medium">
            Claude เทียบ<NoBreak>โมเดลภายในองค์กร</NoBreak> / Claude vs on-prem candidate
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            ค่านี้บอกได้แค่ว่าสองโมเดลให้คะแนนคล้ายกัน อาจผิดเหมือน ๆ กันก็ได้ ไม่ใช่หลักฐานความถูกต้อง ใช้ได้เพียงเพื่อ
            คัดโมเดลที่ไม่ผ่านออกก่อน ไม่ใช่เพื่อรับรอง /
            agreement here proves only that the two models are similar — possibly similarly wrong. It is a SCREENING
            signal: it can reject a candidate before any human effort is spent, and it can never accept one. Only the
            vs-auditor arm above can do that.
          </p>
          {/* Its own threshold, and deliberately a different one. Showing it beside the vs-auditor
              verdicts is what stops a reader treating a strong model-vs-model number as acceptance. */}
          <VerdictBadge verdict={secondary?.verdict} />
        </div>
      </div>

      {/* Per-domain: wide by nature, so it scrolls inside its own container instead of the page. */}
      <div>
        <h3 className="mb-2 text-base font-semibold">รายโดเมน PIS-7 / Per-domain (ICC · 95% CI)</h3>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">
              ICC per PIS-7 domain for each of the three comparison arms, with 95% confidence intervals
            </caption>
            <thead className="bg-secondary text-left">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  โดเมน / Domain
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Claude vs <NoBreak>ผู้ตรวจสอบ</NoBreak>
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  <NoBreak>ภายในองค์กร</NoBreak> vs <NoBreak>ผู้ตรวจสอบ</NoBreak>
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                  Claude vs <NoBreak>ภายในองค์กร</NoBreak> (รอง)
                </th>
              </tr>
            </thead>
            <tbody>
              {DOMAIN_KEYS.map((k, i) => (
                <tr key={k} className="border-t">
                  <th
                    scope="row"
                    className="px-3 py-2 text-left font-medium whitespace-nowrap"
                    title={
                      PIS7_RUBRIC[i] ? `${PIS7_RUBRIC[i].th} / ${PIS7_RUBRIC[i].en}` : undefined
                    }
                  >
                    {DOMAIN_LABELS[i]}
                  </th>
                  <DomainCell stat={arms.ai_vs_human?.per_domain?.[k] ?? null} />
                  <DomainCell stat={arms.shadow_vs_human?.per_domain?.[k] ?? null} />
                  <DomainCell stat={secondary?.per_domain?.[k] ?? null} neutral />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          สีเขียว = ผ่านเกณฑ์ ICC ≥ {GATE}, สีแดง = ยังไม่ผ่าน; คอลัมน์สุดท้ายเป็นสัญญาณรองจึงไม่ตัดสินด้วยเกณฑ์นี้ / green =
          meets the ICC ≥ {GATE} gate, red = does not; the last column is a secondary signal and is not judged against it.
        </p>
      </div>
    </Frame>
  );
}
