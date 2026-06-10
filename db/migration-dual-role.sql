-- migration-dual-role.sql
-- Special role: a physician who is ALSO an auditor (manager request, 2026-06-10).
-- Model = role stays 'physician' + can_audit flag (no RLS changes: the auditor-side RLS and the
-- audit_scores_guard trigger key off auditor_id/assignment, not role). Dual users keep their
-- pseudonym and do NOT consume an auditor slot. invites.can_audit lets A/B issue "Special" invites.
-- Single run, idempotent, no RLS changes.

alter table public.professionals add column if not exists can_audit boolean not null default false;
alter table public.invites       add column if not exists can_audit boolean not null default false;

-- Auditor-rights requests reuse access_requests with provider='role_request' — widen the check.
alter table public.access_requests drop constraint if exists access_requests_provider_check;
alter table public.access_requests add constraint access_requests_provider_check
  check (provider in ('email','google','line','role_request'));
