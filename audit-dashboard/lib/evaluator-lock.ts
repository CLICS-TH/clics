// The Model Lock declaration form's logic, kept out of the page so it is plain functions: what the form
// holds, how it is validated, what it sends, and what the manifest pre-fills.
//
// The request shape is backend/src/routes/superadmin.js ModelLockSchema (pinned field-for-field by
// __tests__/backend-mirrors.test.ts). Client validation repeats the server's rules — a 64-hex digest,
// integer max_tokens and seed — so the form never offers a submit the API would answer with a 400; the
// server stays the authority and its 400 `details` are shown per field too.
import type {
  EvaluatorLockBlocker,
  EvaluatorLockManifest,
  ManifestDecodingValue,
  ManifestExpectedForCandidate,
} from './types';

export const TEXT_FIELDS = [
  { key: 'weights_sha256', th: 'SHA-256 ของไฟล์น้ำหนักโมเดล', en: 'Weights SHA-256', required: true, mono: true,
    hint: 'เลขฐานสิบหก 64 ตัวจาก sha256sum ของไฟล์บนเครื่อง — อ่านผ่าน API ไม่ได้ / 64 hex characters from sha256sum on the box. No inference API can report it.' },
  { key: 'inference_engine', th: 'โปรแกรมให้บริการโมเดลและรุ่น', en: 'Inference engine + version', required: true, mono: false,
    hint: 'เช่น vllm 0.21.1 / e.g. vllm 0.21.1' },
  { key: 'quantization', th: 'การบีบอัดโมเดล', en: 'Quantization', required: false, mono: false,
    hint: 'เช่น Q8_0 หรือเว้นว่างถ้าไม่ได้บีบอัด / e.g. Q8_0, or blank if none.' },
  { key: 'system_prompt_version', th: 'เวอร์ชัน system prompt', en: 'System prompt version', required: true, mono: true,
    hint: 'ไม่มีใน manifest จึงไม่ถูกเทียบ / Not in the manifest, so it is not compared.' },
  { key: 'evaluator_prompt_version', th: 'เวอร์ชัน prompt ผู้ให้คะแนน', en: 'Evaluator prompt version', required: true, mono: true,
    hint: 'ต้องตรงกับ manifest และเป็นเวอร์ชันที่ผ่านเกณฑ์ / Must match the manifest; the agreement verdict is recomputed on this version’s own rows.' },
  { key: 'rubric_version', th: 'เวอร์ชันเกณฑ์ PIS-7', en: 'PIS-7 rubric version', required: true, mono: true,
    hint: 'ต้องตรงกับ manifest / Must match the manifest.' },
] as const;
export type TextKey = (typeof TEXT_FIELDS)[number]['key'];

export const DECODING_FIELDS = [
  { key: 'temperature', th: 'อุณหภูมิ', en: 'Temperature', int: false },
  { key: 'top_p', th: 'ค่า top-p', en: 'Top-p', int: false },
  { key: 'max_tokens', th: 'จำนวนโทเคนสูงสุด', en: 'Max tokens', int: true },
  { key: 'seed', th: 'ค่า seed', en: 'Seed', int: true },
] as const;
export type DecodingKey = (typeof DECODING_FIELDS)[number]['key'];

// The server's own limits (ModelLockSchema): 200 for each text field, 4000 for the note.
const TEXT_MAX = 200;
export const NOTE_MAX = 4000;

/**
 * Would the server refuse this value as a manifest mismatch (services/model-lock.js manifestDiff)? It
 * compares the declared evaluator_prompt_version and rubric_version, and each declared decoding value
 * the manifest states — numerically, so "0.0" and 0 agree. A blank field is not compared. The engine
 * is pre-filled from the manifest but never compared.
 */
export function differsFromManifest(field: string, raw: string, expected: string | null): boolean {
  const v = raw.trim();
  if (expected == null || !v) return false;
  if (field.startsWith('decoding.')) return Number(v) !== Number(expected);
  if (field === 'evaluator_prompt_version' || field === 'rubric_version') return v !== expected;
  return false;
}

export interface EnvRow { id: number; key: string; value: string }
export interface LockForm {
  text: Record<TextKey, string>;
  decoding: Record<DecodingKey, string>;
  // A STATED "no seed" (sent as seed: null), distinct from leaving the seed undeclared (omitted).
  noSeed: boolean;
  env: EnvRow[];
  note: string;
  // Field ids the operator has edited. The manifest pre-fill never overwrites one of these.
  touched: string[];
}

export function emptyForm(): LockForm {
  return {
    text: { weights_sha256: '', inference_engine: '', quantization: '', system_prompt_version: '', evaluator_prompt_version: '', rubric_version: '' },
    decoding: { temperature: '', top_p: '', max_tokens: '', seed: '' },
    noSeed: false,
    env: [{ id: 1, key: '', value: '' }],
    note: '',
    touched: [],
  };
}

