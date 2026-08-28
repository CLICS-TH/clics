-- How the Socratic rescue ENDED, as data.
--
-- rescue_exchanges_after already records WHEN a rescue stopped, but not why, and the two reasons are
-- not the same finding: the session came back (the "return to PLE eligibility" the analysis plan
-- reports), or the rescue ran its round cap without the session ever qualifying. Before this column
-- the second case was indistinguishable from the first, and in fact was not recorded at all — the
-- session simply stopped being re-assessed and dropped back to the general examiner prompt.
--
-- NULL means the rescue never ended: either it is still running, or the session finished inside it.
-- Idempotent: safe to re-run.

ALTER TABLE public.cles
  ADD COLUMN IF NOT EXISTS rescue_outcome text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cles_rescue_outcome_chk') THEN
    ALTER TABLE public.cles
      ADD CONSTRAINT cles_rescue_outcome_chk
      CHECK (rescue_outcome IS NULL OR rescue_outcome IN ('recovered', 'exhausted'));
  END IF;
END $$;

COMMENT ON COLUMN public.cles.rescue_outcome IS
  'recovered = the conversation qualified again and the rescue ended; exhausted = the round cap was reached without qualifying; NULL = the rescue never ended.';
