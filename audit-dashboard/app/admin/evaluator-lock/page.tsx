'use client';
// The Primary Evaluator Model Lock — freezing the configuration every score is measured against, bound
// to the model manifest (CCME R2, GitHub #75). Backend: GET/POST /admin/evaluator-lock
// (backend/src/routes/superadmin.js, services/model-lock.js).
//
// Scores already carry a configuration fingerprint. What this screen collects is the DECLARATION: the
// parts a running system cannot read for itself. A weights checksum is not obtainable over an inference
// API; neither is the container image, the library set, or the quantization the operator chose. Those
// have to be stated by a person with access to the machine.
//
// The form is CLOSED while the backend lists any blocker, and each blocker is shown as its own reason.
// A load failure is an ERROR state, never "gate not passed": a lock state the server could not read is
// not a lock state, and showing it as one would be a guess.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, CircleAlert, HelpCircle, Lock, ShieldCheck, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { PageIntro } from '@/components/PageIntro';
import { BiLabel } from '@/components/BiLabel';
import { toast } from '@/components/Overlays';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { StateMessage } from '@/components/ui/state-message';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DriftKeyList } from '@/components/DriftKeyList';
import { formatApiError } from '@/lib/types';
import type {
  ApiError, EvaluatorLockPostResult, EvaluatorLockRecord, EvaluatorLockState, ManifestDiffRow,
} from '@/lib/types';
import {
  DECODING_FIELDS, DRIFT_COPY, NOTE_MAX, OUTCOME_UNKNOWN, POST_ERROR_FALLBACK, POST_ERROR_TITLE, TEXT_FIELDS,
  applyPrefill, blockerCopy, buildBody, classifyDrift, differsFromManifest, emptyForm, fmtDate, fmtNum, fmtValue, manifestValue,
  postOutcome, shortSha, validate, TIMEOUT_CODE,
  type DecodingKey, type DriftClasses, type LockForm, type TextKey,
} from '@/lib/evaluator-lock';

type LoadBody = EvaluatorLockState & { error?: ApiError; code?: string; httpStatus?: number; detail?: string };
type Load =
  | { kind: 'loading' }
  | { kind: 'error'; title: string; message: string }
  | { kind: 'ready'; state: EvaluatorLockState };
// `res` undefined is a 401: apiFetch is already navigating to sign-in, and nothing was locked.
// `unknown` is a POST that came back with nothing readable (lib/evaluator-lock.ts postOutcome): the lock
// may have been written. Its phase is what re-reading the state found.
type UnknownPhase = 'checking' | 'new_lock' | 'no_change' | 'unreadable';
type Submit =
  | { kind: 'idle' }
  | { kind: 'error'; res: EvaluatorLockPostResult | undefined }
  | { kind: 'success'; res: EvaluatorLockPostResult }
  | { kind: 'unknown'; res: EvaluatorLockPostResult; phase: UnknownPhase; lockedAt?: string | null };

const SESSION_EXPIRED = 'เซสชันหมดอายุ / Your session has expired';
const LOAD_FAILED = 'โหลดหน้านี้ไม่สำเร็จ / This page could not be loaded';

function loadError(d: LoadBody | undefined): { title: string; message: string } | null {
  if (d === undefined) return { title: SESSION_EXPIRED, message: 'กำลังพาไปหน้าเข้าสู่ระบบ / Taking you back to sign in.' };
  if (!d.error && Array.isArray(d.blockers)) return null;
  const message = [formatApiError(d.error, 'เซิร์ฟเวอร์ตอบกลับในรูปแบบที่หน้านี้อ่านไม่ได้ / The server answered in a shape this page cannot read.'), d.detail]
    .filter(Boolean).join(' — ');
  const s = d.httpStatus;
  const title = s === 503 || d.code === 'lock_state_unreadable'
    ? 'อ่านสถานะการล็อกไม่ได้ / The lock state could not be read'
    : s === 403 ? 'สำหรับผู้ดูแลระดับสูงสุดเท่านั้น / Superadmin only'
      : s && s >= 500 ? 'อ่านข้อมูลการล็อกไม่สำเร็จ / The lock could not be read'
        : LOAD_FAILED;
  return { title, message };
}