const SHA256 = /^[0-9a-fA-F]{64}$/;
const DECIMAL = /^-?(?:\d+\.?\d*|\.\d+)$/;
const INTEGER = /^-?\d+$/;

// The comparable form of a manifest decoding value: a number, or the `default` of { default, env, min }
// (the same reading as services/model-lock.js decodingValue).
export function decodingValue(v: ManifestDecodingValue | undefined): number | null {
  if (v && typeof v === 'object') return typeof v.default === 'number' ? v.default : null;
  return typeof v === 'number' ? v : null;
}

const expectedOf = (m: EvaluatorLockManifest | null | undefined): ManifestExpectedForCandidate | null =>
  (m && m.ok ? m.expected_for_candidate : null);

/**
 * What the manifest says for one form field, as the string the field would hold — or null where the
 * manifest states nothing for it. Field ids: a TextKey, or `decoding.<key>`.
 */
export function manifestValue(m: EvaluatorLockManifest | null | undefined, field: string): string | null {
  const e = expectedOf(m);
  if (!e) return null;
  if (field === 'evaluator_prompt_version') return e.prompt_version ?? null;
  if (field === 'rubric_version') return e.rubric_version ?? null;
  if (field === 'inference_engine') return e.declared?.engine ?? null;
  if (field.startsWith('decoding.')) {
    const k = field.slice('decoding.'.length);
    if (!e.decoding || !(k in e.decoding)) return null;
    const v = decodingValue(e.decoding[k]);
    return v == null ? null : String(v);
  }
  return null;
}

/** Fill every field the manifest states that is still empty and that the operator has not touched. */
export function applyPrefill(form: LockForm, m: EvaluatorLockManifest | null | undefined): LockForm {
  const text = { ...form.text };
  const decoding = { ...form.decoding };
  for (const k of ['evaluator_prompt_version', 'rubric_version', 'inference_engine'] as const) {
    const v = manifestValue(m, k);
    if (v != null && !text[k] && !form.touched.includes(k)) text[k] = v;
  }
  for (const k of ['temperature', 'top_p', 'max_tokens', 'seed'] as const) {
    const id = `decoding.${k}`;
    const v = manifestValue(m, id);
    if (v != null && !decoding[k] && !form.touched.includes(id)) decoding[k] = v;
  }
  return { ...form, text, decoding };
}

export interface Validation {
  // Keyed by field id: a TextKey, `decoding.<key>`, `env.<rowId>.key`, `note`.
  errors: Record<string, string>;
  // Required text fields still empty.
  missing: TextKey[];
}

function numberError(raw: string, key: DecodingKey, int: boolean): string | null {
  if (!(int ? INTEGER : DECIMAL).test(raw)) {
    return int ? 'ต้องเป็นจำนวนเต็ม / Must be a whole number.' : 'ต้องเป็นตัวเลข / Must be a number.';
  }
  const n = Number(raw);
  if (int && !Number.isSafeInteger(n)) return 'ตัวเลขใหญ่เกินไป / Too large.';
  if (key === 'max_tokens' && n < 1) return 'ต้องมากกว่า 0 / Must be at least 1.';
  if (key === 'top_p' && (n < 0 || n > 1)) return 'ต้องอยู่ระหว่าง 0 ถึง 1 / Must be between 0 and 1.';
  if (key === 'temperature' && n < 0) return 'ต้องไม่ติดลบ / Must not be negative.';
  return null;
}

export function validate(form: LockForm): Validation {
  const errors: Record<string, string> = {};
  const missing: TextKey[] = [];
  for (const f of TEXT_FIELDS) {
    const v = form.text[f.key].trim();
    if (!v) { if (f.required) missing.push(f.key); continue; }
    if (v.length > TEXT_MAX) errors[f.key] = `ยาวเกิน ${TEXT_MAX} ตัวอักษร / Longer than ${TEXT_MAX} characters.`;
  }
  const sha = form.text.weights_sha256.trim();
  if (sha && !SHA256.test(sha)) {
    errors.weights_sha256 = /^[0-9a-fA-F]*$/.test(sha)
      ? `ต้องมี 64 ตัว ตอนนี้มี ${sha.length} ตัว / Must be 64 characters; this is ${sha.length}.`
      : 'มีอักขระที่ไม่ใช่เลขฐานสิบหก (0–9, a–f) / Contains a character that is not hexadecimal (0–9, a–f).';
  }
  for (const f of DECODING_FIELDS) {
    if (f.key === 'seed' && form.noSeed) continue;
    const raw = form.decoding[f.key].trim();
    if (!raw) continue;
    const e = numberError(raw, f.key, f.int);
    if (e) errors[`decoding.${f.key}`] = e;
  }
  const seen = new Set<string>();
  for (const r of form.env) {
    const k = r.key.trim();
    if (!k && !r.value.trim()) continue;
    if (!k) { errors[`env.${r.id}.key`] = 'ใส่ชื่อของรายการนี้ / Name this entry.'; continue; }
    if (seen.has(k)) errors[`env.${r.id}.key`] = 'ชื่อซ้ำกับรายการก่อนหน้า / Same name as an earlier entry.';
    seen.add(k);
  }
  if (form.note.length > NOTE_MAX) errors.note = `ยาวเกิน ${NOTE_MAX.toLocaleString()} ตัวอักษร / Longer than ${NOTE_MAX.toLocaleString()} characters.`;
  return { errors, missing };
}

