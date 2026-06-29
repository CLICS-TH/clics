-- Migration: Hold Result Until Audited toggle (for a blinded test round)
--
-- Seeds the app_settings flag `hold_result_until_audited` (default 0 = OFF). When a superadmin sets it
-- to 1, the backend withholds a physician's PIS-7 score (GET /cles/:id/evaluation returns
-- {status:'pending_review'}, and /cles/lpdp/me drops un-audited CLEs) until an expert auditor has
-- submitted a score for that CLE — so physicians can't see/compare scores before review.
--
-- Idempotent. Apply to the prod Supabase before deploying the backend that reads this key.

insert into public.app_settings (key, value) values ('hold_result_until_audited', 0)
on conflict (key) do nothing;
