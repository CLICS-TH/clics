-- Migration: the 100% human privacy review (CREC082 ICF §5-6, Local Open-Weight AI Processing
-- Declaration "Privacy gate", Infrastructure Statement "Privacy review").
--
-- The protocol commits to automated PII/PHI screening PLUS a human reading every transcript before
-- it reaches an expert rater or the primary analysis, and to quarantining / de-identifying /
-- excluding anything that carries patient data. Only the automated half was built: rimpl's
-- pii-filter scrubs the OUTBOUND cloud call, and a scored session entered the auditor queue
-- immediately. The stored transcript — which is deliberately kept RAW as the evidentiary record —
-- reached a third party with no human ever having looked at it.
--
-- A CLEARANCE, NOT A STATUS. The obvious shape is a 'privacy_review' status between 'evaluated' and
-- assignable, but the scoring lifecycle and the privacy clearance are different axes: a session is
-- scored or not, and separately cleared or not. One column would have meant rewriting a dozen
-- status filters across the admin queue, auditor queue, sampler, result release and the dashboard's
-- types. See backend/src/lib/privacy-review.js for the four exposure points this replaces that with.
--
-- Idempotent. Apply to prod Supabase BEFORE deploying the backend that reads these columns.

alter table public.cles
  add column if not exists privacy_review_status text not null default 'pending',
  add column if not exists privacy_reviewed_at   timestamptz,
  add column if not exists privacy_reviewed_by   uuid references public.professionals(id),
  add column if not exists privacy_review_note   text;

alter table public.cles drop constraint if exists cles_privacy_review_status_chk;
alter table public.cles add constraint cles_privacy_review_status_chk
  check (privacy_review_status in ('pending', 'passed', 'redacted', 'quarantined', 'excluded'));

comment on column public.cles.privacy_review_status is
  'Human privacy clearance. pending = nobody has looked yet (the default, and the honest state for '
  'any session predating this gate). passed = read and safe. redacted = something was found and '
  'fixed; the remainder is cleared. quarantined = withheld pending a decision. excluded = removed '
  'from the study. Only passed and redacted release a session to a rater.';

comment on column public.cles.privacy_review_note is
  'Required for anything other than a clean pass. A quarantine with no stated reason is '
  'unreviewable later, and "why was this session excluded?" is a question the ethics committee is '
  'entitled to ask about any row.';

-- The queue query: pending sessions, oldest first, within a council.
create index if not exists cles_privacy_review_idx
  on public.cles (privacy_review_status, ended_at) where status = 'evaluated';

-- The gate itself. ON by default, because the protocol's promise is 100% — the safe default is the
-- one that keeps it. A superadmin lowering it is a recorded deviation, not a silent omission.
insert into public.app_settings (key, value) values ('privacy_review_required', 1)
on conflict (key) do nothing;

-- NOTE ON EXISTING ROWS. Every current CLE defaults to 'pending', so the 14 already-evaluated
-- sessions in production drop out of the auditor queue until someone reviews them. That is the
-- correct behaviour and not an accident: backfilling them to 'passed' would assert that a review
-- happened when none did, which is exactly the claim this gate exists to make true.
--
-- If an in-flight sandbox round needs to keep running while the reviewer screen is rolled out, the
-- honest lever is the setting, not the data:
--     update public.app_settings set value = 0 where key = 'privacy_review_required';
-- That records a deliberate, reversible decision to run without the gate. Do not mass-update
-- privacy_review_status instead.
