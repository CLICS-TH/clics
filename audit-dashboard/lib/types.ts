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

// A specialty reference, embedded (PostgREST) on PLE rows / users via specialty_id.
export interface SpecialtyRef {
  id?: string;
  council_id?: string | null;
  code?: string;
  name_th: string;
  name_en: string;
}

// A physician/professional, as embedded in PLE rows and transcript headers.
export interface Professional {
  full_name_th?: string | null;
  full_name_en?: string | null;
  pseudonym?: string | null;
  specialty?: string | null;
}

// PLE row from /admin/ples and /admin/ples/flagged. C-screen pass flags (c1_pass…c6_pass) are read
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
  ple_code?: string | null;
  ended_at?: string | null;
  // CREC082 ICF §5-6 human privacy clearance. Only 'passed' and 'redacted' release a session to a
  // rater; see backend/src/lib/privacy-review.js.
  privacy_review_status?: 'pending' | 'passed' | 'redacted' | 'quarantined' | 'excluded';
  privacy_reviewed_at?: string | null;
  privacy_review_note?: string | null;
  // A RATER's stop-and-report, kept apart from the reviewer's decision above: `privacy_concern_by` is
  // who raised it, never who cleared it. Open until any privacy decision resolves it.
  privacy_concern_open?: boolean;
  privacy_concern_by?: string | null;
  privacy_concern_at?: string | null;
  privacy_concern_note?: string | null;
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

