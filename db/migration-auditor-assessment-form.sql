-- Migration: the auditor scoring surface records what the approved assessment form asks for.
--
-- Two things were missing from every stored assessment.
--
-- ANCHOR CLARITY. The form asks the rater, for each domain, how clear that domain's behavioural
-- anchor was for this transcript. It is not decoration: the calibration workshop's stated output is a
-- map of where raters disagree and which anchors are ambiguous, and the rubric may only be refined
-- AFTER the primary analysis. Without somewhere to put the judgement, the workshop produces a
-- conversation and no evidence, and the refinement it exists to inform has nothing to work from.
--
-- ATTESTATIONS. The form ends with a set of confirmations the rater makes before submitting —
-- distinct from the one-time confidentiality/COI consent already recorded at account level, because
-- these are per-assessment claims about THIS assessment.
--
-- Idempotent. Apply to prod Supabase BEFORE deploying the backend that writes these columns.

alter table public.audit_scores
  add column if not exists d1_anchor text,
  add column if not exists d2_anchor text,
  add column if not exists d3_anchor text,
  add column if not exists d4_anchor text,
  add column if not exists d5_anchor text,
  add column if not exists d6_anchor text,
  add column if not exists d7_anchor text,
  add column if not exists attestations jsonb not null default '{}'::jsonb;

-- Three values, mirroring the form. NULLABLE, and unbackfilled: NULL means "this assessment predates
-- the field", which is true. Defaulting it to 'clear' would assert a judgement nobody made about
-- every score already collected — precisely the kind of invention the rubric-refinement analysis
-- would then be built on.
do $$
declare d text;
begin
  foreach d in array array['d1','d2','d3','d4','d5','d6','d7'] loop
    execute format('alter table public.audit_scores drop constraint if exists audit_scores_%s_anchor_chk', d);
    execute format(
      'alter table public.audit_scores add constraint audit_scores_%s_anchor_chk '
      'check (%s_anchor is null or %s_anchor in (''clear'', ''moderate'', ''ambiguous''))', d, d, d);
  end loop;
end $$;

comment on column public.audit_scores.d1_anchor is
  'How clear this domain''s behavioural anchor was for this transcript: clear | moderate | ambiguous. '
  'NULL = the assessment predates the field. Feeds post-analysis rubric refinement; never affects a score.';

-- jsonb rather than five boolean columns. Every one of them is true in any row that exists — the API
-- refuses the submission otherwise — so as columns they would carry no information at all. What IS
-- worth keeping is WHICH set of confirmations was affirmed, so that a later change to the checklist
-- does not silently rewrite the meaning of assessments already collected.
comment on column public.audit_scores.attestations is
  'The pre-submit confirmations affirmed for THIS assessment, as {key: true}. Distinct from the '
  'one-time confidentiality/COI consent held at account level. The API requires the full current set.';
