-- Booth sort memo (#374): the tier a typed booth answer was first sorted into, kept so the same text at the same
-- point of the same case version always sorts the same. The backend sends the AI the answer and keeps only the
-- tier it gave, under an HMAC (server secret) of the case id, version, tier path and normalised text.
--
-- Why a table of its own (ADR 0004): the text never reaches the database. A row is a 64-hex key and a tier
-- letter, never updated; there is NO text column, and none may be added (backend/tests/booth-consistency.test.js
-- holds the column list). First writer wins: a play that loses the race reads the stored tier.
--
-- Idempotent. Needs nothing from migration-booth-plays.sql; the backend that calls booth_sort_memo falls back to
-- the AI's tier while this file is not applied, so apply it any time before or after that deploy.

create table if not exists public.booth_sort_memos (
  key         text primary key check (key ~ '^[0-9a-f]{64}$'),
  tier        text not null check (tier in ('B', 'R', 'W')),
  created_at  timestamptz not null default now()
);

-- DENY-ALL (RLS on, no policy): only the backend's service role reaches the memo, and only through the function.
alter table public.booth_sort_memos enable row level security;
revoke all on table public.booth_sort_memos from public, anon, authenticated;

comment on table public.booth_sort_memos is
  'Booth sort memo (#374): an HMAC of a typed answer at one point of one case version, and its first tier. '
  'No text column.';

-- With p_tier: keeps it unless the key already has one. Either way returns the stored tier (null on a miss, which
-- only a lookup without p_tier can see).
create or replace function public.booth_sort_memo(p_key text, p_tier text default null)
returns text
language plpgsql as $$
declare
  stored text;
begin
  if p_tier is not null then
    insert into public.booth_sort_memos (key, tier) values (p_key, p_tier) on conflict (key) do nothing;
  end if;
  select tier into stored from public.booth_sort_memos where key = p_key;
  return stored;
end $$;

revoke all on function public.booth_sort_memo(text, text) from public, anon, authenticated;
grant execute on function public.booth_sort_memo(text, text) to service_role;
