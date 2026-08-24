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
  assignment_count?: number;   // how many auditors are assigned (multi-auditor pilot)
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
  // Peer calibration (toggle): mean PIS-7 across the OTHER auditors who scored this CLE (self
  // excluded), returned only post-submit and when peer_n >= 1. peer_n = number of other auditors;
  // when peer_n === 1 the "average" is that single other auditor's scores, so the UI relabels it
  // ("the other auditor" rather than "the auditor average").
  peer_avg?: Record<string, number> | null;
  peer_n?: number;
  error?: unknown;
}

// GET /auditor/calibration — this auditor's mean PIS-7 (d1–d7) vs the AI's, across scored CLEs.
// `peer` (the auditor-cohort average) is present only when the peer_calibration toggle is on.
export interface AuditorCalibration {
  n: number;
  auditor: Record<string, number> | null;
  ai: Record<string, number> | null;
  peer?: Record<string, number> | null;
}

// GET /admin/payouts (superadmin) — the real-name compensation payout pipeline (owed/paid/outstanding).
export interface PayoutRecipient {
  physician_id: string;
  name: string | null;
  pseudonym: string | null;
  completed_cles: number;
  owed_thb: number;
  paid_thb: number;
  outstanding_thb: number;
  has_payment_info: boolean;
  account_masked: string | null;
}
export interface PayoutReport {
  rate_thb_per_cle: number;
  cap_cles: number;
  n: number;
  recipients: PayoutRecipient[];
}

// The physician's own saved payment details (GET /auth/payment-info), for read-back/edit.
export interface PaymentInfo {
  account_name: string;
  bank?: string;
  account_no?: string;
  promptpay?: string;
}

// GET /oversight/icc/three-way — the shadow-evaluator three-way agreement report (analyst / ethics /
// superadmin ONLY; see components/ThreeWayIcc.tsx for the blinding rule). One arm = one two-rater
// ICC(2,1) comparison; every arm is computed by the backend on the SAME set of CLEs (those carrying
// all three scores) so the arms are actually comparable, and each still reports its own n.
export interface ThreeWayArm {
  overall: IccStat;
  per_domain?: Record<string, IccStat>;
  n: number;
}
// Honest denominators. `shadow_failed` counts shadow_evaluations rows that carry an `error` and no
// scores — excluded from every ICC, but a first-class result in their own right; a candidate model
// that cannot emit a valid score set some of the time is disqualified regardless of its ICC.
export interface ThreeWayCoverage {
  cles_with_human: number;
  cles_with_ai: number;
  cles_with_shadow: number;
  cles_all_three: number;
  // Cohort-scoped: the candidate's runs on the audited, is_test-filtered CLEs the arms are computed on.
  shadow_failed: number;
  shadow_contract_rate: number | null;
  // Corpus-wide: EVERY run recorded for this candidate. This is the model's real contract rate — the
  // cohort figures above are a subset and can look flattering when few CLEs have been audited yet.
  // Null when the backend could not count them (it falls back to the cohort figures rather than fail).
  shadow_scored_corpus?: number | null;
  shadow_failed_corpus?: number | null;
  shadow_contract_rate_corpus?: number | null;
}
export interface ThreeWayIccData {
  arms?: {
    ai_vs_human: ThreeWayArm | null;
    shadow_vs_human: ThreeWayArm | null;
    ai_vs_shadow: ThreeWayArm | null;
  };
  coverage?: ThreeWayCoverage;
  // available=false when the shadow table is absent (migration deliberately unapplied) or empty.
  shadow?: { available: boolean; provider: string | null; model_version: string | null };
  // apiFetch resolves an {error} envelope instead of rejecting — see lib/api.ts.
  error?: ApiError;
}
