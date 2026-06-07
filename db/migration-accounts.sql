-- db/migration-accounts.sql
-- Multi-account system: account lifecycle, role slot pools, access requests,
-- and the on-prem encrypted OAuth-identity vault.
--
-- IMPORTANT: run this in the Supabase SQL editor as TWO separate queries.
-- The editor wraps a multi-statement script in ONE transaction, so a single
-- policy error rolls the whole thing back. Run "STRUCTURE" first, verify it
-- succeeded, then run "RLS / POLICIES".
-- ===========================================================================


-- ========================= RUN 1 — STRUCTURE ===============================

-- Account lifecycle + stable pseudonym on the existing users table.
alter table public.professionals
  add column if not exists status text not null default 'active'
    check (status in ('active','deactivated'));
alter table public.professionals
  add column if not exists pseudonym text unique;   -- P-NNN; the only identifier allowed in exports/audit

-- Editable per-role capacity pool (superadmin-managed).
create table if not exists public.role_slots (
  role       text primary key check (role in ('superadmin','admin','physician','auditor')),
  capacity   int not null check (capacity >= 0),
  updated_at timestamptz default now()
);
insert into public.role_slots (role, capacity) values
  ('superadmin', 1),    -- locked at 1 in code
  ('admin',      5),
  ('physician',  100),
  ('auditor',    20)
on conflict (role) do nothing;

-- Pending holding area for self-service access requests (email + OAuth).
-- A row's auth_user_id points at a Supabase auth.users row that exists but has
-- NO professionals row yet -> the person cannot pass verifyJwt until approved.
create table if not exists public.access_requests (
  id              uuid primary key default gen_random_uuid(),
  email           text,
  full_name_th    text,
  full_name_en    text,
  specialty       text,
  provider        text not null default 'email' check (provider in ('email','google','line')),
  provider_subject text,                 -- OAuth stable subject id (null for email)
  auth_user_id    uuid,                  -- the pending Supabase auth.users id
  requested_role  text default 'physician',
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  note            text,                  -- reviewer note / rejection reason
  reviewed_by     uuid references public.professionals(id),
  reviewed_at     timestamptz,
  created_at      timestamptz default now()
);
create index if not exists access_requests_status_idx on public.access_requests(status);

-- On-prem ENCRYPTED identity vault: the OAuth real identity (name/email/provider id)
-- never leaves on-premise and is never read by RIMPL. professionals.pseudonym is its
-- only externally-visible alias. identity_encrypted = AES-256-GCM (key IDENTITY_ENC_KEY).
create table if not exists public.oauth_identities (
  id                uuid primary key default gen_random_uuid(),
  professional_id   uuid references public.professionals(id) on delete cascade,  -- null until approved
  auth_user_id      uuid,
  provider          text check (provider in ('google','line')),
  provider_subject  text,
  identity_encrypted text not null,
  created_at        timestamptz default now()
);
create index if not exists oauth_identities_prof_idx on public.oauth_identities(professional_id);


-- ========================= RUN 2 — RLS / POLICIES ==========================
-- The backend uses the service-role key (bypasses RLS); these are defense-in-depth
-- and follow the existing "for all using (<expr>)" form in db/schema.sql.

alter table public.role_slots       enable row level security;
alter table public.access_requests  enable row level security;
alter table public.oauth_identities enable row level security;

-- role_slots: admins/superadmins may read; superadmin manages (service-role bypasses anyway).
drop policy if exists "slots: admin read" on public.role_slots;
create policy "slots: admin read"
  on public.role_slots for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
drop policy if exists "slots: superadmin write" on public.role_slots;
create policy "slots: superadmin write"
  on public.role_slots for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- access_requests: admins/superadmins may review.
drop policy if exists "requests: admin all" on public.access_requests;
create policy "requests: admin all"
  on public.access_requests for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );

-- oauth_identities: DENY-ALL. RLS is enabled and NO permissive policy is created,
-- so every non-service-role request is rejected. Only the backend's service-role
-- key (which bypasses RLS) can read/write the vault. RIMPL never touches this table.
