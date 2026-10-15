'use client';
// The Primary Evaluator Model Lock — freezing the configuration every score is measured against.
//
// Scores already carry a configuration fingerprint. What this screen collects is the DECLARATION:
// the parts a running system cannot read for itself. A weights checksum is not obtainable over an
// inference API; neither is the container image, the library set, or the quantization the operator
// chose. Those have to be stated by a person with access to the machine, and until they are, the
// lock is an assertion rather than a checkable fact.
//
// The form is CLOSED until the candidate has cleared the decisive threshold, and stays closed on
// `insufficient` as well as on `fail` — freezing against a number the data cannot support is exactly
// the failure the third state exists to prevent. Not knowing is not permission.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { PageIntro } from '@/components/PageIntro';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/Overlays';
import type { ApiResult, IccVerdict } from '@/lib/types';
import { Lock, ShieldCheck, HelpCircle } from 'lucide-react';

interface LockRecord {
  locked_at: string; locked_by?: string | null;
  provider?: string | null; model_version?: string | null;
  weights_sha256: string; inference_engine: string; quantization?: string | null;
  system_prompt_version: string; evaluator_prompt_version: string; rubric_version: string;
  decoding?: Record<string, number | null> | null;
  environment?: Record<string, string> | null;
  gate?: IccVerdict | null;
}
interface LockState {
  locked_at: string | null;
  current: LockRecord | null;
  candidate: { provider: string | null; model_version: string | null } | null;
  can_declare: boolean;
  gate: IccVerdict | null;
}

const FIELDS = [
  { key: 'weights_sha256', th: 'SHA-256 ของไฟล์น้ำหนักโมเดล', en: 'Weights SHA-256', hint: '64 hex characters', required: true },
  { key: 'inference_engine', th: 'โปรแกรมให้บริการโมเดลและรุ่น', en: 'Inference engine + version', hint: 'e.g. ollama 0.12.0', required: true },
  { key: 'quantization', th: 'การบีบอัดโมเดล', en: 'Quantization', hint: 'e.g. Q8_0, or leave blank', required: false },
  { key: 'system_prompt_version', th: 'เวอร์ชัน system prompt', en: 'System prompt version', hint: '', required: true },
  { key: 'evaluator_prompt_version', th: 'เวอร์ชัน prompt ผู้ให้คะแนน', en: 'Evaluator prompt version', hint: '', required: true },
  { key: 'rubric_version', th: 'เวอร์ชันเกณฑ์ PIS-7', en: 'PIS-7 rubric version', hint: '', required: true },
] as const;

export default function EvaluatorLockPage() {
  const [state, setState] = useState<LockState | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => (
    apiFetch<LockState>('/admin/evaluator-lock').then(setState).catch(() => setState(null))
  ), []);
  useEffect(() => { load(); }, [load]);

  const missing = FIELDS.filter((f) => f.required && !form[f.key]?.trim());

  async function declare() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      for (const f of FIELDS) if (form[f.key]?.trim()) body[f.key] = form[f.key].trim();
      const res = await apiFetch<ApiResult<unknown>>('/admin/evaluator-lock', {
        method: 'POST', body: JSON.stringify(body),
      });
      if (res?.error) { toast(`ล็อกไม่สำเร็จ / Lock failed: ${String(res.error)}`, 'error'); return; }
      toast('ล็อกเรียบร้อย / Configuration frozen.', 'success');
      setForm({}); load();
    } finally { setBusy(false); }
  }

  const gate = state?.gate;
  const gateLook =
    gate?.state === 'pass' ? 'border-ok/40 text-ok'
    : gate?.state === 'fail' ? 'border-danger/40 text-danger'
    : 'border-border text-muted-foreground';

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <PageIntro
        eyebrow="Model Lock"
        title="ล็อกค่าโมเดลผู้ให้คะแนน"
        subtitle="Freeze the configuration every PIS-7 score is measured against — and record the parts the system cannot read for itself."
      />

      {state?.locked_at && state.current && (
        <section className="rounded-lg border border-ok/40 bg-card p-4">
          <p className="flex items-center gap-2 font-medium text-ok">
            <Lock className="size-4" aria-hidden="true" />
            ล็อกแล้วเมื่อ / Frozen at {state.locked_at}
          </p>
          <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
            {FIELDS.map((f) => (
              <div key={f.key} className="contents">
                <dt className="text-muted-foreground">{f.en}</dt>
                <dd className="font-mono text-xs break-all">{String(state.current?.[f.key as 'weights_sha256'] ?? '—')}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-sm text-muted-foreground">
            การเปลี่ยนหลังล็อกต้องหยุดการให้คะแนน บันทึกเหตุผล และแยกข้อมูลก่อน/หลังอย่างชัดเจน /
            Changing this after the freeze means stopping scoring, recording why, and separating the data either side.
          </p>
        </section>
      )}

      {gate && (
        <section className={`rounded-lg border p-4 ${gateLook}`}>
          <p className="flex items-center gap-2 font-medium">
            {gate.state === 'pass' ? <ShieldCheck className="size-4" aria-hidden="true" /> : <HelpCircle className="size-4" aria-hidden="true" />}
            {gate.state === 'pass' ? `ผ่านเกณฑ์ ≥ ${gate.threshold} / Decisive gate met`
              : gate.state === 'fail' ? `ไม่ผ่านเกณฑ์ ≥ ${gate.threshold} / Decisive gate not met`
              : 'ยังตัดสินไม่ได้ / Not yet decidable'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{gate.why}</p>
          <p className="mt-1 text-sm tabular-nums text-muted-foreground">
            ICC {gate.icc ?? '—'} · 95% CI [{gate.lower ?? '—'}, {gate.upper ?? '—'}] · n = {gate.n}
          </p>
        </section>
      )}

      {!state?.can_declare ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          แบบฟอร์มจะเปิดเมื่อโมเดลผู้ท้าชิงผ่านเกณฑ์เทียบกับผู้ตรวจสอบที่เป็นมนุษย์แล้วเท่านั้น /
          The form opens only once the candidate has cleared the decisive threshold against the human auditors.
          “ยังตัดสินไม่ได้” ก็ยังไม่เปิด — การไม่รู้ไม่ใช่การอนุญาต / `Not yet decidable` keeps it closed too: not knowing is not permission.
        </p>
      ) : (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="text-base font-medium">
            บันทึกค่าที่ระบบอ่านเองไม่ได้ / Declare what the system cannot read for itself
            {state.candidate?.model_version && (
              <span className="ml-2 font-normal text-muted-foreground">· {state.candidate.provider} {state.candidate.model_version}</span>
            )}
          </h2>
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <label htmlFor={f.key} className="block text-sm">
                {f.th} / {f.en}{!f.required && <span className="text-muted-foreground"> (ไม่บังคับ / optional)</span>}
              </label>
              <input
                id={f.key} value={form[f.key] ?? ''} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                className="w-full rounded-lg border p-2 font-mono text-sm" placeholder={f.hint} />
            </div>
          ))}
          <Button className="w-full" disabled={busy || missing.length > 0} onClick={declare}>
            {busy ? 'กำลังบันทึก…' : missing.length ? `กรอกให้ครบอีก ${missing.length} ช่อง / ${missing.length} field(s) still needed` : 'ล็อกค่าโมเดล / Freeze this configuration'}
          </Button>
        </section>
      )}
    </div>
  );
}
