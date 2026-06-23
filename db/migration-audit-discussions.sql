-- db/migration-audit-discussions.sql
-- Persistence + audit trail for the auditor AI discussion chat (PR3). After an auditor submits their
-- PIS-7 score, they can chat with an AI calibration tutor about the evaluation; each turn is stored
-- here (auditor question + assistant reply), metered against the auditor budget pool.
-- Safe to re-run (idempotent).
-- ===========================================================================

create table if not exists public.audit_discussions (
  id            uuid primary key default gen_random_uuid(),
  cle_id        uuid not null references public.cles(id) on delete cascade,
  auditor_id    uuid not null references public.professionals(id) on delete cascade,
  role          text not null check (role in ('auditor', 'assistant')),
  content       text not null,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  created_at    timestamptz not null default now()
);

-- Discussion is loaded per (cle, auditor) in time order.
create index if not exists audit_discussions_cle_auditor_idx
  on public.audit_discussions (cle_id, auditor_id, created_at);

-- RLS defense-in-depth: the backend mediates all writes via the service role (which bypasses RLS);
-- this only lets an auditor read their OWN discussion if a client ever queried directly.
alter table public.audit_discussions enable row level security;
drop policy if exists "audit_discussions: own read" on public.audit_discussions;
create policy "audit_discussions: own read"
  on public.audit_discussions for select using (auditor_id = auth.uid());
