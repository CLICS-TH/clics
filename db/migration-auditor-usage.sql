-- db/migration-auditor-usage.sql
-- Separate AI-usage budget POOL for auditors, independent of the physician meter.
--
-- The auditor AI discussion chat (separate feature) bills THIS pool. A dual-role "Special" user
-- (a physician with can_audit, a SINGLE professionals row) therefore never has their auditing spend
-- drawn from their physician budget. Mirrors the physician pool exactly: a per-user meter + a per-user
-- limit override + a superadmin-editable standard default. Safe to re-run (idempotent).
--
-- The new app_settings row reuses the existing table + RLS from migration-usage-limits.sql, so this
-- can run as a single query (no new policies). Backend uses the service role and bypasses RLS anyway.
-- ===========================================================================

-- Per-auditor usage meter + per-user limit override (override NULL => use the standard default).
alter table public.professionals
  add column if not exists auditor_usage_cost_usd      numeric not null default 0;
alter table public.professionals
  add column if not exists auditor_usage_input_tokens  bigint  not null default 0;
alter table public.professionals
  add column if not exists auditor_usage_output_tokens bigint  not null default 0;
alter table public.professionals
  add column if not exists auditor_usage_limit_usd      numeric;   -- null => standard default applies

-- Standard default for the auditor pool ($0.50, superadmin-editable) — mirrors standard_usage_limit_usd.
insert into public.app_settings (key, value) values
  ('auditor_standard_usage_limit_usd', 0.50)
on conflict (key) do nothing;

-- Atomic increment of the auditor meter (mirror of increment_usage on the auditor columns).
create or replace function public.increment_auditor_usage(
  p_id  uuid,
  p_cost numeric,
  p_in  bigint,
  p_out bigint
) returns void
language sql as $$
  update public.professionals
     set auditor_usage_cost_usd      = auditor_usage_cost_usd      + p_cost,
         auditor_usage_input_tokens  = auditor_usage_input_tokens  + p_in,
         auditor_usage_output_tokens = auditor_usage_output_tokens + p_out
   where id = p_id;
$$;

-- Atomic reservation against the auditor pool (mirror of reserve_usage — closes the TOCTOU on the cap).
create or replace function public.reserve_auditor_usage(p_id uuid, p_estimate numeric, p_limit numeric)
returns boolean
language plpgsql as $$
declare reserved boolean;
begin
  update public.professionals
     set auditor_usage_cost_usd = auditor_usage_cost_usd + p_estimate
   where id = p_id and auditor_usage_cost_usd < p_limit
   returning true into reserved;
  return coalesce(reserved, false);
end $$;

-- Org-wide auditor spend so far (mirror of total_usage_sum) — powers the superadmin usage-settings card.
create or replace function public.total_auditor_usage_sum() returns numeric language sql stable as $$
  select coalesce(sum(auditor_usage_cost_usd), 0) from public.professionals;
$$;
