-- Migration: a Model Lock Record may name the evaluator by model identity (ADR 0012; GitHub #430).
--
-- PREREQUISITE: db/migration-evaluator-model-lock.sql (the evaluator_model_lock table). This file
-- refuses to run without it rather than creating a half-shaped table of its own.
--
-- WHY. CME cannot give a weights digest for the on-prem evaluator. A lock may now name it by versioned
-- model id (model_version, the candidate's measured value) plus the system fingerprint the inference
-- server reports, with weights_sha256 NULL. identity_basis says which kind of record a row is:
--   'weights_sha256'               a declared 64-hex weights digest (every lock before this migration)
--   'model_id+system_fingerprint'  NO weights digest exists; model_version and system_fingerprint name
--                                  the evaluator instead
-- The backend digests the two kinds under different tags (services/model-lock.js LOCK_IDENTITY:
-- clics-lock-declaration/v1 and /v2), so an existing lock's declaration digest does not move.
--
-- DEPLOY ORDER: the backend code ships FIRST. Until this is applied, POST /admin/evaluator-lock answers
-- 503 migration_required naming this file (nothing written), and GET /admin/evaluator-lock lists it in
-- migrations_pending. Scoring under a lock already in force is unaffected. Gate query (returns 2 once
-- applied):
--   select count(*) from information_schema.columns
--    where table_schema = 'public' and table_name = 'evaluator_model_lock'
--      and column_name in ('identity_basis', 'system_fingerprint');
--
-- Idempotent: re-running changes nothing. No functions; grants and RLS are untouched (the table stays
-- RLS deny-all, service-role only).

do $$
begin
  if to_regclass('public.evaluator_model_lock') is null then
    raise exception 'public.evaluator_model_lock does not exist: apply db/migration-evaluator-model-lock.sql first'
      using errcode = 'undefined_table';
  end if;
end $$;

alter table public.evaluator_model_lock
  add column if not exists identity_basis     text not null default 'weights_sha256',
  add column if not exists system_fingerprint text;

alter table public.evaluator_model_lock alter column weights_sha256 drop not null;

alter table public.evaluator_model_lock drop constraint if exists evaluator_model_lock_identity_basis;
alter table public.evaluator_model_lock add constraint evaluator_model_lock_identity_basis check (
  (identity_basis = 'weights_sha256' and weights_sha256 is not null)
  or (identity_basis = 'model_id+system_fingerprint' and weights_sha256 is null
      and model_version is not null and system_fingerprint is not null)
);

comment on column public.evaluator_model_lock.identity_basis is
  'What names the evaluator this lock froze. ''weights_sha256'': a declared weights digest. '
  '''model_id+system_fingerprint'': NO weights digest exists for this lock (CME cannot give one); the '
  'evaluator is named by model_version plus system_fingerprint, and weights_sha256 is NULL.';

comment on column public.evaluator_model_lock.system_fingerprint is
  'For identity_basis ''model_id+system_fingerprint'' only: the system fingerprint the model manifest '
  'declared for the provider, which rimpl had observed unchanged at lock time. This row has NO weights '
  'digest. NULL on a weights_sha256 lock.';

comment on column public.evaluator_model_lock.weights_sha256 is
  'Declared, not measured: a weights checksum is not readable over an inference API. Copied to '
  'app_settings.evaluator_weights_sha256 at declaration time and stamped onto every score from then on. '
  'NULL exactly when identity_basis = ''model_id+system_fingerprint'': that lock has no weights digest.';
