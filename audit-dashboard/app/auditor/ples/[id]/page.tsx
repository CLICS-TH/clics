'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { DomainSliders } from '@/components/DomainSliders';
import { TranscriptView } from '@/components/TranscriptView';
import { Button } from '@/components/ui/button';

const WEIGHTS: Record<string, number> = { d1:0.15, d2:0.20, d3:0.15, d4:0.15, d5:0.15, d6:0.10, d7:0.10 };
const computeComposite = (s: Record<string,number>) =>
  Object.entries(WEIGHTS).reduce((a,[k,w]) => a + (s[k]??0)*w, 0) * 20;

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
  });

  useEffect(() => { loadData(); }, [id]);

  async function submit() {
    setSubmitting(true);
    await apiFetch(`/auditor/ples/${id}/score`, {
      method: 'POST', body: JSON.stringify({ ...scores, notes }),
    });
    setSubmitted(true); setSubmitting(false);
    loadData();
  }

  if (!data) return <div className="p-8 text-slate-400">กำลังโหลด...</div>;
  const composite = computeComposite(scores);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-bold">ประเมิน CLE (Blinded)</h1>
        <Button variant="outline" onClick={() => router.push('/auditor/queue')}>← กลับ</Button>
      </div>
      <TranscriptView messages={data.messages ?? []} />
      <div className="border rounded-xl p-5">
        <h2 className="font-semibold mb-4">PIS-7 Scoring</h2>
        <DomainSliders scores={scores} onChange={(k,v) => setScores(s => ({...s,[k]:v}))} disabled={submitted} />
        <div className="mt-4 text-right text-lg font-bold text-blue-600">คะแนนรวม: {composite.toFixed(1)} / 100</div>
        <textarea className="w-full border rounded-lg p-3 text-sm mt-3" rows={3}
          placeholder="หมายเหตุ / Notes (optional)" value={notes}
          onChange={e => setNotes(e.target.value)} disabled={submitted} />
        {!submitted
          ? <Button className="w-full mt-3" onClick={submit} disabled={submitting}>
              {submitting ? 'กำลังบันทึก...' : 'ส่งคะแนน / Submit Score'}
            </Button>
          : <p className="text-green-600 font-medium mt-3 text-center">✅ บันทึกแล้ว</p>
        }
      </div>
      {submitted && data.ai_evaluation && (
        <div className="border rounded-xl p-5 bg-blue-50">
          <h2 className="font-semibold mb-2">AI Score (เปิดเผยหลังส่งคะแนน)</h2>
          <p className="text-2xl font-bold text-blue-600">{Number(data.ai_evaluation.composite_score).toFixed(1)} / 100</p>
          <p className="text-sm text-slate-500 mt-1">คะแนนของคุณ: {composite.toFixed(1)}</p>
        </div>
      )}
    </div>
  );
}
