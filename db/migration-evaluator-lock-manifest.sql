-- Migration: bind the Primary Evaluator Model Lock to the model manifest (CCME R2; GitHub #75).
--
-- PREREQUISITE: db/migration-evaluator-model-lock.sql (the evaluator_model_lock table). This file
-- refuses to run without it rather than creating a half-shaped table of its own.
--
-- WHY. A lock row recorded a declaration and a weights digest, but not WHICH BUILD of the scoring stack
-- it froze: the evaluator prompt, rubric, decoding defaults, router and provider policy live in rimpl's
-- code, and nothing tied the row to them. rimpl now publishes a content-addressed manifest
-- (rimpl/src/model-manifest.json, GET /manifest). POST /admin/evaluator-lock freezes onto the row:
--   evaluator_sha256  THE binding. A digest over exactly the evaluator keys of the manifest
--                     (backend/src/services/model-lock.js evaluatorDigest; the key list is there and in
--                     docs/deployment.md). The lock freezes the scoring instrument, not the whole build.
--                     /health/deep recomputes it on the live manifest while locked and degrades on a
--                     mismatch.
--   manifest_sha256   the whole manifest's address, for the record. A change here with the evaluator
--                     digest unchanged (a tutor, router or chat change) is a note on /health/deep, not a
--                     failure.
--   manifest          the EXPECTED half itself, so either digest can be recomputed from the row.
--
-- WHAT IS NOT HERE, AND WHY.
--   * No expected config_fingerprint column. Shadow rows carry no fingerprint, and the fingerprint on a
--     served score (rimpl provenance.js) hashes weights_sha256, which exists only from the moment of
--     locking — no pre-lock score can carry the value post-lock scores will. Computing one in the
--     backend would be inventing it. manifest_sha256 is what binds the lock to the build.
--   * No unlocked_at / unlocked_by. The table stays append-only in practice: the app INSERTs, and
--     DELETEs only a row its own request inserted when that request fails. An unlock is recorded where
--     tamper evidence exists, the hash-chained audit_log (action 'evaluator_lock', awaited and rolled
--     back on failure), and the lock in force is the one whose locked_at equals
--     app_settings.evaluator_locked_at. Writing unlocks onto the row would turn the record into a mutable
--     second copy of the audit trail, with its own way to disagree with it.
--
-- shadow_evaluations.decoding: rimpl now sends the shadow (candidate) evaluation the served
-- evaluator's decoding (temperature 0), and had no column to record it on the row. Nullable; nothing
-- writes it until rimpl does. ADDED ONLY IF THE TABLE EXISTS: db/migration-shadow-evaluations.sql is
-- deliberately unapplied in some environments. Apply that one later and re-run this file.
--
-- DEPLOY ORDER: the backend code ships FIRST. Until this is applied, POST /admin/evaluator-lock answers
-- 503 migration_required (nothing written), GET /admin/evaluator-lock lists it in migrations_pending,
-- and /health/deep is unaffected while unlocked. Gate query (returns 3 once applied):
--   select count(*) from information_schema.columns
--    where table_schema = 'public' and table_name = 'evaluator_model_lock'
--      and column_name in ('manifest_sha256', 'manifest', 'evaluator_sha256');
--
-- Additive and idempotent: re-running changes nothing. Grants and RLS are untouched (the table stays
-- RLS deny-all, service-role only).

do $$
begin
  if to_regclass('public.evaluator_model_lock') is null then
    raise exception 'public.evaluator_model_lock does not exist: apply db/migration-evaluator-model-lock.sql first'
      using errcode = 'undefined_table';
  end if;
end $$;

alter table public.evaluator_model_lock
  add column if not exists manifest_sha256  text,
  add column if not exists manifest         jsonb,
  add column if not exists evaluator_sha256 text;

-- The shape of the address, and the pair travels together: a sha with no frozen content (or content
-- with no sha) is a record nobody can check. Both NULL is a lock taken before this migration.
alter table public.evaluator_model_lock drop constraint if exists evaluator_model_lock_manifest_sha256_hex;
alter table public.evaluator_model_lock add constraint evaluator_model_lock_manifest_sha256_hex
  check (manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$');
alter table public.evaluator_model_lock drop constraint if exists evaluator_model_lock_evaluator_sha256_hex;
alter table public.evaluator_model_lock add constraint evaluator_model_lock_evaluator_sha256_hex
  check (evaluator_sha256 is null or evaluator_sha256 ~ '^[0-9a-f]{64}$');
alter table public.evaluator_model_lock drop constraint if exists evaluator_model_lock_manifest_pair;
alter table public.evaluator_model_lock add constraint evaluator_model_lock_manifest_pair
  check ((manifest_sha256 is null) = (manifest is null));

comment on column public.evaluator_model_lock.manifest_sha256 is
  'sha256 of rimpl/src/model-manifest.json as rimpl verified it at lock time (GET /manifest). For the '
  'record: a different live sha with the same evaluator_sha256 is a tutor/router change, shown as a '
  'note. NULL = locked before the manifest existed.';

comment on column public.evaluator_model_lock.evaluator_sha256 is
  'The lock''s binding: sha256 over exactly the evaluator keys of the manifest''s expected half, for this '
  'row''s provider (backend/src/services/model-lock.js evaluatorDigest). /health/deep recomputes it on '
  'the live manifest while locked and degrades on a mismatch. NULL = not bound (degrades while locked).';

comment on column public.evaluator_model_lock.manifest is
  'The EXPECTED half of the model manifest at lock time (code + declared target), frozen beside its '
  'sha256. Never the live view: that carries operator- and server-supplied strings.';

do $$
begin
  if to_regclass('public.shadow_evaluations') is not null then
    execute 'alter table public.shadow_evaluations add column if not exists decoding jsonb';
    execute $c$comment on column public.shadow_evaluations.decoding is
      'Decoding parameters the candidate evaluation was SENT (temperature, max_tokens, ...). NULL on rows '
      'written before rimpl recorded it.'$c$;
  else
    raise notice 'public.shadow_evaluations does not exist; decoding not added. Re-run this file after db/migration-shadow-evaluations.sql.';
  end if;
end $$;
