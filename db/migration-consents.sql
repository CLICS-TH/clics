-- db/migration-consents.sql
-- Phase 5 — structured informed consent (CLICS_Proposal Appendix 03 physician / 04+15 auditor).
-- The legacy professionals.consented_at flag stays as the gate signal; this table is the AUDITABLE
-- record: which checkboxes were ticked, the COI disclosure, the version, and when. Additive +
-- idempotent. Oversight (superadmin/ethics) can read; each user reads/writes only their own.

begin;

create table if not exists public.consents (
  id              uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals(id) on delete cascade,
  role_context    text not null check (role_context in ('physician','auditor')),
  consent_version text not null,
  checkboxes      jsonb not null default '{}'::jsonb,
  coi             jsonb,                 -- auditor conflict-of-interest disclosure (Appendix 15)
  agreed_at       timestamptz not null default now(),
  unique (professional_id, role_context, consent_version)
);
create index if not exists consents_prof_idx on public.consents(professional_id);

alter table public.consents enable row level security;
drop policy if exists "consents: own" on public.consents;
create policy "consents: own" on public.consents for all
  using (professional_id = auth.uid()) with check (professional_id = auth.uid());
drop policy if exists "consents: oversight read" on public.consents;
create policy "consents: oversight read" on public.consents for select using (
  exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('superadmin','ethics'))
);

commit;
