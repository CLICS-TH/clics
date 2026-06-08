-- db/migration-usage-limits.sql
-- Per-user AI usage budget for the real-participant pilot.
--   * physicians accrue real Claude cost (chat + PIS-7 eval + C4-C6 criteria);
--   * each physician has a running cost meter + a per-user limit override;
--   * a standard default limit ($0.50) lives in app_settings (superadmin-editable);
--   * session start + each chat turn are gated on the effective limit (backend).
--
-- IMPORTANT: run this in the Supabase SQL editor as TWO separate queries.
-- The editor wraps a multi-statement script in ONE transaction, so a single
-- policy error rolls the whole thing back. Run "STRUCTURE" first, verify it
-- succeeded, then run "RLS / POLICIES".
-- ===========================================================================


-- ========================= RUN 1 — STRUCTURE ===============================

-- Per-physician usage meter + per-user limit override (override NULL => use the standard default).
alter table public.professionals
  add column if not exists usage_cost_usd      numeric not null default 0;
alter table public.professionals
  add column if not exists usage_input_tokens  bigint  not null default 0;
alter table public.professionals
  add column if not exists usage_output_tokens bigint  not null default 0;
alter table public.professionals
  add column if not exists usage_limit_usd      numeric;   -- null => standard default applies

-- Per-session token breakdown (input/output split, for cost auditability + superadmin drill-down).
-- token_count stays as-is (the C3 CLE gate depends on it).
alter table public.ples
  add column if not exists input_tokens  bigint not null default 0;
alter table public.ples
  add column if not exists output_tokens bigint not null default 0;

-- Reusable keyed app settings (currently just the standard usage limit). Mirrors role_slots.
create table if not exists public.app_settings (
  key        text primary key,
  value      numeric not null,
  updated_at timestamptz default now()
);
insert into public.app_settings (key, value) values
  ('standard_usage_limit_usd', 0.50)
on conflict (key) do nothing;

-- Atomic increment of the running meter (avoids the read-modify-write race on usage_cost_usd).
create or replace function public.increment_usage(
  p_id  uuid,
  p_cost numeric,
  p_in  bigint,
  p_out bigint
) returns void
language sql as $$
  update public.professionals
     set usage_cost_usd      = usage_cost_usd      + p_cost,
         usage_input_tokens  = usage_input_tokens  + p_in,
         usage_output_tokens = usage_output_tokens + p_out
   where id = p_id;
$$;


-- ========================= RUN 2 — RLS / POLICIES ==========================

alter table public.app_settings enable row level security;

-- Admins/superadmins read; only the superadmin writes (mirrors the role_slots policies).
drop policy if exists "app_settings: admin read" on public.app_settings;
create policy "app_settings: admin read"
  on public.app_settings for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
drop policy if exists "app_settings: superadmin write" on public.app_settings;
create policy "app_settings: superadmin write"
  on public.app_settings for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );
