-- Booth retention (#217, ADR 0004): booth_event_summary(), the one call scripts/booth/purge-event.mjs makes. It
-- returns the counts summary CCME keeps for an event and, with p_delete, deletes that event's booth_plays in the
-- same transaction, so the summary describes exactly the rows deleted. The same transaction writes that summary
-- to booth_event_purges, so a delete whose response is lost still leaves its counts: every call returns the
-- latest recorded purge of the event under `recorded` ({purged_at, summary} or null).
--
-- Why one function: as separate requests, a superadmin could switch the event on between the switch check and the
-- delete, and a score still running (switching off does not stop one) could land between the summary read and the
-- delete. Here the event's advisory lock (the key booth_start_play takes) keeps a play from starting, the
-- booth_event_code and booth_enabled rows are locked FOR UPDATE so a switch-on waits for the commit, and the summary
-- is computed from the DELETE's RETURNING rows. A score that commits first is deleted as scored; one that commits
-- after finds no row and answers unavailable.
--
-- Idempotent. Owner-gated apply before the Sun 1 Nov 18:00 freeze: re-apply migration-booth-plays.sql (its
-- booth_start_play now refuses while booth_enabled = 0), then this file. Tested against a throwaway PostgreSQL by
-- scripts/db/booth-purge-test.sh.
--
-- Refuses with SQLSTATE BP409 (message booth_event_switched_on) when p_delete and booth_enabled = 1, whatever
-- booth_event_code holds: comparing codes would have to match the backend's JS trim() exactly, so it fails closed.
-- A purge therefore commits only while the booth is off, and booth_start_play, serialized after it on the
-- advisory lock, refuses. Aggregates only: no id, tag or per-play row reaches the result or booth_event_purges.

create table if not exists public.booth_event_purges (
  id          bigserial primary key,
  event_code  text not null check (event_code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  purged_at   timestamptz not null default now(),
  summary     jsonb not null
);

-- DENY-ALL (RLS on, no policy), like booth_plays: only the service role reads it, through booth_event_summary().
alter table public.booth_event_purges enable row level security;
revoke all on table public.booth_event_purges from public, anon, authenticated;
grant select, insert on table public.booth_event_purges to service_role;
grant usage on sequence public.booth_event_purges_id_seq to service_role;

comment on table public.booth_event_purges is
  'Booth retention (#217, ADR 0004): the counts summary of each booth_plays purge, written in the purge''s '
  'transaction. Aggregates only, outside pilot data: no play id, tag or per-play row.';

create or replace function public.booth_event_summary(p_event text, p_delete boolean)
returns jsonb
language plpgsql as $$
declare
  v_rows public.booth_plays[];
  v_enabled numeric;
  v_summary jsonb;
  v_recorded jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('booth_plays:' || p_event));

  -- Read before this call's own insert, so `recorded` is always an earlier purge.
  select jsonb_build_object('purged_at', p.purged_at, 'summary', p.summary) into v_recorded
    from public.booth_event_purges p where p.event_code = p_event order by p.purged_at desc, p.id desc limit 1;

  if p_delete then
    perform 1 from public.app_settings where key in ('booth_enabled', 'booth_event_code') order by key for update;
    select value into v_enabled from public.app_settings where key = 'booth_enabled';
    if v_enabled = 1 then
      raise exception using errcode = 'BP409', message = 'booth_event_switched_on',
        detail = 'a booth event is switched on (booth_enabled = 1); switch it off first';
    end if;
    with d as (delete from public.booth_plays b where b.event_code = p_event returning b)
    select array_agg(d.b) into v_rows from d;
  else
    select array_agg(b) into v_rows from public.booth_plays b where b.event_code = p_event;
  end if;

  select jsonb_build_object(
    'plays', count(*),
    'scored', count(*) filter (where r.status = 'scored'),
    'unavailable', count(*) filter (where r.status = 'unavailable'),
    'abandoned', count(*) filter (where r.status = 'abandoned'),
    'started', count(*) filter (where r.status = 'started'),
    'ranked', count(*) filter (where r.status = 'scored' and r.ranked),
    'spend_usd', coalesce(sum(r.spend_usd), 0),
    'first_play_at', min(r.created_at),
    'last_play_at', max(r.created_at),
    -- Linear interpolation (R type 7) and the population SD: the event's scored plays are the whole population.
    'spread', jsonb_build_object(
      'min', min(r.composite) filter (where r.status = 'scored'),
      'p25', percentile_cont(0.25) within group (order by r.composite) filter (where r.status = 'scored'),
      'median', percentile_cont(0.5) within group (order by r.composite) filter (where r.status = 'scored'),
      'p75', percentile_cont(0.75) within group (order by r.composite) filter (where r.status = 'scored'),
      'max', max(r.composite) filter (where r.status = 'scored'),
      'mean', avg(r.composite) filter (where r.status = 'scored'),
      'sd', stddev_pop(r.composite) filter (where r.status = 'scored')),
    'domain_mean', jsonb_build_object(
      'd1', avg(r.d1) filter (where r.status = 'scored'),
      'd2', avg(r.d2) filter (where r.status = 'scored'),
      'd3', avg(r.d3) filter (where r.status = 'scored'),
      'd4', avg(r.d4) filter (where r.status = 'scored'),
      'd5', avg(r.d5) filter (where r.status = 'scored'),
      'd6', avg(r.d6) filter (where r.status = 'scored'),
      'd7', avg(r.d7) filter (where r.status = 'scored')))
  into v_summary
  from unnest(coalesce(v_rows, '{}')) r;

  if p_delete and v_rows is not null then
    insert into public.booth_event_purges (event_code, summary) values (p_event, v_summary);
  end if;
  return v_summary || jsonb_build_object('recorded', v_recorded);
end $$;

revoke all on function public.booth_event_summary(text, boolean) from public, anon, authenticated;
grant execute on function public.booth_event_summary(text, boolean) to service_role;
