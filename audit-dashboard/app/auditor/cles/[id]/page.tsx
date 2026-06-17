'use client';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { DomainScorer } from '@/components/DomainScorer';
import { TranscriptView } from '@/components/TranscriptView';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';
import { computeComposite } from '@/lib/labels';
import { PIS7_RUBRIC } from '@/lib/pis7-rubric';
import { confirmDialog, toast } from '@/components/Overlays';
import type { AuditorPle, ApiResult } from '@/lib/types';
import { Check } from 'lucide-react';

const EMPTY_SCORES: Record<string, number | null> = { d1:null,d2:null,d3:null,d4:null,d5:null,d6:null,d7:null };

export default function AuditorScorePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<AuditorPle | null>(null);
  const [scores, setScores] = useState<Record<string,number|null>>({ ...EMPTY_SCORES });
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(() => apiFetch<AuditorPle>(`/auditor/cles/${id}`).then(d => {
    setData(d);
    if (d?.audit_score) {
      const { d1,d2,d3,d4,d5,d6,d7, notes: n } = d.audit_score;
      setScores({ d1,d2,d3,d4,d5,d6,d7 }); setNotes(n ?? ''); setSubmitted(true);
    }
  }).catch(() => setData({ error: 'โหลดข้อมูลไม่สำเร็จ / Could not load this session.' })), [id]);

  useEffect(() => { loadData(); }, [loadData]);

  const allSet = PIS7_RUBRIC.every((d) => typeof scores[d.key] === 'number');

  async function submit() {
    // Every domain must be explicitly picked (no silent 0 default) — this is what protects ICC.
    if (!allSet) { toast('กรุณาให้คะแนนครบทุกหมวดก่อนส่ง / Score every domain before submitting.', 'error'); return; }
    // An intentional all-zeros score is still extreme + irreversible — confirm it.
    const composite = computeComposite(scores as Record<string, number>);
    if (composite === 0) {
      const ok = await confirmDialog({
        title: 'ให้ 0 ทุกหมวด? / Score 0 for every domain?',
        body: 'คะแนนรวมจะเป็น 0/100 และแก้ไขไม่ได้ภายหลัง / The total will be 0/100 and cannot be changed.',
        danger: true, confirmLabel: 'ยืนยัน / Confirm',
      });
      if (!ok) return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<ApiResult<unknown>>(`/auditor/cles/${id}/score`, {
        method: 'POST', body: JSON.stringify({ ...scores, notes }),
      });
      if (res?.error) {
        // Already scored (409, e.g. a concurrent double-submit): localize and flip to read-only with
        // the existing score, instead of a raw English alert on an editable-but-locked form.
        if (/already scored/i.test(String(res.error))) {
          toast('คุณให้คะแนนเซสชันนี้ไปแล้ว / You have already scored this session.', 'error');
          setSubmitted(true); loadData(); return;
        }
        toast(`ส่งไม่สำเร็จ / Submit failed: ${String(res.error)}`, 'error');
        return;
      }
      setSubmitted(true);
      loadData();
    } catch {
      toast('เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!data) return <div className="p-8 text-muted-foreground">กำลังโหลด...</div>;

  // A 404 ("Not found or not assigned") resolves with the JSON error body — explain it
  // instead of rendering an empty scoring UI the auditor could submit against.
  if (data.error) return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <div className="border rounded-xl p-6 text-center space-y-3">
        <p className="font-medium">ไม่พบเซสชันนี้ หรือคุณไม่ได้รับมอบหมายให้ตรวจ</p>
        <p className="text-sm text-muted-foreground">
          This session could not be found, or it is not assigned to you. ({String(data.error)})
        </p>
        <Button variant="outline" onClick={() => router.push('/auditor/queue')}>← กลับไปที่คิว / Back to queue</Button>
      </div>
    </div>
  );

  const composite = allSet ? computeComposite(scores as Record<string, number>) : null;

  return (
    <div className="max-w-6xl mx-auto p-6 md:p-10 space-y-6">
      <PageIntro
        eyebrow="Auditor · Blind Scoring"
        title="ประเมิน CLE"
        subtitle="Score the transcript on PIS-7 — the AI's score stays hidden until you submit"
        action={<Button variant="outline" onClick={() => router.push('/auditor/queue')}>← กลับ</Button>}
      />
      {/* Two-pane: the transcript stays sticky beside the scorer so raters don't scroll up to re-read.
          grid-cols-1 (not bare `grid`) gives a shrinkable minmax(0,1fr) column on mobile so a wide
          transcript can't blow the column out and overflow the viewport (the w-full textarea inherits it). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <div className="lg:sticky lg:top-6">
          <TranscriptView messages={data.messages ?? []} />
        </div>
        <div className="space-y-6">
          <div className="border rounded-xl p-5">
            <h2 className="font-heading text-xl mb-1">การให้คะแนน PIS-7</h2>
            <p className="text-xs text-muted-foreground mb-4">แตะระดับ 0–5 ของแต่ละหมวด — ใช้คำอธิบายระดับเป็นเกณฑ์ร่วม / Tap a 0–5 level per domain; the descriptors are the shared scale.</p>
            <DomainScorer scores={scores} onChange={(k,v) => setScores(s => ({...s,[k]:v}))} disabled={submitted} />
            <div className="mt-4 flex items-baseline justify-end gap-2">
              <span className="text-sm text-muted-foreground">คะแนนรวม / Total</span>
              <span className="font-heading text-3xl font-semibold text-primary tabular-nums">{composite != null ? composite.toFixed(1) : '—'}</span>
              <span className="text-sm text-muted-foreground">/ 100</span>
            </div>
            <textarea className="w-full border rounded-lg p-3 text-sm mt-3" rows={3}
              placeholder="หมายเหตุ / Notes (optional)" value={notes}
              onChange={e => setNotes(e.target.value)} disabled={submitted} />
            {!submitted
              ? <Button className="w-full mt-3" onClick={submit} disabled={submitting || !allSet}>
                  {submitting ? 'กำลังบันทึก…' : !allSet ? 'ให้คะแนนให้ครบทุกหมวด / Score all 7 domains' : 'ส่งคะแนน / Submit score'}
                </Button>
              : <p className="text-[var(--ok)] font-medium mt-3 flex items-center justify-center gap-1.5"><Check className="size-4" /> บันทึกแล้ว / Submitted</p>
            }
          </div>
          {submitted && data.ai_evaluation && (
            <div className="border rounded-xl p-5 bg-secondary">
              <h2 className="font-heading text-xl mb-2">AI Score <span className="text-sm font-normal text-muted-foreground">(เปิดเผยหลังส่งคะแนน)</span></h2>
              <p className="font-heading text-3xl font-semibold text-primary tabular-nums">{Number(data.ai_evaluation.composite_score).toFixed(1)} <span className="text-base text-muted-foreground">/ 100</span></p>
              <p className="text-sm text-muted-foreground mt-1">คะแนนของคุณ / Yours: {composite != null ? composite.toFixed(1) : '—'}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
