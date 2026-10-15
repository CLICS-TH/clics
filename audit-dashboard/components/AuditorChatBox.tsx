'use client';
// Auditor AI discussion chat — appears on the post-submit reveal pane. The auditor asks an AI
// calibration tutor about the evaluation (why the AI scored a domain a certain way, where they
// diverge). Metered against the auditor's SEPARATE budget pool (POST /auditor/ples/:id/discuss).
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, REQUEST_TIMEOUT_CODE } from '@/lib/api';
import { Markdown } from './Markdown';
import { Button } from './ui/button';
import { Textarea } from './ui/input';
import { AiOutput } from './ui/ai-output';
import { StateMessage } from './ui/state-message';
import { AuditorUsageBar } from './AuditorUsageBar';
import type { ApiResult } from '@/lib/types';

type Msg = { role: string; content: string };

// The backend gives rimpl up to RIMPL_CHAT_TIMEOUT_MS (default 100000ms,
// backend/src/services/rimpl-client.js) for /audit-discuss; rimpl's own provider limit is longer
// (150s). This client timeout MUST stay above RIMPL_CHAT_TIMEOUT_MS, or the page gives up on a call
// the backend is still allowed to finish and store. If that env var is raised, raise this too.
// 130s also matches the physician portal's client limit.
export const DISCUSS_TIMEOUT_MS = 130_000;
// Within this many px of the bottom counts as "reading the latest message".
const NEAR_BOTTOM_PX = 80;

const TIMEOUT_MSG =
  'ใช้เวลานานเกินไป คำถามของคุณอาจถูกบันทึกไว้แล้ว รีเฟรชหน้าเพื่อดูการสนทนาล่าสุดก่อนส่งซ้ำ / '
  + 'This is taking too long. Your question may already have been saved — reload the page to see the latest discussion before sending again.';
const SEND_FAILED_MSG = 'ส่งไม่สำเร็จ กรุณาลองใหม่ / Could not send. Please try again.';

// Smooth scrolling is motion: honour the OS reduced-motion setting.
function scrollBehavior(): ScrollBehavior {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  } catch {
    return 'auto';
  }
}

export function AuditorChatBox({ pleId }: { pleId: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  // A failed history load must not read as "no discussion yet" (apiFetch never rejects: a failure is a
  // non-array {error} body).
  const [loadErr, setLoadErr] = useState(false);
  const [usageVersion, setUsageVersion] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Whether the reader is at the bottom. A reader who scrolled up to re-read an earlier answer must not
  // be yanked down when a new message lands.
  const follow = useRef(true);

  const loadDiscussion = useCallback(() => {
    apiFetch<Msg[]>(`/auditor/ples/${pleId}/discussion`)
      .then(d => { if (Array.isArray(d)) setMsgs(d); else setLoadErr(true); })
      .catch(() => setLoadErr(true));
  }, [pleId]);
  useEffect(() => { loadDiscussion(); }, [loadDiscussion]);
  // Retry is a user event, so resetting the error here is not a setState-in-effect.
  const retryLoad = () => { setLoadErr(false); loadDiscussion(); };
  // Scrolls the LIST only (scrollIntoView on a sentinel also scrolled the whole page).
  useEffect(() => {
    const el = listRef.current;
    if (!el || !follow.current) return;
    el.scrollTo?.({ top: el.scrollHeight, behavior: scrollBehavior() });
  }, [msgs.length, sending]);
  function onListScroll() {
    const el = listRef.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setErr(''); setSending(true);
    follow.current = true; // the auditor's own message always comes into view
    setMsgs(m => [...m, { role: 'auditor', content: text }]); // optimistic
    setInput('');
    try {
      const res = await apiFetch<ApiResult<{ content: string }>>(`/auditor/ples/${pleId}/discuss`, {
        method: 'POST', body: JSON.stringify({ message: text }), timeoutMs: DISCUSS_TIMEOUT_MS,
      });
      const content = (res as { content?: string })?.content;
      if (content && !(res as { error?: unknown })?.error) {
        setMsgs(m => [...m, { role: 'assistant', content }]);
        setUsageVersion(v => v + 1); // refresh the usage bar
      } else {
        // Retract the optimistic message (the turn wasn't saved) and restore the text so they can retry.
        setMsgs(m => m.slice(0, -1));
        setInput(text);
        const code = (res as { code?: string })?.code;
        // A timeout is NOT "not sent": the server may finish and store the exchange after we gave up.
        // The text is put back so nothing is lost, but nothing is re-sent for the auditor.
        setErr(code === 'budget_exceeded'
          ? 'ใช้โควตา AI ครบแล้ว — ติดต่อผู้ดูแลระบบ / AI allowance used up — contact an administrator.'
          : code === REQUEST_TIMEOUT_CODE ? TIMEOUT_MSG : SEND_FAILED_MSG);
      }
    } catch {
      setMsgs(m => m.slice(0, -1));
      setInput(text);
      setErr(SEND_FAILED_MSG);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <h3 className="text-base font-medium">พูดคุยกับ AI เกี่ยวกับผลการประเมิน / Discuss this evaluation with AI</h3>
      <AuditorUsageBar version={usageVersion} />
      <div ref={listRef} onScroll={onListScroll} className="h-[32rem] max-h-[70vh] overflow-y-auto space-y-3 rounded-lg border bg-background p-3">
        {loadErr && (
          <StateMessage kind="error" className="px-3 py-2 text-sm" onRetry={retryLoad}
            title="โหลดการสนทนาก่อนหน้าไม่สำเร็จ / Could not load the earlier discussion." />
        )}
        {!loadErr && msgs.length === 0 && (
          <StateMessage kind="empty" className="py-0 text-xs"
            title={<>ถามได้ เช่น “ทำไม AI ให้คะแนนหมวด Critical Appraisal สูงกว่าฉัน?” / Ask e.g. &ldquo;Why did the AI score Critical Appraisal higher than I did?&rdquo;</>} />
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'auditor' ? 'text-right' : ''}>
            {m.role === 'auditor'
              // The auditor's own words: human = coral tint, no AI chrome.
              ? <div className="inline-block max-w-[85%] rounded-lg bg-primary/10 px-3 py-2 text-left">
                  <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                </div>
              : <AiOutput variant="bubble" className="inline-block max-w-[85%] text-left"><Markdown>{m.content}</Markdown></AiOutput>}
          </div>
        ))}
        {sending && <StateMessage kind="loading" className="py-0 text-xs" title="กำลังคิด… / Thinking…" />}
      </div>
      {err && <StateMessage kind="error" className="px-3 py-2 text-sm" title={err} />}
      <div className="flex gap-2">
        <Textarea className="flex-1" rows={3} aria-label="คำถามถึง AI / Your question for the AI"
          placeholder="พิมพ์คำถาม… / Type your question…" value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            // Enter that CONFIRMS an IME candidate (Thai, Japanese, …) must not send: isComposing is the
            // standard flag, keyCode 229 covers browsers that fire the keydown after composition ends.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          disabled={sending} />
        <Button onClick={send} disabled={sending || !input.trim()} className="self-end">ส่ง / Send</Button>
      </div>
    </div>
  );
}
