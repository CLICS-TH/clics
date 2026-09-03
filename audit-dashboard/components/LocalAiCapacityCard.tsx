'use client';
// Superadmin card for the on-prem evaluator's capacity settings plus a read-only glance at the
// evaluation queue. Sits on /admin/overview under "Capacity & budget", beside the $ pool.
//
// WHAT IT CONTROLS. The local model is priced at $0, so the $ ceilings never throttle it; tokens are
// the honest unit (the two ceilings). A transcript that outgrows the served context cannot be scored
// at all (the cap + warn %). The DGX serves ~2 evaluations at once and takes ~70 s each, so a burst of
// submissions must queue (the drain concurrency + the p50 behind the ETA). And while a laptop stack
// scores one council on the local model, this backend must leave that council's queue alone (the
// exclude-councils partition).
//
// HOW IT SAVES. Each field PATCHes /admin/usage-settings on its own — the endpoint the toggles on the
// same page use — with the backend's zod bounds mirrored here so a typo is refused before it travels.
// The PATCH response echoes only the ORIGINAL ten settings (superadmin.js re-reads those keys, not
// these), so after a save the card re-reads GET /admin/usage-settings and hands the fresh object up via
// onChange. That also shows what the server actually stored (council codes come back upper-cased)
// rather than the operator's raw draft.
//
// Drafts are a sparse map keyed by field: an input shows the draft if the operator has typed, else the
// server value. No effect seeds inputs when `usage` arrives, and a saved field simply drops its draft.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { BiLabel } from '@/components/BiLabel';
import { Skeleton } from '@/components/Skeleton';
import { fmtTokens } from '@/lib/labels';
import { type ApiResult, type EvalQueueStatus, type HealthDeep, type UsageSettings, formatApiError } from '@/lib/types';

type NumericKey =
  | 'standard_limit_tokens' | 'auditor_standard_limit_tokens'
  | 'ple_max_transcript_tokens' | 'ple_transcript_warn_pct'
  | 'eval_drain_concurrency' | 'eval_p50_seconds';
type FieldKey = NumericKey | 'eval_drain_exclude_councils';
const CODES_KEY: FieldKey = 'eval_drain_exclude_councils';

// Bounds mirror UsageSettingsSchema in backend/src/routes/superadmin.js. `noCap` fields read 0 as
// "no ceiling" (usage.js standardTokenLimit), so the current value is shown in words, not as 0.
const NUMERIC: { key: NumericKey; th: string; en: string; min: number; max: number; noCap?: boolean; note: string }[] = [
  { key: 'standard_limit_tokens', th: 'เพดานโทเคนต่อแพทย์', en: 'Physician token ceiling', min: 0, max: 50_000_000, noCap: true,
    note: 'ใช้กับแพทย์ทุกคนที่ไม่มีค่าเฉพาะราย · 0 = ไม่จำกัด / Applies to every physician without a per-user override · 0 = no cap.' },
  { key: 'auditor_standard_limit_tokens', th: 'เพดานโทเคนต่อผู้ตรวจ', en: 'Auditor token ceiling', min: 0, max: 50_000_000, noCap: true,
    note: 'พูลผู้ตรวจแยกต่างหาก · 0 = ไม่จำกัด / The separate auditor pool · 0 = no cap.' },
  { key: 'ple_max_transcript_tokens', th: 'ขนาดบทสนทนาสูงสุด (โทเคน)', en: 'Transcript cap (tokens)', min: 8000, max: 200_000,
    note: 'บริบทสูงสุดที่ PLE หนึ่งไปถึงได้ก่อนต้องจบเซสชัน (8,000–200,000) / The largest context a PLE may reach before it must end (8,000–200,000).' },
  { key: 'ple_transcript_warn_pct', th: 'เตือนเมื่อถึง (% ของขนาดสูงสุด)', en: 'Warn at (% of cap)', min: 50, max: 95,
    note: 'พอร์ทัลแจ้งเตือนแพทย์เมื่อบทสนทนาถึงสัดส่วนนี้ (50–95) / The portal warns the physician at this share of the cap (50–95).' },
  { key: 'eval_drain_concurrency', th: 'ให้คะแนนพร้อมกันสูงสุด', en: 'Drain concurrency', min: 1, max: 8,
    note: 'จำนวน PLE ที่ backend นี้ส่งให้โมเดลประเมินพร้อมกัน (1–8) — DGX รับได้ราว 2 / Evaluations this backend keeps in flight at once (1–8); the DGX serves about 2.' },
  { key: 'eval_p50_seconds', th: 'เวลาให้คะแนนกลาง p50 (วินาที)', en: 'Eval p50 (seconds)', min: 10, max: 1800,
    note: 'ใช้คำนวณเวลารอโดยประมาณของคิว (10–1800) / Used for the queue’s estimated wait (10–1800).' },
];

