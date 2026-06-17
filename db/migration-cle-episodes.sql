-- db/migration-cle-episodes.sql
-- Phase 1 — the CLICS protocol's core experimental manipulation (CLICS_Proposal.pdf §6.4):
-- each physician produces 3 Clinical Learning Episodes in sequence, with a Socratic-mode toggle:
--   CLE1  natural (free) — Socratic remediation only after 3 consecutive Tier-1 fails
--   CLE2  Socratic clinical-examiner from the very first turn
--   CLE3  natural again (under the same conditions as CLE1)
-- Additive + idempotent. Apply AFTER migration-cle-rename.sql.

begin;

-- Per-session experimental state ------------------------------------------------------------------
alter table public.cles add column if not exists episode_number  smallint;            -- 1 | 2 | 3, assigned at creation
alter table public.cles add column if not exists socratic_active boolean not null default false;
alter table public.cles add column if not exists socratic_reason text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cles_socratic_reason_chk') then
    alter table public.cles add constraint cles_socratic_reason_chk
      check (socratic_reason is null or socratic_reason in ('cle2_examiner','t1_remediation'));
  end if;
end $$;

-- Per-physician Tier-1 remediation counter --------------------------------------------------------
alter table public.professionals add column if not exists consecutive_t1_fails int not null default 0;

-- Reset on any Tier-1 pass, increment on fail. Called once per /end (atomic, race-free).
create or replace function public.record_t1_outcome(p_id uuid, p_pass boolean) returns void
language sql as $$
  update public.professionals
     set consecutive_t1_fails = case when p_pass then 0 else consecutive_t1_fails + 1 end
   where id = p_id;
$$;

commit;
