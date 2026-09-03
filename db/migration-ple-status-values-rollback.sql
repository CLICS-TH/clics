-- Rollback of db/migration-ple-status-values.sql: put the cle_* status values and CHECK back.
-- Only needed if the pre-rename backend (master before the CLE -> PLE refactor) has to run again.
alter table public.ples drop constraint if exists ples_status_check;
update public.ples
   set status = 'cle_' || substr(status, 5)
 where status in ('ple_pass', 'ple_fail_t1', 'ple_flag_t2');
alter table public.ples
  add constraint ples_status_check
  check (status in ('active', 'ended', 'cle_pass', 'cle_fail_t1', 'cle_flag_t2', 'evaluated'));
