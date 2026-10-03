'use client';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { DomainScorer } from '@/components/DomainScorer';
import { TranscriptView } from '@/components/TranscriptView';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';
import { Textarea, Checkbox } from '@/components/ui/input';
import { StateMessage } from '@/components/ui/state-message';
import { AiOutput } from '@/components/ui/ai-output';
import { Modal } from '@/components/ui/modal';
import { AI_LABEL } from '@/lib/ai-label';
import { computeComposite } from '@/lib/labels';
import { PIS7_RUBRIC, ATTESTATIONS } from '@/lib/pis7-rubric';
import { Pis7Radar } from '@/components/Pis7Radar';
import { pis7Conclusion } from '@/lib/pis7-delta';
import { AuditorChatBox } from '@/components/AuditorChatBox';
import { ConsistencyChip } from '@/components/ConsistencyChip';
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
  // Auditor confidentiality + COI consent (Appendix 04/15) — required once before scoring. Surfaced
  // reactively when the backend returns auditor_consent_required.
  const [needsConsent, setNeedsConsent] = useState(false);
  const [coiNone, setCoiNone] = useState(false);
  const [conf, setConf] = useState(false);
  const [calib, setCalib] = useState(false);
  // Per-assessment confirmations from the approved form — distinct from the one-time
  // confidentiality/COI consent above, which is recorded once per account.
  const [attest, setAttest] = useState<Record<string, boolean>>({});
  const [anchors, setAnchors] = useState<Record<string, string | undefined>>({});
  const [reporting, setReporting] = useState(false);
  const [concern, setConcern] = useState('');
  const consentReady = coiNone && conf && calib;

  const loadData = useCallback(() => apiFetch<AuditorPle>(`/auditor/ples/${id}`).then(d => {
    setData(d);
    if (d?.audit_score) {
      const { d1,d2,d3,d4,d5,d6,d7, notes: n } = d.audit_score;
      setScores({ d1,d2,d3,d4,d5,d6,d7 }); setNotes(n ?? ''); setSubmitted(true);
      // Restore the anchor choices too. Without this a submitted assessment reopens with every
      // anchor radio blank, which reads as "the rater never answered" rather than "here is what
      // they answered" — and the answers are the input to the rubric-refinement analysis.
      setAnchors(Object.fromEntries(
        PIS7_RUBRIC.map((dd) => [`${dd.key}_anchor`, d.audit_score?.[`${dd.key}_anchor` as 'd1_anchor'] ?? undefined])
      ));
    }
  }).catch(() => setData({ error: 'โหลดข้อมูลไม่สำเร็จ / Could not load this session.' })), [id]);

  useEffect(() => { loadData(); }, [loadData]);

  const allSet = PIS7_RUBRIC.every((d) => typeof scores[d.key] === 'number');
  const attestAll = ATTESTATIONS.every((a) => attest[a.key]);

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
      const res = await apiFetch<ApiResult<unknown>>(`/auditor/ples/${id}/score`, {
        method: 'POST', body: JSON.stringify({ ...scores, ...anchors, notes, attestations: attest }),
      });
      if (res?.error) {
        // Confidentiality + COI consent not yet recorded — open the one-time consent gate.
        if ((res as { code?: string }).code === 'auditor_consent_required') { setNeedsConsent(true); return; }
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

  async function reportConcern() {
    setSubmitting(true);
    try {
      const res = await apiFetch<ApiResult<unknown>>(`/auditor/ples/${id}/privacy-concern`, {
        method: 'POST', body: JSON.stringify({ note: concern.trim() }),
      });
      if (res?.error) { toast(`ส่งรายงานไม่สำเร็จ / Report failed: ${String(res.error)}`, 'error'); return; }
      toast('ส่งรายงานแล้ว เซสชันถูกกักไว้เพื่อตรวจสอบ / Reported. The session is quarantined for review.', 'success');
      router.push('/auditor/queue');
    } catch {
      toast('เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function recordConsent() {
    const r = await apiFetch<ApiResult<unknown>>('/auth/consent', {
      method: 'POST',
      body: JSON.stringify({
        context: 'auditor', version: 'auditor-v1',
        checkboxes: { confidentiality: conf, calibration_ack: calib },
        coi: { none: coiNone },
      }),
    });
    if (r && !(r as { error?: string }).error) { setNeedsConsent(false); submit(); }
    else toast('บันทึกความยินยอมไม่สำเร็จ / Could not record consent.', 'error');
  }

  if (!data) return <div className="mx-auto max-w-3xl p-6 md:p-10"><StateMessage kind="loading" center title="กำลังโหลด… / Loading…" /></div>;

  // A 404 ("Not found or not assigned") resolves with the JSON error body — explain it
  // instead of rendering an empty scoring UI the auditor could submit against.
  if (data.error) return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <StateMessage kind="error" center title="ไม่พบเซสชันนี้ หรือคุณไม่ได้รับมอบหมายให้ตรวจ">
        This session could not be found, or it is not assigned to you. ({String(data.error)})
        <div className="mt-3">
          <Button variant="outline" onClick={() => router.push('/auditor/queue')}>← กลับไปที่คิว / Back to queue</Button>
        </div>
      </StateMessage>
    </div>
  );

  const composite = allSet ? computeComposite(scores as Record<string, number>) : null;
  // Peer card wording: peer_avg excludes self, so peer_n === 1 means a SINGLE other auditor — call it
  // "the other auditor", not an "average" (which only reads true once ≥2 peers have scored).
  const onePeer = (data.peer_n ?? 0) === 1;

  return (
    <div className="max-w-6xl mx-auto p-6 md:p-10 space-y-6">
      <PageIntro
        eyebrow="Auditor · Blind Scoring"
        title="ประเมิน PLE"
        subtitle="Score the transcript on PIS-7 — the AI's score stays hidden until you submit"
        action={<Button variant="outline" onClick={() => router.push('/auditor/queue')}>← กลับ</Button>}
      />
      {/* Two-pane: the transcript stays sticky beside the scorer so raters don't scroll up to re-read.
          grid-cols-1 (not bare `grid`) gives a shrinkable minmax(0,1fr) column on mobile so a wide
          transcript can't blow the column out and overflow the viewport (the w-full textarea inherits it). */}
      <div className="grid grid-cols-1 gap-6 @min-[1024px]:grid-cols-2 lg:items-start">
        <div className="lg:sticky lg:top-6">
          <TranscriptView messages={data.messages ?? []} />
        </div>
        <div className="space-y-6">
          <div className="border rounded-xl p-5">
            <h2 className="font-sans text-xl font-semibold mb-1">การให้คะแนน PIS-7</h2>
            <p className="text-xs text-muted-foreground mb-4">แตะระดับ 0–5 ของแต่ละหมวด — ใช้คำอธิบายระดับเป็นเกณฑ์ร่วม / Tap a 0–5 level per domain; the descriptors are the shared scale.</p>
            <DomainScorer
              scores={scores} onChange={(k,v) => setScores(s => ({...s,[k]:v}))}
              anchors={anchors} onAnchorChange={(k,v) => setAnchors(a => ({...a,[k]:v}))}
              disabled={submitted} />
            <div className="mt-4 flex items-baseline justify-end gap-2">
              <span className="text-sm text-muted-foreground">คะแนนรวม / Total</span>
              <span className="text-3xl font-semibold text-primary tabular-nums">{composite != null ? composite.toFixed(1) : '—'}</span>
              <span className="text-sm text-muted-foreground">/ 100</span>
            </div>
            <Textarea className="mt-3 p-3" rows={3}
              aria-label="หมายเหตุ / Notes"
              placeholder="หมายเหตุ / Notes (optional)" value={notes}
              onChange={e => setNotes(e.target.value)} disabled={submitted} />
            {!submitted && (
              <fieldset className="mt-4 rounded-lg border p-3">
                <legend className="px-1 text-xs font-medium">ยืนยันก่อนส่ง / Confirm before submitting</legend>
                <div className="space-y-2">
                  {ATTESTATIONS.map((a) => (
                    <label key={a.key} className="flex gap-2 text-sm">
                      <Checkbox className="mt-0.5" checked={!!attest[a.key]}
                        onChange={e => setAttest(s => ({ ...s, [a.key]: e.target.checked }))} />
                      <span>{a.th} / {a.en}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {!submitted
              ? <Button className="w-full mt-3" onClick={submit} disabled={submitting || !allSet || !attestAll}>
                  {submitting ? 'กำลังบันทึก…'
                    : !allSet ? 'ให้คะแนนให้ครบทุกหมวด / Score all 7 domains'
                    : !attestAll ? 'ยืนยันให้ครบทุกข้อ / Confirm every item above'
                    : 'ส่งคะแนน / Submit score'}
                </Button>
              : <p className="text-[var(--ok)] font-medium mt-3 flex items-center justify-center gap-1.5"><Check className="size-4" /> บันทึกแล้ว / Submitted</p>
            }
            {/* The approved form tells a rater who sees possible patient data to stop and notify the
                research team. Without this the only options were to score it anyway or say nothing. */}
            {!submitted && (
              <div className="mt-4 border-t pt-3">
                {!reporting ? (
                  <button type="button" onClick={() => setReporting(true)}
                    className="text-sm text-danger underline underline-offset-2">
                    พบข้อมูลที่อาจระบุตัวบุคคล — หยุดและแจ้งผู้วิจัย / Report a suspected identifier instead of scoring
                  </button>
                ) : (
                  <div className="space-y-2">
                    <label htmlFor="concern" className="block text-sm font-medium">
                      ระบุตำแหน่งและลักษณะของข้อมูล / Where in the transcript, and what kind
                    </label>
                    <Textarea id="concern" rows={3} value={concern} onChange={e => setConcern(e.target.value)}
                      className="p-3"
                      placeholder="เช่น เทิร์นที่ 3 ระบุชื่อโรงพยาบาลและวันที่ / e.g. turn 3 names a hospital and a date" />
                    <p className="text-xs text-muted-foreground">
                      เซสชันนี้จะถูกกักไว้เพื่อตรวจสอบและออกจากคิวของคุณ ไม่มีการบันทึกคะแนน /
                      The session is quarantined for review and leaves your queue. No score is recorded.
                    </p>
                    <div className="flex gap-2">
                      <Button variant="destructive" disabled={!concern.trim() || submitting} onClick={reportConcern}>
                        ส่งรายงาน / Send report
                      </Button>
                      <Button variant="outline" onClick={() => { setReporting(false); setConcern(''); }}>
                        ยกเลิก / Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Locked for a calibration round: say so where the reveal would have been. Placed before the
              reveal block because when the lock is on the server sends no ai_evaluation at all, so
              nothing below would render and the rater would be left guessing. */}
          {submitted && data.reveal_locked && (
            <StateMessage kind="locked" heading="h2" aria-describedby="reveal-lock-why"
              title="ปิดการเผยคะแนนไว้ระหว่างรอบสอบเทียบ / AI reveal locked for this round">
              <p id="reveal-lock-why" className="text-muted-foreground">
                คะแนนของคุณถูกบันทึกเรียบร้อยแล้ว ระหว่างรอบสอบเทียบระบบจะยังไม่แสดงคะแนน AI ค่าเฉลี่ยของผู้ตรวจท่านอื่น
                และการสนทนากับ AI เพื่อให้การให้คะแนน PLE ถัดไปเป็นอิสระจากกัน ผู้ประสานงานจะเปิดให้ดูเมื่อทุกท่านให้คะแนนครบแล้ว •
                Your score is saved. For the duration of this calibration round the AI score, the auditor
                average and the AI discussion stay hidden so that each session is scored independently of
                the last. The coordinator opens them once every rater has finished.
              </p>
            </StateMessage>
          )}
          {submitted && data.ai_evaluation && (
            <div className="border rounded-xl p-5 bg-secondary space-y-4">
              <div>
                {/* Colour law: coral = the human (your Total above), slate-blue = the AI. The AI number was
                    coral, which made the two totals look like the same kind of thing. The label text is
                    AI_LABEL (approved by the product owner 2026-10-03). */}
                <AiOutput label={AI_LABEL.score}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <p className="text-3xl font-semibold tabular-nums">{Number(data.ai_evaluation.composite_score).toFixed(1)} <span className="text-base">/ 100</span></p>
                    {/* Repeat-scoring metadata, when RIMPL recorded it. Renders nothing otherwise; display only. */}
                    <ConsistencyChip provenance={data.ai_evaluation.provenance} />
                  </div>
                  <p className="mt-1 text-xs">เปิดเผยหลังส่งคะแนน / Revealed after you submit</p>
                </AiOutput>
                <p className="mt-2 text-sm text-muted-foreground">คะแนนของคุณ / Yours: {composite != null ? composite.toFixed(1) : '—'}</p>
              </div>
              {/* Per-domain comparison: where you scored above/below the AI across the 7 PIS-7 axes. */}
              <div>
                <h3 className="font-sans text-sm font-medium mb-1">เทียบกับ AI รายหมวด PIS-7 / PIS-7 by domain — vs AI</h3>
                <Pis7Radar ai={data.ai_evaluation} human={scores} />
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{pis7Conclusion(data.ai_evaluation, scores)}</p>
              </div>
              {/* Peer calibration (toggle): your scores vs the average of the OTHER auditors who scored
                  this PLE. Shown once ≥1 other auditor has submitted (backend gates peer_avg/peer_n). */}
              {data.peer_avg && (data.peer_n ?? 0) >= 1 && (
                <div>
                  <h3 className="font-sans text-sm font-medium mb-1">{onePeer
                    ? 'เทียบกับผู้ประเมินอีกคน / vs the other auditor'
                    : <>เทียบกับค่าเฉลี่ยผู้ประเมินคนอื่น / vs Other auditors <span className="font-normal text-muted-foreground">· n={data.peer_n}</span></>}</h3>
                  <Pis7Radar peer={data.peer_avg} human={scores} peerLabel={onePeer ? 'อีกคน / Other' : undefined} />
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{pis7Conclusion(data.peer_avg, scores, onePeer ? { th: 'ผู้ประเมินอีกคน', en: 'the other auditor' } : { th: 'ค่าเฉลี่ยผู้ประเมิน', en: 'the auditor average' })}</p>
                </div>
              )}
              {/* Discuss the evaluation with an AI tutor — metered against the auditor's own pool. */}
              <AuditorChatBox pleId={id} />
            </div>
          )}
        </div>
      </div>

      {needsConsent && (
        <Modal title="ความยินยอมผู้เชี่ยวชาญประเมิน / Expert Auditor Consent" onClose={() => setNeedsConsent(false)}>
          <p className="text-sm text-muted-foreground">ก่อนให้คะแนน กรุณายืนยันข้อตกลงด้านความลับและผลประโยชน์ทับซ้อน (Appendix 04/15) / Before scoring, confirm the confidentiality + COI terms.</p>
          <label className="flex gap-2 text-sm"><Checkbox className="mt-0.5" checked={conf} onChange={e => setConf(e.target.checked)} /> รักษาความลับของ transcript คะแนน และข้อมูลวิจัย ไม่บันทึก/ดาวน์โหลด/ส่งต่อ / I will keep transcripts, scores, and research data confidential — no screenshots, downloads, or sharing.</label>
          <label className="flex gap-2 text-sm"><Checkbox className="mt-0.5" checked={calib} onChange={e => setCalib(e.target.checked)} /> เข้าใจ rubric/behavioral anchors และจะประเมินตามเกณฑ์มาตรฐานเดียวกัน / I understand the PIS-7 rubric/anchors and will score by the calibrated standard.</label>
          <label className="flex gap-2 text-sm"><Checkbox className="mt-0.5" checked={coiNone} onChange={e => setCoiNone(e.target.checked)} /> ไม่มีผลประโยชน์ทับซ้อนกับผู้เข้าร่วมวิจัยรายนี้ และจะแจ้งทันทีหากพบภายหลัง / I have no conflict of interest with this participant and will report any that arises.</label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setNeedsConsent(false)}>ยกเลิก / Cancel</Button>
            <Button disabled={!consentReady} onClick={recordConsent}>ยินยอมและส่งคะแนน / Consent &amp; submit</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
