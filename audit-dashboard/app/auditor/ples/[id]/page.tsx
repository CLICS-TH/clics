'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { DomainSliders } from '@/components/DomainSliders';
import { TranscriptView } from '@/components/TranscriptView';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';
import { computeComposite } from '@/lib/labels';

export default function AuditorScorePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [scores, setScores] = useState<Record<string,number>>({ d1:0,d2:0,d3:0,d4:0,d5:0,d6:0,d7:0 });
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadData = () => apiFetch<any>(`/auditor/ples/${id}`).then(d => {
    setData(d);
    if (d?.audit_score) {
      const { d1,d2,d3,d4,d5,d6,d7, notes: n } = d.audit_score;
      setScores({ d1,d2,d3,d4,d5,d6,d7 }); setNotes(n ?? ''); setSubmitted(true);
    }
  }).catch(() => setData({ error: 'โหลดข้อมูลไม่สำเร็จ / Could not load this session.' }));

  useEffect(() => { loadData(); }, [id]);

  async function submit() {
    // The score is IRREVERSIBLE (backend 409s any re-score) and the sliders default to 0, so guard an
    // accidental unedited submit — an all-zeros score would permanently corrupt this auditor's ICC.
    const allZero = Object.values(scores).every((v) => v === 0);
    if (allZero && !confirm('ยืนยันให้คะแนน 0/100 ทุกหมวด? / Submit a score of 0 for every domain?')) return;
    setSubmitting(true);
    try {
      const res: any = await apiFetch(`/auditor/ples/${id}/score`, {
        method: 'POST', body: JSON.stringify({ ...scores, notes }),
      });
      if (res?.error) {
        // Already scored (409, e.g. a concurrent double-submit): localize and flip to read-only with
        // the existing score, instead of a raw English alert on an editable-but-locked form.
        if (/already scored/i.test(String(res.error))) {
          alert('คุณให้คะแนนเซสชันนี้ไปแล้ว / You have already scored this session.');
          setSubmitted(true); loadData(); return;
        }
        alert(`ส่งไม่สำเร็จ / Submit failed: ${res.error}`);
        return;
      }
      setSubmitted(true);
      loadData();
    } catch {
      alert('เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong. Please try again.');
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

  const composite = computeComposite(scores);

  return (
    <>
      <div className="max-w-3xl mx-auto p-6 md:p-10 space-y-6">
      <PageIntro
        eyebrow="Auditor · Blind Scoring"
        title="ประเมิน CLE"
        subtitle="Score the transcript on PIS-7 — the AI's score stays hidden until you submit"
        action={<Button variant="outline" onClick={() => router.push('/auditor/queue')}>← กลับ</Button>}
      />
      <TranscriptView messages={data.messages ?? []} />
      <div className="border rounded-xl p-5">
        <h2 className="font-semibold mb-4">PIS-7 Scoring</h2>
        <DomainSliders scores={scores} onChange={(k,v) => setScores(s => ({...s,[k]:v}))} disabled={submitted} />
        <div className="mt-4 text-right text-lg font-bold text-primary">คะแนนรวม: {composite.toFixed(1)} / 100</div>
        <textarea className="w-full border rounded-lg p-3 text-sm mt-3" rows={3}
          placeholder="หมายเหตุ / Notes (optional)" value={notes}
          onChange={e => setNotes(e.target.value)} disabled={submitted} />
        {!submitted
          ? <Button className="w-full mt-3" onClick={submit} disabled={submitting}>
              {submitting ? 'กำลังบันทึก...' : 'ส่งคะแนน / Submit Score'}
            </Button>
          : <p className="text-[var(--ok)] font-medium mt-3 text-center">✅ บันทึกแล้ว</p>
        }
      </div>
      {submitted && data.ai_evaluation && (
        <div className="border rounded-xl p-5 bg-secondary">
          <h2 className="font-semibold mb-2">AI Score (เปิดเผยหลังส่งคะแนน)</h2>
          <p className="text-2xl font-bold text-primary">{Number(data.ai_evaluation.composite_score).toFixed(1)} / 100</p>
          <p className="text-sm text-muted-foreground mt-1">คะแนนของคุณ: {composite.toFixed(1)}</p>
        </div>
      )}
    </div>
    </>
  );
}
