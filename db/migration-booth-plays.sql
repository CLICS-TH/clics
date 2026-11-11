-- Booth Mode plays (#210): one booth_plays row per kiosk play (tag, demo score, d1-d7, spend, status), the
-- booth_* app_settings rows that open and close a booth event and switch the board to five-step plays, and the
-- booth_* functions the backend calls.
--
-- Why outside the pilot model (ADR 0004): SANDBOX is not an isolation boundary. ICC, payouts and the XLSX export
-- filter only on is_test, the Participants sheet lists every professional, PLE/P- codes are global sequences, and
-- the held-out calibration anchors live in SANDBOX. So a booth play creates no professional, no ples/messages/
-- ai_evaluations/lpdp_snapshots row and no code, and its AI spend never touches professionals.usage_cost_usd
-- (the $0.50 cap and api_budget_pool_usd both read that column). Since #375 (ADR 0010) a scored play keeps its
-- dialogue as open research data: per step the ids it was asked and chose, the AI reply and, for a typed answer,
-- rimpl's de-identified text of it, and since #377 the kiosk's language look. Never the raw typed text, an IP or
-- device data (backend/tests/booth-consistency.test.js holds the column list). Rows are kept, with no 30-day delete;
-- migration-booth-purge.sql removes an event's plays only for a test event or an owner-ordered removal.
--
-- Idempotent. #246 adds case_id, case_version and tier_path and replaces booth_start_play(text) with
-- booth_start_play(text, text, text). The running backend calls only one of the two, so apply this file right
-- before deploying the backend that sends p_case and p_version: a start fails in between. Then re-apply
-- migration-booth-purge.sql, which reads the same advisory key.
--
-- #380 (spec #370) lets a play run five steps: tier_path up to five letters, replied_step up to 5, and d1-d7 one
-- decimal (a five-step case scores from a fitted table). It seeds booth_board_five_steps off. Apply it before
-- deploying the backend that plays five-step cases: the old checks refuse a fourth reply, a tier path past three
-- letters and a decimal domain, so such a play would answer unavailable.
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
  d1 numeric(2, 1) check (d1 between 0 and 5),
  d2 numeric(2, 1) check (d2 between 0 and 5),
  d3 numeric(2, 1) check (d3 between 0 and 5),
  d4 numeric(2, 1) check (d4 between 0 and 5),
  d5 numeric(2, 1) check (d5 between 0 and 5),
  d6 numeric(2, 1) check (d6 between 0 and 5),
  d7 numeric(2, 1) check (d7 between 0 and 5),
  created_at  timestamptz not null default now(),
  scored_at   timestamptz,
  constraint booth_plays_event_tag_key unique (event_code, tag),
  constraint booth_plays_score_complete check (
    (status = 'scored') = (composite is not null)
    and (status = 'scored') = (scored_at is not null)
    and num_nonnulls(d1, d2, d3, d4, d5, d6, d7) = case when status = 'scored' then 7 else 0 end
  )
);

-- #212: whether the play ranks on the public board. Since #247 every scored play ranks (a typed answer included);
-- older rows keep false. Added after the table went out, so it is an ALTER.
alter table public.booth_plays add column if not exists ranked boolean not null default false;

-- #246: the case and version the play walked (reply and score rebuild the dialogue from that case alone) and the
-- tier letters of its answers. Ids and letters only, never option or answer text (ADR 0004). Null on older rows.
alter table public.booth_plays add column if not exists case_id text
  constraint booth_plays_case_id_check check (case_id ~ '^[a-z0-9][a-z0-9-]{0,31}$');
alter table public.booth_plays add column if not exists case_version text;
alter table public.booth_plays add column if not exists tier_path text
  constraint booth_plays_tier_path_check check (tier_path ~ '^[BRW]{0,5}$');

-- #247: how many replies the play has had. A reply for step n claims it only from n - 1, so one step is answered
-- once and a re-posted reply cannot draw the AI's tier for a typed answer again.
alter table public.booth_plays add column if not exists replied_step smallint not null default 0
  constraint booth_plays_replied_step_check check (replied_step between 0 and 5);

