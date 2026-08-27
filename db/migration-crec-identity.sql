-- Migration: professional identity verification (CREC082 ICF §4, Infrastructure Statement
-- "Professional identity", Local Open-Weight AI Processing Declaration "Identity verification").
--
-- The protocol requires that before a physician's first PLE the system verifies who they are, by
-- ThaID or by checking their national ID together with their medical licence number — and that the
-- identity layer is kept SEPARATE from the research dataset.
--
-- As built, the system knows an email address. The TMC licence gate was switched off in June 2026
-- (db/migration-drop-license-gate.sql) and professionals.license_number has been unused since.
--
-- Idempotent. Apply to prod Supabase BEFORE deploying the backend that reads this table.

create table if not exists public.identity_verifications (
  id                         uuid primary key default gen_random_uuid(),
  professional_id            uuid not null references public.professionals(id) on delete cascade,
  method                     text not null check (method in ('national_id_license', 'thaid')),
  status                     text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),

  -- The national ID is never stored in the clear and never leaves this table.
  --   *_encrypted: AES-256-GCM (lib/crypto.encryptJson). Reversible, because the research team may
  --                have to re-check a number against a register.
  --   *_index:     keyed HMAC (lib/crypto.blindIndex). Deterministic, so uniqueness can be enforced,
  --                but not reversible without the key. A plain SHA-256 would be pointless here — the
  --                whole space is ~10^12 candidates and a leaked column would fall to exhaustive
  --                search on a laptop.
  --   *_last4:     so a person can confirm they are looking at the right record without the number
  --                being on screen.
  national_id_encrypted      text,
  national_id_index          text,
  national_id_last4          text,

  -- Licence lookup: EVIDENCE, not a verdict. It can confirm a licence exists and the name matches;
  -- it cannot confirm the person typing it is that person. An administrator decides.
  license_number             text,
  license_check_status       text,   -- 'verified' | 'not_found' | 'name_mismatch' | 'unavailable'
  license_check_source       text,   -- 'stub' | 'tmc_scrape' | 'none'
  license_evidence_encrypted text,

  submitted_at               timestamptz not null default now(),
  decided_by                 uuid references public.professionals(id),
  decided_at                 timestamptz,
  reject_reason              text,
  created_at                 timestamptz default now()
);

-- One national ID, one physician. Partial: a rejected or superseded submission must not block the
-- person from resubmitting a corrected one, and must not block the rightful owner of that number.
create unique index if not exists identity_verifications_nid_uniq
  on public.identity_verifications (national_id_index)
  where national_id_index is not null and status in ('pending', 'verified');

create index if not exists identity_verifications_prof_idx
  on public.identity_verifications (professional_id, status);

-- The admin queue: oldest undecided first.
create index if not exists identity_verifications_pending_idx
  on public.identity_verifications (submitted_at) where status = 'pending';

-- Deny-all RLS: this table is service-role only. Nothing in the browser, and no other service, has
-- any business reading it — that is the point of keeping it out of `professionals`.
alter table public.identity_verifications enable row level security;
drop policy if exists identity_verifications_no_access on public.identity_verifications;
create policy identity_verifications_no_access on public.identity_verifications for all using (false);

-- The gate. OFF by default, and unlike the privacy gate that is deliberate rather than cautious.
--
-- The privacy gate fails closed because closing it WITHHOLDS data from third parties — the safe
-- direction. This one fails closed by BLOCKING every physician from working, and it protects
-- nothing that is not already protected: there are no real participants yet. Switching it on before
-- the submission form exists and physicians have used it would simply stop the system.
--
-- It MUST be 1 before the first participant. That is a release step, not a default:
--     update public.app_settings set value = 1 where key = 'identity_verification_required';
insert into public.app_settings (key, value) values ('identity_verification_required', 0)
on conflict (key) do nothing;
