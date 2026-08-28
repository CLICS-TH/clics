-- A rater's privacy REPORT is not a reviewer's DECISION. Separate the two.
--
-- The stop-and-report path (CREC082 assessment form: a rater who sees possible patient data stops
-- and notifies the research team) was writing privacy_review_status='quarantined' together with
-- privacy_reviewed_at / privacy_reviewed_by set to the REPORTING AUDITOR. Two things went wrong:
--
--   1. The reviewer's queue defaults to status='pending' — the work list. A report therefore landed
--      in the already-decided 'quarantined' bucket, where nobody was looking, and the default tab
--      still read "every session has been reviewed".
--   2. The person who raised the concern was recorded as the person who reviewed it. That is the
--      one fact the privacy audit trail exists to state correctly.
--
-- So a concern gets its own four columns and leaves privacy_review_* to the reviewer. The session
-- returns to 'pending' — it genuinely does need a human decision again — and `privacy_concern_open`
-- is what withholds it from the reporting auditor, independent of whether the privacy gate is on.
-- Idempotent: safe to re-run.

ALTER TABLE public.cles
  ADD COLUMN IF NOT EXISTS privacy_concern_open boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS privacy_concern_by   uuid REFERENCES public.professionals(id),
  ADD COLUMN IF NOT EXISTS privacy_concern_at   timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_concern_note text;

COMMENT ON COLUMN public.cles.privacy_concern_open IS
  'An auditor stopped and reported a suspected identifier; cleared by any privacy-review decision. Withholds the session from the auditor queue regardless of the privacy_review_required setting.';
COMMENT ON COLUMN public.cles.privacy_concern_by IS
  'The auditor who REPORTED the concern. Never a reviewer — see privacy_reviewed_by for that.';
COMMENT ON COLUMN public.cles.privacy_concern_note IS
  'What the reporting auditor said. Kept apart from privacy_review_note so a report cannot overwrite a reviewer''s own note.';

-- The auditor queue and the privacy queue both filter on this, and it is overwhelmingly false.
CREATE INDEX IF NOT EXISTS idx_cles_privacy_concern_open
  ON public.cles (privacy_concern_open) WHERE privacy_concern_open;
