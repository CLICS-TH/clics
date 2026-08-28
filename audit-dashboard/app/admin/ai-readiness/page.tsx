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
import { CheckCircle2, XCircle, HelpCircle, RefreshCw } from 'lucide-react';

interface Check { status: string; model?: string | null; context_length?: number | string | null; min_context?: number | null; error?: string | null }
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
}

// 'unknown' is its own state, never folded into either of the other two. A context we could not read
// is not a context we read and approved — that distinction is the whole point of the screen.
function contextState(c: Check): 'ok' | 'bad' | 'unknown' {
  if (c.status !== 'up') return 'bad';
  return typeof c.context_length === 'number' ? 'ok' : 'unknown';
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

  const entries = Object.entries(data?.checks ?? {});

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
                const state = contextState(c);
                return (
                  <tr key={name} className="border-b border-border/50 align-top">
                    <td className="py-3 pr-4 font-medium">{name}</td>
                    <td className="py-3 pr-4">
                      <span className={`inline-flex items-center gap-1.5 ${c.status === 'up' ? 'text-ok' : 'text-danger'}`}>
                        {c.status === 'up'
                          ? <CheckCircle2 className="size-4" aria-hidden="true" />
                          : <XCircle className="size-4" aria-hidden="true" />}
                        {c.status === 'up' ? 'พร้อม / Up' : 'ไม่พร้อม / Down'}
                      </span>
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
          <h2 className="text-sm font-medium">มิติเวกเตอร์ของการฝัง / Embedding dimension</h2>
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
          <h2 className="text-sm font-medium">งานแต่ละประเภทวิ่งที่ไหน / Which provider serves each purpose</h2>
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
    </div>
  );
}
