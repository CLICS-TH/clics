-- Booth reply cache (#387, ADR 0011): a reply the AI already gave to a typed booth answer at one point of one case
-- version, kept so a later answer that means the same can be replied at once. rimpl embeds the de-identified answer
-- in-process and decides a reuse under its guards (rimpl/src/lib/booth-cache.js); the backend reads and writes
-- this table.
--
-- Why a table of its own (ADR 0004, 0010): it holds no answer text, raw or de-identified. A row is the point of the
-- case (case, version, bank, tier path, language), the embedding of the de-identified answer, the guard cues (short
-- digests, never text), the tier it was sorted into and the checked-in reply and pick. A tier other than B or R, or
-- a reply with a safety field, cannot be stored (CHECKs), so a weaker or safety reply is never reused. Rows are
-- never updated. backend/tests/booth-consistency.test.js holds the column list.
--
-- Idempotent, and nothing reads it while app_settings.booth_reply_cache is 0 (the seed below). Switching it on,
-- in this order: fetch the embedding model (rimpl/scripts/fetch-embed-model.js), run
-- scripts/booth/reply-cache-calibration.mjs on the labelled pairs until it reports zero unsafe reuses, commit its
-- record (--write), get the owner's go-ahead, deploy rimpl and the backend, apply this file, then
--   update public.app_settings set value = 1, updated_at = now() where key = 'booth_reply_cache';
-- and off again: update public.app_settings set value = 0, updated_at = now() where key = 'booth_reply_cache';
-- Without the calibration record rimpl only embeds, so the table fills and nothing is reused.

create table if not exists public.booth_reply_cache (
  id            uuid primary key default gen_random_uuid(),
  case_id       text not null check (case_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  case_version  text not null,
  bank          text not null check (bank ~ '^step[1-9](\.[BRW]{1,8})?$'),
  tier_path     text not null check (tier_path ~ '^[BRW]{0,4}$'),
  language      text not null check (language in ('th', 'en')),
  model         text not null,
  embedding     real[] not null check (array_ndims(embedding) = 1 and cardinality(embedding) between 16 and 4096
                  and array_position(embedding, null) is null),
  cues          text[] not null default '{}' check (cardinality(cues) <= 64 and array_position(cues, null) is null
                  and array_to_string(cues, ' ') ~ '^([0-9a-f]{16}( [0-9a-f]{16})*)?$'),
  tier          text not null check (tier in ('B', 'R')),
  -- Exactly the three reply fields, each a string, and safety empty. CASE, not AND: a NULL would pass a CHECK.
  reply         jsonb not null check (case when jsonb_typeof(reply) = 'object' then
                  reply - 'strength' - 'weigh' - 'safety' = '{}'::jsonb
                  and coalesce(jsonb_typeof(reply->'strength') = 'string' and jsonb_typeof(reply->'weigh') = 'string'
                    and reply->'safety' = '""'::jsonb, false)
                  else false end),
  pick          jsonb check (jsonb_typeof(pick) = 'object'),
  created_at    timestamptz not null default now()
);

create index if not exists booth_reply_cache_point_idx
  on public.booth_reply_cache (case_id, case_version, bank, tier_path, language, created_at desc);

-- DENY-ALL (RLS on, no policy): only the backend's service role reaches the table, and it only reads and appends.
alter table public.booth_reply_cache enable row level security;
revoke all on table public.booth_reply_cache from public, anon, authenticated, service_role;
grant select, insert on table public.booth_reply_cache to service_role;

comment on table public.booth_reply_cache is
  'Booth reply cache (#387): per point of a case version, the embedding of a de-identified typed answer, its guard '
  'cues, its tier (B or R) and the reply given. No answer text.';

insert into public.app_settings (key, value, value_text) values
  ('booth_reply_cache', 0, null)
on conflict (key) do nothing;
