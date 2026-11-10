'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Check } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { DomainScorer } from '@/components/DomainScorer';
import { TranscriptView } from '@/components/TranscriptView';
import { PageIntro } from '@/components/PageIntro';
import { Pis7Radar } from '@/components/Pis7Radar';
import { toast } from '@/components/Overlays';
import { Button } from '@/components/ui/button';
import { StateMessage } from '@/components/ui/state-message';
import { computeComposite } from '@/lib/labels';
import { PIS7_RUBRIC } from '@/lib/pis7-rubric';
import { pis7Conclusion } from '@/lib/pis7-delta';
import { type ApiError, type BoothStudy, formatApiError } from '@/lib/types';

const DEMO_LABEL = 'คะแนนสาธิต / Demo score';
const DEMO_REF = { th: 'คะแนนสาธิต', en: 'the demo score' };
const EMPTY_SCORES: Record<string, number | null> = { d1: null, d2: null, d3: null, d4: null, d5: null, d6: null, d7: null };

type Failure = { error?: ApiError; httpStatus?: number };
type View =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  | { kind: 'failed'; detail: string }
  | { kind: 'study'; study: BoothStudy };

function asStudy(r: unknown): BoothStudy | null {
  if (!r || typeof r !== 'object' || !Array.isArray((r as { messages?: unknown }).messages)) return null;
  const s = r as BoothStudy;
  if (s.state === 'blind') return s;
  if (s.state === 'revealed' && s.audit && s.demo) return s;
  return null;
}

const pis7Of = (m: Record<string, unknown>) => Object.fromEntries(PIS7_RUBRIC.map((d) => [d.key, Number(m[d.key])]));
const signed = (n: number) => { const r = Math.round(n * 10) / 10; return r > 0 ? `+${r.toFixed(1)}` : r.toFixed(1); };

