'use client';
// Auditor AI discussion chat — appears on the post-submit reveal pane. The auditor asks an AI
// calibration tutor about the evaluation (why the AI scored a domain a certain way, where they
// diverge). Metered against the auditor's SEPARATE budget pool (POST /auditor/cles/:id/discuss).
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Markdown } from './Markdown';
import { Button } from './ui/button';
import { AuditorUsageBar } from './AuditorUsageBar';
import type { ApiResult } from '@/lib/types';

type Msg = { role: string; content: string };

export function AuditorChatBox({ cleId }: { cleId: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const [usageVersion, setUsageVersion] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiFetch<Msg[]>(`/auditor/cles/${cleId}/discussion`).then(d => setMsgs(Array.isArray(d) ? d : [])).catch(() => {});
  }, [cleId]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs.length, sending]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setErr(''); setSending(true);
    setMsgs(m => [...m, { role: 'auditor', content: text }]); // optimistic
    setInput('');
    try {
      const res = await apiFetch<ApiResult<{ content: string }>>(`/auditor/cles/${cleId}/discuss`, {
        method: 'POST', body: JSON.stringify({ message: text }),
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
        setErr(code === 'budget_exceeded'
          ? 'ใช้โควตา AI ครบแล้ว — ติดต่อผู้ดูแลระบบ / AI allowance used up — contact an administrator.'
          : 'ส่งไม่สำเร็จ กรุณาลองใหม่ / Could not send. Please try again.');
      }
    } catch {
      setMsgs(m => m.slice(0, -1));
      setInput(text);
      setErr('ส่งไม่สำเร็จ กรุณาลองใหม่ / Could not send. Please try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">พูดคุยกับ AI เกี่ยวกับผลการประเมิน / Discuss this evaluation with AI</h3>
      <AuditorUsageBar version={usageVersion} />
      <div className="h-[32rem] max-h-[70vh] overflow-y-auto space-y-3 rounded-lg border bg-background p-3">
        {msgs.length === 0 && (
          <p className="text-xs text-muted-foreground">
            ถามได้ เช่น “ทำไม AI ให้คะแนนหมวด Critical Appraisal สูงกว่าฉัน?” / Ask e.g. &ldquo;Why did the AI score Critical Appraisal higher than I did?&rdquo;
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'auditor' ? 'text-right' : ''}>
            <div className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-left ${m.role === 'auditor' ? 'bg-primary/10' : 'bg-secondary'}`}>
              {m.role === 'auditor' ? <p className="text-sm whitespace-pre-wrap">{m.content}</p> : <Markdown>{m.content}</Markdown>}
            </div>
          </div>
        ))}
        {sending && <p className="text-xs text-muted-foreground">กำลังคิด… / Thinking…</p>}
        <div ref={endRef} />
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex gap-2">
        <textarea className="flex-1 border rounded-lg p-2 text-sm" rows={3}
          placeholder="พิมพ์คำถาม… / Type your question…" value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={sending} />
        <Button onClick={send} disabled={sending || !input.trim()} className="self-end">ส่ง / Send</Button>
      </div>
    </div>
  );
}
