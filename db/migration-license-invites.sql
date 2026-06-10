-- db/migration-license-invites.sql
-- Secure-signup overhaul: per-physician/auditor license-verification state, an audit trail
-- of verification attempts (PII evidence stored ENCRYPTED), and A/B invite links that create
-- a physician (C) or auditor (D) bound to an email.
--
-- IMPORTANT: run this in the Supabase SQL editor as TWO separate queries (STRUCTURE then RLS).
-- The editor wraps a multi-statement script in ONE transaction, so a single policy error rolls
-- the whole thing back. Run "RUN 1 — STRUCTURE" first, verify, then run "RUN 2 — RLS".
-- ===========================================================================


-- ========================= RUN 1 — STRUCTURE ===============================

-- License-verification state on each professional.
--   unverified      — not checked yet (physicians may still be active; auditors may NOT)
--   verified        — confirmed against the Medical Council (TMC)
--   not_found       — TMC returned no match
--   name_mismatch   — license exists but the name didn't match
--   manual_verified — an admin/superadmin manually confirmed (the override valve)
alter table public.professionals
  add column if not exists license_status text not null default 'unverified'
    check (license_status in ('unverified','verified','not_found','name_mismatch','manual_verified'));
alter table public.professionals
  add column if not exists license_verified_at timestamptz;

-- Audit trail of every verification attempt. evidence_encrypted holds the scrape evidence
-- (AES-256-GCM via lib/crypto.encryptJson) — it can carry PII, so it is encrypted at rest and
-- this table is RLS deny-all (service-role only), like oauth_identities.
create table if not exists public.license_verifications (
  id                 uuid primary key default gen_random_uuid(),
  professional_id    uuid references public.professionals(id) on delete set null,  -- null for pre-provision checks
  license_number     text not null,
  name_checked       text,                 -- the name string queried (the query, not the vault)
  status             text not null check (status in ('verified','not_found','name_mismatch','unavailable','manual_verified')),
  source             text not null,        -- 'stub' | 'tmc_scrape' | 'manual'
  evidence_encrypted text,                 -- encryptJson(scrape evidence); nullable
  checked_at         timestamptz not null default now(),
  created_at         timestamptz default now()
);
create index if not exists license_verifications_prof_idx on public.license_verifications(professional_id);
create index if not exists license_verifications_lic_idx  on public.license_verifications(license_number);

-- Invite links: A/B invite a physician or auditor by email. The raw token is high-entropy and
-- lives ONLY in the accept link; the DB stores only sha256(token). RLS deny-all (service-role only).
create table if not exists public.invites (
  id              uuid primary key default gen_random_uuid(),
  token_hash      text not null unique,     -- sha256(raw token)
  email           text not null,
  role            text not null check (role in ('physician','auditor')),
  council_id      uuid not null references public.councils(id),
  created_by      uuid references public.professionals(id),
  status          text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  professional_id uuid references public.professionals(id),  -- set on accept
  created_at      timestamptz default now()
);
create index if not exists invites_email_idx  on public.invites(email);
create index if not exists invites_status_idx on public.invites(status);
-- At most one LIVE invite per (email, role, council); revoke/expire before re-inviting.
-- (Council-scoped so a 23505 conflict can't reveal an invite in another admin's council.)
create unique index if not exists invites_one_pending
  on public.invites(email, role, council_id) where status = 'pending';

-- Defense-in-depth: one identity row per auth user in the on-prem vault.
create unique index if not exists oauth_identities_auth_user_uniq on public.oauth_identities(auth_user_id);

-- Grandfather existing ACTIVE auditors to manual_verified so the invariant trigger (RUN 2)
-- doesn't block future edits to already-onboarded auditors (seeded/soak cohorts).
update public.professionals set license_status = 'manual_verified', license_verified_at = now()
 where role = 'auditor' and status = 'active' and license_status = 'unverified';


-- ========================= RUN 2 — RLS / POLICIES ==========================

-- Both tables are DENY-ALL to JWT clients (no permissive policy). Only the backend's
-- service-role key reads/writes them; the dashboard reaches them through backend routes.
alter table public.license_verifications enable row level security;
alter table public.invites               enable row level security;
-- (license_status / license_verified_at live on professionals, already covered by its policies.)

-- Backstop invariant: an auditor may NEVER be active without a verified/manual_verified license,
-- guaranteed at the DB layer regardless of which code path (or a direct service-role write) inserts/updates.
create or replace function public.enforce_auditor_license()
returns trigger language plpgsql as $$
begin
  if new.role = 'auditor' and new.status = 'active'
     and new.license_status not in ('verified','manual_verified') then
    raise exception 'An auditor cannot be active without a verified license.';
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_auditor_license_trg on public.professionals;
create trigger enforce_auditor_license_trg
  before insert or update on public.professionals
  for each row execute function public.enforce_auditor_license();
