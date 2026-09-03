-- Migration: randomise WHICH episode runs in Socratic examiner mode
--
-- Until now `backend/src/routes/cles.js` hard-coded episode 2 as the Socratic one, so every
-- physician received the identical order: 1 natural → 2 Socratic → 3 natural. That makes the
-- experimental condition perfectly confounded with position in the sequence: a difference observed
-- at episode 2 could be the Socratic mode, or growing familiarity with the platform, or a warm-up
-- effect from episode 1, and the three cannot be told apart. Randomising which episode is Socratic
-- averages the order effect out across the cohort, so the remaining difference is attributable to
-- the mode. This is what turns the CLE1/2/3 comparison into a finding rather than an observation.
--
-- The draw is per physician, made once, and persisted — so it is reproducible, auditable, and
-- identical across a retried attempt at the same episode.
--
-- Idempotent. Apply to prod Supabase BEFORE deploying the backend that reads this column.

alter table public.professionals
  add column if not exists socratic_episode smallint
    check (socratic_episode between 1 and 3);

comment on column public.professionals.socratic_episode is
  'Which of the 3 CLE episodes runs in Socratic examiner mode. Drawn uniformly at random on the '
  'physician''s first CLE and never changed. NULL = not yet drawn. Randomising this de-confounds '
  'the Socratic condition from episode order.';

-- Backfill: anyone ALREADY MID-SEQUENCE keeps episode 2, which is what they were actually given.
-- Re-randomising them would change the condition underneath a physician and corrupt their own
-- within-physician contrast — strictly worse than the confounding we are removing.
--
-- "Mid-sequence" means they have PASSED a real episode, not merely opened a session. episode_number
-- is (# of passed, non-test CLEs) + 1, so a physician with only unfinished or test CLEs is still on
-- episode 1 and has never met the episode-2 condition — there is nothing to protect, and pinning
-- them would freeze them into the non-randomised arm for no benefit.
--
-- Checked against prod before writing this (2026-08-26): 0 sessions had the passing status, every
-- episode_number present was 1, and none carried socratic_reason 'randomised_examiner'. An
-- earlier draft matched on "has any session", which would have pinned 18 of 28 physicians on the
-- strength of test sessions. This clause matched 0 rows on the day it was applied, and stays
-- correct if the migration is ever re-run once the pilot has real sequences in flight.
--
-- Names updated 2026-09-03 for the CLE -> PLE rename (`cles`/'cle_pass' -> `ples`/'ple_pass').
-- Editing an applied migration is normally wrong, but this statement is idempotent and its own
-- comment promises it is re-runnable — left unrenamed it would raise PGRST205/42P01 instead.
update public.professionals p
   set socratic_episode = 2
 where p.socratic_episode is null
   and exists (
     select 1 from public.ples c
      where c.physician_id = p.id
        and c.status = 'ple_pass'
        and c.is_test = false
   );
