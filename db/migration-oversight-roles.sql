-- db/migration-oversight-roles.sql
-- Phase 6 — Tier-3 (analyst) + Tier-4 (ethics) oversight roles (CLICS_Proposal §9.4 access tiers).
-- analyst = aggregated de-identified data only; ethics = audit log + aggregates. NEITHER can read
-- transcripts (no RLS policy grants them cles/messages access → default-deny). Global roles (no
-- council). Additive + idempotent.

begin;

-- Allow the two new role values.
alter table public.professionals drop constraint if exists professionals_role_check;
alter table public.professionals add constraint professionals_role_check
  check (role in ('superadmin','admin','physician','auditor','analyst','ethics'));

-- analyst/ethics are global like the superadmin — they have no council.
alter table public.professionals drop constraint if exists prof_council_required;
alter table public.professionals add constraint prof_council_required
  check (role in ('superadmin','analyst','ethics') or council_id is not null);

commit;
