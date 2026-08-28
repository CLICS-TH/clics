-- Migration: the Socratic rescue applies per ROUND, and its cost is recorded where it belongs.
--
-- The approved instruction sheet describes the rescue as a bounded, non-leading intervention applied
-- each round until the conversation returns to being a qualifying episode. The implementation applied
-- it once, on the round it fired, and then handed the session to the general examiner behaviour —
-- which cites and answers, and is therefore a different instrument. Rounds two onward of a rescued
-- session were governed by no rescue constraint at all, and nothing recorded whether the session
-- ever recovered.
--
-- Idempotent. Apply to prod Supabase BEFORE deploying the backend that writes these columns.

alter table public.cles
  add column if not exists rescue_exchanges_after     smallint,
  add column if not exists rescue_assessment_tokens   integer not null default 0,
  add column if not exists rescue_assessment_cost_usd numeric not null default 0;

-- NOT a second timestamp. `qualified_at` already records the moment the session first met the four
-- qualifying elements, which for a rescued session IS the moment it recovered — a `rescue_recovered_at`
-- would be the same instant under a second name, and two columns that must agree eventually disagree.
-- What is NOT derivable from timestamps is the turn count, and "exchanges after rescue" is exactly
-- what the analysis plan asks for beside the exchanges-before already stored.
comment on column public.cles.rescue_exchanges_after is
  'Physician turns taken while in rescue before the session returned to qualifying. NULL = the '
  'rescue never resolved (the session ended still rescued), which is a distinct finding from 0.';

-- Re-assessing every round costs one classifier call per round. That spend belongs to the STUDY, not
-- to the physician: the system chose the intervention, and charging their $0.50 budget for it would
-- penalise exactly the people whose conversation had not yet qualified — the opposite of what the
-- rescue is for. Recorded per episode so "what did the rescue cost" is a sum over this column, and
-- deliberately NOT a new per-user pool: the spend is not attributable to anyone's quota.
comment on column public.cles.rescue_assessment_tokens is
  'Cumulative tokens spent on the qualifying classifier for this session. Never billed to the '
  'physician; see rescue_assessment_cost_usd.';

comment on column public.cles.rescue_assessment_cost_usd is
  'Cumulative cost of the qualifying classifier for this session, priced against the provider that '
  'actually served it (0 on the on-prem model). Study cost, not physician cost.';
