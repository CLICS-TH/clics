-- Migration: one audit score per (session, auditor) — DB backstop for the SELECT-then-INSERT race.
--
-- POST /auditor/ples/:id/score checks for an existing score then inserts; two concurrent submits
-- (two tabs, a retried request, scripting) can both pass the check and both insert. A duplicate
-- double-counts that PLE pair in the ICC credit-gate statistic (services/icc.js), corrupting it.
-- The audit_scores_guard trigger only enforces council + self-scoring, not uniqueness.
--
-- Safe to run more than once. Run on scaletest first, then prod.

-- 1) Remove any pre-existing duplicates, KEEPING THE EARLIEST score per pair (the legitimate first
--    submit; any later twin is the concurrency artifact). Deterministic tiebreak on id.
delete from public.audit_scores a
using public.audit_scores b
where a.ple_id = b.ple_id
  and a.auditor_id = b.auditor_id
  and (a.scored_at > b.scored_at
       or (a.scored_at = b.scored_at and a.id > b.id));

-- 2) Enforce it going forward. The route still does a friendly pre-check (409 "Already scored");
--    this constraint is the backstop so the loser of a true race gets 409, never a duplicate row.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'audit_scores_ple_auditor_uniq'
  ) then
    alter table public.audit_scores
      add constraint audit_scores_ple_auditor_uniq unique (ple_id, auditor_id);
  end if;
end $$;
