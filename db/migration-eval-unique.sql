-- Migration: one AI evaluation + one LPDP snapshot per session — DB backstop for the
-- duplicate-evaluation race (same class as audit_scores, fixed in migration-audit-score-unique.sql).
--
-- Every evaluation path is check-then-insert with no lock: the fire-and-forget triggerEvaluation
-- from POST /ples/:id/end (and /admin/ples/:id/approve) can race the 6h reconcile sweep, or the
-- manual /reevaluate, and persistEvaluation (services/ple-evaluation.js) did a plain INSERT into
-- ai_evaluations + lpdp_snapshots with only a NON-unique index (schema.sql:557). A duplicate
-- ai_evaluations row breaks .single() reads (ples.js:286, auditor.js:48), double-counts the ICC
-- pair, and double-bills the physician's usage meter.
--
-- Safe to run more than once. Run on scaletest first, then prod.

-- 1) Remove pre-existing duplicates, KEEPING THE EARLIEST row per PLE (the legitimate first
--    evaluation; any later twin is the concurrency artifact). Deterministic tiebreak on id.
delete from public.ai_evaluations a
using public.ai_evaluations b
where a.ple_id = b.ple_id
  and (a.evaluated_at > b.evaluated_at
       or (a.evaluated_at = b.evaluated_at and a.id > b.id));

delete from public.lpdp_snapshots a
using public.lpdp_snapshots b
where a.ple_id = b.ple_id
  and (a.snapshot_at > b.snapshot_at
       or (a.snapshot_at = b.snapshot_at and a.id > b.id));

-- 2) Enforce one-per-PLE going forward. persistEvaluation now treats a 23505 as "already
--    evaluated" (idempotent) and falls through to finish the snapshot + status, so the loser of a
--    true race — or a re-run after a partial persist — heals instead of erroring.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_evaluations_ple_uniq') then
    alter table public.ai_evaluations add constraint ai_evaluations_ple_uniq unique (ple_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lpdp_snapshots_ple_uniq') then
    alter table public.lpdp_snapshots add constraint lpdp_snapshots_ple_uniq unique (ple_id);
  end if;
end $$;
