-- db/migration-pseudonym-codes.sql
-- Phase 2 — protocol pseudonym codes (CLICS_Proposal §7.1, §9.2): sessions get CLE-NNN, expert
-- auditors get EXP-NNN, mirroring the existing P-NNN physician series (next_pseudonym). These are the
-- ONLY identifiers that appear in the research export / audit trail. Additive + idempotent.

begin;

alter table public.cles          add column if not exists cle_code text unique;
alter table public.professionals add column if not exists exp_code text unique;

-- CLE-NNN session series (O(1) sequence; setval seeds from any existing codes for re-run safety).
create sequence if not exists public.cle_code_seq;
select setval('public.cle_code_seq',
  greatest(1, coalesce((select max((substring(cle_code from 5))::int) from public.cles where cle_code ~ '^CLE-[0-9]+$'), 0) + 1),
  false);
create or replace function public.next_cle_code() returns text language sql as $$
  select 'CLE-' || lpad(nextval('public.cle_code_seq')::text, 3, '0');
$$;

-- EXP-NNN expert-auditor series.
create sequence if not exists public.exp_code_seq;
select setval('public.exp_code_seq',
  greatest(1, coalesce((select max((substring(exp_code from 5))::int) from public.professionals where exp_code ~ '^EXP-[0-9]+$'), 0) + 1),
  false);
create or replace function public.next_exp_code() returns text language sql as $$
  select 'EXP-' || lpad(nextval('public.exp_code_seq')::text, 3, '0');
$$;

-- Backfill existing rows so the export is complete from day one (chronological numbering).
update public.professionals set exp_code = public.next_exp_code()
  where role = 'auditor' and exp_code is null;
do $$ declare r record; begin
  for r in select id from public.cles where cle_code is null and is_test = false order by created_at, id loop
    update public.cles set cle_code = public.next_cle_code() where id = r.id;
  end loop;
end $$;

commit;
