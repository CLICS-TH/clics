-- Migration: indexes for hot filter/lookup columns that had none.
--
--  * ples(auditor_id)  — GET /auditor/queue filters auditor_id + status='evaluated' every load.
--  * ples(status)      — the reconcile sweep (status='ple_pass'), /stats, and the status filter.
--  * lpdp_snapshots(ple_id) — the per-PLE snapshot lookups (LPDP, purge, reconcile repair).
--
-- Pilot tables are small, so a plain CREATE INDEX is fine; at large scale prefer CREATE INDEX
-- CONCURRENTLY (run outside a transaction) to avoid a write lock. Safe to run more than once.

create index if not exists ples_auditor_idx       on public.ples(auditor_id);
create index if not exists ples_status_idx        on public.ples(status);
create index if not exists lpdp_snapshots_ple_idx on public.lpdp_snapshots(ple_id);
