-- db/migration-ple-status-values.sql
-- The half of the CLE -> PLE rename that db/migration-ple-rename.sql (applied to prod 2026-08-31) did not
-- do: the VALUES in ples.status. The rename moved every table, column, constraint, index, sequence and
-- function to the ple_* names, but the status column still held 'cle_pass' / 'cle_fail_t1' / 'cle_flag_t2'
-- and its CHECK only allowed those, while the renamed code writes 'ple_pass' / 'ple_fail_t1' /
-- 'ple_flag_t2' (backend/src/lib/ple-status.js) — so every /end would have failed the CHECK.
--
-- Verified before writing (2026-09-02, prod): no function, trigger, policy or view embeds a cle_* status
-- literal; the only objects carrying the old values are the rows and ples_status_check. socratic_reason
-- keeps 'cle2_examiner' on purpose — the code still writes that value (it names the CLE-2 arm of the
-- protocol, not the record type).
--
-- Idempotent: re-running updates zero rows and re-creates the same constraint.
-- Rollback: db/migration-ple-status-values-rollback.sql
-- ===========================================================================

alter table public.ples drop constraint if exists ples_status_check;
alter table public.ples drop constraint if exists cles_status_check;

update public.ples
   set status = 'ple_' || substr(status, 5)
 where status in ('cle_pass', 'cle_fail_t1', 'cle_flag_t2');

alter table public.ples
  add constraint ples_status_check
  check (status in ('active', 'ended', 'ple_pass', 'ple_fail_t1', 'ple_flag_t2', 'evaluated'));
