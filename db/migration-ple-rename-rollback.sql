-- Rollback for db/migration-ple-rename.sql — PLE -> CLE.
--
-- Present so the forward migration is a decision that can be taken back, not a one-way door. It
-- undoes the rename in the REVERSE order the forward file applies it: data, then functions, then
-- sequence, indexes, constraints, columns, and tables last.
--
-- IT DOES NOT DROP ple_code_migration. That table is the only record of which CLE- code became which
-- PLE- code, and external documents cite the old ones; dropping it on a rollback would destroy the
-- mapping precisely when someone is trying to reconcile the two.
--
-- Code must roll back WITH this. The embed hints in backend/src/routes/admin.js name the constraint
-- literally, so a database on CLE- names with code on PLE- names 500s exactly as it did in 2026-06.

begin;

-- Data: PLE-NNN -> CLE-NNN, from the mapping rather than by string surgery.
update public.ples p set ple_code = m.old_code
from public.ple_code_migration m where m.ple_id = p.id and p.ple_code = m.new_code;

-- Functions
drop function if exists public.next_ple_code();
create or replace function public.next_cle_code()
returns text language sql as $function$
  select 'CLE-' || lpad(nextval('public.cle_code_seq')::text, 3, '0');
$function$;

drop function if exists public.ple_status_counts(uuid, boolean);
create or replace function public.cle_status_counts(p_council uuid default null::uuid, p_include_test boolean default false)
returns table(status text, n bigint) language sql stable as $function$
  select status, count(*)::bigint from public.cles
  where (p_council is null or council_id = p_council) and (p_include_test or is_test = false)
  group by status;
$function$;

create or replace function public.audit_scores_guard()
returns trigger language plpgsql as $function$
declare
  v_cle_council uuid;
  v_physician   uuid;
  v_aud_council uuid;
begin
  select council_id, physician_id into v_cle_council, v_physician
    from public.cles where id = new.cle_id;
  select council_id into v_aud_council
    from public.professionals where id = new.auditor_id;

  if new.auditor_id = v_physician then
    raise exception 'An auditor cannot score their own session (auditor = physician).';
  end if;
  if v_aud_council is distinct from v_cle_council then
    raise exception 'Cross-council audit is not allowed (auditor council <> session council).';
  end if;
  new.council_id := v_cle_council;
  return new;
end;
$function$;

-- Sequence
alter sequence public.ple_code_seq rename to cle_code_seq;

-- Indexes
alter index public.ai_evaluations_ple_idx rename to ai_evaluations_cle_idx;
alter index public.audit_assignments_ple_idx rename to audit_assignments_cle_idx;
alter index public.audit_discussions_ple_auditor_idx rename to audit_discussions_cle_auditor_idx;
alter index public.audit_scores_ple_idx rename to audit_scores_cle_idx;
alter index public.ple_folders_physician_idx rename to cle_folders_physician_idx;
alter index public.ple_integrity_flags_ple_idx rename to cle_integrity_flags_cle_idx;
alter index public.ple_integrity_flags_severity_idx rename to cle_integrity_flags_severity_idx;
alter index public.ple_patient_refs_physician_idx rename to cle_patient_refs_physician_idx;
alter index public.ples_council_idx rename to cles_council_idx;
alter index public.ples_council_specialty_idx rename to cles_council_specialty_idx;
alter index public.ples_created_idx rename to cles_created_idx;
alter index public.ples_folder_idx rename to cles_folder_idx;
alter index public.ples_physician_idx rename to cles_physician_idx;
alter index public.ples_privacy_review_idx rename to cles_privacy_review_idx;
alter index public.ples_rescue_activated_idx rename to cles_rescue_activated_idx;
alter index public.idx_ples_privacy_concern_open rename to idx_cles_privacy_concern_open;
alter index public.messages_ple_idx rename to messages_cle_idx;
alter index public.shadow_evaluations_ple_idx rename to shadow_evaluations_cle_idx;