export default function EvaluatorLockPage() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [form, setForm] = useState<LockForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ kind: 'idle' });
  // The phrase a 409 confirmation_required asked for (a lock landed after this page loaded).
  const [phrase409, setPhrase409] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const resultRef = useRef<HTMLDivElement>(null);
  const nextEnvId = useRef(2);

  // Every setState lands in a promise callback (react-hooks/set-state-in-effect).
  // Resolves with the state it read, or null when it could not read one.
  const fetchState = useCallback((): Promise<EvaluatorLockState | null> => (
    apiFetch<LoadBody | undefined>('/admin/evaluator-lock')
      .then((d) => {
        const err = loadError(d);
        if (err) { setLoad({ kind: 'error', ...err }); return null; }
        const state = d as EvaluatorLockState;
        setLoad({ kind: 'ready', state });
        setForm((f) => applyPrefill(f, state.manifest));
        return state;
      })
      .catch(() => { setLoad({ kind: 'error', title: LOAD_FAILED, message: 'เครือข่ายขัดข้อง / Network error.' }); return null; })
  ), []);
  useEffect(() => { fetchState(); }, [fetchState]);
  const retry = () => { setLoad({ kind: 'loading' }); fetchState(); };

  // A refusal or a success is announced (role=alert / status) AND receives focus, so it is where the
  // reader lands after pressing submit, whatever happened to the form beneath it.
  useEffect(() => { if (submit.kind !== 'idle') resultRef.current?.focus(); }, [submit]);

  // Where focus goes once an environment row is added or removed. Removing the focused row's button
  // would otherwise drop a keyboard user on <body>, at the top of the page.
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    document.getElementById(id)?.focus();
  }, [form.env]);

  const result = submit.kind === 'idle' ? null : (
    <div ref={resultRef} tabIndex={-1} className="outline-none">
      {submit.kind === 'success' ? <SubmitSuccess res={submit.res} />
        : submit.kind === 'unknown' ? <SubmitUnknown res={submit.res} phase={submit.phase} lockedAt={submit.lockedAt} />
          : <SubmitError res={submit.res} />}
    </div>
  );

  if (load.kind === 'loading') {
    return <Shell><StateMessage kind="loading" title="กำลังโหลดสถานะการล็อก… / Loading the lock state…" /></Shell>;
  }
  if (load.kind === 'error') {
    return (
      <Shell>
        {result}
        <StateMessage kind="error" title={load.title} onRetry={retry}>
          <p className="break-words">{load.message}</p>
          <p className="mt-1">
            ยังไม่แสดงว่าล็อกหรือไม่จนกว่าจะอ่านสถานะได้ / Nothing is shown as locked or unlocked until the state can be read: unreadable is not unlocked.
          </p>
        </StateMessage>
      </Shell>
    );
  }

  const state = load.state;
  const { errors, missing } = validate(form);
  const relockPhrase = phrase409 ?? (state.locked_at ? state.confirm_phrases?.replace_lock ?? null : null);
  const relockOk = !relockPhrase || typed === relockPhrase;
  const problems = missing.length + Object.keys(errors).length;
  const canSubmit = !busy && problems === 0 && relockOk;
  const serverField = (submit.kind === 'error' && submit.res?.details?.fieldErrors) || {};
  const problemNames = [...new Set([...missing, ...Object.keys(errors)].map(fieldName))];

  const touch = (f: LockForm, id: string) => (f.touched.includes(id) ? f.touched : [...f.touched, id]);
  const setText = (key: TextKey, v: string) => setForm((f) => ({ ...f, text: { ...f.text, [key]: v }, touched: touch(f, key) }));
  const setDecoding = (key: DecodingKey, v: string) =>
    setForm((f) => ({ ...f, decoding: { ...f.decoding, [key]: v }, touched: touch(f, `decoding.${key}`) }));
  const setEnv = (id: number, part: 'key' | 'value', v: string) =>
    setForm((f) => ({ ...f, env: f.env.map((r) => (r.id === id ? { ...r, [part]: v } : r)) }));
  const addEnv = () => {
    const id = nextEnvId.current++;
    focusAfter.current = `lock-env-${id}-key`;
    setForm((f) => ({ ...f, env: [...f.env, { id, key: '', value: '' }] }));
  };
  // Focus lands on the previous row's Remove, or the row that moved into this one's place, or — with no
  // rows left — on "Add an entry".
  const removeEnv = (id: number) => {
    const i = form.env.findIndex((r) => r.id === id);
    const rest = form.env.filter((r) => r.id !== id);
    const next = rest[i - 1] ?? rest[i];
    focusAfter.current = next ? `lock-env-${next.id}-remove` : 'lock-env-add';
    setForm((f) => ({ ...f, env: f.env.filter((r) => r.id !== id) }));
  };
  const drift = state.manifest?.ok ? classifyDrift(state.manifest.drift_keys, state.candidate?.provider) : null;

  async function declare(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const lockedBefore = state.locked_at;
    setBusy(true);
    const res = await apiFetch<EvaluatorLockPostResult | undefined>('/admin/evaluator-lock', {
      method: 'POST', body: JSON.stringify(buildBody(form, relockPhrase ? typed : null)),
    });
    setBusy(false);
    const outcome = postOutcome(res);
    if (outcome === 'success') {
      setSubmit({ kind: 'success', res: res! });
      toast('ล็อกเรียบร้อย / Configuration frozen.', 'success');
      setForm(emptyForm());
      setTyped('');
      setPhrase409(null);
      fetchState();
      return;
    }
    if (outcome !== 'unknown') {
      setSubmit({ kind: 'error', res });
      if (res?.code === 'confirmation_required') {
        setPhrase409(res.confirm_phrase ?? state.confirm_phrases?.replace_lock ?? null);
        setTyped('');
      }
      // The refusal may reflect a state that moved since this page loaded (a new verdict, a redeploy, a
      // lock someone else took): re-read it so the blockers say why. The form keeps what was typed.
      if (res && res.code !== 'invalid_declaration') fetchState();
      return;
    }
    // Nothing readable came back, so the lock may have been written. Never "not applied, try again":
    // re-read the state and say what it shows.
    setSubmit({ kind: 'unknown', res: res!, phase: 'checking' });
    const after = await fetchState();
    if (!after) { setSubmit({ kind: 'unknown', res: res!, phase: 'unreadable' }); return; }
    if (after.locked_at && after.locked_at !== lockedBefore) {
      // A lock appeared, and it may be this one. Clear what was typed so it cannot be re-sent on top.
      setSubmit({ kind: 'unknown', res: res!, phase: 'new_lock', lockedAt: after.locked_at });
      setForm(applyPrefill(emptyForm(), after.manifest));
      setTyped('');
      setPhrase409(null);
      return;
    }
    setSubmit({ kind: 'unknown', res: res!, phase: 'no_change' });
  }

  return (
    <Shell>
      <LockBanner state={state} />
      <CandidatePanel state={state} />
      {state.manifest?.ok && <ManifestPanel state={state} drift={drift!} />}
      {state.blockers.length > 0 && <Blockers state={state} />}
      {drift && drift.evaluator.length > 0 && !state.blockers.includes('evaluator_live_drift') && <EvaluatorDrift keys={drift.evaluator} />}

      {result}

      {!state.can_declare ? (
        <p className="rounded-lg border border-dashed border-field p-4 text-sm text-muted-foreground">
          แบบฟอร์มจะเปิดเมื่อไม่มีเหตุขัดข้องข้างต้นเหลืออยู่ “ยังตัดสินไม่ได้” ก็ยังไม่เปิด เพราะการไม่รู้ไม่ใช่การอนุญาต /
          The form opens once none of the reasons above remains. “Not yet decidable” keeps it closed too: not knowing is not permission.
        </p>
      ) : (
        <form noValidate onSubmit={declare} aria-labelledby="lock-form-h" className="space-y-5 rounded-lg border border-border p-4">
          <div>
            <h2 id="lock-form-h" className="font-sans text-sm font-medium text-foreground">
              บันทึกค่าที่ระบบอ่านเองไม่ได้ / Declare what the system cannot read for itself
            </h2>
            {state.candidate?.provider && (
              <p className="mt-1 text-xs text-muted-foreground">
                สำหรับ / For <span className="font-mono break-all text-foreground">{state.candidate.provider} {state.candidate.model_version ?? ''}</span>
              </p>
            )}
          </div>

          {TEXT_FIELDS.map((f) => {
            const id = `lock-${f.key}`;
            const mv = manifestValue(state.manifest, f.key);
            const value = form.text[f.key];
            const differs = differsFromManifest(f.key, value, mv);
            return (
              <Field key={f.key} id={id} th={f.th} en={f.en} required={f.required}
                hints={[{ text: f.hint }, ...(mv != null ? [manifestHint(mv, value, differs)] : [])]}
                error={errors[f.key] ?? serverField[f.key]?.join(' ')}
              >
                {(describedBy, invalid) => (
                  <Input id={id} value={value} onChange={(e) => setText(f.key, e.target.value)}
                    required={f.required} aria-required={f.required} aria-invalid={invalid || undefined} aria-describedby={describedBy}
                    autoComplete="off" spellCheck={false} className={f.mono ? 'font-mono' : undefined} />
                )}
              </Field>
            );
          })}

          <fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-3" aria-describedby="lock-decoding-hint">
            <legend className="px-1 text-sm font-medium text-foreground"><BiLabel th="ค่าการสร้างข้อความ" en="Decoding" /></legend>
            <p id="lock-decoding-hint" className="text-xs text-muted-foreground">
              ค่าที่ผู้ให้คะแนนส่งไปกับทุกคำขอ ทุกช่องไม่บังคับ เว้นว่างถ้าไม่ได้ตั้ง ค่าที่ manifest ระบุจะถูกเทียบ / What the evaluator sends with every
              call. All optional: leave a value blank if it is not set. Any value the manifest states is compared against it.
            </p>
            {serverField.decoding && <p className="text-xs text-danger">{serverField.decoding.join(' ')}</p>}
            <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2">
              {DECODING_FIELDS.map((f) => {
                const fid = `decoding.${f.key}`;
                const id = `lock-decoding-${f.key}`;
                const mv = manifestValue(state.manifest, fid);
                const disabled = f.key === 'seed' && form.noSeed;
                const value = disabled ? '' : form.decoding[f.key];
                const differs = differsFromManifest(fid, value, mv);
                return (
                  <Field key={f.key} id={id} th={f.th} en={f.en} required={false} marker={false}
                    hints={[
                      { text: f.int ? 'จำนวนเต็ม / A whole number' : 'ตัวเลข เช่น 0 หรือ 0.7 / A number, e.g. 0 or 0.7' },
                      ...(mv != null ? [manifestHint(mv, value, differs)] : []),
                    ]}
                    error={errors[fid]}
                  >
                    {(describedBy, invalid) => (
                      <Input id={id} value={value} onChange={(e) => setDecoding(f.key, e.target.value)} disabled={disabled}
                        inputMode={f.int ? 'numeric' : 'decimal'} aria-invalid={invalid || undefined} aria-describedby={describedBy}
                        autoComplete="off" className="font-mono tabular-nums" />
                    )}
                  </Field>
                );
              })}
            </div>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <Checkbox className="mt-0.5" checked={form.noSeed} onChange={(e) => { const on = e.target.checked; setForm((f) => ({ ...f, noSeed: on, touched: touch(f, 'decoding.seed') })); }} />
              <span>ไม่ได้ตั้ง seed (ประกาศว่าไม่มี) / No seed is set (declared as none)</span>
            </label>
          </fieldset>

          <fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-3" aria-describedby="lock-env-hint">
            <legend className="px-1 text-sm font-medium text-foreground"><BiLabel th="สภาพแวดล้อม" en="Environment" /></legend>
            <p id="lock-env-hint" className="text-xs text-muted-foreground">
              เช่น os, cuda, driver, digest ของ container ห้ามใส่รหัสผ่าน คีย์ token หรือ URL เพราะจะถูกเก็บในบันทึกงานวิจัย /
              e.g. os, cuda, driver, container image digest. Never a password, key, token or URL: this is kept in the study record.
            </p>
            {serverField.environment && <p className="text-xs text-danger">{serverField.environment.join(' ')}</p>}
            {form.env.map((r, i) => {
              const keyErr = errors[`env.${r.id}.key`];
              return (
                <div key={r.id} className="grid grid-cols-1 gap-2 @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] @min-[640px]:items-end">
                  <div className="min-w-0 space-y-1">
                    <label htmlFor={`lock-env-${r.id}-key`} className="block text-xs text-muted-foreground">ชื่อ / Name {i + 1}</label>
                    <Input id={`lock-env-${r.id}-key`} value={r.key} onChange={(e) => setEnv(r.id, 'key', e.target.value)} autoComplete="off" spellCheck={false}
                      aria-invalid={keyErr ? true : undefined} aria-describedby={keyErr ? `lock-env-${r.id}-error` : undefined} className="font-mono" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <label htmlFor={`lock-env-${r.id}-value`} className="block text-xs text-muted-foreground">ค่า / Value {i + 1}</label>
                    <Input id={`lock-env-${r.id}-value`} value={r.value} onChange={(e) => setEnv(r.id, 'value', e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
                  </div>
                  <button type="button" id={`lock-env-${r.id}-remove`} onClick={() => removeEnv(r.id)} aria-label={`ลบ / Remove ${i + 1}`} className="justify-self-start rounded-lg border border-field px-3 py-2 text-sm whitespace-nowrap text-foreground hover:bg-muted">
                    ลบ / Remove
                  </button>
                  {keyErr && <p id={`lock-env-${r.id}-error`} className="text-xs text-danger @min-[640px]:col-span-3">{keyErr}</p>}
                </div>
              );
            })}
            <button type="button" id="lock-env-add" onClick={addEnv} className="rounded-lg border border-field px-3 py-2 text-sm whitespace-nowrap text-foreground hover:bg-muted">
              เพิ่มรายการ / Add an entry
            </button>
          </fieldset>

          <Field id="lock-note" th="หมายเหตุ" en="Note" required={false}
            hints={[{ text: `เหตุผลและบริบทของการล็อก ${form.note.length.toLocaleString()} / ${NOTE_MAX.toLocaleString()} ตัวอักษร / Why, and anything a later reader needs: ${form.note.length.toLocaleString()} of ${NOTE_MAX.toLocaleString()} characters.` }]}
            error={errors.note ?? serverField.note?.join(' ')}
          >
            {(describedBy, invalid) => (
              <Textarea id="lock-note" rows={4} value={form.note} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, note: v })); }}
                aria-invalid={invalid || undefined} aria-describedby={describedBy} />
            )}
          </Field>

          {/* Typed confirmation, as AiProviderPanel does it: a re-declaration changes the study's
              instrument mid-pilot, so it must not be one more press of the same button. */}
          {relockPhrase && (
            <div className="rounded-lg border-2 border-destructive/50 p-4">
              <p className="text-sm font-medium text-foreground">แทนที่การล็อกที่มีผลอยู่? / Replace the lock in force?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                ทำได้เฉพาะเหตุผลด้านความปลอดภัยที่สำคัญ ต้องหยุดการให้คะแนน บันทึกเหตุผลในหมายเหตุ และแยกข้อมูลก่อนและหลังการเปลี่ยน /
                Only for a critical safety or security reason: scoring stops, the reason goes in the note, and the data either side of the change is kept apart.
              </p>
              <label className="mt-3 block text-xs text-muted-foreground" htmlFor="lock-relock-confirm">
                พิมพ์ <span className="font-mono font-semibold text-foreground">{relockPhrase}</span> เพื่อยืนยัน / Type it to confirm
              </label>
              <Input id="lock-relock-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false}
                required aria-required className="mt-1 max-w-xs font-mono" />
            </div>
          )}

          <div className="space-y-2">
            <Button type="submit" disabled={!canSubmit} aria-describedby="lock-submit-hint">
              <Lock className="size-4" aria-hidden="true" />
              {busy ? 'กำลังบันทึก… / Saving…' : relockPhrase ? 'แทนที่การล็อก / Replace the lock' : 'ล็อกค่าโมเดล / Freeze it'}
            </Button>
            <p id="lock-submit-hint" className="text-xs break-words text-muted-foreground">
              {problems > 0
                ? `ยังขาดหรือไม่ถูกต้อง ${problems} ช่อง / ${problems} field(s) still missing or invalid: ${problemNames.join(', ')}.`
                : !relockOk
                  ? 'พิมพ์วลียืนยันให้ตรงก่อน / Type the confirmation phrase first.'
                  : 'พร้อมล็อก ระบบจะตรวจผลความสอดคล้องและ manifest อีกครั้งก่อนบันทึก / Ready. The server re-checks the verdict and the manifest before it writes anything.'}
            </p>
          </div>
        </form>
      )}
    </Shell>
  );
}

