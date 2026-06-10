-- migration-patient-intake.sql
-- Structured patient-identifier intake (real-PII de-identification, 2026-06-09).
--
-- Patient identifiers (name / HN / phone …) are captured in a PHYSICALLY SEPARATE table so they can
-- NEVER leak into the cloud-AI payload, the auditor blind queue, or the de-identified export — all of
-- which read `ples`, never this table. Only the owning physician (and, later, the on-prem layer)
-- reads it. This keeps the case narrative name-free so real patient PII never reaches the cloud AI;
-- the broadened rimpl/pii-filter.js remains the backstop for anything typed into the narrative.
--
-- Idempotent. Single run (one table + one policy).

create table if not exists public.ple_patient_refs (
  ple_id        uuid primary key references public.ples(id) on delete cascade,
  physician_id  uuid not null references public.professionals(id) on delete cascade,
  patient_ref   text,
  created_at    timestamptz not null default now()
);
create index if not exists ple_patient_refs_physician_idx on public.ple_patient_refs(physician_id);

-- Deny-all by default; the owning physician may read/write only their own row. The backend uses the
-- service-role key (bypasses RLS), so this is defense-in-depth — the route-layer physician_id filter
-- is the load-bearing access control.
alter table public.ple_patient_refs enable row level security;
drop policy if exists ple_patient_refs_owner on public.ple_patient_refs;
create policy ple_patient_refs_owner on public.ple_patient_refs
  for all using (physician_id = auth.uid()) with check (physician_id = auth.uid());
