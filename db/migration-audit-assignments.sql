-- db/migration-audit-assignments.sql
-- Multi-auditor calibration (pilot): let a CLE be scored by SEVERAL auditors so the dashboard can show
-- each auditor their PIS-7 scores vs the AVERAGE of all auditors (alongside the existing vs-AI radar).
-- Gated behind the superadmin 'peer_calibration' toggle. Assignment is recorded in this join table;
-- cles.auditor_id is kept as the legacy/primary pointer (back-compat) and existing rows are backfilled.
-- Safe to re-run (idempotent).
-- ===========================================================================

create table if not exists public.audit_assignments (
  id           uuid primary key default gen_random_uuid(),
  cle_id       uuid not null references public.cles(id) on delete cascade,
  auditor_id   uuid not null references public.professionals(id) on delete cascade,
  assigned_by  uuid references public.professionals(id),
  assigned_at  timestamptz not null default now(),
  unique (cle_id, auditor_id)   -- one assignment per (session, auditor)
);

create index if not exists audit_assignments_auditor_idx on public.audit_assignments (auditor_id);
create index if not exists audit_assignments_cle_idx      on public.audit_assignments (cle_id);

-- Backfill the existing single-assignee pointer so no in-flight assignment is lost.
insert into public.audit_assignments (cle_id, auditor_id)
  select id, auditor_id from public.cles where auditor_id is not null
  on conflict (cle_id, auditor_id) do nothing;

-- RLS defense-in-depth (backend mediates writes via the service role, which bypasses RLS): an auditor
-- may read their OWN assignments if a client ever queried directly.
alter table public.audit_assignments enable row level security;
drop policy if exists "audit_assignments: own read" on public.audit_assignments;
create policy "audit_assignments: own read"
  on public.audit_assignments for select using (auditor_id = auth.uid());

-- Peer-calibration toggle (0/1): when 1, the auditor reveal pane shows a you-vs-auditor-average radar
-- and admins may assign multiple auditors per CLE. Default 0 (single-auditor blind audit unchanged).
insert into public.app_settings (key, value) values ('peer_calibration', 0)
  on conflict (key) do nothing;