/** The POST body. Blank optional values are omitted, never sent as empty strings or zeros. */
export function buildBody(form: LockForm, confirmRelock?: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of TEXT_FIELDS) {
    const v = form.text[f.key].trim();
    if (v) body[f.key] = v;
  }
  const decoding: Record<string, number | null> = {};
  for (const f of DECODING_FIELDS) {
    const raw = form.decoding[f.key].trim();
    if (raw) decoding[f.key] = Number(raw);
  }
  if (form.noSeed) decoding.seed = null;
  if (Object.keys(decoding).length) body.decoding = decoding;
  const env: Record<string, string> = {};
  for (const r of form.env) if (r.key.trim()) env[r.key.trim()] = r.value.trim();
  if (Object.keys(env).length) body.environment = env;
  if (form.note.trim()) body.note = form.note.trim();
  if (confirmRelock) body.confirm_relock = confirmRelock;
  return body;
}

// ---- copy ------------------------------------------------------------------------------------------

// One bilingual reason per blocker. Pinned to the backend's vocabulary by backend-mirrors.test.ts: a
// blocker the backend can send and this map cannot name would render as a bare key.
export const BLOCKER_COPY: Record<EvaluatorLockBlocker, { th: string; en: string }> = {
  no_candidate: { th: 'ยังไม่มีโมเดลผู้ท้าชิงที่ให้คะแนนคู่ขนานไว้', en: 'No candidate model has shadow-scored any audited PLE yet.' },
  verdict_unavailable: { th: 'คำนวณผลความสอดคล้องกับผู้ตรวจไม่ได้', en: 'The agreement verdict could not be computed.' },
  gate_not_passed: { th: 'ผู้ท้าชิงยังไม่ผ่านเกณฑ์ตัดสินเทียบกับผู้ตรวจที่เป็นมนุษย์', en: 'The candidate has not cleared the decisive threshold against the human auditors.' },
  candidate_not_evaluator: { th: 'ผู้ให้บริการของผู้ท้าชิงใช้เป็นผู้ให้คะแนน PIS-7 ไม่ได้', en: 'The candidate’s provider cannot serve as the PIS-7 evaluator.' },
  candidate_not_serving: { th: 'ผู้ท้าชิงไม่ใช่ผู้ให้บริการที่ให้คะแนนอยู่ตอนนี้', en: 'The candidate is not the provider serving evaluate.' },
  manifest_unavailable: { th: 'ไม่มี model manifest ที่ใช้ผูกการล็อกได้', en: 'There is no usable model manifest to bind the lock to.' },
  manifest_mismatch: { th: 'ผู้ท้าชิงไม่ตรงกับ model manifest', en: 'The candidate does not match the model manifest.' },
  migration_required: { th: 'ฐานข้อมูลยังไม่พร้อม ต้องรัน migration ก่อน', en: 'The database needs a migration before a manifest-bound lock.' },
  lock_table_unreadable: { th: 'อ่านตารางบันทึกการล็อกไม่ได้', en: 'The lock table could not be read.' },
};

