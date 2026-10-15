'use client';
// AI readiness — what each provider can actually do right now, beside the switch that points traffic
// at it.
//
// These numbers already existed on RIMPL's deep health route, and that is exactly why they were
// useless: nobody curls a JSON endpoint before flipping a switch. The failure that motivated this
// screen was measured on the real box — an inference server left on a 4,096-token context accepts
// the switch happily and then fails EVERY evaluation, because a creditable transcript runs past
// 10,000 tokens. The switch endpoint now refuses that outright; this is where you see it coming.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { PageIntro } from '@/components/PageIntro';
import { Button } from '@/components/ui/button';
import type { ReadinessManifest, ReadinessModelLock } from '@/lib/types';
import { LOCK_NOTE, LOCK_REASON } from '@/lib/evaluator-lock';
import { AlertTriangle, CheckCircle2, XCircle, HelpCircle, RefreshCw } from 'lucide-react';

// `warning` rides on a `warn` check, `error` on a `down` one (rimpl services/ai.js readiness()).
interface Check { status: string; model?: string | null; context_length?: number | string | null; min_context?: number | null; error?: string | null; warning?: string | null }
// Measured by embedding a probe string, because no endpoint reports a vector width. `dimension` is
// null when the probe could not run — which is a distinct answer from a mismatch, and is rendered
// as one.
interface Embedding {
  provider: string;
  model: string | null;
  fit: boolean;
  dimension: number | null;
  required: number | null;
  reason: string | null;
}
interface Readiness {
  reachable: boolean;
  error?: string;
  checks: Record<string, Check>;
  models: Record<string, { provider: string; model: string | null }> | null;
  routing: { source?: string; evaluator_locked_at?: string | null } | null;
  embedding: Embedding | null;
  // rimpl's public manifest block and the backend's verdict on the lock (services/model-lock.js
  // modelLockCheck). Absent from a backend that predates the Model Lock binding.
  manifest?: ReadinessManifest | null;
  model_lock?: ReadinessModelLock | null;
}

const short = (s: string | null | undefined) => (s ? `${s.slice(0, 12)}…` : null);
const thDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('th-TH');
};


// The same verdict rimpl's /health/deep reaches (routes/health.js): `up` and `warn` both SERVE — a
// warning is a finding about the configuration, e.g. r3_distinct_models (tutor and evaluator are one
// model artifact, CCME R3) — and every other value is not. That includes a status this screen
// predates, and none at all: the endpoint already counted those as not serving and answered 503, so
// the screen says Down too rather than inventing a fourth meaning. Before `warn` existed here, a
// serving box with one config finding read as red "Down" — the opposite of what it was.
type Status = 'up' | 'warn' | 'down';
function statusOf(c: Check): Status {
  return c.status === 'up' || c.status === 'warn' ? c.status : 'down';
}

// Not colour alone: each state has its own icon and its own words.
const STATUS_VIEW: Record<Status, { tone: string; Icon: typeof CheckCircle2; label: string }> = {
  up: { tone: 'text-ok', Icon: CheckCircle2, label: 'พร้อม / Up' },
  warn: { tone: 'text-warn', Icon: AlertTriangle, label: 'คำเตือน / Warning' },
  down: { tone: 'text-danger', Icon: XCircle, label: 'ไม่พร้อม / Down' },
};

// 'unknown' is its own state, never folded into either of the other two. A context we could not read
// is not a context we read and approved — that distinction is the whole point of the screen.
// 'none' is a warning that names no context at all: r3_distinct_models is a comparison, not a model,
// so "unknown" would claim there was a window to read, and red would claim it failed.
function contextState(c: Check, status: Status): 'ok' | 'bad' | 'unknown' | 'none' {
  if (status === 'down') return 'bad';
  if (typeof c.context_length === 'number') return 'ok';
  if (status === 'warn' && c.context_length == null) return 'none';
  return 'unknown';
}

