-- db/migration-cle-rename.sql
-- Protocol alignment (CLICS_Proposal.pdf v3.0): rename the unit-of-analysis PLE → CLE.
-- The status enum already uses cle_pass/cle_fail_t1/cle_flag_t2; this aligns the table,
-- column, index, and function NAMES so the system speaks the protocol's "CLE".
--
-- Safe by construction:
--   * Data is preserved through `rename` (no copy, no downtime beyond the txn).
--   * RLS policies + constraints track columns by identity, so table/column renames are
--     transparent to them — they keep working, only their *names* still say "ple" (cosmetic).
--   * SQL FUNCTION bodies are stored as TEXT and re-parsed at call time, so the two functions
--     that reference `public.ples` (ple_status_counts, audit_scores_guard) MUST be recreated.
--   * LPDP (lpdp_snapshots) is a separate longitudinal-profile artifact — it keeps its name;
--     only its `ple_id` FK column is renamed to `cle_id`.
--
-- Idempotent: guarded by existence checks, safe to re-run. Apply BEFORE deploying renamed code.

begin;

-- 1. Tables -----------------------------------------------------------------
do $$ begin
  if to_regclass('public.ples') is not null then alter table public.ples rename to cles; end if;
  if to_regclass('public.ple_folders') is not null then alter table public.ple_folders rename to cle_folders; end if;
  if to_regclass('public.ple_patient_refs') is not null then alter table public.ple_patient_refs rename to cle_patient_refs; end if;
end $$;

-- 2. FK columns ple_id → cle_id ---------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['cle_patient_refs','messages','ai_evaluations','audit_scores','lpdp_snapshots'] loop
    if exists (select 1 from information_schema.columns
               where table_schema='public' and table_name=t and column_name='ple_id') then
      execute format('alter table public.%I rename column ple_id to cle_id', t);
    end if;
  end loop;
end $$;

-- 3. Indexes ----------------------------------------------------------------
alter index if exists public.ple_folders_physician_idx      rename to cle_folders_physician_idx;
alter index if exists public.ple_patient_refs_physician_idx rename to cle_patient_refs_physician_idx;
alter index if exists public.ples_folder_idx                rename to cles_folder_idx;
alter index if exists public.ples_council_idx               rename to cles_council_idx;
alter index if exists public.ples_physician_idx             rename to cles_physician_idx;
alter index if exists public.ples_created_idx               rename to cles_created_idx;
alter index if exists public.ples_auditor_idx               rename to cles_auditor_idx;
alter index if exists public.ples_status_idx                rename to cles_status_idx;
alter index if exists public.messages_ple_idx               rename to messages_cle_idx;
alter index if exists public.ai_evaluations_ple_idx         rename to ai_evaluations_cle_idx;
alter index if exists public.audit_scores_ple_idx           rename to audit_scores_cle_idx;
alter index if exists public.lpdp_snapshots_ple_idx         rename to lpdp_snapshots_cle_idx;

-- 4. Functions whose TEXT body references the renamed table -----------------
-- 4a. ple_status_counts(uuid, boolean) → cle_status_counts(uuid, boolean)
drop function if exists public.ple_status_counts(uuid, boolean);
create or replace function public.cle_status_counts(p_council uuid default null, p_include_test boolean default false)
returns table(status text, n bigint) language sql stable as $$
  select status, count(*)::bigint from public.cles
  where (p_council is null or council_id = p_council) and (p_include_test or is_test = false)
  group by status;
$$;

-- 4b. audit_scores_guard(): now reads public.cles and new.cle_id
create or replace function public.audit_scores_guard()
returns trigger language plpgsql as $$
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
$$;

commit;

-- Note: RLS policy names + unique-constraint names still read "ples"/"ple_id" (e.g.
-- "ples: physician own", ai_evaluations_ple_id_key). They function correctly (bound by
-- identity, not name); leaving the cosmetic names avoids churn. schema.sql (fresh installs)
-- uses the new names throughout. Historical migration-*.sql files are append-only history
-- and are intentionally NOT edited.