// The English name of a form field id, for the submit hint: a TextKey, `decoding.<key>`, `env.<id>.key`, `note`.
function fieldName(id: string): string {
  if (id.startsWith('decoding.')) return DECODING_FIELDS.find((f) => `decoding.${f.key}` === id)!.en;
  if (id.startsWith('env.')) return 'Environment';
  if (id === 'note') return 'Note';
  return TEXT_FIELDS.find((f) => f.key === id)!.en;
}

type Hint = { text: string; warn?: boolean; chip?: boolean };

// The manifest's value for a field, under the input. It is the "from manifest" marker too: a chip while
// the field still holds that value (pre-filled, or typed to match), a warning once a compared value
// differs, and a plain note otherwise. Kept out of the label so every label in a row is one line and the
// inputs beside each other line up.
function manifestHint(mv: string, value: string, differs: boolean): Hint {
  if (differs) return { text: `ต่างจาก manifest (${mv}) ระบบจะไม่ยอมล็อก / Differs from the manifest (${mv}); the lock will be refused.`, warn: true };
  if (value.trim() !== '' && (value.trim() === mv || Number(value) === Number(mv))) return { text: mv, chip: true };
  return { text: `ค่าจาก manifest / From the manifest: ${mv}` };
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 @min-[640px]:p-6">
      <PageIntro
        eyebrow="Model Lock"
        title="ล็อกค่าโมเดลผู้ให้คะแนน"
        subtitle="Freeze the configuration every PIS-7 score is measured against, bound to the model manifest, and record the parts the system cannot read for itself."
      />
      {children}
    </div>
  );
}

