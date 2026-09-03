-- db/migration-local-ai-capacity.sql
-- Local AI in production shape: a durable evaluation queue, token-denominated budgets, and the
-- transcript-size counter. Additive and idempotent; safe to re-run.
--
-- WHY. The on-prem evaluator takes ~70s per PLE and the box serves ~2 calls at once, so a burst of
-- submissions must QUEUE rather than fan out. The `ples` row at status 'ple_pass' IS the queue:
-- claim_ple_evaluations() hands out the oldest rows under a lease, FOR UPDATE SKIP LOCKED, so the
-- drain, the reconcile sweep and a redeploy can never evaluate the same PLE twice.
--
-- IMPORTANT: run in the Supabase SQL editor as ONE query (no policies here, so a single run is safe).
-- ===========================================================================

-- ---- queue state on the ple_pass row -------------------------------------------------------------
alter table public.ples add column if not exists eval_enqueued_at timestamptz;
alter table public.ples add column if not exists eval_claimed_at  timestamptz;
alter table public.ples add column if not exists eval_attempts    smallint not null default 0;
alter table public.ples add column if not exists eval_next_at     timestamptz;
alter table public.ples add column if not exists eval_last_error  text;
-- The LAST reported context size (prompt + completion tokens of the most recent turn). This is the
-- number a transcript cap must compare against — Σ messages.token_count is per-call input+output and
-- grows quadratically with the number of turns, which is what C3 measures, not what the model sees.
alter table public.ples add column if not exists context_tokens   integer not null default 0;

-- Rows already waiting at ple_pass join the queue in the order they ended.
update public.ples set eval_enqueued_at = coalesce(ended_at, created_at)
 where status = 'ple_pass' and eval_enqueued_at is null;

create index if not exists ples_eval_queue_idx on public.ples (eval_enqueued_at)
 where status = 'ple_pass';

-- Claim up to p_limit queued evaluations under a lease. Returns the claimed ids.
--   * oldest first (FIFO fairness — a backlog cannot starve the earliest submitter);
--   * a row whose lease expired is claimable again (a process died mid-evaluation);
--   * eval_next_at defers a row after a transient failure (backoff owned by the caller);
--   * council scoping: p_exclude keeps a laptop-scored council out of the prod drain, p_include keeps
--     a laptop drain from touching anything but its own council. NULL means "no filter".
-- FOR UPDATE SKIP LOCKED makes concurrent callers claim disjoint rows without waiting on each other.
create or replace function public.claim_ple_evaluations(
  p_limit int,
  p_lease_seconds int,
  p_exclude_councils uuid[] default null,
  p_include_councils uuid[] default null)
returns table (id uuid)
language plpgsql as $$
begin
  return query
  with cte as (
    select p.id
      from public.ples p
     where p.status = 'ple_pass'
       and (p.eval_next_at is null or p.eval_next_at <= now())
       and (p.eval_claimed_at is null
            or p.eval_claimed_at < now() - make_interval(secs => p_lease_seconds))
       and (p_exclude_councils is null or p.council_id is null
            or not (p.council_id = any(p_exclude_councils)))
       and (p_include_councils is null or p.council_id = any(p_include_councils))
     order by coalesce(p.eval_enqueued_at, p.ended_at, p.created_at)
     limit greatest(p_limit, 0)
       for update skip locked)
  update public.ples u
     set eval_claimed_at = now(),
         eval_attempts   = u.eval_attempts + 1
    from cte
   where u.id = cte.id
  returning u.id;
end $$;

-- ---- token-denominated budgets -------------------------------------------------------------------
-- The local provider is priced at $0, so the $-cap never throttles it; tokens are the honest unit.
alter table public.professionals add column if not exists usage_limit_tokens         bigint;
alter table public.professionals add column if not exists auditor_usage_limit_tokens bigint;

insert into public.app_settings (key, value) values
  -- 0 = NO token cap (usage.js reads <= 0 as "unset"). Seeding a number here would cap every existing
  -- cloud user the moment this runs — accounts already past it would 403 on their next turn. The real
  -- ceiling is set deliberately by a superadmin from the capacity report (plan: 3 × p95 tokens/PLE × 1.25).
  ('standard_usage_limit_tokens',         0),
  ('auditor_standard_usage_limit_tokens', 0),
  ('ple_max_transcript_tokens',           64000),   -- trial value; re-set from the capacity report
  ('ple_transcript_warn_pct',             80),
  ('eval_drain_concurrency',              1),
  ('eval_p50_seconds',                    90)
on conflict (key) do nothing;
-- Text-valued: comma-separated council CODES whose ple_pass rows the prod drain must leave alone
-- (e.g. 'SANDBOX' while a laptop stack scores that council on the local model).
insert into public.app_settings (key, value, value_text) values ('eval_drain_exclude_councils', 0, null)
on conflict (key) do nothing;

-- Reservation RPCs gain an optional token ceiling. The old 3-arg signature is DROPPED first: a defaulted
-- extra argument is a NEW overload, and two overloads make PostgREST's RPC resolution ambiguous. The
-- 4-arg one is `create or replace` so this file stays re-runnable (the drop is a no-op the second time).
drop function if exists public.reserve_usage(uuid, numeric, numeric);
create or replace function public.reserve_usage(p_id uuid, p_estimate numeric, p_limit numeric, p_token_limit bigint default null)
returns boolean
language plpgsql as $$
declare reserved boolean;
begin
  update public.professionals
     set usage_cost_usd = usage_cost_usd + p_estimate
   where id = p_id
     and usage_cost_usd < p_limit
     and (p_token_limit is null or usage_input_tokens + usage_output_tokens < p_token_limit)
   returning true into reserved;
  return coalesce(reserved, false);
end $$;

drop function if exists public.reserve_auditor_usage(uuid, numeric, numeric);
create or replace function public.reserve_auditor_usage(p_id uuid, p_estimate numeric, p_limit numeric, p_token_limit bigint default null)
returns boolean
language plpgsql as $$
declare reserved boolean;
begin
  update public.professionals
     set auditor_usage_cost_usd = auditor_usage_cost_usd + p_estimate
   where id = p_id
     and auditor_usage_cost_usd < p_limit
     and (p_token_limit is null or auditor_usage_input_tokens + auditor_usage_output_tokens < p_token_limit)
   returning true into reserved;
  return coalesce(reserved, false);
end $$;
