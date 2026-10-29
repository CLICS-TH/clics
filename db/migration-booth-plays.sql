-- Booth Mode plays (#210): one booth_plays row per kiosk play (tag, demo score, d1-d7, spend, status), the five
-- booth_* app_settings rows that open and close a booth event, and the booth_* functions the backend calls.
--
-- Why outside the pilot model (ADR 0004): SANDBOX is not an isolation boundary. ICC, payouts and the XLSX export
-- filter only on is_test, the Participants sheet lists every professional, PLE/P- codes are global sequences, and
-- the held-out calibration anchors live in SANDBOX. So a booth play creates no professional, no ples/messages/
-- ai_evaluations/lpdp_snapshots row and no code, and its AI spend never touches professionals.usage_cost_usd
-- (the $0.50 cap and api_budget_pool_usd both read that column). The dialogue lives only in the kiosk's memory:
-- this table has NO transcript, answer-text, IP or device column, and none may be added
-- (backend/tests/booth-consistency.test.js holds the column list).
--
-- Idempotent. Apply to the prod Supabase BEFORE deploying the backend that mounts /booth.
--
-- Switching the event on, until the superadmin booth card (#214) exists (times need an explicit offset):
--   update public.app_settings set value = 1, updated_at = now() where key = 'booth_enabled';
--   update public.app_settings set value_text = '2026-11-03T08:00:00+07:00', updated_at = now() where key = 'booth_opens_at';
--   update public.app_settings set value_text = '2026-11-04T18:00:00+07:00', updated_at = now() where key = 'booth_closes_at';
-- and off again: update public.app_settings set value = 0, updated_at = now() where key = 'booth_enabled';

create table if not exists public.booth_plays (
  id          uuid primary key default gen_random_uuid(),
  event_code  text not null check (event_code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  tag         integer not null check (tag > 0),
  status      text not null default 'started'
              check (status in ('started', 'scored', 'unavailable', 'abandoned')),
  spend_usd   numeric(10, 6) not null default 0 check (spend_usd >= 0),
  composite   numeric(5, 2) check (composite between 0 and 100),
  d1 smallint check (d1 between 0 and 5),
  d2 smallint check (d2 between 0 and 5),
  d3 smallint check (d3 between 0 and 5),
  d4 smallint check (d4 between 0 and 5),
  d5 smallint check (d5 between 0 and 5),
  d6 smallint check (d6 between 0 and 5),
  d7 smallint check (d7 between 0 and 5),
  created_at  timestamptz not null default now(),
  scored_at   timestamptz,
  constraint booth_plays_event_tag_key unique (event_code, tag),
  constraint booth_plays_score_complete check (
    (status = 'scored') = (composite is not null)
    and (status = 'scored') = (scored_at is not null)
    and num_nonnulls(d1, d2, d3, d4, d5, d6, d7) = case when status = 'scored' then 7 else 0 end
  )
);

-- #212: a play whose answers were all tapped choices. Only these rank on the public board: a typed answer reaches the
-- evaluator as written and could address it. Added after the table went out, so it is an ALTER.
alter table public.booth_plays add column if not exists ranked boolean not null default false;

-- DENY-ALL (RLS on, no policy): only the backend's service role reads or writes booth plays.
alter table public.booth_plays enable row level security;

comment on table public.booth_plays is
  'Booth Mode plays (ADR 0004): tag, demo score, d1-d7, spend and status only. No transcript, answer text, IP or '
  'device data, and no link to professionals or ples. Deleted 30 days after the event (#217).';

create or replace function public.booth_start_play(p_event text)
returns table (play_id uuid, play_tag integer)
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('booth_plays:' || p_event));

  update public.booth_plays b
     set status = 'abandoned'
   where b.event_code = p_event and b.status = 'started' and b.created_at < now() - interval '30 minutes';

  insert into public.booth_plays (event_code, tag)
  select p_event, coalesce(max(b.tag), 0) + 1 from public.booth_plays b where b.event_code = p_event
  returning id, tag into play_id, play_tag;
  return next;
end $$;

-- Returns one of:
--   'reserved'     the play is 'started', in this event, and spend + p_amount <= p_ceiling; spend now includes it
--   'ceiling'      the play is 'started' but the call would pass the ceiling; the play is now 'unavailable'
--   'not_started'  the play exists in this event but is already scored, unavailable or abandoned
--   'not_found'    no such play in this event
create or replace function public.booth_reserve_spend(p_play uuid, p_event text, p_amount numeric, p_ceiling numeric)
returns text
language plpgsql as $$
begin
  update public.booth_plays
     set spend_usd = spend_usd + p_amount
   where id = p_play and event_code = p_event and status = 'started' and spend_usd + p_amount <= p_ceiling;
  if found then return 'reserved'; end if;

  update public.booth_plays
     set status = 'unavailable'
   where id = p_play and event_code = p_event and status = 'started';
  if found then return 'ceiling'; end if;

  perform 1 from public.booth_plays where id = p_play and event_code = p_event;
  if found then return 'not_started'; end if;
  return 'not_found';
end $$;

-- p_delta = actual - reserved (negative when the call was cheaper).
create or replace function public.booth_settle_spend(p_play uuid, p_delta numeric)
returns void
language sql as $$
  update public.booth_plays set spend_usd = spend_usd + p_delta where id = p_play;
$$;

revoke all on function public.booth_start_play(text) from public, anon, authenticated;
revoke all on function public.booth_reserve_spend(uuid, text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.booth_settle_spend(uuid, numeric) from public, anon, authenticated;
grant execute on function public.booth_start_play(text) to service_role;
grant execute on function public.booth_reserve_spend(uuid, text, numeric, numeric) to service_role;
grant execute on function public.booth_settle_spend(uuid, numeric) to service_role;

insert into public.app_settings (key, value, value_text) values
  ('booth_event_code',       0, 'NFCME-2026'),
  ('booth_enabled',          0, null),
  ('booth_opens_at',         0, null),
  ('booth_closes_at',        0, null),
  ('booth_play_ceiling_usd', 3, null)
on conflict (key) do nothing;
