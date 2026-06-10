-- db/migration-scale.sql
-- Scale hardening for ~80K users (almost all physicians, role C). Adds the indexes the hot
-- query paths need, replaces the O(N) nextPseudonym() with an O(1) sequence, and adds SQL
-- aggregate RPCs so /admin/stats and /usage-settings stop loading whole tables into JS.
--
-- All ADDITIVE and idempotent. Run once in the Supabase SQL editor (no separate RLS run needed —
-- there are no policies here; the backend calls these via the service-role key).
-- ===========================================================================

-- ---- Indexes the 80K-row hot paths need -----------------------------------
-- Slot-checks count active members by role (+council): usedCount / councilUsedCount.
create index if not exists professionals_role_status_idx          on public.professionals(role, status);
create index if not exists professionals_council_role_status_idx  on public.professionals(council_id, role, status);
-- Pseudonym lookups + the sequence seed below.
create index if not exists professionals_pseudonym_idx            on public.professionals(pseudonym);
-- Per-physician / per-session joins (admin profile, export, transcripts, reconcile, LPDP).
create index if not exists ples_physician_idx                     on public.ples(physician_id);
create index if not exists messages_ple_idx                       on public.messages(ple_id);
create index if not exists ai_evaluations_ple_idx                 on public.ai_evaluations(ple_id);
create index if not exists audit_scores_ple_idx                   on public.audit_scores(ple_id);
create index if not exists audit_scores_auditor_idx               on public.audit_scores(auditor_id);
create index if not exists lpdp_snapshots_physician_idx           on public.lpdp_snapshots(physician_id);
-- ORDER BY created_at LIMIT n (paginated /admin/users + /admin/ples) — index the sort key
-- so it's an index scan, not a top-N sort over the whole 80K/400K table.
create index if not exists professionals_created_idx              on public.professionals(created_at);
create index if not exists ples_created_idx                       on public.ples(created_at);

-- ---- O(1) pseudonym allocation (was a full-table scan per signup) ----------
-- A sequence is concurrency-safe and constant-time. Seed it to current max+1 so existing
-- P-NNN values are never reused. Width grows naturally past 999 (P-1000, P-80000, ...).
create sequence if not exists public.pseudonym_seq;
select setval(
  'public.pseudonym_seq',
  greatest(1, coalesce(
    (select max((substring(pseudonym from 3))::int) from public.professionals where pseudonym ~ '^P-[0-9]+$'),
    0) + 1),
  false   -- is_called=false => the next nextval() returns this value as-is
);

create or replace function public.next_pseudonym() returns text language sql as $$
  select 'P-' || lpad(nextval('public.pseudonym_seq')::text, 3, '0');
$$;

-- ---- SQL aggregates (replace whole-table JS reductions) -------------------
-- /admin/stats — counts by status, council-scoped, test-aware. GROUP BY in SQL.
create or replace function public.ple_status_counts(p_council uuid default null, p_include_test boolean default false)
returns table(status text, n bigint) language sql stable as $$
  select status, count(*)::bigint
  from public.ples
  where (p_council is null or council_id = p_council)
    and (p_include_test or is_test = false)
  group by status;
$$;

-- /admin/usage-settings — total spend across all members, summed in SQL.
create or replace function public.total_usage_sum() returns numeric language sql stable as $$
  select coalesce(sum(usage_cost_usd), 0) from public.professionals;
$$;