// Same character class the backend regex accepts; the normalisation matches its upper-case/trim step.
const CODES_RE = /^[A-Za-z0-9_,\s-]*$/;
const normaliseCodes = (raw: string) => raw.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean).join(',');

const num = (v: number | undefined) => (v == null || !Number.isFinite(v) ? '—' : String(v));
// m:ss — the oldest unclaimed evaluation's wait. Minutes are not wrapped into hours on purpose: a
// queue that has waited 75:00 should look like the outage it is, not like "1:15".
const fmtWait = (s: number | undefined) => {
  if (s == null || !Number.isFinite(s)) return '—';
  const total = Math.max(0, Math.round(s));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function SaveButton({ th, en, busy, disabled, onClick }: { th: string; en: string; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`บันทึก ${th} / Save ${en}`}
      className="shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50"
    >
      {busy ? 'กำลังบันทึก… / Saving…' : 'บันทึก / Save'}
    </button>
  );
}

// Read-only glance at the evaluation queue, from the public /health/deep probe on the same API base.
// apiFetch parses the JSON even on the 503 the probe returns when degraded, and resolves an {error}
// envelope (no `checks`) on a network failure; a rejection is caught too, though the contract says it
// cannot happen. Fail-soft throughout: whatever is missing renders as "—", never as a crash.
// aria-busy stays true until the first read settles (success or not), so a reader — or a test — can
// tell "not read yet" from "read, and there is nothing there".
function QueueNow() {
  // undefined = not read yet, null = the probe was unreachable or had no eval_queue block.
  const [queue, setQueue] = useState<EvalQueueStatus | null | undefined>(undefined);
  const [queueAt, setQueueAt] = useState('');

  // Promise-chain form on purpose: react-hooks/set-state-in-effect does not treat `await` as deferring,
  // so an async function that sets state after awaiting is flagged when an effect calls it; setState
  // inside .then callbacks is the shape the rule (and the rest of the dashboard) accepts.
  const loadQueue = useCallback(() => apiFetch<HealthDeep>('/health/deep')
    .then(
      (d): EvalQueueStatus | null => {
        const eq = d && typeof d === 'object' && d.checks && typeof d.checks === 'object' ? d.checks.eval_queue : undefined;
        return eq && typeof eq === 'object' ? eq : null;
      },
      // A rejection. apiFetch resolves envelopes by contract, but the row must not depend on that.
      (): EvalQueueStatus | null => null,
    )
    .then((q) => {
      setQueue(q);
      setQueueAt(new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    }), []);
  useEffect(() => { void loadQueue(); }, [loadQueue]);

  const running = queue?.drain?.running;
  const lastError = queue?.drain?.last_error || queue?.error || null;
  // One unrecognised council code in the exclude field above resolves the drain's scope to nothing.
  // Every evaluation then stops while the drain still reports itself as running and raises no error
  // — the failure is invisible unless this row says so. It gets its own full-width line.
  const failedClosed = queue?.drain?.scope?.failed_closed || null;
  const stuck = queue?.stuck === true;

  return (
    <div
      role="group"
      aria-label="คิวตอนนี้ / Queue now"
      aria-busy={queue === undefined}
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t pt-3 text-xs tabular-nums"
    >
      <span className="font-medium text-foreground"><BiLabel th="คิวตอนนี้" en="Queue now" /></span>
      <span className="text-muted-foreground">รอคิว / queued <span className="text-foreground">{num(queue?.queued)}</span></span>
      <span className="text-muted-foreground">กำลังให้คะแนน / scoring <span className="text-foreground">{num(queue?.scoring)}</span></span>
      <span className="text-muted-foreground">รอนานสุด / oldest wait <span className="text-foreground">{fmtWait(queue?.oldest_wait_s)}</span></span>
      <span className="text-muted-foreground">
        drain{' '}
        <span className={running === true ? 'text-ok' : running === false ? 'text-danger' : 'text-foreground'}>
          {running == null ? '—' : running ? 'ทำงาน / running' : 'หยุด / stopped'}
        </span>
      </span>
      {lastError && <span className="break-all text-danger">ข้อผิดพลาดล่าสุด / last error: {lastError}</span>}
      {queue === null && <span className="text-muted-foreground">อ่านสถานะคิวไม่ได้ / queue status unavailable</span>}
      {failedClosed && (
        <p role="alert" className="w-full text-sm font-medium text-danger">
          ขอบเขตสภาไม่ตรงกับสภาใด — ไม่มีการให้คะแนนเลย ตรวจรหัสสภาในช่องด้านบน
          {' · '}
          Council scope matched nothing — no session is being scored. Check the codes above.
          {' ('}<span className="break-all font-mono">{failedClosed}</span>{')'}
        </p>
      )}
      {stuck && !failedClosed && (
        <p role="alert" className="w-full text-sm font-medium text-danger">
          มีงานจริงค้างคิวเกินเวลาที่กำหนด — ตรวจว่า drain ทำงานอยู่หรือไม่
          {' · '}
          Real work has waited past the grace period. Check that the drain is running.
        </p>
      )}
      <button
        type="button"
        onClick={() => void loadQueue()}
        className="ml-auto rounded-md border px-2 py-1 text-xs text-foreground hover:bg-secondary"
      >
        รีเฟรช / Refresh{queueAt && <span className="ml-1 text-muted-foreground">· {queueAt}</span>}
      </button>
    </div>
  );
}

export function LocalAiCapacityCard({ usage, onChange }: { usage: UsageSettings | null; onChange: (next: UsageSettings) => void }) {
  const [drafts, setDrafts] = useState<Partial<Record<FieldKey, string>>>({});
  const [saving, setSaving] = useState<FieldKey | null>(null);
  const [savedKey, setSavedKey] = useState<FieldKey | null>(null);
  const [err, setErr] = useState('');

  const serverValue = (current: UsageSettings, key: FieldKey): string => {
    const v = current[key];
    return v == null ? '' : String(v);
  };
  const edit = (key: FieldKey, v: string) => { setDrafts((d) => ({ ...d, [key]: v })); setSavedKey(null); };

  // `current` is the loaded settings object — the fields (and so their Save buttons) only exist once
  // it does, which is why this takes it as an argument instead of re-checking the prop for null.
  async function save(current: UsageSettings, key: FieldKey) {
    setErr(''); setSavedKey(null);
    // No draft = the operator pressed Save without typing: re-send the value on screen as-is.
    const raw = (drafts[key] ?? serverValue(current, key)).trim();
    let value: number | string;
    if (key === CODES_KEY) {
      if (raw.length > 200 || !CODES_RE.test(raw)) {
        setErr('รหัสสภาไม่ถูกต้อง — ใช้ A–Z, 0–9, _ หรือ - คั่นด้วยจุลภาค / Invalid council codes — use A–Z, 0–9, _ or -, comma-separated.');
        return;
      }
      value = normaliseCodes(raw);
    } else {
      const f = NUMERIC.find((x) => x.key === key)!;
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < f.min || n > f.max) {
        setErr(`${f.th} ต้องเป็นจำนวนเต็ม ${fmtTokens(f.min)}–${fmtTokens(f.max)} / ${f.en} must be a whole number from ${fmtTokens(f.min)} to ${fmtTokens(f.max)}.`);
        return;
      }
      value = n;
    }
    setSaving(key);
    const res = await apiFetch<ApiResult<UsageSettings>>('/admin/usage-settings', { method: 'PATCH', body: JSON.stringify({ [key]: value }) });
    if (!res || res.error) {
      setErr(formatApiError(res?.error, 'บันทึกไม่สำเร็จ / Could not save.'));
      setSaving(null);
      return;
    }
    // The PATCH echo does not carry these keys — re-read so the card shows what was actually stored.
    const fresh = await apiFetch<ApiResult<UsageSettings>>('/admin/usage-settings');
    onChange(fresh && !fresh.error ? (fresh as UsageSettings) : { ...current, [key]: value });
    setDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
    setSavedKey(key);
    setSaving(null);
  }

  const renderFields = (current: UsageSettings) => {
    const shown = (key: FieldKey) => drafts[key] ?? serverValue(current, key);
    return (
      <>
        <div className="grid grid-cols-1 gap-4 @min-[640px]:grid-cols-2">
          {NUMERIC.map((f) => {
            const value = current[f.key];
            const currentText = f.noCap && (value == null || Number(value) <= 0) ? 'ไม่จำกัด / no cap' : fmtTokens(value);
            const id = `lac-${f.key}`;
            return (
              <div key={f.key} className="rounded-lg border border-border p-3">
                <label htmlFor={id} className="block text-sm font-medium"><BiLabel th={f.th} en={f.en} /></label>
                <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  ปัจจุบัน / Current: <span className="text-foreground">{currentText}</span>
                  {savedKey === f.key && <span className="ml-2 text-ok">บันทึกแล้ว / Saved</span>}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={f.min}
                    max={f.max}
                    step={1}
                    className="w-full min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums"
                    value={shown(f.key)}
                    onChange={(e) => edit(f.key, e.target.value)}
                  />
                  <SaveButton th={f.th} en={f.en} busy={saving === f.key} disabled={saving !== null} onClick={() => void save(current, f.key)} />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">{f.note}</p>
              </div>
            );
          })}

          {/* Council-code partition — full width, since the explanation is the important part. */}
          <div className="rounded-lg border border-border p-3 @min-[640px]:col-span-2">
            <label htmlFor="lac-eval_drain_exclude_councils" className="block text-sm font-medium">
              <BiLabel th="สภาที่ยกเว้นจากคิวให้คะแนน (รหัส)" en="Exclude councils from the drain (codes)" />
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              ปัจจุบัน / Current: <span className="font-mono text-foreground">{current.eval_drain_exclude_councils || 'ไม่มี / none'}</span>
              {savedKey === CODES_KEY && <span className="ml-2 text-ok">บันทึกแล้ว / Saved</span>}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                id="lac-eval_drain_exclude_councils"
                type="text"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={200}
                placeholder="เช่น SANDBOX / e.g. SANDBOX"
                className="w-full min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 font-mono text-sm uppercase"
                value={shown(CODES_KEY)}
                onChange={(e) => edit(CODES_KEY, e.target.value)}
              />
              <SaveButton th="สภาที่ยกเว้น" en="Exclude councils" busy={saving === CODES_KEY} disabled={saving !== null} onClick={() => void save(current, CODES_KEY)} />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              รหัสสภาตัวพิมพ์ใหญ่ คั่นด้วยจุลภาค — นี่คือพาร์ติชันสำหรับ sandbox smoke: backend นี้จะไม่ดึง PLE ของสภาเหล่านี้ไปให้คะแนน
              ปล่อยให้เครื่องที่รันโมเดลภายในเป็นผู้ให้คะแนนแทน เว้นว่างเพื่อกลับมารวมทุกสภา •
              Upper-case council codes, comma-separated. This is the sandbox-smoke partition: this backend leaves those councils’
              queued evaluations alone so a laptop stack scoring on the local model can take them. Clear it to include every council again.
            </p>
          </div>
        </div>
        <QueueNow />
      </>
    );
  };

  return (
    <section className="space-y-3">
      <h2 className="font-heading text-xl text-foreground">ความจุ AI ภายใน / Local AI capacity</h2>
      <div className="space-y-4 rounded-xl border p-5">
        <p className="text-xs text-muted-foreground">
          เพดานโทเคน ขนาดบทสนทนา และคิวการให้คะแนนของโมเดลในองค์กร — โมเดลภายในคิดราคา $0 จึงใช้โทเคนเป็นหน่วยจำกัดแทนเงิน •
          Token ceilings, the transcript cap and the scoring queue for the on-prem model. The local model is priced at $0,
          so tokens — not dollars — are the unit that throttles it.
        </p>

        {err && (
          <p role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-foreground">
            {err}
          </p>
        )}

        {usage ? renderFields(usage) : <Skeleton className="h-40 w-full" />}
      </div>
    </section>
  );
}