// One labelled field: <label htmlFor>, its hints and its error wired through aria-describedby.
function Field({ id, th, en, required, marker = true, hints, error, children }: {
  id: string; th: string; en: string; required: boolean; marker?: boolean;
  hints: Hint[];
  error?: string;
  children: (describedBy: string, invalid: boolean) => React.ReactNode;
}) {
  const ids = [...hints.map((_, i) => `${id}-hint-${i}`), ...(error ? [`${id}-error`] : [])].join(' ');
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-medium text-foreground">
        <BiLabel th={th} en={en} />
        {marker && <span className="text-xs font-normal text-muted-foreground">{required ? '(จำเป็น / required)' : '(ไม่บังคับ / optional)'}</span>}
      </label>
      {children(ids, !!error)}
      {hints.map((h, i) => (
        <p key={i} id={`${id}-hint-${i}`} className={`text-xs break-words ${h.warn ? 'text-warn' : 'text-muted-foreground'}`}>
          {h.chip && <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-foreground">จาก manifest / from manifest</span>}
          {h.text}
        </p>
      ))}
      {error && <p id={`${id}-error`} className="text-xs text-danger">{error}</p>}
    </div>
  );
}

// ---- the lock in force -----------------------------------------------------------------------------

function decodingText(d: EvaluatorLockRecord['decoding']): string {
  const parts = Object.entries(d ?? {}).filter(([, v]) => v !== undefined)
    .map(([k, v]) => (v === null ? `${k} ไม่ได้ตั้ง / none` : `${k} ${v}`));
  return parts.length ? parts.join(' · ') : 'ไม่ได้ประกาศ / Not declared';
}

type Row = [string, React.ReactNode];
const mono = (v: string | null | undefined) => <span className="font-mono text-xs break-all">{v ?? '—'}</span>;
const sha = (v: string | null | undefined) => <span className="font-mono text-xs" title={v ?? undefined}>{shortSha(v)}</span>;

