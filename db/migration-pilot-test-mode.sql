-- db/migration-pilot-test-mode.sql
-- Pilot Test Mode: a superadmin toggle so the team can exercise the CLE1/2/3 Socratic experiment
-- without polluting real study data. Additive + idempotent. Apply after migration-cle-episodes.sql.

begin;

-- The toggle (0/1) lives in the existing app_settings bag.
insert into public.app_settings (key, value) values ('pilot_test_mode', 0) on conflict (key) do nothing;

-- Allow the 'pilot_test' socratic_reason (a tester directly chose the mode). The constraint was named
-- cles_socratic_reason_chk in migration-cle-episodes.sql.
alter table public.cles drop constraint if exists cles_socratic_reason_chk;
alter table public.cles add constraint cles_socratic_reason_chk
  check (socratic_reason is null or socratic_reason in ('cle2_examiner','t1_remediation','pilot_test'));

commit;