-- #380: a table that existed before five-step plays keeps its three-step checks and whole domains through the adds
-- above, so they are replaced here. Converting smallint to numeric(2, 1) keeps every stored value.
alter table public.booth_plays drop constraint if exists booth_plays_tier_path_check;
alter table public.booth_plays add constraint booth_plays_tier_path_check check (tier_path ~ '^[BRW]{0,5}$');
alter table public.booth_plays drop constraint if exists booth_plays_replied_step_check;
alter table public.booth_plays add constraint booth_plays_replied_step_check check (replied_step between 0 and 5);
alter table public.booth_plays
  alter column d1 type numeric(2, 1),
  alter column d2 type numeric(2, 1),
  alter column d3 type numeric(2, 1),
  alter column d4 type numeric(2, 1),
  alter column d5 type numeric(2, 1),
  alter column d6 type numeric(2, 1),
  alter column d7 type numeric(2, 1);

-- #375 (ADR 0010): the play's dialogue (backend services/booth-dialogue.js stepRecords), per step { variant,
-- bridge, options, choice | typed, reply, tier }, typed being rimpl's de-identified text, and whether the score came
-- from the live evaluator or the case's path score table. Written with the score. Older rows, the 3-4 Nov 2026
-- NFCME-2026 plays among them, keep nulls: no backfill.
alter table public.booth_plays add column if not exists steps jsonb
  constraint booth_plays_steps_check check (jsonb_typeof(steps) = 'array');
alter table public.booth_plays add column if not exists score_source text
  constraint booth_plays_score_source_check check (score_source in ('table', 'live'));

-- #377: the kiosk's language look when the play was scored (backend services/booth-dialogue.js LOOK_LANGUAGE). It
-- set the language of the AI replies, never the score. Older rows keep null.
alter table public.booth_plays add column if not exists language_look text
  constraint booth_plays_language_look_check check (language_look in ('th+en', 'th', 'en+th', 'en'));

-- DENY-ALL (RLS on, no policy): only the backend's service role reads or writes booth plays.
alter table public.booth_plays enable row level security;

comment on table public.booth_plays is
  'Booth Mode plays (ADR 0004, 0010): tag, demo score, d1-d7, spend, status, case id and version, tier path, '
  'score source, language look and the de-identified dialogue (option ids, AI replies, rimpl''s de-identified typed answers). '
  'Never raw typed text, IP or device data, and no link to professionals or ples. Kept as open research data with '
  'no 30-day delete; purged only for a test event or an owner-ordered removal.';

drop function if exists public.booth_start_play(text);

create or replace function public.booth_start_play(p_event text, p_case text, p_version text)
returns table (play_id uuid, play_tag integer)
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('booth_plays:' || p_event));

  -- Checked under the lock: a start admitted before a switch-off that waited out a purge (which commits only while
  -- booth_enabled = 0, migration-booth-purge.sql) must not recreate a row. No row is the backend's 'unavailable'.
  perform 1 from public.app_settings where key = 'booth_enabled' and value = 1;
  if not found then return; end if;

  update public.booth_plays b
     set status = 'abandoned'
   where b.event_code = p_event and b.status = 'started' and b.created_at < now() - interval '30 minutes';

  insert into public.booth_plays (event_code, tag, case_id, case_version)
  select p_event, coalesce(max(b.tag), 0) + 1, p_case, p_version from public.booth_plays b where b.event_code = p_event
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

revoke all on function public.booth_start_play(text, text, text) from public, anon, authenticated;
revoke all on function public.booth_reserve_spend(uuid, text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.booth_settle_spend(uuid, numeric) from public, anon, authenticated;
grant execute on function public.booth_start_play(text, text, text) to service_role;
grant execute on function public.booth_reserve_spend(uuid, text, numeric, numeric) to service_role;
grant execute on function public.booth_settle_spend(uuid, numeric) to service_role;

insert into public.app_settings (key, value, value_text) values
  ('booth_event_code',       0, 'NFCME-2026'),
  ('booth_enabled',          0, null),
  ('booth_opens_at',         0, null),
  ('booth_closes_at',        0, null),
  ('booth_play_ceiling_usd', 3, null),
  ('booth_board_five_steps', 0, null)
on conflict (key) do nothing;
