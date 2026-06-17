-- db/migration-audit-log.sql
-- Phase 3 — the protocol's audit trail (CLICS_Proposal §9.4, Appendix 07/08): a single append-only
-- event log of access + scoring + provisioning actions, retrievable for the ethics committee.
-- Additive + idempotent. Reads are oversight-only (superadmin + the Tier-4 'ethics' role added in
-- Phase 6); inserts are service-role only (no insert policy).

begin;

create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.professionals(id) on delete set null,
  actor_role  text,
  action      text not null,                 -- e.g. 'cle.create','cle.end','audit.score','export','user.provision','consent'
  target_type text,                          -- 'cle' | 'professional' | 'export' | ...
  target_id   text,                          -- a CLE-NNN code, a pseudonym, an email, or a uuid
  council_id  uuid references public.councils(id),
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_created_idx on public.audit_log(created_at);
create index if not exists audit_log_target_idx  on public.audit_log(target_type, target_id);
create index if not exists audit_log_actor_idx   on public.audit_log(actor_id);

alter table public.audit_log enable row level security;
drop policy if exists "audit_log: oversight read" on public.audit_log;
create policy "audit_log: oversight read" on public.audit_log for select using (
  exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('superadmin','ethics'))
);

commit;