export default function AiReadinessPage() {
  const [data, setData] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState(true);

  // `load` sets no state synchronously — every setState here lands in a promise callback. That keeps
  // the effect below clean under the react-hooks/set-state-in-effect gate; the button's own handler
  // is where the pending state is raised.
  const load = useCallback(() => (
    apiFetch<Readiness>('/admin/ai-readiness')
      .then(setData)
      .catch(() => setData({ reachable: false, error: 'ไม่สามารถตรวจสอบได้ / Probe failed', checks: {}, models: null, routing: null, embedding: null }))
      .finally(() => setBusy(false))
  ), []);
  useEffect(() => { load(); }, [load]);
  const refresh = () => { setBusy(true); load(); };

  // A null or non-object entry renders as a check with no status (Down, "no status reported") rather
  // than throwing on `.status` and blanking the whole table — the rows beside it are still the answer.
  const entries = Object.entries(data?.checks ?? {}).map(([name, c]): [string, Check] =>
    [name, c && typeof c === 'object' ? c : { status: '' }]);

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-6">
      <PageIntro
        eyebrow="AI readiness"
        title="ความพร้อมของเครื่องประมวลผล"
        subtitle="What each provider can serve right now — reachability, model, the context window it is actually configured with, and the embedding dimension it returns."
      />

      <div className="flex justify-end">
        <Button onClick={refresh} disabled={busy}>
          <RefreshCw className="size-4" aria-hidden="true" />
          {busy ? 'กำลังตรวจ / Checking…' : 'ตรวจซ้ำ / Re-check'}
        </Button>
      </div>

      {data && !data.reachable && (
        <div className="rounded-lg border border-danger/40 bg-card p-4">
          <p className="text-danger font-medium">ติดต่อชั้น RIMPL ไม่ได้ / Could not reach the RIMPL layer</p>
          <p className="mt-1 text-sm text-muted-foreground">{data.error}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            ระบบจะไม่ยอมให้สลับผู้ให้บริการขณะตรวจสอบไม่ได้ / A provider switch is refused while readiness cannot be
            verified. That is deliberate: unverified is not the same as fit.
          </p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-4 font-medium">ผู้ให้บริการ / Provider</th>
                <th className="py-2 pr-4 font-medium">สถานะ / Status</th>
                <th className="py-2 pr-4 font-medium">โมเดล / Model</th>
                <th className="py-2 font-medium">ความยาวบทสนทนา / Context</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([name, c]) => {
                const status = statusOf(c);
                const state = contextState(c, status);
                const view = STATUS_VIEW[status];
                // Down for a reason the screen cannot name: say what arrived, so "Down" is not
                // mistaken for a dependency that answered `down`.
                const unrecognised = status === 'down' && c.status !== 'down';
                const raw = typeof c.status === 'string' ? c.status : '';
                return (
                  <tr key={name} className="border-b border-border/50 align-top">
                    <td className="py-3 pr-4 font-medium">{name}</td>
                    <td className="py-3 pr-4">
                      <span className={`inline-flex items-center gap-1.5 ${view.tone}`}>
                        <view.Icon className="size-4 shrink-0" aria-hidden="true" />
                        {view.label}
                      </span>
                      {status === 'warn' && c.warning && (
                        <p className="mt-1 max-w-xs text-xs text-muted-foreground break-words">{c.warning}</p>
                      )}
                      {unrecognised && (
                        <p className="mt-1 max-w-xs text-xs text-muted-foreground break-words">
                          {raw
                            ? <>สถานะที่ไม่รู้จัก / Unrecognised status <span className="font-mono">{raw}</span></>
                            : 'ไม่มีสถานะ / No status reported'}
                        </p>
                      )}
                      {c.error && <p className="mt-1 max-w-xs text-xs text-muted-foreground">{c.error}</p>}
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs">{c.model ?? '—'}</td>
                    <td className="py-3 tabular-nums">
                      {state === 'ok' && (
                        <>
                          <span className="text-ok">{Number(c.context_length).toLocaleString()}</span>
                          {/* The floor the switch refuses against. Without it the number above is
                              only readable by someone who already knows what it has to beat. */}
                          {typeof c.min_context === 'number' && (
                            <span className="ml-1 text-xs text-muted-foreground">
                              / ต้องการ {c.min_context.toLocaleString()}
                            </span>
                          )}
                        </>
                      )}
                      {state === 'unknown' && (
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          <HelpCircle className="size-4" aria-hidden="true" />
                          ไม่ทราบ / Unknown
                        </span>
                      )}
                      {state === 'bad' && <span className="text-danger">—</span>}
                      {state === 'none' && <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data?.embedding && (
        <section className="space-y-2">
          <h2 className="font-sans text-sm font-medium">มิติเวกเตอร์ของการฝัง / Embedding dimension</h2>
          <div className="rounded-lg border border-border bg-card p-4 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{data.embedding.provider}</span>
              <span className="font-mono text-xs text-muted-foreground">{data.embedding.model ?? '—'}</span>
              {data.embedding.dimension == null ? (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <HelpCircle className="size-4" aria-hidden="true" />
                  วัดไม่ได้ / Not measurable
                </span>
              ) : (
                <span className={`inline-flex items-center gap-1.5 tabular-nums ${data.embedding.fit ? 'text-ok' : 'text-danger'}`}>
                  {data.embedding.fit
                    ? <CheckCircle2 className="size-4" aria-hidden="true" />
                    : <XCircle className="size-4" aria-hidden="true" />}
                  {data.embedding.dimension.toLocaleString()}
                  {data.embedding.required != null && (
                    <span className="text-muted-foreground">/ คลังเอกสาร {data.embedding.required.toLocaleString()}</span>
                  )}
                </span>
              )}
            </div>
            {data.embedding.reason && (
              <p className="mt-2 text-sm text-muted-foreground">{data.embedding.reason}</p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              วัดโดยการฝังข้อความทดสอบจริง / Measured by embedding a probe string — no endpoint reports a vector
              width, so this is the only honest way to know it before switching.
            </p>
          </div>
        </section>
      )}

      {data?.models && (
        <section className="space-y-2">
          <h2 className="font-sans text-sm font-medium">งานแต่ละประเภทวิ่งที่ไหน / Which provider serves each purpose</h2>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {Object.entries(data.models).map(([purpose, m]) => (
              <li key={purpose} className="flex flex-wrap gap-x-2">
                <span className="font-medium text-foreground">{purpose}</span>
                <span>{m.provider}</span>
                <span className="font-mono text-xs">{m.model ?? '—'}</span>
              </li>
            ))}
          </ul>
          {data.routing?.evaluator_locked_at && (
            <p className="text-sm text-muted-foreground">
              ผู้ให้คะแนนถูกล็อกเมื่อ / Evaluator locked at {data.routing.evaluator_locked_at}
            </p>
          )}
        </section>
      )}

      {data?.manifest && <ManifestBlock m={data.manifest} />}
      {data?.model_lock && <ModelLockBlock l={data.model_lock} />}
    </div>
  );
}

// The KEYS of the drift only. rimpl already hashes free-text live values on this public block, but the
// values are still not this screen's business: which settings differ is the finding.
function ManifestBlock({ m }: { m: ReadinessManifest }) {
  const keys = (m.drift ?? []).map((d) => d?.key).filter((k): k is string => typeof k === 'string');
  const sha = short(m.sha256);
  return (
    <section className="space-y-2">
      <h2 className="font-sans text-sm font-medium">Model manifest</h2>
      <div className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-xs" title={m.sha256 ?? undefined}>
            {sha ?? <span className="text-danger">ยืนยัน sha256 ไม่ได้ / sha256 not verified</span>}
          </span>
          <span className="text-muted-foreground">file: <span className="font-mono text-xs text-foreground">{m.file ?? '—'}</span></span>
          {m.code_match === true ? (
            <span className="inline-flex items-center gap-1.5 text-ok"><CheckCircle2 className="size-4" aria-hidden="true" />ตรงกับโค้ด / Matches the code</span>
          ) : m.code_match === false ? (
            <span className="inline-flex items-center gap-1.5 text-danger"><XCircle className="size-4" aria-hidden="true" />ไม่ตรงกับโค้ด / Differs from the code</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground"><HelpCircle className="size-4" aria-hidden="true" />ไม่ทราบว่าตรงกับโค้ดหรือไม่ / Code match unknown</span>
          )}
        </div>
        {keys.length > 0 ? (
          <>
            <p className="inline-flex items-center gap-1.5 text-warn">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              ค่าที่รันอยู่ต่างจาก manifest {keys.length} รายการ / {keys.length} live value(s) differ from the manifest
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {keys.map((k) => <li key={k} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all text-foreground">{k}</li>)}
            </ul>
            <p className="text-xs text-muted-foreground">
              คาดว่าจะมีคำเตือนนี้ขณะ production ใช้ Claude ทุกงาน เพราะ manifest ระบุเครื่องในองค์กรเป็นเป้าหมาย (CCME R1/R3) /
              Expected while production runs every purpose on Claude: the manifest declares the on-prem target (CCME R1/R3), so live
              routing differs from it until those close.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">ไม่มีค่าที่ต่างจาก manifest / No live value differs from the manifest.</p>
        )}
      </div>
    </section>
  );
}

function ModelLockBlock({ l }: { l: ReadinessModelLock }) {
  const status: Status | 'unknown' = l.status === 'up' ? 'up' : l.status === 'unknown' ? 'unknown' : 'down';
  const view = status === 'unknown'
    ? { tone: 'text-muted-foreground', Icon: HelpCircle, label: 'ไม่ทราบ / Unknown' }
    : STATUS_VIEW[status];
  return (
    <section className="space-y-2">
      <h2 className="font-sans text-sm font-medium">การล็อกผู้ให้คะแนน / Evaluator Model Lock</h2>
      <div className="space-y-1.5 rounded-lg border border-border bg-card p-4 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`inline-flex items-center gap-1.5 ${view.tone}`}>
            <view.Icon className="size-4 shrink-0" aria-hidden="true" />
            {view.label}
          </span>
          <span className="text-foreground">
            {l.locked === true
              ? `ล็อกตั้งแต่ ${thDate(l.locked_at)} / Locked since ${thDate(l.locked_at)}`
              : l.locked === false ? 'ยังไม่ล็อก / Not locked' : 'อ่านสถานะการล็อกไม่ได้ / Lock state unreadable'}
          </span>
        </div>
        {l.locked === true && (
          <p className="font-mono text-xs break-words text-muted-foreground">
            {l.provider ?? '—'} · frozen manifest {short(l.manifest_sha256) ?? '—'} · live {short(l.live_sha256) ?? '—'}
            {' '}· evaluator {l.match === true ? 'match' : l.match === false ? 'MISMATCH' : '—'}
          </p>
        )}
        {l.reason && <p className="break-words text-foreground">{LOCK_REASON[l.reason] ?? <span className="font-mono">{l.reason}</span>}</p>}
        {l.note && <p className="break-words text-muted-foreground">{LOCK_NOTE[l.note] ?? <span className="font-mono">{l.note}</span>}</p>}
        {l.error && <p className="break-words text-muted-foreground">{l.error}</p>}
      </div>
    </section>
  );
}
