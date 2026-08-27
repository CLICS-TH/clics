-- Migration: retention policy + the monthly security review record
-- (CREC082 Data Management & Protection Plan §8, ICF §11, Infrastructure Statement "Security review").
--
-- Two separate commitments, neither of which existed in the system.
--
-- RETENTION §8: "ข้อมูลวิจัยเก็บไม่เกิน 5 ปีหลังสิ้นสุดโครงการ แล้วทำลายหรือทำให้ไม่สามารถเชื่อมโยง
-- กลับได้ตาม data destruction policy. ข้อมูลการเงินเก็บตามระเบียบการเงิน/บัญชีที่เกี่ยวข้องและแยกจาก
-- research dataset."
--
-- Note there is NO scheduled deletion job, deliberately. The deadline is five years after a project
-- that has not started — around 2031. A cron written today, unattended for five years, executing
-- irreversible deletes against a schema that will have changed repeatedly, is a larger risk than the
-- one it manages. What the protocol needs is that the policy is recorded, the deadline is
-- computable, the affected set is enumerable in advance, and execution is audited. See
-- backend/src/services/retention.js; a human runs it once, when it is due.
--
-- SECURITY REVIEW: "ทบทวนด้าน security รายเดือนตามแผน CCME 8.0 รวมถึง access/audit review และ
-- incident review" — three named parts, so the record has three fields rather than one free-text
-- box. An unstructured note cannot answer "was access reviewed in March?".
--
-- Idempotent. Apply to prod Supabase BEFORE deploying the backend that reads these.

-- The retention clock. NULL project_end_date = the study has not ended, so nothing is due and
-- nothing can run. app_settings.value is numeric, so the date lives in value_text (added by
-- db/migration-provider-switch.sql).
insert into public.app_settings (key, value, value_text) values
  ('project_end_date', 0, null),
  ('retention_years',  5, null)
on conflict (key) do nothing;

-- One row per monthly review. The point is that "we review security monthly" becomes a checkable
-- claim instead of a sentence in a document.
create table if not exists public.security_reviews (
  id            uuid primary key default gen_random_uuid(),
  -- The month under review, stored as its first day so a unique index enforces one review per month.
  period_month  date not null unique,
  reviewed_by   uuid not null references public.professionals(id),
  reviewed_at   timestamptz not null default now(),

  -- The three parts the Infrastructure Statement names. Separate columns because a reviewer who
  -- covered access but not incidents should produce a record that says so.
  access_review   text,   -- who has what role; any account that should have been removed
  audit_review    text,   -- anything anomalous in audit_log
  incident_review text,   -- privacy/security incidents this period, and their disposition

  -- Explicit rather than inferred from empty text: "we looked and found nothing" and "we did not
  -- look" are different facts, and only one of them keeps the promise.
  incidents_found boolean not null default false,
  notes           text,
  created_at      timestamptz default now()
);

create index if not exists security_reviews_period_idx on public.security_reviews (period_month desc);

alter table public.security_reviews enable row level security;
drop policy if exists security_reviews_no_access on public.security_reviews;
create policy security_reviews_no_access on public.security_reviews for all using (false);

-- ---------------------------------------------------------------------------------------------
-- Model Lock provenance per score (CREC082 Primary Evaluator Model Lock Record V1.0, §10.2).
--
-- The Record asks for the weights SHA-256, inference engine, quantization, decoding parameters
-- (temperature / top_p / max tokens / seed) and container/OS, frozen before the first participant.
-- The system stamped model_version / prompt_version / rubric_version; the rest were blanks in a
-- Word document, which makes the lock an assertion rather than a checkable fact.
--
-- What a running system can know: the decoding parameters it actually sent, and the model the
-- server answered with. What it cannot: the weights checksum, which is not readable over an
-- inference API. That one is DECLARED once at lock time (app_settings.evaluator_weights_sha256) and
-- stamped onto every score — so a score produced before the lock says "not locked" on its face, and
-- a mid-pilot re-declaration shows up as two different fingerprints either side of the change.
alter table public.ai_evaluations add column if not exists provenance jsonb;

comment on column public.ai_evaluations.provenance is
  'The configuration that produced this score: provider, model, decoding parameters as SENT, the '
  'declared Model Lock weights checksum, and config_fingerprint (a hash over the set). Two scores '
  'with different fingerprints did not come from the same locked configuration. NULL for scores '
  'produced before this column existed.';

-- Index the fingerprint: "which scores came from configuration X?" is the §10.2 audit question.
create index if not exists ai_evaluations_fingerprint_idx
  on public.ai_evaluations ((provenance ->> 'config_fingerprint'));

-- Declared at lock time, NULL until then. app_settings.value is numeric, so the digest lives in
-- value_text (added by db/migration-provider-switch.sql).
insert into public.app_settings (key, value, value_text) values
  ('evaluator_weights_sha256', 0, null)
on conflict (key) do nothing;
