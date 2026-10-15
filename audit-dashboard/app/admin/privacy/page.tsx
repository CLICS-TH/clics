'use client';
// The human half of the privacy gate (CREC082 ICF §5-6, Declaration "Privacy gate").
//
// The protocol promises a person reads every transcript before an expert rater sees it. That means
// the reviewer's job here is READING, not triaging a list — so the transcript opens inline rather
// than behind a link to another page, and the decision buttons sit under it. A queue that made it
// easy to clear a session without opening it would satisfy the schema and not the promise.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PageIntro } from '@/components/PageIntro';
import { TranscriptView } from '@/components/TranscriptView';
import { toast } from '@/components/Overlays';
import type { CleRow, ApiResult } from '@/lib/types';
import { ShieldCheck, EyeOff, Scissors, Ban, ChevronDown } from 'lucide-react';

type Decision = 'passed' | 'redacted' | 'quarantined' | 'excluded';
type Message = { role: string; content: string; refs?: { source: string; title?: string }[]; socratic_question?: string };

// Ordered least → most restrictive, which is the order a reviewer works through them.
const DECISIONS: { key: Decision; th: string; en: string; icon: typeof ShieldCheck; variant?: 'destructive' | 'outline'; needsNote: boolean }[] = [
  { key: 'passed',      th: 'ผ่าน',        en: 'Pass',       icon: ShieldCheck, needsNote: false },
  { key: 'redacted',    th: 'แก้ไขแล้ว',   en: 'Redacted',   icon: Scissors,    variant: 'outline', needsNote: true },
  { key: 'quarantined', th: 'กันออกไว้',   en: 'Quarantine', icon: EyeOff,      variant: 'outline', needsNote: true },
  { key: 'excluded',    th: 'ตัดออก',      en: 'Exclude',    icon: Ban,         variant: 'destructive', needsNote: true },
];

const FILTERS: { key: string; th: string; en: string }[] = [
  { key: 'pending',     th: 'รอตรวจ',      en: 'Pending' },
  { key: 'quarantined', th: 'กันออกไว้',   en: 'Quarantined' },
  { key: 'excluded',    th: 'ตัดออก',      en: 'Excluded' },
  { key: 'redacted',    th: 'แก้ไขแล้ว',   en: 'Redacted' },
  { key: 'passed',      th: 'ผ่านแล้ว',    en: 'Passed' },
];

