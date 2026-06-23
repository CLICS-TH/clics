// Shared API-response shapes for the admin/auditor dashboard pages. These mirror the JSON returned
// by backend/src/routes/{admin,superadmin,auditor}.js — only the fields the front-end actually reads
// are typed here. Kept in one place so the shapes can't drift across the pages that consume them.

// The error carried by a non-2xx / network response. apiFetch's own envelopes are strings; backend
// validation failures resolve a zod-flatten object ({ fieldErrors, formErrors }). Callers either
// String() it for display or read .fieldErrors — both are covered here.
export type ApiError =
  | string
  | { fieldErrors?: Record<string, string[] | undefined>; formErrors?: string[] };

// apiFetch resolves an { error } envelope on network/non-2xx instead of rejecting (see lib/api.ts),
// so mutation responses are "the success body OR an error envelope". This is the common shape callers
// narrow against (`res?.error`, `res?.id`, …).
export type ApiResult<T> = Partial<T> & { error?: ApiError };

// Render an ApiError for display: a zod-flatten object → its fieldErrors JSON; a string → itself;
// anything else (undefined / unexpected) → the caller's fallback. Single home for the
// `error?.fieldErrors ? JSON.stringify : string` dance repeated across the create/edit handlers.
export function formatApiError(error: ApiError | undefined, fallback: string): string {
  if (error && typeof error === 'object' && error.fieldErrors) return JSON.stringify(error.fieldErrors);
  if (typeof error === 'string') return error;
  return fallback;
}

// A specialty reference, embedded (PostgREST) on CLE rows / users via specialty_id.
export interface SpecialtyRef {
  id?: string;
  council_id?: string | null;
  code?: string;
  name_th: string;
  name_en: string;
}

// A physician/professional, as embedded in CLE rows and transcript headers.
export interface Professional {
  full_name_th?: string | null;
  full_name_en?: string | null;
  pseudonym?: string | null;
  specialty?: string | null;
}

// CLE row from /admin/cles and /admin/cles/flagged. C-screen pass flags (c1_pass…c6_pass) are read
// dynamically by key, so they live in an index signature alongside the named fields.
export interface CleRow {
  id: string;
  status: string;
  turn_count?: number;
  token_count?: number;
  started_at: string;
  council_id?: string | null;
  auditor_id?: string | null;
  is_test?: boolean;
  specialty_id?: string | null;
  specialties?: SpecialtyRef | null;   // embedded specialty (name) for display
  professionals?: Professional | null;
  // C-screen pass flags (c1_pass … c6_pass) are read by computed key (`p[c + '_pass']`), so the row
  // carries a string index signature for them. `unknown` (used only in truthiness checks) keeps the
  // named fields above precisely typed while allowing the dynamic flag reads.
  [key: string]: unknown;
}

// Auditor row from /admin/auditors.
export interface Auditor {
  id: string;
  full_name_th?: string | null;
  specialty_id?: string | null;
  specialties?: SpecialtyRef | null;
}

// Council row from /admin/councils.
export interface Council {
  id: string;
  code: string;
  name_th: string;
  name_en: string;
  active?: boolean;
}

// /admin/cles/:id/transcript — the CLE plus its messages.
export interface TranscriptMessage {
  role: string;
  content: string;
  refs?: { source: string; title?: string }[];
  socratic_question?: string;
}
export interface CleTranscript {
  cle: {
    title?: string | null;
    chief_complaint?: string | null;
    status: string;
    turn_count?: number | null;
    professionals?: Professional | null;
    specialties?: SpecialtyRef | null;
  };
  messages?: TranscriptMessage[];
  error?: unknown;
}

// /admin/icc + /admin/stats ICC shape (one rater-reliability stat block; null when degenerate).
export type IccStat = {
  icc: number | null;
  lower: number | null;
  upper: number | null;
  n: number;
  interpretation: string;
} | null;
export interface IccData {
  overall: IccStat;
  per_domain?: Record<string, IccStat>;
  per_council?: Record<
    string,
    { council: Council | null; overall: IccStat } | null | undefined
  >;
  n?: number;
}

// /admin/stats — per-status CLE counts (every key optional; cleStatusCards tolerates gaps).
export type CleStats = Record<string, number>;

// /admin/physicians/:id/profile — the physician header, their sessions, and the LPDP series.
export interface ProfileScore {
  composite_score: number | string;
}
export interface ProfileSession {
  id: string;
  status: string;
  chief_complaint?: string | null;
  folder_name?: string | null;
  started_at: string;
  turn_count?: number;
  ai?: ProfileScore | null;
  audits?: { composite_score: number | string; auditor_name?: string | null }[];
}
export interface PhysicianProfile {
  physician?: {
    full_name_th?: string | null;
    full_name_en?: string | null;
    pseudonym?: string | null;
    specialty?: string | null;
  };
  sessions?: ProfileSession[];
  lpdp?: ProfileScore[];
}

// /auditor/cles/:id — transcript + (post-submit) the auditor's own score and the AI evaluation.
export interface AuditorPle {
  messages?: TranscriptMessage[];
  audit_score?: {
    d1: number; d2: number; d3: number; d4: number;
    d5: number; d6: number; d7: number;
    notes?: string | null;
  } | null;
  ai_evaluation?: {
    composite_score: number | string;
    d1?: number; d2?: number; d3?: number; d4?: number;
    d5?: number; d6?: number; d7?: number;
    domain_rationale?: Record<string, string> | null;
  } | null;
  error?: unknown;
}

// GET /auditor/calibration — this auditor's mean PIS-7 (d1–d7) vs the AI's, across scored CLEs.
export interface AuditorCalibration {
  n: number;
  auditor: Record<string, number> | null;
  ai: Record<string, number> | null;
}
