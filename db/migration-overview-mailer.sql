-- migration-overview-mailer.sql
-- Participant-ready additions (2026-06-10). Single run, idempotent, no RLS changes.
--   1. council_member_counts() — active members grouped by council × role; powers the
--      superadmin executive overview (GET /admin/overview-counts).
--   2. invites.email_sent_at — stamped when the invite accept-link email was delivered
--      (the backend mailer is fail-soft: invites work without this column or any SMTP).

create or replace function public.council_member_counts()
returns table(council_id uuid, role text, n bigint) language sql stable as $$
  select council_id, role, count(*)::bigint
  from public.professionals
  where status = 'active' and council_id is not null
  group by council_id, role;
$$;

alter table public.invites add column if not exists email_sent_at timestamptz;
