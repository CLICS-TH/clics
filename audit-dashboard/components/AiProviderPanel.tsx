'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

// Superadmin control for WHICH model serves each AI purpose — Claude in the cloud, or the on-prem
// model on the DGX. Reads and writes /admin/ai-providers; RIMPL layers those values over its env
// (app_settings.ai_provider_<purpose> → AI_PROVIDER_<PURPOSE> → AI_PROVIDER → 'anthropic'), so a
// cutover is a toggle here plus the next request — no redeploy, no restart.
//
// `evaluate` is deliberately in its own card. The other purposes are preferences; the evaluator is
// the measuring instrument that every PIS-7 score and the ICC ≥ 0.75 credit gate are defined
// against. Putting it in the same list as "which model writes the chat reply" would make the two
// look like the same kind of decision.

type Purpose = 'chat' | 'evaluate' | 'criteria' | 'discuss' | 'embed';
type Providers = Record<Purpose, string>;
type ApiShape = {
  providers: Providers;
  choices: Record<Purpose, string[]>;
  evaluator_locked_at: string | null;
  confirm_phrases: { change_evaluator: string; unlock_evaluator: string };
  error?: string;
  code?: string;
  confirm_phrase?: string;
};

// What each purpose actually is, in the operator's terms — not the internal key. Someone deciding
// whether to move a purpose on-prem needs to know what breaks if the box is slow, not what the
// route is called.
const PURPOSE_COPY: Record<Purpose, { th: string; en: string; note: string; icon: string }> = {
  chat: { th: 'บทสนทนากับแพทย์', en: 'Physician chat', icon: '💬',
    note: 'ตอบแพทย์ระหว่างทำ CLE — ผู้ใช้รู้สึกถึงความเร็วโดยตรง / Answers the physician during a CLE. Latency here is felt directly.' },
  criteria: { th: 'ตัวคัดกรอง C1–C6', en: 'C1–C6 screening', icon: '🔍',
    note: 'ตัดสินว่า CLE ผ่านเกณฑ์ขั้นต้นหรือไม่ / Decides whether a CLE clears the entry criteria.' },
  discuss: { th: 'ผู้ช่วยสอบเทียบผู้ตรวจ', en: 'Auditor calibration tutor', icon: '🎓',
    note: 'คุยกับผู้ตรวจหลังให้คะแนนแล้วเท่านั้น — ไม่แตะคะแนน / Talks to the auditor only after they have scored. Never touches a score.' },
  embed: { th: 'ค้นคืนเอกสารอ้างอิง (RAG)', en: 'Reference retrieval (RAG)', icon: '📚',
    note: 'ฝังข้อความเพื่อค้นคลังอ้างอิง — ต้องฝังคลังใหม่ก่อนย้ายผู้ให้บริการ / Embeds text to search the reference corpus. The corpus must be re-embedded before switching provider.' },
  evaluate: { th: 'ผู้ให้คะแนน PIS-7', en: 'PIS-7 evaluator', icon: '⚖️',
    note: 'เครื่องมือวัดของงานวิจัย — ICC ≥ 0.75 และหน่วยกิตอ้างอิงจากตัวนี้ / The study’s measuring instrument: ICC ≥ 0.75 and every credit decision are defined against it.' },
};

const PROVIDER_COPY: Record<string, { label: string; where: string }> = {
  anthropic: { label: 'Claude', where: 'คลาวด์ / cloud' },
  openai: { label: 'OpenAI', where: 'คลาวด์ / cloud' },
  local: { label: 'DGX ในองค์กร', where: 'on-premise' },
};

const OPERATIONAL: Purpose[] = ['chat', 'criteria', 'discuss', 'embed'];