// Titles for a refused POST. The body's own `error` (bilingual) is shown beneath as the detail.
export const POST_ERROR_TITLE: Record<string, string> = {
  invalid_declaration: 'ข้อมูลที่ประกาศไม่ครบหรือไม่ถูกต้อง / The declaration was refused as incomplete or malformed',
  confirmation_required: 'ต้องยืนยันการแทนที่การล็อก / Replacing the lock needs the typed confirmation',
  gate_not_passed: 'ผู้ท้าชิงยังไม่ผ่านเกณฑ์ จึงยังไม่ได้ล็อก / Not locked: the candidate has not cleared the gate',
  candidate_not_evaluator: 'ผู้ท้าชิงใช้เป็นผู้ให้คะแนนไม่ได้ / Not locked: the candidate cannot be the evaluator',
  candidate_not_serving: 'ผู้ท้าชิงไม่ได้ให้คะแนนอยู่ / Not locked: the candidate is not serving evaluate',
  manifest_mismatch: 'ค่าที่ประกาศไม่ตรงกับ model manifest / Not locked: the declaration does not match the manifest',
  manifest_unavailable: 'อ่าน model manifest ไม่ได้ / Not locked: no usable model manifest',
  migration_required: 'ต้องรัน migration ก่อน / Not locked: a database migration is needed',
  lock_state_unreadable: 'อ่านสถานะการล็อกไม่ได้ / Not locked: the lock state could not be read',
  verdict_unavailable: 'คำนวณผลความสอดคล้องไม่ได้ / Not locked: the agreement verdict could not be computed',
  lock_record_unconfirmed: 'บันทึกการล็อกไม่ได้รับการยืนยัน / Not locked: the lock record was not confirmed',
  lock_not_applied: 'บันทึกค่าการล็อกไม่สำเร็จ / Not locked: the lock settings could not be written',
  audit_write_failed: 'บันทึก audit log ไม่สำเร็จ / Not locked: the audit entry could not be written',
  rollback_incomplete: 'ย้อนกลับได้ไม่ครบ ต้องแก้ไขด้วยมือ / Rollback incomplete: manual repair is needed',
};
export const POST_ERROR_FALLBACK = 'ล็อกไม่สำเร็จ / The lock was not applied';

// ---- formatting ------------------------------------------------------------------------------------

export const shortSha = (s: string | null | undefined, n = 12): string => (s ? `${s.slice(0, n)}…` : '—');

/** th-TH date and time, as AiProviderPanel prints a lock time. An unparseable value is shown as sent. */
export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('th-TH');
}

/** A diff value: null is "none", an array is its items, anything else its text. */
export function fmtValue(v: unknown): string {
  if (v == null) return '— (ไม่มี / none)';
  if (Array.isArray(v)) return v.length ? v.map((x) => (x == null ? 'null' : String(x))).join(', ') : '— (ไม่มี / none)';
  return String(v);
}

export const fmtNum = (v: number | null | undefined, digits = 3): string =>
  (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—');

// ---- the lock as other screens report it --------------------------------------------------------

// Why the lock check reads Down, in words (services/model-lock.js modelLockCheck). A reason this map
// does not know is shown by its key rather than dropped. Pinned to services/model-lock.js by
// backend-mirrors.test.ts. Used by /admin/ai-readiness.
export const LOCK_REASON: Record<string, string> = {
  evaluator_changed_since_lock: 'ส่วนผู้ให้คะแนนใน manifest ที่รันอยู่ต่างจากที่ล็อกไว้ / The evaluator part of the live manifest differs from what was frozen.',
  live_manifest_unknown: 'อ่านหรือยืนยัน manifest ที่รันอยู่ไม่ได้ / The live manifest could not be read or verified.',
  lock_not_bound_to_manifest: 'การล็อกนี้ไม่ได้ผูกกับ manifest ต้องแทนที่ที่หน้า Model Lock / This lock names no evaluator digest (taken before binding, or a flag with no record). Replace it on Model Lock.',
  lock_record_unmigrated: 'ตารางบันทึกการล็อกยังไม่ได้ migrate / The lock table has not been migrated for the manifest columns.',
  lock_record_unreadable: 'อ่านบันทึกการล็อกไม่ได้ / The lock record could not be read.',
};
export const LOCK_NOTE: Record<string, string> = {
  tutor_or_router_changed_since_lock: 'ส่วนผู้สอนหรือตัวจัดเส้นทางเปลี่ยนหลังล็อก เครื่องมือวัดไม่เปลี่ยน / The tutor or router changed since the lock; the scoring instrument did not.',
};

// Why a lock in force is not bound to the model manifest, by what /admin/ai-providers says is behind
// it (services/model-lock.js lockInForce). Each is its own sentence: "unreadable" is not "missing".
// Used by AiProviderPanel.
export const UNBOUND_COPY: Record<string, string> = {
  none: 'ไม่มีบันทึกการล็อกรองรับ ล็อกไว้ด้วยปุ่มเดิมหรือด้วยมือ / No lock record is behind this flag: it was set by the retired quick-lock switch or by hand, so nothing records what it froze.',
  found: 'บันทึกการล็อกนี้ทำก่อนผูกกับ model manifest / This lock was declared before locks were bound to the model manifest, so it names no evaluator digest.',
  migration_pending: 'ตารางบันทึกการล็อกยังไม่ได้ migrate จึงยังผูกกับ manifest ไม่ได้ / The lock table has not been migrated yet, so no lock can carry a manifest binding.',
  unreadable: 'อ่านบันทึกการล็อกไม่ได้ จึงบอกไม่ได้ว่าผูกกับ manifest หรือไม่ / The lock record could not be read, so whether it is bound to the manifest is unknown.',
};