export default function PrivacyReviewPage() {
  const [filter, setFilter] = useState('pending');
  const [ples, setPles] = useState<CleRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Message[] | null>(null);
  const [transcriptError, setTranscriptError] = useState(false);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);

  const fetchQueue = useCallback(() => {
    apiFetch<{ ples: CleRow[] }>(`/admin/privacy-queue?status=${filter}&limit=100`)
      .then(d => setPles(Array.isArray(d?.ples) ? d.ples : []))
      .catch(() => setErr(true));
  }, [filter]);
  const load = () => { setErr(false); fetchQueue(); };
  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  async function open(id: string) {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id); setTranscript(null); setTranscriptError(false); setNote('');
    try {
      const d = await apiFetch<{ messages: Message[] }>(`/admin/ples/${id}/transcript`);
      setTranscript(Array.isArray(d?.messages) ? d.messages : []);
    } catch {
      toast('โหลด transcript ไม่สำเร็จ / Could not load the transcript', 'error');
      setTranscriptError(true);
    }
  }

  async function decide(id: string, decision: Decision) {
    const spec = DECISIONS.find(d => d.key === decision)!;
    if (spec.needsNote && !note.trim()) {
      // Mirrors the server rule. A quarantine with no stated reason is unreviewable later, and the
      // ethics committee is entitled to ask why any given session was withheld.
      toast('กรุณาระบุเหตุผล / Please give a reason before this decision', 'error');
      return;
    }
    setActing(true);
    try {
      const res = await apiFetch<ApiResult<unknown>>(`/admin/ples/${id}/privacy-review`, {
        method: 'POST', body: JSON.stringify({ decision, note: note.trim() || undefined }),
      });
      if (res?.error) { toast(`ไม่สำเร็จ / Failed: ${String(res.error)}`, 'error'); return; }
      toast('บันทึกแล้ว / Recorded', 'success');
      setOpenId(null); setNote(''); load();
    } catch { toast('เกิดข้อผิดพลาด / Error saving the decision', 'error'); }
    finally { setActing(false); }
  }

  return (
    <div className="max-w-4xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Privacy review"
        title="ตรวจสอบความเป็นส่วนตัว"
        subtitle="Every transcript is read by a person before any rater sees it (CREC082 §5–6)"
      />

      <div className="flex flex-wrap gap-2 mb-5">
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => { setFilter(f.key); setOpenId(null); }}
            aria-pressed={filter === f.key}
            className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
              filter === f.key ? 'bg-coral-active text-primary-foreground border-coral-active' : 'text-muted-foreground hover:bg-secondary'}`}
          >
            {f.th} <span className="text-[length:max(0.84em,12px)] font-normal">/ {f.en}</span>
          </button>
        ))}
      </div>

      {err ? (
        <div className="text-center py-10">
          <p className="text-muted-foreground mb-3">โหลดคิวไม่สำเร็จ / Could not load the queue.</p>
          <button className="text-sm text-link underline" onClick={load}>ลองใหม่ / Retry</button>
        </div>
      ) : ples === null ? (
        <p className="text-muted-foreground text-center py-10">กำลังโหลด… / Loading…</p>
      ) : ples.length === 0 ? (
        <p className="text-muted-foreground text-center py-10">
          {filter === 'pending'
            ? 'ตรวจครบทุก session แล้ว / Every session has been reviewed.'
            : 'ไม่มี session ในสถานะนี้ / No sessions in this state.'}
        </p>
      ) : ples.map(p => (
        <div key={p.id} className="border rounded-xl p-5 mb-3">
          <button
            onClick={() => open(p.id)}
            aria-expanded={openId === p.id}
            className="flex w-full items-start justify-between gap-3 text-left"
          >
            <div className="min-w-0">
              <p className="font-semibold break-words">{p.ple_code ?? p.id.slice(0, 8)}</p>
              <p className="text-xs text-muted-foreground">
                {p.turn_count ?? 0} รอบ · {p.token_count ?? 0} tokens
                {p.is_test ? ' · TEST' : ''}
                {p.ended_at ? ` · ${new Date(p.ended_at).toLocaleDateString('th-TH')}` : ''}
              </p>
              {/* A rater's report is shown FIRST and marked as one. It is why this session is back in
                  the queue, and it is not the reviewer's note. */}
              {p.privacy_concern_open ? (
                <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="font-medium text-danger">ผู้ตรวจแจ้งข้อกังวล / Reported by a rater</span>
                  {p.privacy_concern_at ? (
                    <span className="text-muted-foreground">{new Date(p.privacy_concern_at).toLocaleDateString('th-TH')}</span>
                  ) : null}
                </p>
              ) : null}
              {p.privacy_concern_note ? (
                <p className="mt-1 text-xs text-muted-foreground italic break-words">“{p.privacy_concern_note}”</p>
              ) : null}
              {p.privacy_review_note ? (
                <p className="mt-1 text-xs text-muted-foreground italic break-words">“{p.privacy_review_note}”</p>
              ) : null}
            </div>
            <ChevronDown className={`size-5 shrink-0 text-muted-foreground transition-transform ${openId === p.id ? 'rotate-180' : ''}`} />
          </button>

          {openId === p.id && (
            <div className="mt-4">
              {transcriptError
                ? <p role="alert" className="text-danger text-sm py-6 text-center">โหลด transcript ไม่สำเร็จ กรุณาลองเปิดใหม่ / Could not load the transcript. Reopen to retry.</p>
                : transcript === null
                ? <p className="text-muted-foreground text-sm py-6 text-center">กำลังโหลด transcript… / Loading transcript…</p>
                : <TranscriptView messages={transcript} />}

              <label className="mt-4 block text-sm font-medium" htmlFor={`note-${p.id}`}>
                เหตุผล / Reason <span className="text-muted-foreground font-normal">— จำเป็นสำหรับทุกกรณีที่ไม่ใช่ &ldquo;ผ่าน&rdquo; / required for anything other than a pass</span>
              </label>
              <textarea
                id={`note-${p.id}`}
                value={note}
                onChange={e => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="เช่น พบเลข HN ในรอบที่ 3 / e.g. HN visible in turn 3"
                className="mt-1.5 w-full rounded-lg border bg-background p-2.5 text-sm"
              />

              <div className="mt-3 flex flex-wrap gap-2">
                {DECISIONS.map(d => (
                  <Button key={d.key} size="sm" variant={d.variant} disabled={acting || transcript === null || transcriptError}
                          onClick={() => decide(p.id, d.key)}>
                    <d.icon className="size-4" /> {d.th} <span className="text-[length:max(0.84em,12px)] font-normal">/ {d.en}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
