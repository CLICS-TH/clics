-- CLE -> PLE. Align the schema with CREC082 Protocol V4.3, which governs.
--
-- WHY. The protocol and the v12 manuscript both use ONE term for the unit of analysis:
-- Professional Learning Episode (PLE) — 168 and 49 occurrences respectively, and "CLE" zero times in
-- either. Protocol §9.8 records the terminology change as deliberate ("harmonize with PCT/JMIR,
-- without changing participant rights or risks"). The schema is the last place still saying CLE.
--
-- THIS IS THE SECOND HALF OF A RENAME THAT WAS ONLY EVER DONE HALFWAY. db/migration-cle-rename.sql
-- renamed PLE->CLE in 2026-06 but left constraint names behind, and the mismatch broke production:
-- PostgREST's embed hint `professionals!cles_physician_id_fkey` resolved against a constraint that
-- no longer existed, /admin/cles returned 500, admins saw zero CLEs and the auditor queue was empty.
-- The catalog today is a mix of both eras — `ples_pkey` and `messages_ple_id_fkey` sitting beside
-- `cles_physician_id_fkey` and `cle_integrity_flags_pkey`. So this migration finishes the job in the
-- direction the protocol requires, and renames EVERY object rather than only the visible ones.
--
-- ORDER MATTERS. Constraints are renamed before indexes, because renaming a unique/primary-key
-- CONSTRAINT also renames its backing index — doing indexes first would then fail on a name that has
-- already moved. Seven objects appear in both lists for exactly that reason.
--
-- THE EMBED HINTS IN backend/src/routes/admin.js MUST SHIP WITH THIS. Three `select()` calls name
-- `professionals!cles_physician_id_fkey` literally. After this migration that constraint is
-- `ples_physician_id_fkey`, and the old hint 500s. backend/tests/admin-transcript-robustness.test.js
-- asserts every such hint maps to a real FK and is the gate for it.
--
-- Rollback: db/migration-ple-rename-rollback.sql

begin;

-- 1. Tables -----------------------------------------------------------------------------------
alter table public.cles                rename to ples;
alter table public.cle_folders         rename to ple_folders;
alter table public.cle_integrity_flags rename to ple_integrity_flags;
alter table public.cle_patient_refs    rename to ple_patient_refs;
alter table public.cle_pii_map         rename to ple_pii_map;

-- 2. Columns ----------------------------------------------------------------------------------
alter table public.ai_evaluations       rename column cle_id    to ple_id;
alter table public.audit_assignments    rename column cle_id    to ple_id;
alter table public.audit_discussions    rename column cle_id    to ple_id;
alter table public.audit_scores         rename column cle_id    to ple_id;
alter table public.ple_integrity_flags  rename column cle_id    to ple_id;
alter table public.ple_patient_refs     rename column cle_id    to ple_id;
alter table public.ple_pii_map          rename column cle_id    to ple_id;
alter table public.lpdp_snapshots       rename column cle_id    to ple_id;
alter table public.messages             rename column cle_id    to ple_id;
alter table public.ple_reflections      rename column cle_id    to ple_id;
alter table public.shadow_evaluations   rename column cle_id    to ple_id;
alter table public.ples                 rename column cle_code  to ple_code;
alter table public.payouts              rename column cle_count to ple_count;

-- 3. Constraints ------------------------------------------------------------------------------
alter table public.audit_assignments   rename constraint audit_assignments_cle_id_auditor_id_key to audit_assignments_ple_id_auditor_id_key;
alter table public.audit_assignments   rename constraint audit_assignments_cle_id_fkey           to audit_assignments_ple_id_fkey;
alter table public.audit_discussions   rename constraint audit_discussions_cle_id_fkey           to audit_discussions_ple_id_fkey;
alter table public.ple_integrity_flags rename constraint cle_integrity_flags_cle_id_fkey         to ple_integrity_flags_ple_id_fkey;
alter table public.ple_integrity_flags rename constraint cle_integrity_flags_cle_id_signal_key   to ple_integrity_flags_ple_id_signal_key;
alter table public.ple_integrity_flags rename constraint cle_integrity_flags_pkey                to ple_integrity_flags_pkey;
alter table public.ple_integrity_flags rename constraint cle_integrity_flags_severity_check      to ple_integrity_flags_severity_check;
alter table public.ple_pii_map         rename constraint cle_pii_map_cle_id_fkey                 to ple_pii_map_ple_id_fkey;
alter table public.ple_pii_map         rename constraint cle_pii_map_pkey                        to ple_pii_map_pkey;
alter table public.ples                rename constraint cles_auditor_id_fkey                    to ples_auditor_id_fkey;
alter table public.ples                rename constraint cles_cle_code_key                       to ples_ple_code_key;
alter table public.ples                rename constraint cles_council_id_fkey                    to ples_council_id_fkey;
alter table public.ples                rename constraint cles_folder_id_fkey                     to ples_folder_id_fkey;
-- The one the 2026-06 breakage was about.
alter table public.ples                rename constraint cles_physician_id_fkey                  to ples_physician_id_fkey;
alter table public.ples                rename constraint cles_privacy_concern_by_fkey            to ples_privacy_concern_by_fkey;
alter table public.ples                rename constraint cles_privacy_review_status_chk          to ples_privacy_review_status_chk;
alter table public.ples                rename constraint cles_privacy_reviewed_by_fkey           to ples_privacy_reviewed_by_fkey;
alter table public.ples                rename constraint cles_rescue_outcome_chk                 to ples_rescue_outcome_chk;
alter table public.ples                rename constraint cles_rescue_reason_chk                  to ples_rescue_reason_chk;
alter table public.ples                rename constraint cles_socratic_reason_chk                to ples_socratic_reason_chk;
alter table public.ples                rename constraint cles_specialty_id_fkey                  to ples_specialty_id_fkey;
alter table public.ple_reflections     rename constraint ple_reflections_cle_id_fkey             to ple_reflections_ple_id_fkey;
alter table public.ple_reflections     rename constraint ple_reflections_cle_id_key              to ple_reflections_ple_id_key;
alter table public.shadow_evaluations  rename constraint shadow_evaluations_cle_id_fkey          to shadow_evaluations_ple_id_fkey;
alter table public.shadow_evaluations  rename constraint shadow_evaluations_cle_id_provider_model_version_key to shadow_evaluations_ple_id_provider_model_version_key;

-- 4. Indexes that are NOT backed by a constraint above -----------------------------------------
alter index public.ai_evaluations_cle_idx           rename to ai_evaluations_ple_idx;
alter index public.audit_assignments_cle_idx        rename to audit_assignments_ple_idx;
alter index public.audit_discussions_cle_auditor_idx rename to audit_discussions_ple_auditor_idx;
alter index public.audit_scores_cle_idx             rename to audit_scores_ple_idx;
alter index public.cle_folders_physician_idx        rename to ple_folders_physician_idx;
alter index public.cle_integrity_flags_cle_idx      rename to ple_integrity_flags_ple_idx;
alter index public.cle_integrity_flags_severity_idx rename to ple_integrity_flags_severity_idx;
alter index public.cle_patient_refs_physician_idx   rename to ple_patient_refs_physician_idx;
alter index public.cles_council_idx                 rename to ples_council_idx;
alter index public.cles_council_specialty_idx       rename to ples_council_specialty_idx;
alter index public.cles_created_idx                 rename to ples_created_idx;
alter index public.cles_folder_idx                  rename to ples_folder_idx;
alter index public.cles_physician_idx               rename to ples_physician_idx;
alter index public.cles_privacy_review_idx          rename to ples_privacy_review_idx;
alter index public.cles_rescue_activated_idx        rename to ples_rescue_activated_idx;
alter index public.idx_cles_privacy_concern_open    rename to idx_ples_privacy_concern_open;
alter index public.messages_cle_idx                 rename to messages_ple_idx;
alter index public.shadow_evaluations_cle_idx       rename to shadow_evaluations_ple_idx;

-- 5. Sequence ---------------------------------------------------------------------------------
alter sequence public.cle_code_seq rename to ple_code_seq;

-- 6. Functions --------------------------------------------------------------------------------
-- Renamed AND rewritten: the bodies reference the old sequence and emit the old prefix, so a bare
-- ALTER FUNCTION ... RENAME would leave next_ple_code() still handing out 'CLE-036'.
drop function if exists public.next_cle_code();
create or replace function public.next_ple_code()
returns text language sql as $function$
  select 'PLE-' || lpad(nextval('public.ple_code_seq')::text, 3, '0');
$function$;

-- Recreated, not dropped: /admin/stats and /oversight both rpc() it, and its body selects from the
-- table that just became `ples`. Same signature and same return shape, so the callers only change
-- the name they call.
drop function if exists public.cle_status_counts(uuid, boolean);
create or replace function public.ple_status_counts(p_council uuid default null::uuid, p_include_test boolean default false)
returns table(status text, n bigint) language sql stable as $function$
  select status, count(*)::bigint from public.ples
  where (p_council is null or council_id = p_council) and (p_include_test or is_test = false)
  group by status;
$function$;

-- audit_scores_guard is a TRIGGER function and it is the one that enforces "an auditor cannot score
-- their own session" and "no cross-council audit". Its body selects `from public.cles where id =
-- new.cle_id` — both of which this migration renames. Postgres does not rewrite function bodies, so
-- without this the trigger raises `relation "public.cles" does not exist` on the next score INSERT
-- and the guard fails CLOSED into an outage rather than open. Replaced, same name, same trigger.
create or replace function public.audit_scores_guard()
returns trigger language plpgsql as $function$
declare
  v_ple_council uuid;
  v_physician   uuid;
  v_aud_council uuid;
begin
  select council_id, physician_id into v_ple_council, v_physician
    from public.ples where id = new.ple_id;
  select council_id into v_aud_council
    from public.professionals where id = new.auditor_id;

  if new.auditor_id = v_physician then
    raise exception 'An auditor cannot score their own session (auditor = physician).';
  end if;
  if v_aud_council is distinct from v_ple_council then
    raise exception 'Cross-council audit is not allowed (auditor council <> session council).';
  end if;
  new.council_id := v_ple_council;
  return new;
end;
$function$;

-- 7. Existing codes: CLE-NNN -> PLE-NNN, with the mapping kept ---------------------------------
-- The old codes have left the building — they appear in IRB correspondence and working notes — so
-- the rewrite is paired with a permanent lookup rather than done in place and forgotten. Protocol
-- §9.2 fixes the new format: PLE-001 through PLE-225.
create table if not exists public.ple_code_migration (
  ple_id      uuid primary key references public.ples(id) on delete cascade,
  old_code    text not null,
  new_code    text not null,
  migrated_at timestamptz not null default now()
);
comment on table public.ple_code_migration is
  'CLE-NNN -> PLE-NNN rename (CREC082 V4.3 §9.2). Kept so external references to a CLE- code stay traceable.';

insert into public.ple_code_migration (ple_id, old_code, new_code)
select id, ple_code, 'PLE-' || substring(ple_code from 5)
from public.ples
where ple_code like 'CLE-%'
on conflict (ple_id) do nothing;

update public.ples
set ple_code = 'PLE-' || substring(ple_code from 5)
where ple_code like 'CLE-%';

commit;
