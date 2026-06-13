-- Migration: atomic AI-budget reservation — closes the check-then-spend TOCTOU on the $0.50 cap.
--
-- requireBudget read the meter (loaded once per request) and only spent (increment_usage) AFTER the
-- multi-second RIMPL call, so N parallel chat turns from one physician could all pass the check before
-- any spend landed and blow past the cap. reserve_usage increments the meter by an ESTIMATE ONLY IF
-- the current spend is still under the limit, in ONE row-locked statement — so once the meter crosses
-- the limit, further reserves fail. The caller reconciles the estimate to the real cost after the call
-- (increment_usage with the signed delta) and refunds it (negative delta) if the turn fails.
--
-- Preserves the existing semantic (a turn is allowed while spend < limit, blocked once it reaches it);
-- overshoot is now bounded to a single in-flight turn instead of all concurrent ones. Safe to re-run.

create or replace function public.reserve_usage(p_id uuid, p_estimate numeric, p_limit numeric)
returns boolean
language plpgsql as $$
declare reserved boolean;
begin
  update public.professionals
     set usage_cost_usd = usage_cost_usd + p_estimate
   where id = p_id and usage_cost_usd < p_limit
   returning true into reserved;
  return coalesce(reserved, false);
end $$;