-- Constraints
alter table public.audit_assignments rename constraint audit_assignments_ple_id_auditor_id_key to audit_assignments_cle_id_auditor_id_key;
alter table public.audit_assignments rename constraint audit_assignments_ple_id_fkey to audit_assignments_cle_id_fkey;
alter table public.audit_discussions rename constraint audit_discussions_ple_id_fkey to audit_discussions_cle_id_fkey;
alter table public.ple_integrity_flags rename constraint ple_integrity_flags_ple_id_fkey to cle_integrity_flags_cle_id_fkey;
alter table public.ple_integrity_flags rename constraint ple_integrity_flags_ple_id_signal_key to cle_integrity_flags_cle_id_signal_key;
alter table public.ple_integrity_flags rename constraint ple_integrity_flags_pkey to cle_integrity_flags_pkey;
alter table public.ple_integrity_flags rename constraint ple_integrity_flags_severity_check to cle_integrity_flags_severity_check;
alter table public.ple_pii_map rename constraint ple_pii_map_ple_id_fkey to cle_pii_map_cle_id_fkey;
alter table public.ple_pii_map rename constraint ple_pii_map_pkey to cle_pii_map_pkey;
alter table public.ples rename constraint ples_auditor_id_fkey to cles_auditor_id_fkey;
alter table public.ples rename constraint ples_ple_code_key to cles_cle_code_key;
alter table public.ples rename constraint ples_council_id_fkey to cles_council_id_fkey;
alter table public.ples rename constraint ples_folder_id_fkey to cles_folder_id_fkey;
alter table public.ples rename constraint ples_physician_id_fkey to cles_physician_id_fkey;
alter table public.ples rename constraint ples_privacy_concern_by_fkey to cles_privacy_concern_by_fkey;
alter table public.ples rename constraint ples_privacy_review_status_chk to cles_privacy_review_status_chk;
alter table public.ples rename constraint ples_privacy_reviewed_by_fkey to cles_privacy_reviewed_by_fkey;
alter table public.ples rename constraint ples_rescue_outcome_chk to cles_rescue_outcome_chk;
alter table public.ples rename constraint ples_rescue_reason_chk to cles_rescue_reason_chk;
alter table public.ples rename constraint ples_socratic_reason_chk to cles_socratic_reason_chk;
alter table public.ples rename constraint ples_specialty_id_fkey to cles_specialty_id_fkey;
alter table public.ple_reflections rename constraint ple_reflections_ple_id_fkey to ple_reflections_cle_id_fkey;
alter table public.ple_reflections rename constraint ple_reflections_ple_id_key to ple_reflections_cle_id_key;
alter table public.shadow_evaluations rename constraint shadow_evaluations_ple_id_fkey to shadow_evaluations_cle_id_fkey;
alter table public.shadow_evaluations rename constraint shadow_evaluations_ple_id_provider_model_version_key to shadow_evaluations_cle_id_provider_model_version_key;

-- Columns
alter table public.ai_evaluations rename column ple_id to cle_id;
alter table public.audit_assignments rename column ple_id to cle_id;
alter table public.audit_discussions rename column ple_id to cle_id;
alter table public.audit_scores rename column ple_id to cle_id;
alter table public.ple_integrity_flags rename column ple_id to cle_id;
alter table public.ple_patient_refs rename column ple_id to cle_id;
alter table public.ple_pii_map rename column ple_id to cle_id;
alter table public.lpdp_snapshots rename column ple_id to cle_id;
alter table public.messages rename column ple_id to cle_id;
alter table public.ple_reflections rename column ple_id to cle_id;
alter table public.shadow_evaluations rename column ple_id to cle_id;
alter table public.ples rename column ple_code to cle_code;
alter table public.payouts rename column ple_count to cle_count;

-- Tables
alter table public.ples rename to cles;
alter table public.ple_folders rename to cle_folders;
alter table public.ple_integrity_flags rename to cle_integrity_flags;
alter table public.ple_patient_refs rename to cle_patient_refs;
alter table public.ple_pii_map rename to cle_pii_map;

commit;