export default function BoothStudyPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [scores, setScores] = useState<Record<string, number | null>>({ ...EMPTY_SCORES });
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => apiFetch<unknown>(`/auditor/booth/${id}`).then((r) => {
    const study = asStudy(r);
    if (study) { setView({ kind: 'study', study }); return; }
    const f = (r ?? {}) as Failure;
    setView(f.httpStatus === 404
      ? { kind: 'not_found' }
      : { kind: 'failed', detail: formatApiError(f.error, 'โหลดไม่สำเร็จ / Could not load.') });
  }), [id]);

  useEffect(() => { load(); }, [load]);
  const retry = () => { setView({ kind: 'loading' }); void load(); };

  const allSet = PIS7_RUBRIC.every((d) => typeof scores[d.key] === 'number');

  async function submit() {
    if (!allSet || submitting) return;
    setSubmitting(true);
    try {
      const body = Object.fromEntries(PIS7_RUBRIC.map((d) => [d.key, scores[d.key]]));
      const r = await apiFetch<unknown>(`/auditor/booth/${id}/audit`, { method: 'POST', body: JSON.stringify(body) });
      const study = asStudy(r);
      if (study?.state === 'revealed') { setView({ kind: 'study', study }); return; }
      const f = (r ?? {}) as Failure;
      if (f.httpStatus === 409) {
        toast('คุณให้คะแนนกรณีนี้ไปแล้ว / You have already scored this case.', 'info');
        await load();
        return;
      }
      toast(formatApiError(f.error, 'ส่งไม่สำเร็จ / Could not submit.'), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const backToList = (
    <Link href="/auditor/booth" className="text-sm font-medium text-link underline underline-offset-2">← กลับ / Back</Link>
  );

  if (view.kind === 'loading') {
    return <div className="mx-auto max-w-3xl p-6 md:p-10"><StateMessage kind="loading" center title="กำลังโหลด… / Loading…" /></div>;
  }
  if (view.kind === 'not_found') {
    return (
      <div className="mx-auto max-w-3xl p-6 md:p-10">
        <StateMessage kind="error" center title="ไม่พบกรณีศึกษานี้ / This case study could not be found.">
          <div className="mt-3">{backToList}</div>
        </StateMessage>
      </div>
    );
  }
  if (view.kind === 'failed') {
    return (
      <div className="mx-auto max-w-3xl p-6 md:p-10">
        <StateMessage kind="error" onRetry={retry} title="โหลดกรณีศึกษาไม่สำเร็จ / Could not load this case study.">
          <p className="text-base">รายละเอียด / Detail: {view.detail}</p>
          <div className="mt-3">{backToList}</div>
        </StateMessage>
      </div>
    );
  }

  const { study } = view;
  const revealed = study.state === 'revealed';
  const shown = revealed ? pis7Of(study.audit) : scores;
  const total = revealed ? study.audit.composite : allSet ? computeComposite(scores as Record<string, number>) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 md:p-10">
      <PageIntro
        eyebrow="Auditor · Booth case study"
        title="ประเมินกรณีศึกษาจากบูธ"
        subtitle="ฝึกให้คะแนน ไม่นับในงานวิจัยนำร่อง / Practice scoring, not counted in the pilot. The demo score stays hidden until you submit."
        action={backToList}
      />
      {/* grid-cols-1, not bare `grid`: a shrinkable column on mobile, so a long transcript line cannot
          widen the page past the viewport. */}
      <div className="grid grid-cols-1 gap-6 @min-[1024px]:grid-cols-2 lg:items-start">
        <div className="space-y-3 lg:sticky lg:top-6">
          <div className="space-y-1">
            <p className="font-medium text-foreground [overflow-wrap:anywhere]">{study.play.case.teaser.th}</p>
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{study.play.case.teaser.en}</p>
          </div>
          <TranscriptView messages={study.messages} />
        </div>
        <div className="space-y-6">
          <div className="rounded-xl border p-5">
            <h2 className="mb-1 font-sans text-xl font-semibold">การให้คะแนน PIS-7</h2>
            <p className="mb-4 text-sm text-muted-foreground">แตะระดับ 0–5 ของแต่ละหมวด / Tap a 0–5 level per domain.</p>
            <DomainScorer scores={shown} onChange={(k, v) => setScores((s) => ({ ...s, [k]: v }))} disabled={revealed} />
            <div className="mt-4 flex items-baseline justify-end gap-2">
              <span className="text-sm text-muted-foreground">คะแนนรวม / Total</span>
              <span className="text-3xl font-semibold tabular-nums text-primary">{total != null ? total.toFixed(1) : '—'}</span>
              <span className="text-sm text-muted-foreground">/ 100</span>
            </div>
            {revealed
              ? <p className="mt-3 flex items-center justify-center gap-1.5 font-medium text-[var(--ok)]"><Check className="size-4" /> บันทึกแล้ว / Submitted</p>
              : <Button className="mt-3 w-full" onClick={submit} disabled={submitting || !allSet}>
                  {submitting ? 'กำลังบันทึก… / Saving…' : !allSet ? 'ให้คะแนนให้ครบทุกหมวด / Score all 7 domains' : 'ส่งคะแนน / Submit score'}
                </Button>}
          </div>
          {study.state === 'revealed' && (
            <div className="space-y-3 rounded-xl border bg-secondary p-5">
              <h3 className="font-sans text-base font-medium">เทียบกับคะแนนสาธิต รายหมวด PIS-7 / PIS-7 by domain, vs the demo score</h3>
              <p className="text-sm tabular-nums text-foreground">
                คะแนนรวม / Total: คุณ / You {study.audit.composite.toFixed(1)} · {DEMO_LABEL} {study.demo.composite.toFixed(1)} ·
                ต่างกัน / Difference {signed(study.audit.composite - study.demo.composite)}
              </p>
              <Pis7Radar ai={study.demo} human={study.audit} label={DEMO_LABEL} />
              <p className="text-sm leading-relaxed text-muted-foreground">{pis7Conclusion(study.demo, study.audit, DEMO_REF)}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