function LockBanner({ state }: { state: EvaluatorLockState }) {
  const { locked_at, current, in_force } = state;
  if (in_force && current) {
    const env = Object.entries(current.environment ?? {});
    const rows: Row[] = [
      ['ผู้ให้บริการ / Provider', current.provider ?? '—'],
      ['รุ่นโมเดล / Model version', mono(current.model_version)],
      ['Manifest sha256', sha(current.manifest_sha256)],
      ['Evaluator sha256', sha(current.evaluator_sha256)],
      ['Weights sha256', sha(current.weights_sha256)],
      ['Inference engine', current.inference_engine ?? '—'],
      ...(current.quantization ? [['Quantization', current.quantization] as Row] : []),
      ['Evaluator prompt', mono(current.evaluator_prompt_version)],
      ['Rubric', mono(current.rubric_version)],
      ['System prompt', mono(current.system_prompt_version)],
      ['Decoding', <span key="d" className="font-mono text-xs break-words">{decodingText(current.decoding)}</span>],
      ['Environment', env.length
        ? <ul key="env" className="space-y-0.5 font-mono text-xs break-all">{env.map(([k, v]) => <li key={k}>{k} = {v}</li>)}</ul>
        : 'ไม่ได้ประกาศ / Not declared'],
      ...(current.note ? [['หมายเหตุ / Note', <span key="n" className="block whitespace-pre-wrap break-words">{current.note}</span>] as Row] : []),
    ];
    return (
      <section aria-labelledby="lock-banner-h" className="rounded-lg border border-ok/40 p-4">
        <h2 id="lock-banner-h" className="flex items-center gap-2 font-sans text-sm font-medium text-ok">
          <Lock className="size-4 shrink-0" aria-hidden="true" />
          ล็อกอยู่ตั้งแต่ / Locked since {fmtDate(current.locked_at)}
        </h2>
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm @min-[640px]:grid-cols-[max-content_minmax(0,1fr)]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 pb-1 text-foreground @min-[640px]:pb-0">{v}</dd>
            </div>
          ))}
        </dl>
        {!current.evaluator_sha256 && (
          <p className="mt-3 flex gap-2 text-sm text-warn">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              การล็อกนี้ไม่ได้ผูกกับ model manifest ต้องแทนที่ด้วยการประกาศใหม่ด้านล่าง / This lock was taken before it could be bound to the model
              manifest: it names no evaluator digest, so the health check cannot show the frozen instrument is the one scoring. Replace it below.
            </span>
          </p>
        )}
        <p className="mt-3 text-sm text-muted-foreground">
          การเปลี่ยนหลังล็อกต้องหยุดการให้คะแนน บันทึกเหตุผล และแยกข้อมูลก่อนและหลังอย่างชัดเจน /
          Changing this after the freeze means stopping scoring, recording why, and separating the data either side.
        </p>
      </section>
    );
  }
  if (locked_at) {
    // The flag is set and no record carries its timestamp: the retired quick-lock switch, or a hand edit.
    return (
      <section role="status" className="rounded-lg border-l-4 border-l-chart-warn bg-muted px-4 py-3">
        <p className="flex gap-2 text-sm font-medium text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <span>ล็อกไว้โดยไม่มีบันทึกรองรับ / Locked, with no record behind it</span>
        </p>
        <p className="mt-1 text-sm text-foreground">
          ผู้ให้คะแนนถูกล็อกตั้งแต่ {fmtDate(locked_at)} แต่ไม่มีบันทึกการล็อกที่ตรงกัน จึงไม่มีอะไรบอกว่าล็อกค่าใดไว้ ต้องแทนที่ด้วยการประกาศด้านล่าง /
          The evaluator has been locked since {fmtDate(locked_at)}, but no lock record matches it. It was set by the retired quick-lock switch or by
          hand, so nothing records what it froze: no weights digest, no agreement verdict, no manifest. Replace it with a declaration below.
        </p>
        {current && (
          <p className="mt-1 text-sm text-foreground">
            บันทึกล่าสุดที่มี ({fmtDate(current.locked_at)}) ไม่ใช่การล็อกที่มีผลอยู่ / The latest record on file ({fmtDate(current.locked_at)}) is not the lock in force.
          </p>
        )}
      </section>
    );
  }
  return (
    <p role="status" className="flex gap-2 text-sm text-muted-foreground">
      <HelpCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {current
          ? `ยังไม่ได้ล็อก บันทึกล่าสุด (${fmtDate(current.locked_at)}) ถูกปลดล็อกแล้วแต่ยังเก็บไว้ / Not locked. The last declaration (${fmtDate(current.locked_at)}) stays on file; the evaluator was unlocked after it.`
          : 'ผู้ให้คะแนนยังไม่ถูกล็อก / The evaluator is not locked.'}
      </span>
    </p>
  );
}

// ---- the candidate, the serving evaluator and the gate ---------------------------------------------

const GATE_LABEL: Record<string, string> = {
  pass: 'ผ่านเกณฑ์ / Decisive gate met',
  fail: 'ไม่ผ่านเกณฑ์ / Decisive gate not met',
  insufficient: 'ยังตัดสินไม่ได้ / Not yet decidable',
};

