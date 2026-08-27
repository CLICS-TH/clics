-- Migration: CREC082 Phase 0 — retire the Socratic randomisation, open the constraint for the
-- protocol rescue, and record the T1-remediation deviation as a switch.
--
-- WHY. db/migration-socratic-randomisation.sql (applied 2026-08-26) added
-- professionals.socratic_episode so the backend could allocate one of a physician's three episodes
-- to Socratic examiner mode by hashing their id. The CREC082 submission set, read the day after,
-- says the opposite in two places: the PLE Instruction Sheet §4 and ICF §3 describe Socratic as
-- "a standardized rescue ... not an experimental arm" — a scaffold opened MID-SESSION after 4
-- physician-AI exchanges when the conversation is not yet qualifying or has gone off topic.
-- Allocating episodes up front is a randomised trial arm, i.e. precisely what the protocol assures
-- the ethics committee the study does not do. So the allocation goes.
--
-- This migration SUPERSEDES rather than reverts the earlier one: its file stays in db/ so the
-- history reads honestly, and the column it added is dropped here.
--
-- Nothing is lost. The randomisation never took effect in production: pilot_test_mode = 1
-- overwrote socratic_reason on every insert, and (see below) the reason it would have written was
-- not even a legal value.
--
-- Idempotent. Apply to prod Supabase BEFORE deploying the backend that stops reading the column.

-- 1. The CHECK constraint never allowed the value the code was writing.
--
-- cles_socratic_reason_chk permits ('cle2_examiner', 't1_remediation', 'pilot_test'). The deployed
-- backend wrote 'randomised_examiner', which no migration ever added — so every randomised-episode
-- insert would have failed with 23514. It went unnoticed because pilot_test_mode was on and
-- replaced the reason before the insert reached the database. The randomised path was therefore
-- never executed against prod even once, which is the only reason this is a cleanup and not an
-- incident.
--
-- Rewrite the allowed set: drop the dead 'randomised_examiner' idea entirely, keep 'cle2_examiner'
-- (historic rows predating the rename) and 'pilot_test', keep 't1_remediation' (now behind a
-- setting, see 3), and add 'protocol_rescue' for the CREC §4 mid-session rescue that replaces all
-- of this.
alter table public.cles drop constraint if exists cles_socratic_reason_chk;

alter table public.cles add constraint cles_socratic_reason_chk
  check (socratic_reason is null or socratic_reason in (
    'cle2_examiner',    -- historic: the fixed-episode-2 behaviour, before randomisation
    't1_remediation',   -- deviation, off by default — see app_settings.t1_remediation_enabled
    'pilot_test',       -- tester chose the mode by hand under pilot_test_mode
    'protocol_rescue'   -- CREC082 PLE Instruction Sheet §4: mid-session rescue after 4 exchanges
  ));

comment on column public.cles.socratic_reason is
  'Why this session ran in Socratic mode, NULL when it did not. From CREC082 onward the only '
  'protocol-sanctioned value is protocol_rescue, decided mid-session rather than at creation. '
  'There is deliberately no value for a randomised assignment: Socratic is a rescue, not an arm.';

-- 2. Drop the allocation column.
--
-- Guarded: refuse to drop it if any physician actually carries an allocation, because that would
-- mean a cohort was randomised for real and the rows are evidence rather than scaffolding. Verified
-- 0 rows on prod before writing this; the guard is for any other environment.
do $$
declare allocated integer;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'professionals'
                and column_name = 'socratic_episode') then
    execute 'select count(*) from public.professionals where socratic_episode is not null'
       into allocated;
    if allocated > 0 then
      raise exception
        'Refusing to drop professionals.socratic_episode: % physician(s) carry an allocation. '
        'Export them before dropping — a randomised cohort is study evidence.', allocated;
    end if;
    alter table public.professionals drop column socratic_episode;
  end if;
end $$;

-- 3. Socratic remediation after 3 consecutive Tier-1 failures: keep it, but off by default.
--
-- This rule predates the randomisation and is a support path rather than a study condition — but it
-- is not in the approved protocol either, and it opens a session in Socratic mode from turn 1,
-- which the protocol reserves for the mid-session rescue. Rather than delete a genuine safety net,
-- make switching it on a deliberate act that leaves a record. 0 = off, matching the protocol.
insert into public.app_settings (key, value) values ('t1_remediation_enabled', 0)
on conflict (key) do nothing;

-- 4. Footnote on a claim in the superseded migration.
--
-- migration-socratic-randomisation.sql justified its backfill with "0 CLEs had status 'cle_pass'".
-- That reading was an artifact, not a fact about the pilot: cle_pass is a transient state that a
-- scored CLE leaves within seconds for 'evaluated', so a point-in-time count of it is always ~0.
-- Production in fact held 14 evaluated CLEs at that moment. The backfill clause was still correct
-- (it also required is_test = false, and matched 0 rows), and the column is dropped above anyway —
-- but the same misreading was live in five counting queries, and is fixed in
-- backend/src/lib/cle-status.js. Recorded here so the next person to read that file is not misled.