export function AiProviderPanel() {
  const [data, setData] = useState<ApiShape | null>(null);
  const [saving, setSaving] = useState<Purpose | 'lock' | null>(null);
  const [err, setErr] = useState('');
  // The purpose whose change is waiting on a typed confirmation, plus what it is waiting to become.
  const [pending, setPending] = useState<{ purpose: Purpose; provider: string; phrase: string } | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    apiFetch<ApiShape>('/admin/ai-providers')
      .then(d => { if (d && d.providers) setData(d); else setErr(d?.error || 'โหลดค่าไม่สำเร็จ / Could not load provider settings.'); })
      .catch(() => setErr('โหลดค่าไม่สำเร็จ / Could not load provider settings.'));
  }, []);

  const locked = !!data?.evaluator_locked_at;

  async function send(body: Record<string, unknown>, busy: Purpose | 'lock') {
    setSaving(busy); setErr('');
    const next = await apiFetch<ApiShape>('/admin/ai-providers', { method: 'PATCH', body: JSON.stringify(body) });
    setSaving(null);
    if (next?.providers) { setData(next); setPending(null); setTyped(''); return true; }
    setErr(next?.error || 'บันทึกไม่สำเร็จ / Could not save.');
    return false;
  }

  function choose(purpose: Purpose, provider: string) {
    if (!data || provider === data.providers[purpose]) return;
    if (purpose === 'evaluate') {
      if (locked) return;                                   // the button is disabled; belt and braces
      setErr('');
      setPending({ purpose, provider, phrase: data.confirm_phrases.change_evaluator });
      setTyped('');
      return;
    }
    void send({ purpose, provider }, purpose);
  }

  const rows = (purposes: Purpose[], disabled: boolean) => purposes.map(p => {
    const current = data!.providers[p];
    return (
      <div key={p} className="flex flex-wrap items-center justify-between gap-3 border-t py-4 first:border-t-0 first:pt-0">
        <div className="min-w-0 flex-1 pr-2">
          <p className="text-sm font-medium">
            {PURPOSE_COPY[p].icon} {PURPOSE_COPY[p].th}
            <span className="ml-1 text-[0.8em] font-normal opacity-[0.85]">{PURPOSE_COPY[p].en}</span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{PURPOSE_COPY[p].note}</p>
        </div>
        <div role="radiogroup" aria-label={`${PURPOSE_COPY[p].en} provider`}
          className="inline-flex shrink-0 overflow-hidden rounded-lg border">
          {data!.choices[p].map(name => {
            const on = name === current;
            return (
              <button
                key={name}
                role="radio"
                aria-checked={on}
                disabled={disabled || saving === p}
                onClick={() => choose(p, name)}
                title={`${PROVIDER_COPY[name]?.label ?? name} — ${PROVIDER_COPY[name]?.where ?? name}`}
                // Selected state is a TINT + an inset ring, not solid --primary. White on #cc785c
                // measures 3.28:1, which fails WCAG body text at this 13px size (the large-text
                // exemption starts at 18.66px bold). The tint keeps --foreground on the label at
                // ~16:1 while the ring carries the selection just as unambiguously.
                className={`px-3 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60
                  ${on
                    ? 'bg-primary/15 font-semibold text-foreground ring-2 ring-inset ring-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
              >
                {PROVIDER_COPY[name]?.label ?? name}
                {/* No opacity on this: dimming 13px text pushed it to ~3.5:1. Where the data goes
                    is the single most important thing on this control — it does not get faded. */}
                <span className="ml-1">· {PROVIDER_COPY[name]?.where ?? ''}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  });

  return (
    <section className="space-y-3">
      <h2 className="font-heading text-xl text-foreground">ผู้ให้บริการ AI / AI provider</h2>

      {err && (
        <p role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-foreground">
          {err}
        </p>
      )}

      {!data ? (
        <div className="h-40 w-full animate-pulse rounded-xl bg-muted" />
      ) : (
        <>
          <div className="rounded-xl border p-5">
            <p className="mb-1 text-sm font-medium">งานทั่วไป / Operational purposes</p>
            <p className="mb-3 text-xs text-muted-foreground">
              ย้ายไป–กลับได้ตลอด มีผลกับคำขอถัดไปทันที ไม่ต้อง deploy ใหม่ •
              Switch freely; the change takes effect on the next request, with no redeploy.
            </p>
            {rows(OPERATIONAL, false)}
          </div>

          {/* The evaluator: same control, deliberately different framing and different guards. */}
          <div className="rounded-xl border-2 border-primary/30 p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">เครื่องมือวัด / Measuring instrument</p>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${locked ? 'bg-primary/20 text-foreground ring-1 ring-primary' : 'bg-muted text-foreground'}`}>
                {locked ? '🔒 ล็อกแล้ว / locked' : '🔓 ยังไม่ล็อก / unlocked'}
              </span>
            </div>

            {rows(['evaluate'], locked)}

            {locked ? (
              <div className="mt-3 border-l-4 border-l-chart-warn bg-muted px-4 py-3">
                <p className="text-sm text-foreground">
                  ล็อกไว้ตั้งแต่ <span className="font-mono">{new Date(data.evaluator_locked_at!).toLocaleString('th-TH')}</span> —
                  เปลี่ยนผู้ให้คะแนนระหว่าง pilot ไม่ได้ เพราะคะแนนทั้งหมดและเกณฑ์ ICC อ้างอิงจากโมเดลตัวนี้
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Locked — the PIS-7 evaluator cannot change while the pilot runs. Every score and the ICC credit
                  gate are defined against this model, so swapping it mid-cohort would confound the outcome with
                  the instrument.
                </p>
                <button
                  onClick={() => setPending({ purpose: 'evaluate', provider: '', phrase: data.confirm_phrases.unlock_evaluator })}
                  disabled={saving === 'lock'}
                  className="mt-3 rounded-lg border px-3 py-1.5 text-xs text-foreground hover:bg-background disabled:opacity-50"
                >
                  ปลดล็อก / Unlock…
                </button>
              </div>
            ) : (
              <button
                onClick={() => send({ evaluator_locked: true }, 'lock')}
                disabled={saving === 'lock'}
                className="mt-3 rounded-lg border-2 border-primary bg-primary/15 px-3 py-2 text-xs font-semibold text-foreground hover:bg-primary/25 disabled:opacity-50"
              >
                🔒 ล็อกผู้ให้คะแนนสำหรับ pilot / Lock the evaluator for the pilot
              </button>
            )}
          </div>
        </>
      )}

      {/* Typed confirmation. Not theatre — a checkbox is too easy to hit on the way somewhere else,
          and both of these actions change what the study is measuring with. */}
      {pending && data && (
        <div className="rounded-xl border-2 border-destructive/50 p-5">
          <p className="text-sm font-medium text-foreground">
            {pending.provider
              ? `เปลี่ยนผู้ให้คะแนน PIS-7 เป็น ${PROVIDER_COPY[pending.provider]?.label ?? pending.provider}?`
              : 'ปลดล็อกผู้ให้คะแนน PIS-7?'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {pending.provider
              ? 'คะแนนที่ให้หลังจากนี้จะมาจากโมเดลคนละตัวกับคะแนนก่อนหน้า และค่า ICC จะเทียบข้ามเครื่องมือ · Scores produced after this come from a different model than the ones before it, and the ICC would then compare across two instruments.'
              : 'การปลดล็อกทำให้เปลี่ยนเครื่องมือวัดระหว่าง pilot ได้ · Unlocking makes it possible to change the measuring instrument mid-pilot.'}
          </p>
          <label className="mt-3 block text-xs text-muted-foreground" htmlFor="ai-provider-confirm">
            พิมพ์ <span className="font-mono font-semibold text-foreground">{pending.phrase}</span> เพื่อยืนยัน / Type it to confirm
          </label>
          <input
            id="ai-provider-confirm"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            autoComplete="off"
            className="mt-1 w-full max-w-xs rounded-lg border bg-background px-3 py-2 font-mono text-sm text-foreground"
          />
          <div className="mt-3 flex gap-2">
            <button
              disabled={typed !== pending.phrase || saving !== null}
              onClick={() => send(
                pending.provider
                  ? { purpose: pending.purpose, provider: pending.provider, confirm: typed }
                  : { evaluator_locked: false, confirm: typed },
                pending.provider ? pending.purpose : 'lock',
              )}
              className="rounded-lg bg-destructive px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              ยืนยัน / Confirm
            </button>
            <button
              onClick={() => { setPending(null); setTyped(''); setErr(''); }}
              className="rounded-lg border px-3 py-2 text-xs text-foreground hover:bg-muted"
            >
              ยกเลิก / Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
