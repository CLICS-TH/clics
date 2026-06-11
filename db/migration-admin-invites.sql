-- migration-admin-invites.sql
-- Admin-role invites (2026-06-11): the SUPERADMIN may issue an invite for role 'admin'
-- (council director). The API guard lives in POST /admin/invites (role 'admin' → superadmin
-- only, 403 otherwise); accept provisions an ACTIVE admin in the invite's council through the
-- existing per-council admin slot pool (council_slots) — no pseudonym (physician-only).
-- This migration only widens the invites role check. Single run, idempotent, no RLS changes.

alter table public.invites drop constraint if exists invites_role_check;
alter table public.invites add constraint invites_role_check
  check (role in ('physician','auditor','admin'));