// /admin/ples/:id/transcript — the PLE plus its messages.
export interface TranscriptMessage {
  role: string;
  content: string;
  refs?: { source: string; title?: string }[];
  socratic_question?: string;
}
export interface CleTranscript {
  ple: {
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
// A kappa result. `kappa` is null when every rating fell in one category — perfect agreement AND
// perfect chance agreement, i.e. 0/0 — which is undefined rather than 1.0.
export interface KappaStat {
  kappa: number | null;
  n: number;
  n_excluded?: number;
  weights?: string;
  scale?: [number, number];
  exact_agreement?: number;
  interpretation: string;
}

export interface IccData {
  overall: IccStat;
  per_domain?: Record<string, IccStat>;
  per_council?: Record<
    string,
    { council: Council | null; overall: IccStat } | null | undefined
  >;
  n?: number;
  // Cohort transparency: the rater distribution behind the headline figure, never a filter on it.
  min_auditors?: number;
  auditors_per_cle?: Record<string, number>;
  n_at_target?: number;
  n_below_target?: number;
  overall_at_target?: IccStat;
  // Human interrater. ICC(1,1) assumes auditors are drawn per PLE; ICC(A,k) assumes a fixed panel.
  // Both are reported because which is legitimate depends on how assignment actually ran.
  // model_alt is optional on both: only the average-measures result carries a second notation
  // (McGraw & Wong's ICC(A,k) and Shrout & Fleiss's ICC(2,k) name the same quantity).
  inter_auditor?: IccStat & { model?: string; model_alt?: string; n_ratings?: number; k0?: number };
  inter_auditor_average?: (IccStat & { model?: string; model_alt?: string; k?: number }) | null;
  inter_auditor_note?: string;
  // The same ICC(1,1) per PIS-7 domain, so it reads on one scale with inter_auditor above. A null
  // entry means the domain had no multi-rated episode; an entry whose `icc` is null carries the
  // reason in `interpretation` (usually every rater choosing the same value).
  inter_auditor_per_domain?: Record<string, (IccStat & { model?: string; model_alt?: string }) | null>;
  // SAP "Additional agreement" — ordinal-aware, chance-corrected.
  weighted_kappa?: { domains: Record<string, KappaStat | null>; pooled: KappaStat | null };
}

// /admin/stats — per-status PLE counts (every key optional; pleStatusCards tolerates gaps).
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

// /auditor/ples/:id — transcript + (post-submit) the auditor's own score and the AI evaluation.
// The three values the assessment form offers and the API accepts. `string` here would let a typo
// through on a fixed three-value concept — the sibling concept in this file (IccVerdictState) is
// already a union, and this one had no reason not to be.
// SOURCE OF TRUTH: backend/src/lib/schemas.js ANCHOR_CLARITY (see components/DomainScorer.tsx).
export type AnchorClarity = 'clear' | 'moderate' | 'ambiguous';

export interface AuditorPle {
  messages?: TranscriptMessage[];
  audit_score?: {
    d1: number; d2: number; d3: number; d4: number;
    d5: number; d6: number; d7: number;
    notes?: string | null;
    // Per-domain anchor clarity, as stored. Present so a submitted assessment reopens showing what
    // the rater actually answered rather than a row of blanks.
    d1_anchor?: AnchorClarity | null; d2_anchor?: AnchorClarity | null; d3_anchor?: AnchorClarity | null;
    d4_anchor?: AnchorClarity | null; d5_anchor?: AnchorClarity | null; d6_anchor?: AnchorClarity | null;
    d7_anchor?: AnchorClarity | null;
    attestations?: Record<string, boolean> | null;
  } | null;
  ai_evaluation?: {
    composite_score: number | string;
    d1?: number; d2?: number; d3?: number; d4?: number;
    d5?: number; d6?: number; d7?: number;
    domain_rationale?: Record<string, string> | null;
    // The configuration behind this score (ai_evaluations.provenance). Read for DISPLAY only — see
    // components/ConsistencyChip.tsx; nothing in here may feed the radar or any ICC arithmetic.
    provenance?: EvaluationProvenance | null;
  } | null;
  // Peer calibration (toggle): mean PIS-7 across the OTHER auditors who scored this PLE (self
  // excluded), returned only post-submit and when peer_n >= 1. peer_n = number of other auditors;
  // when peer_n === 1 the "average" is that single other auditor's scores, so the UI relabels it
  // ("the other auditor" rather than "the auditor average").
  peer_avg?: Record<string, number> | null;
  peer_n?: number;
  // Set when app_settings.calibration_reveal_locked is on: the AI score, the peer average and the
  // discussion are withheld for the whole round, not merely until this auditor submits. The flag
  // exists so the UI can say so — an unexplained empty pane reads as a bug.
  reveal_locked?: boolean;
  error?: unknown;
  // Error envelope only. `code` is the backend's machine-readable reason ('deidentify_unavailable' when
  // RIMPL cannot mask the transcript and the route fails closed with a 503); `httpStatus` is attached
  // by apiFetch to every error response. Together they separate "not yours" from "down for a moment".
  code?: string;
  httpStatus?: number;
}

// GET /auditor/calibration — this auditor's mean PIS-7 (d1–d7) vs the AI's, across scored PLEs.
// `peer` (the auditor-cohort average) is present only when the peer_calibration toggle is on.
export interface AuditorCalibration {
  n: number;
  auditor: Record<string, number> | null;
  ai: Record<string, number> | null;
  peer?: Record<string, number> | null;
  // Set when app_settings.calibration_reveal_locked is on. Without it a withheld radar is
  // byte-identical to the empty state of a rater who has scored nothing.
  locked?: boolean;
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
// ICC(2,1) comparison; every arm is computed by the backend on the SAME set of PLEs (those carrying
// all three scores) so the arms are actually comparable, and each still reports its own n.
// The server's judgement of one arm against its configured threshold. `insufficient` is NOT a
// variant of `fail`: it means the interval spans the threshold (or could not be formed at all), so
// the data cannot answer the question yet. Reading it as a failure would present the absence of
// evidence as evidence against.
export type IccVerdictState = 'pass' | 'fail' | 'insufficient';
export interface IccVerdict {
  state: IccVerdictState;
  threshold: number;
  icc: number | null;
  lower: number | null;
  upper: number | null;
  n: number;
  why: string;
}
export interface ThreeWayArm {
  overall: IccStat;
  per_domain?: Record<string, IccStat>;
  n: number;
  verdict?: IccVerdict | null;
}
// Honest denominators. `shadow_failed` counts shadow_evaluations rows that carry an `error` and no
// scores — excluded from every ICC, but a first-class result in their own right; a candidate model
// that cannot emit a valid score set some of the time is disqualified regardless of its ICC.
export interface ThreeWayCoverage {
  ples_with_human: number;
  ples_with_ai: number;
  ples_with_shadow: number;
  ples_all_three: number;
  // Cohort-scoped: the candidate's runs on the audited, is_test-filtered PLEs the arms are computed on.
  shadow_failed: number;
  shadow_contract_rate: number | null;
  // Corpus-wide: EVERY run recorded for this candidate. This is the model's real contract rate — the
  // cohort figures above are a subset and can look flattering when few PLEs have been audited yet.
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

// GET /oversight/rater-spread. Descriptive only — every figure carries its n, because at pilot scale
// none of them support inference. `gate` answers "how much further apart must the episodes be for a
// 0.75 ICC to be reachable at the current level of rater disagreement", in score points.
export interface RaterSpread {
  ok: true;
  empty?: boolean;
  n_scores: number;
  n_episodes: number;
  n_auditors: number;
  n_multi_rated_episodes: number;
  between_episodes: { sd: number | null; min: number | null; max: number | null; range: number | null };
  comparison_on_shared: {
    n: number;
    human_sd: number | null; ai_sd: number | null;
    human_range: number | null; ai_range: number | null;
  };
  // `measurable: false` when no episode has two raters — rater error is then unknowable from this
  // corpus, and reporting it as 0 would make the requirement look satisfied.
  gate: {
    measurable: boolean;
    why: string | null;
    sd_error?: number | null;
    sd_between_observed?: number | null;
    sd_between_required?: number | null;
    meets?: boolean;
  };
  scale_use: { min: number | null; max: number | null; span_pct_of_scale: number | null };
  per_domain: Record<string, {
    n: number; sd: number | null; modal_value: number | null; modal_share: number | null; distinct: number;
  }>;
  anchor_clarity?: Record<string, {
    answered: number; unanswered: number;
    clear: number; moderate: number; ambiguous: number;
    ambiguous_share: number | null;
  }>;
  scored_between: { first: string; last: string } | null;
  per_auditor: { auditor_id: string; n: number; mean: number | null; sd: number | null; min: number | null; max: number | null }[];
}

// GET / PATCH /admin/booth (superadmin, #214). Mirrors boothSettings() in backend/src/services/booth.js.
// opens_at / closes_at are the stored text, always with an explicit offset. A null count is a failed read,
// not zero. `state` is why the kiosk is or is not taking plays right now.
export type BoothState = 'open' | 'off' | 'not_yet' | 'ended' | 'misconfigured';
/** One admitted case of the booth event, as GET /admin/booth lists it. `on` false = no longer drawn or started. */
export interface BoothCase {
  case_id: string;
  teaser: { th: string; en: string };
  version: string;
  admitted_on: string;
  plays: number | null;
  on: boolean;
}

export interface BoothSettings {
  event_code: string | null;
  enabled: boolean;
  opens_at: string | null;
  closes_at: string | null;
  ceiling_usd: number | null;
  state: BoothState;
  plays: number | null;
  scored: number | null;
  spend_usd: number | null;
  cases: BoothCase[];
}

// GET / PATCH /admin/usage-settings (superadmin). ONE definition, shared by the overview page, the users
// page and the Local AI capacity card, so a setting cannot be typed three different ways. The $ budget
// keys were always here; the token / transcript / evaluation-drain keys arrived with
// db/migration-local-ai-capacity.sql. On a token ceiling, 0 or a missing key means NO cap
// (backend/src/lib/usage.js standardTokenLimit) — never "capped at zero".
export interface UsageSettings {
  standard_limit_usd: number;
  auditor_standard_limit_usd?: number;
  api_budget_pool_usd: number;
  total_used_usd: number;
  auditor_total_used_usd?: number;
  rescue_total_used_usd?: number;
  pilot_test_mode?: boolean;
  clinical_artifacts_enabled?: boolean;
  peer_calibration_enabled?: boolean;
  hold_result_until_audited?: boolean;
  calibration_reveal_locked?: boolean;
  comp_rate_thb?: number;
  comp_cap_cles?: number;
  min_auditors_per_cle?: number;
  // ---- Local AI capacity (bounds mirror UsageSettingsSchema in backend/src/routes/superadmin.js) ----
  standard_limit_tokens?: number | null;          // org token ceiling per physician; 0/null = no cap
  auditor_standard_limit_tokens?: number | null;  // org token ceiling per auditor;   0/null = no cap
  ple_max_transcript_tokens?: number;             // 8000..200000 context tokens
  ple_transcript_warn_pct?: number;               // 50..95 (% of the cap at which the portal warns)
  eval_drain_concurrency?: number;                // 1..8 evaluations in flight from this backend
  eval_p50_seconds?: number;                      // 10..1800, the p50 behind the queue ETA
  eval_drain_exclude_councils?: string;           // comma-separated council CODES; '' = none excluded
}

// GET /health/deep → checks.eval_queue (backend/src/routes/health.js checkEvalQueue). A public readiness
// probe: it answers 503 with the same JSON when degraded, and `error` appears INSIDE eval_queue when the
// queue count itself timed out — then only `drain` is present. Every field is therefore optional and a
// reader renders "—" for whatever is missing rather than assuming the shape.
export interface EvalQueueStatus {
  queued?: number;
  scoring?: number;
  oldest_wait_s?: number;
  // Oldest wait among rows the drain is actually ELIGIBLE to claim — same status, eval_next_at and
  // council partition as claim_ple_evaluations. A row backing off, or one in an excluded council,
  // is not counted. The stuck signal reads this, never the unfiltered oldest_wait_s.
  oldest_claimable_wait_s?: number;
  // The grace this queue is judged against, scaled from its own predicted wait.
  stuck_after_s?: number;
  error?: string;
  // Verdict fields. 'down' means this check is FAILING /health/deep, and `reasons` says why.
  status?: 'up' | 'down';
  reasons?: string[];
  stuck?: boolean;
  drain?: {
    running?: boolean;
    in_flight?: number;
    last_tick_at?: string | null;
    last_error?: string | null;
    // The council partition the last tick claimed under. failed_closed set means it claimed
    // NOTHING — one unrecognised code in the exclude setting stops every evaluation, silently.
    scope?: {
      exclude_codes?: string[];
      include_codes?: string[];
      failed_closed?: string | null;
    } | null;
  };
}
export interface HealthDeep {
  status?: string;
  service?: string;
  checks?: { eval_queue?: EvalQueueStatus };
  // apiFetch resolves an {error} envelope on a network failure — see lib/api.ts.
  error?: ApiError;
}

// ai_evaluations.provenance — the locked configuration behind one score (persisted by
// backend/src/services/ple-evaluation.js). `consistency` is the repeat-scoring record RIMPL MAY attach
// in future (absent today): how many evaluator calls were made and which rule chose the score, e.g.
// rule 'first-of-agreeing-pair' with calls 2, or 'median-of-3' with calls 3. DISPLAY ONLY — it must
// never enter ICC arithmetic or chart data. Everything else in the object is opaque here.
export interface EvaluationConsistency {
  method?: string;
  rule?: string;
  calls?: number;
  max_delta?: number;
  per_call_scores?: number[];
  json_retries?: number;
  extra_input_tokens?: number;
  extra_output_tokens?: number;
  latency_ms?: number;
}
export interface EvaluationProvenance {
  consistency?: EvaluationConsistency | null;
  [key: string]: unknown;
}

// ---- The Primary Evaluator Model Lock (CCME R2, GitHub #75) ----------------------------------------
// GET/POST /admin/evaluator-lock and the lock fields of /admin/ai-providers + /admin/ai-readiness, as
// backend/src/routes/superadmin.js and services/model-lock.js return them.

// Every reason GET /admin/evaluator-lock can give for `can_declare: false`. Pinned against the backend's
// `blockers.push(...)` calls by __tests__/backend-mirrors.test.ts.
export const EVALUATOR_LOCK_BLOCKERS = [
  'no_candidate', 'verdict_unavailable', 'gate_not_passed', 'candidate_not_evaluator', 'candidate_not_serving',
  'manifest_unavailable', 'manifest_mismatch', 'evaluator_live_drift', 'migration_required', 'lock_table_unreadable',
] as const;
export type EvaluatorLockBlocker = (typeof EVALUATOR_LOCK_BLOCKERS)[number];

// What the declaration states about decoding. `seed: null` is a stated "no seed", distinct from an
// omitted key (never declared).
export interface LockDecoding {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  seed?: number | null;
}

// One evaluator_model_lock row (select '*'). The manifest columns are absent on an unmigrated table and
// null on a lock taken before they existed.
export interface EvaluatorLockRecord {
  id?: string;
  locked_at: string;
  locked_by?: string | null;
  provider?: string | null;
  model_version?: string | null;
  weights_sha256?: string | null;
  inference_engine?: string | null;
  quantization?: string | null;
  system_prompt_version?: string | null;
  evaluator_prompt_version?: string | null;
  rubric_version?: string | null;
  decoding?: LockDecoding | null;
  environment?: Record<string, string> | null;
  note?: string | null;
  gate?: IccVerdict | null;
  manifest_sha256?: string | null;
  evaluator_sha256?: string | null;
  manifest?: unknown;
}

// services/agreement.js candidateSummary: the latest (provider, model_version, prompt_version) group.
export interface LockCandidate {
  provider: string | null;
  model_version: string | null;
  prompt_version: string | null;
  rubric_versions: (string | null)[];
}
export interface LockCorpusGroup {
  provider: string | null;
  model_version: string | null;
  prompt_version: string | null;
  rows: number;
  rubric_versions: (string | null)[];
  latest: string | null;
}

// A manifest decoding value: a number, or { default, env, min } for an env-tunable one.
export type ManifestDecodingValue = number | null | { default?: number | null; env?: string; min?: number };

export interface ManifestExpectedForCandidate {
  prompt_version: string | null;
  rubric_version: string | null;
  model_version: string | null;
  provider_declared?: string | null;
  decoding: Record<string, ManifestDecodingValue> | null;
  declared: { engine: string | null; model: string | null } | null;
  evaluator_sha256: string;
}
export type EvaluatorLockManifest =
  | {
    ok: true; sha256: string; file: string; code_match: true; drift_keys: string[];
    expected_for_candidate: ManifestExpectedForCandidate | null;
    // The drift keys in the evaluator's scope (services/model-lock.js evaluatorDriftKeys, #160), and the
    // provider that scope was computed for. Absent from a backend older than #160.
    evaluator_drift_keys?: string[];
    evaluator_provider?: string;
  }
  | { ok: false; code?: string; reason?: string; error?: string; file?: string | null; code_match?: boolean | null };

// services/model-lock.js manifestDiff. `source: 'candidate'` is MEASURED (the shadow rows); 'declaration'
// is what the operator typed. `value`/`expected` are strings, string arrays (candidate_rubric_versions),
// numbers (decoding) or null.
export interface ManifestDiffRow {
  field: string;
  source: 'candidate' | 'declaration' | string;
  value: unknown;
  expected: unknown;
  manifest_path: string;
}

export interface EvaluatorLockState {
  locked_at: string | null;
  current: EvaluatorLockRecord | null;
  in_force: boolean;
  candidate: LockCandidate | null;
  serving_provider: string | null;
  can_declare: boolean;
  blockers: string[];
  // A string, or (evaluator_live_drift) the list of evaluator-scope keys that drift.
  blocker_detail?: Partial<Record<string, string | string[]>>;
  gate: (IccVerdict & { groups?: LockCorpusGroup[] }) | null;
  manifest: EvaluatorLockManifest | null;
  manifest_diff: ManifestDiffRow[] | null;
  migrations_pending?: string[];
  confirm_phrases?: { replace_lock?: string };
}

// POST /admin/evaluator-lock. Success, or one bilingual { error, code, ...detail } body.
export interface EvaluatorLockPostResult {
  ok?: boolean;
  locked_at?: string;
  record?: EvaluatorLockRecord;
  manifest_sha256?: string;
  evaluator_sha256?: string;
  error?: ApiError;
  code?: string;
  httpStatus?: number;
  details?: { fieldErrors?: Record<string, string[] | undefined>; formErrors?: string[] };
  confirm_phrase?: string;
  diff?: ManifestDiffRow[];
  migrations?: string[];
  reason?: string;
  inconsistent?: { step: string; left: string }[];
  detail?: string;
  // 409 evaluator_live_drift (services/model-lock.js evaluatorLiveDrift): the evaluator-scope keys whose
  // live value differs from the manifest, by name only, and the candidate provider they were read for.
  keys?: string[];
  provider?: string | null;
  // lib/api.ts: the answer was not the backend's JSON (a proxy page, an empty body).
  unreadableBody?: boolean;
}

// /admin/ai-providers `evaluator_lock`: whether the lock in force has a record behind it, and whether
// that record carries the evaluator digest. `record` is null-free only while locked.
export interface ProviderEvaluatorLock {
  locked: boolean;
  record: 'found' | 'none' | 'migration_pending' | 'unreadable' | null;
  manifest_bound: boolean | null;
}

// /admin/ai-readiness `manifest`: rimpl's PUBLIC /health/deep block (services/manifest.js health()).
// Each drift entry carries a key and its expected value; free-text live values arrive only hashed. The
// readiness screen shows the KEYS only.
export interface ReadinessManifest {
  sha256: string | null;
  claimed_sha256?: string | null;
  file: string | null;
  code_match: boolean | null;
  drift?: { key: string }[] | null;
  // Added by the backend beside rimpl's block (routes/superadmin.js, #160). Null when it could not be
  // computed, absent from a backend older than #160: either way the screen does not classify.
  evaluator_drift_keys?: string[] | null;
  evaluator_provider?: string | null;
}

// /admin/ai-readiness `model_lock`: services/model-lock.js modelLockCheck (the /health/deep verdict).
export interface ReadinessModelLock {
  status: 'up' | 'down' | 'unknown' | string;
  locked?: boolean | null;
  locked_at?: string | null;
  provider?: string | null;
  manifest_sha256?: string | null;
  evaluator_sha256?: string | null;
  live_sha256?: string | null;
  live_evaluator_sha256?: string | null;
  // The live evaluator DIGEST against the frozen one. It says nothing about live overrides: with
  // reason 'evaluator_live_drift' it is true while the serving configuration has drifted. Meaningful
  // only beside a live_evaluator_sha256: the reasons sent before the live manifest is read carry
  // `match: false` with no live digest, although nothing was compared.
  match?: boolean | null;
  reason?: string;
  // The evaluator-scope keys the running rimpl overrides, by name (never values). Set whenever there are
  // any, so with 'evaluator_changed_since_lock' as well as 'evaluator_live_drift'.
  drift_keys?: string[];
  // With 'live_manifest_unknown': why the live manifest was refused (unreachable, file_not_present,
  // unverified, code_mismatch, malformed — services/model-lock.js MANIFEST_REASONS).
  live_manifest?: string;
  note?: string;
  error?: string;
}