function CandidatePanel({ state }: { state: EvaluatorLockState }) {
  const c = state.candidate;
  const gate = state.gate;
  const serving = state.serving_provider;
  const groups = gate?.groups ?? [];
  const tone = gate?.state === 'pass' ? 'ok' : gate?.state === 'fail' ? 'fail' : 'open';
  return (
    <section aria-labelledby="lock-candidate-h" className="space-y-3 rounded-lg border border-border p-4">
      <h2 id="lock-candidate-h" className="font-sans text-sm font-medium text-foreground">ผู้ท้าชิงและผู้ให้คะแนนตอนนี้ / The candidate and the serving evaluator</h2>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm @min-[640px]:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="text-muted-foreground">ผู้ท้าชิง / Candidate</dt>
        <dd className="min-w-0 pb-1 font-mono text-xs break-all text-foreground @min-[640px]:pb-0">
          {c ? `${c.provider ?? '—'} · ${c.model_version ?? '—'}` : 'ยังไม่มี / None yet'}
        </dd>
        {c && (
          <>
            <dt className="text-muted-foreground">Prompt version</dt>
            <dd className="min-w-0 pb-1 font-mono text-xs break-all text-foreground @min-[640px]:pb-0">{c.prompt_version ?? '—'}</dd>
            <dt className="text-muted-foreground">Rubric</dt>
            <dd className="min-w-0 pb-1 font-mono text-xs break-all text-foreground @min-[640px]:pb-0">{fmtValue(c.rubric_versions)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">ให้คะแนนอยู่ / Serving evaluate</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-x-2 text-foreground">
          <span className="font-mono text-xs">{serving ?? '—'}</span>
          {c?.provider && (c.provider === serving
            ? <span className="inline-flex items-center gap-1 text-xs text-ok"><CheckCircle2 className="size-4" aria-hidden="true" />ตรงกับผู้ท้าชิง / Same as the candidate</span>
            : <span className="inline-flex items-center gap-1 text-xs text-danger"><XCircle className="size-4" aria-hidden="true" />ไม่ใช่ผู้ท้าชิง / Not the candidate</span>)}
        </dd>
      </dl>

      {gate && (
        <div data-gate={gate.state} className={`rounded-lg border p-3 ${tone === 'ok' ? 'border-ok/40' : tone === 'fail' ? 'border-danger/40' : 'border-field'}`}>
          <p className={`flex items-center gap-2 text-sm font-medium ${tone === 'ok' ? 'text-ok' : tone === 'fail' ? 'text-danger' : 'text-foreground'}`}>
            {tone === 'ok' ? <ShieldCheck className="size-4 shrink-0" aria-hidden="true" /> : <HelpCircle className="size-4 shrink-0" aria-hidden="true" />}
            {GATE_LABEL[gate.state] ?? gate.state} (≥ {gate.threshold})
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{gate.why}</p>
          <p className="mt-1 text-sm tabular-nums text-muted-foreground">
            ICC {fmtNum(gate.icc)} · 95% CI [{fmtNum(gate.lower)}, {fmtNum(gate.upper)}] · n = {gate.n}
          </p>
          {groups.length > 0 && (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-foreground">กลุ่มในคลังข้อมูล ({groups.length}) / Groups in the corpus ({groups.length})</summary>
              <p className="mt-1 text-xs text-muted-foreground">
                ผู้ท้าชิงคือกลุ่มเดียว ไม่รวมกลุ่มอื่น / The candidate is one group; the others are listed so nothing is silently pooled.
              </p>
              <ul className="mt-1 space-y-1">
                {groups.map((g) => (
                  <li key={`${g.provider}|${g.model_version}|${g.prompt_version}`} className="font-mono text-xs break-all text-foreground">
                    {g.provider ?? '—'} · {g.model_version ?? '—'} · {g.prompt_version ?? '—'} · {g.rows} rows
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function ManifestPanel({ state, drift }: { state: EvaluatorLockState; drift: DriftClasses }) {
  const m = state.manifest as Extract<NonNullable<EvaluatorLockState['manifest']>, { ok: true }>;
  const exp = m.expected_for_candidate;
  return (
    <section aria-labelledby="lock-manifest-h" className="space-y-2 rounded-lg border border-border p-4 text-sm">
      <h2 id="lock-manifest-h" className="font-sans text-sm font-medium text-foreground">Model manifest</h2>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 @min-[640px]:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="text-muted-foreground">sha256</dt>
        <dd className="min-w-0 pb-1 text-foreground @min-[640px]:pb-0">{sha(m.sha256)}</dd>
        <dt className="text-muted-foreground">File</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-x-2 pb-1 text-foreground @min-[640px]:pb-0">
          <span className="font-mono text-xs">{m.file}</span>
          <span className="inline-flex items-center gap-1 text-xs text-ok"><CheckCircle2 className="size-4" aria-hidden="true" />ตรงกับโค้ดที่รันอยู่ / Matches the running code</span>
        </dd>
        {exp && (
          <>
            <dt className="text-muted-foreground">จะล็อก / Would freeze</dt>
            <dd className="min-w-0 pb-1 text-foreground @min-[640px]:pb-0"><span className="font-mono text-xs">evaluator </span>{sha(exp.evaluator_sha256)}</dd>
            <dt className="text-muted-foreground">คาดว่าโมเดล / Expects model</dt>
            <dd className="min-w-0 pb-1 text-foreground @min-[640px]:pb-0">{mono(exp.model_version)}</dd>
          </>
        )}
      </dl>
      {/* Live drift, by kind. Only the deployment-target kind is "expected"; evaluator-scope keys are a
          warning of their own before the form (EvaluatorDrift, or the evaluator_live_drift blocker). */}
      {drift.evaluator.length > 0 && (
        <p className="flex gap-1.5 text-xs text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>ค่าในขอบเขตเครื่องมือวัดต่างจาก manifest {drift.evaluator.length} รายการ ดูด้านล่าง / {drift.evaluator.length} value(s) in the evaluator’s scope differ: listed below.</span>
        </p>
      )}
      {drift.expected.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">ค่าที่ประกาศต่างจากที่รันอยู่ {drift.expected.length} รายการ / {drift.expected.length} declared value(s) differ from what is running:</p>
          <DriftKeyList keys={drift.expected} label="ค่าที่ประกาศที่ต่างไป / Declared values that differ" />
          <p className="text-xs text-muted-foreground">{DRIFT_COPY.expected}</p>
        </div>
      )}
      {drift.other.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">ค่าอื่นที่ต่างไป {drift.other.length} รายการ / {drift.other.length} other value(s) differ:</p>
          <DriftKeyList keys={drift.other} label="ค่าอื่นที่ต่างไป / Other values that differ" />
          <p className="text-xs text-muted-foreground">{DRIFT_COPY.other}</p>
        </div>
      )}
    </section>
  );
}

// Evaluator-scope live drift, before the form and never as "expected". Today's backend does not refuse a
// lock for it; the backend change after 6b adds the evaluator_live_drift blocker, which replaces this box.
function EvaluatorDrift({ keys }: { keys: string[] }) {
  return (
    <section aria-labelledby="lock-drift-h" className="space-y-2 rounded-lg border border-warn/50 p-4">
      <h2 id="lock-drift-h" className="flex gap-2 font-sans text-sm font-medium text-warn">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{DRIFT_COPY.evaluatorTitle}</span>
      </h2>
      <DriftKeyList keys={keys} label="ค่าในขอบเขตเครื่องมือวัดที่ต่างไป / Evaluator-scope values that differ" />
      <p className="text-sm text-foreground">{DRIFT_COPY.evaluatorBody}</p>
      <p className="text-sm text-foreground">
        แก้ให้ตรงก่อนล็อก / Resolve them before locking: a lock taken now would record a configuration that is not the one scoring.
      </p>
    </section>
  );
}

// ---- why the form is closed ------------------------------------------------------------------------

function Blockers({ state }: { state: EvaluatorLockState }) {
  return (
    <section aria-labelledby="lock-blockers-h" className="space-y-3">
      <h2 id="lock-blockers-h" className="font-sans text-sm font-medium text-foreground">
        ทำไมยังล็อกไม่ได้ ({state.blockers.length}) / Why the lock cannot be declared yet ({state.blockers.length})
      </h2>
      <ul className="space-y-3">
        {state.blockers.map((b) => {
          const copy = blockerCopy(b);
          return (
            <li key={b} data-blocker={b} className="min-w-0 rounded-lg border border-danger/40 p-3">
              <p className="flex gap-2 text-sm font-medium text-foreground">
                <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                <span>{copy ? `${copy.th} / ${copy.en}` : <>เหตุขัดข้องที่หน้านี้ไม่รู้จัก / A reason this screen does not know: <span className="font-mono">{b}</span></>}</span>
              </p>
              <div className="mt-2 space-y-2 text-sm text-muted-foreground">
                <BlockerDetail blocker={b} state={state} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// A blocker's backend detail: a sentence, or a list of keys (evaluator_live_drift). Anything else is
// not guessed at.
function Detail({ detail }: { detail: string | readonly string[] | undefined }) {
  if (typeof detail === 'string') return detail ? <p className="break-words">{detail}</p> : null;
  if (Array.isArray(detail) && detail.length) return <DriftKeyList keys={detail} label="รายการ / Items" />;
  return null;
}

function BlockerDetail({ blocker, state }: { blocker: string; state: EvaluatorLockState }) {
  const detail = state.blocker_detail?.[blocker];
  const g = state.gate;
  const m = state.manifest && !state.manifest.ok ? state.manifest : null;
  switch (blocker) {
    case 'gate_not_passed':
      return g ? <p>{GATE_LABEL[g.state] ?? g.state}: {g.why} (ICC {fmtNum(g.icc)}, 95% CI [{fmtNum(g.lower)}, {fmtNum(g.upper)}], n = {g.n})</p> : null;
    case 'candidate_not_evaluator':
      return (
        <p>
          ผู้ให้บริการของผู้ท้าชิง / Candidate provider: <span className="font-mono text-foreground">{state.candidate?.provider ?? '—'}</span>.
          {' '}โมเดลผู้สอน (local-tutor) เป็นผู้ให้คะแนนไม่ได้ / The on-prem tutor can never be the evaluator (CCME R3).
        </p>
      );
    case 'candidate_not_serving':
      return (
        <>
          <p>
            ผู้ท้าชิง / Candidate <span className="font-mono text-foreground">{state.candidate?.provider ?? '—'}</span>
            {' '}· ให้คะแนนอยู่ / Serving <span className="font-mono text-foreground">{state.serving_provider ?? '—'}</span>.
            {' '}สลับผู้ให้คะแนนไปที่ผู้ท้าชิงก่อนแล้วจึงล็อก / Switch evaluate to the candidate first, then lock: a lock freezes the instrument that is actually scoring.
          </p>
          <p>
            <Link href="/admin/overview#ai-provider" className="text-link underline underline-offset-2">ไปที่ตัวสลับผู้ให้บริการ AI / Open the AI provider switch</Link>
          </p>
        </>
      );
    case 'manifest_unavailable':
      return m ? (
        <>
          {m.error && <p className="break-words">{m.error}</p>}
          <p className="font-mono text-xs break-all">reason: {m.reason ?? '—'} · file: {m.file ?? '—'}</p>
        </>
      ) : null;
    case 'manifest_mismatch':
      return state.manifest_diff?.length ? <DiffTable rows={state.manifest_diff} /> : null;
    case 'migration_required':
      return state.migrations_pending?.length ? (
        <>
          <p>รันตามลำดับ / Apply, in this order:</p>
          <ol className="list-decimal space-y-0.5 pl-5">
            {state.migrations_pending.map((f) => <li key={f} className="font-mono text-xs break-all text-foreground">{f}</li>)}
          </ol>
        </>
      ) : null;
    case 'evaluator_live_drift': {
      // The backend's key list when it sends one; else the evaluator-scope keys the manifest reports.
      const fallback = state.manifest?.ok ? classifyDrift(state.manifest.drift_keys, state.candidate?.provider).evaluator : undefined;
      return (
        <>
          <Detail detail={detail ?? fallback} />
          <p>{DRIFT_COPY.evaluatorBody}</p>
        </>
      );
    }
    default:
      return <Detail detail={detail} />;
  }
}

const SOURCE_LABEL: Record<string, string> = { candidate: 'วัดจากผู้ท้าชิง / Measured', declaration: 'ที่ประกาศ / Declared' };

// A table where there is room for four columns; below 640px of container width, one card per row. Four
// columns at 320px broke every field name into four-letter fragments.
function DiffTable({ rows }: { rows: ManifestDiffRow[] }) {
  const label = 'ความต่างจาก model manifest / Difference from the model manifest';
  return (
    <>
      <Table label={label} containerClassName="hidden @min-[640px]:block" className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>ช่อง / Field</TableHead>
            <TableHead>ค่าที่วัดหรือประกาศ / Measured or declared</TableHead>
            <TableHead>Manifest คาดหวัง / Manifest expects</TableHead>
            <TableHead>ที่มา / Source</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.field}|${r.source}`} className="align-top">
              <TableCell className="font-mono break-all text-foreground">{r.field}</TableCell>
              <TableCell className="font-mono break-all text-foreground">{fmtValue(r.value)}</TableCell>
              <TableCell className="text-foreground">
                <span className="block font-mono break-all">{fmtValue(r.expected)}</span>
                <span className="mt-0.5 block font-mono break-all text-muted-foreground">{r.manifest_path}</span>
              </TableCell>
              <TableCell className="text-foreground">{SOURCE_LABEL[r.source] ?? r.source}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul aria-label={label} data-diff-cards className="space-y-2 @min-[640px]:hidden">
        {rows.map((r) => (
          <li key={`${r.field}|${r.source}`} className="rounded-md border border-border p-2 text-xs">
            <p className="text-foreground">
              <span className="font-mono font-medium break-all">{r.field}</span>
              <span className="text-muted-foreground"> · {SOURCE_LABEL[r.source] ?? r.source}</span>
            </p>
            <dl className="mt-1 space-y-0.5">
              <dt className="text-muted-foreground">ค่าที่วัดหรือประกาศ / Measured or declared</dt>
              <dd className="font-mono break-all text-foreground">{fmtValue(r.value)}</dd>
              <dt className="text-muted-foreground">Manifest คาดหวัง / Manifest expects</dt>
              <dd className="font-mono break-all text-foreground">{fmtValue(r.expected)}</dd>
              <dd className="font-mono break-all text-muted-foreground">{r.manifest_path}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---- the result of a submit ------------------------------------------------------------------------

function SubmitSuccess({ res }: { res: EvaluatorLockPostResult }) {
  return (
    <StateMessage kind="notice" title={`ล็อกแล้วเมื่อ ${fmtDate(res.locked_at)} / Locked at ${fmtDate(res.locked_at)}`}>
      <p className="font-mono text-xs">manifest {shortSha(res.manifest_sha256)} · evaluator {shortSha(res.evaluator_sha256)}</p>
    </StateMessage>
  );
}

// Nothing readable came back. Amber, not red, and never "try again": the lock may already be written.
// What came back, named — not apiFetch's own envelope text, which ends "please try again".
function unknownCause(res: EvaluatorLockPostResult): string {
  if (res.code === TIMEOUT_CODE) return 'หมดเวลารอคำตอบ / The browser stopped waiting (timeout)';
  if (res.unreadableBody) return `คำตอบไม่ใช่ข้อมูลจากเซิร์ฟเวอร์ / The answer was not the server’s JSON${res.httpStatus ? ` (HTTP ${res.httpStatus})` : ''}`;
  if (res.httpStatus) return `HTTP ${res.httpStatus}, ไม่มีรหัสผล / with no result code`;
  if (res.error) return 'ไม่ได้รับคำตอบ (เครือข่าย) / No answer (network)';
  return 'คำตอบไม่ได้ยืนยันการล็อก / The answer did not confirm the lock';
}

function SubmitUnknown({ res, phase, lockedAt }: { res: EvaluatorLockPostResult; phase: UnknownPhase; lockedAt?: string | null }) {
  const why = unknownCause(res);
  return (
    <StateMessage kind="notice" role="alert" title={OUTCOME_UNKNOWN}>
      <p className="break-words">
        คำขอถูกส่งไปแล้ว แต่ไม่ได้รับคำตอบที่อ่านได้ การล็อกอาจถูกบันทึกแล้วหรือไม่ก็ได้ / The request was sent but no readable answer came
        back, so the lock may or may not have been written.
      </p>
      <p className="mt-1 text-xs break-words">{why}</p>
      {phase === 'checking' && <p className="mt-2">กำลังอ่านสถานะการล็อกอีกครั้ง… / Re-reading the lock state…</p>}
      {phase === 'new_lock' && (
        <>
          <p className="mt-2 font-medium">
            ตอนนี้มีการล็อกที่มีผลอยู่ (ตั้งแต่ {fmtDate(lockedAt)}) ซึ่งอาจเป็นการล็อกที่เพิ่งส่ง ตรวจแถบสถานะด้านบนก่อนส่งอะไรอีก /
            A lock is now in force (since {fmtDate(lockedAt)}), and it may be the one just sent. Check the banner above before sending anything.
          </p>
          <p className="mt-1">แบบฟอร์มถูกล้างแล้ว เพื่อไม่ให้ส่งซ้ำโดยไม่ตั้งใจ / The form was cleared so the declaration cannot be sent twice by accident.</p>
        </>
      )}
      {phase === 'no_change' && (
        <p className="mt-2">
          อ่านสถานะอีกครั้งแล้วยังไม่พบการล็อกใหม่ แต่เซิร์ฟเวอร์อาจทำคำขอเสร็จหลังจากนี้ รอสักครู่แล้วโหลดหน้าใหม่ก่อนส่งอีกครั้ง /
          A fresh read shows no new lock yet, but the server may still finish the request after the browser stopped waiting. Wait a
          minute and reload this page before sending again.
        </p>
      )}
      {phase === 'unreadable' && (
        <p className="mt-2">
          อ่านสถานะการล็อกอีกครั้งไม่ได้ โหลดหน้าใหม่ก่อนส่งอะไรอีก / The lock state could not be re-read either. Reload this page before
          sending anything.
        </p>
      )}
    </StateMessage>
  );
}

function SubmitError({ res }: { res: EvaluatorLockPostResult | undefined }) {
  if (!res) {
    return (
      <StateMessage kind="error" title={`${SESSION_EXPIRED}: ยังไม่ได้ล็อก / Nothing was locked`}>
        <p>เข้าสู่ระบบใหม่แล้วส่งอีกครั้ง / Sign in again, then send the declaration again.</p>
      </StateMessage>
    );
  }
  const title = (res.code && POST_ERROR_TITLE[res.code]) || POST_ERROR_FALLBACK;
  const fieldErrors = Object.entries(res.details?.fieldErrors ?? {}).filter(([, v]) => v?.length);
  const formErrors = res.details?.formErrors ?? [];
  return (
    <StateMessage kind="error" title={title}>
      <p className="break-words">{formatApiError(res.error, 'เซิร์ฟเวอร์ไม่ได้ให้เหตุผล / The server gave no reason.')}</p>
      {fieldErrors.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {fieldErrors.map(([k, v]) => <li key={k}><span className="font-mono">{k}</span>: {v!.join(' ')}</li>)}
        </ul>
      )}
      {formErrors.length > 0 && <p className="mt-2">{formErrors.join(' ')}</p>}
      {res.code === 'manifest_mismatch' && res.diff?.length ? <div className="mt-3 rounded-lg bg-background p-2 text-foreground"><DiffTable rows={res.diff} /></div> : null}
      {res.code === 'migration_required' && res.migrations?.length ? (
        <ol className="mt-2 list-decimal space-y-0.5 pl-5">{res.migrations.map((f) => <li key={f} className="font-mono text-xs break-all">{f}</li>)}</ol>
      ) : null}
      {res.code === 'manifest_unavailable' && res.reason ? <p className="mt-2 font-mono text-xs">reason: {res.reason}</p> : null}
      {res.code === 'rollback_incomplete' && res.inconsistent?.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {res.inconsistent.map((x) => <li key={`${x.step}|${x.left}`}><span className="font-mono">{x.step}</span>: {x.left}</li>)}
        </ul>
      ) : null}
      {res.code === 'lock_record_unconfirmed' && res.locked_at ? <p className="mt-2 font-mono text-xs">locked_at = {res.locked_at}</p> : null}
      {res.detail ? <p className="mt-2 break-words">{res.detail}</p> : null}
      {res.code === 'confirmation_required' && (
        <p className="mt-2 flex gap-2">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>พิมพ์วลียืนยันในแบบฟอร์มด้านล่างแล้วส่งอีกครั้ง / Type the confirmation phrase in the form below and send again.</span>
        </p>
      )}
    </StateMessage>
  );
}
