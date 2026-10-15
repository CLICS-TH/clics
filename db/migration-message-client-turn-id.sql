-- db/migration-message-client-turn-id.sql
-- Idempotency for a physician chat turn (POST /ples/:id/message `client_turn_id`).
--
-- WHY. A dropped connection used to be indistinguishable from a failed turn: the physician-ui showed
-- "something went wrong", restored the text and offered Retry, while the backend had very often already
-- stored both rows (it persists AFTER rimpl returns). Re-sending inserted the physician message a second
-- time into the scored transcript (CREC082: PLE transcripts are scored evidence). The client now
-- generates one UUID per typed turn and reuses it on retry.
--
-- TWO PIECES, deliberately in different tables.
--   1. chat_turn_claims: "a request is working on this turn right now". Taken BEFORE the paid AI call
--      and kept OUT of `messages`, so the scored transcript never holds a row for a turn that has not
--      been answered. A claim left behind by a killed request (a redeploy) is harmless metadata: it
--      goes stale after the AI-call ceiling and the next retry takes it over. Nothing scores it.
--   2. messages.client_turn_id + a partial unique index on the physician row: the FINAL arbiter. The
--      physician and assistant rows are still written after rimpl returns, in the same order and with
--      the same timestamps as before; if two requests for one key both reach that point (a late original
--      and the retry that took over its stale claim), the second physician insert fails here and that
--      request stores nothing.
--
--   3. store_chat_turn(): the physician + assistant rows of a turn (keyed or not) in ONE transaction, refused when
--      the PLE is no longer active. Without it the two rows were separate inserts, so a crash between them
--      left a question with no reply, and a reply could land in a session /end had already closed.
--
-- ORDER: DEPLOY THE BACKEND FIRST, then apply this. The backend feature-detects all three objects: until this
-- is applied it logs "[turn-idem] missing <object>" (throttled) and behaves exactly as before, so
-- code-before-migration is safe. Additive + nullable: no existing row or older code path is touched.
-- Safe to re-run (idempotent). Pre-existing rows stay NULL: they were never keyed and must not be
-- back-filled with a guess.
--
-- SUPERSEDED for store_chat_turn() by db/migration-chat-turn-flags.sql (three trailing params). Re-running
-- THIS file after that one re-creates the 12-param overload beside it, and an old-shape named call becomes
-- ambiguous (42725) — re-run migration-chat-turn-flags.sql afterwards, which drops it again.
-- ===========================================================================

alter table public.messages
  add column if not exists client_turn_id uuid;

create unique index if not exists messages_ple_client_turn_uidx
  on public.messages (ple_id, client_turn_id)
  where client_turn_id is not null and role = 'physician';

comment on column public.messages.client_turn_id is
  'Client-generated UUID of the chat turn this row belongs to (set on both the physician row and its assistant reply); NULL for rows written before 2026-10 or by a client that sent no key. Unique per (ple_id) on physician rows only.';

create table if not exists public.chat_turn_claims (
  ple_id         uuid not null references public.ples(id) on delete cascade,
  client_turn_id uuid not null,
  claim_token    uuid not null,
  status         text not null default 'in_flight' check (status in ('in_flight', 'done')),
  claimed_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  primary key (ple_id, client_turn_id)
);

-- DENY-ALL to client roles (no policy): only the backend's service role touches claims.
alter table public.chat_turn_claims enable row level security;

comment on table public.chat_turn_claims is
  'Chat-turn idempotency claims. One row per (PLE, client turn id) while a request works on that turn. Not part of the transcript; never scored. A row stuck in_flight past the AI-call ceiling is stale and is taken over by the next retry.';
comment on column public.chat_turn_claims.claim_token is
  'Random per-claimer token. Release, completion and takeover are conditional on it, so a late request can never release or complete a claim another request has taken over.';
comment on column public.chat_turn_claims.claimed_at is
  'When the CURRENT holder took the claim (reset on takeover). Freshness is measured from here; created_at is the first claim.';

-- ---------------------------------------------------------------------------------------------------
-- store_chat_turn: write one keyed turn atomically. Called by the backend (service role) only.
-- SQLSTATE CT409 = the PLE is not active (the backend answers 409 ple_not_active and refunds).
-- (An earlier draft of this function had no p_replace_physician_id. Drop that signature if a branch ever
-- applied it, so the two overloads can never both exist.)
drop function if exists public.store_chat_turn(uuid, uuid, text, integer, text, jsonb, text, integer, text, text, text);

create or replace function public.store_chat_turn(
  p_ple_id               uuid,
  p_client_turn_id       uuid,      -- NULL for an unkeyed turn: same atomicity and refusal, no idempotency
  p_physician_content    text,
  p_physician_tokens     integer,
  p_assistant_content    text,
  p_refs                 jsonb,
  p_socratic_question    text,
  p_assistant_tokens     integer,
  p_provider             text,
  p_model                text,
  p_prompt_version       text,
  p_replace_physician_id uuid default null)  -- an orphaned question of THIS key to replace (repair)
returns table (physician_id uuid, assistant_id uuid)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_status text;
  v_physician uuid;
  v_assistant uuid;
begin
  -- FOR SHARE: an /end that is closing this session right now commits first, and we then see it closed.
  select status into v_status from public.ples where id = p_ple_id for share;
  if v_status is null then
    raise exception 'store_chat_turn: ple_not_found %', p_ple_id using errcode = 'P0002';
  end if;
  if v_status <> 'active' then
    raise exception 'store_chat_turn: ple_not_active % (%)', p_ple_id, v_status using errcode = 'CT409';
  end if;
  -- Repair: remove the orphaned question this turn replaces — only that row (id + PLE + role + key), and
  -- only while no reply carries the key. Inside this transaction, so it is undone if anything below fails
  -- and never happens in a session that has ended (refused above).
  if p_replace_physician_id is not null then
    delete from public.messages m
     where m.id = p_replace_physician_id
       and m.ple_id = p_ple_id
       and m.role = 'physician'
       and m.client_turn_id = p_client_turn_id
       and not exists (select 1 from public.messages a
                        where a.ple_id = p_ple_id and a.role = 'assistant' and a.client_turn_id = p_client_turn_id);
  end if;
  -- Explicit column lists (never an array insert, which sends NULL instead of DEFAULT for an omitted key).
  -- clock_timestamp(), not now(): now() is the transaction start, so both rows would tie on created_at and
  -- the transcript order (ORDER BY created_at) would become arbitrary. A 23505 on the physician key aborts
  -- the whole call, so neither row is stored (and a replaced orphan is restored).
  insert into public.messages (ple_id, role, content, token_count, client_turn_id, created_at)
  values (p_ple_id, 'physician', p_physician_content, coalesce(p_physician_tokens, 0), p_client_turn_id, clock_timestamp())
  returning id into v_physician;
  insert into public.messages (ple_id, role, content, refs, socratic_question, token_count,
                               provider, model, prompt_version, client_turn_id, created_at)
  values (p_ple_id, 'assistant', p_assistant_content, coalesce(p_refs, '[]'::jsonb), p_socratic_question,
          coalesce(p_assistant_tokens, 0), p_provider, p_model, p_prompt_version, p_client_turn_id, clock_timestamp())
  returning id into v_assistant;
  return query select v_physician, v_assistant;
end $$;

revoke all on function public.store_chat_turn(uuid, uuid, text, integer, text, jsonb, text, integer, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.store_chat_turn(uuid, uuid, text, integer, text, jsonb, text, integer, text, text, text, uuid)
  to service_role;

comment on function public.store_chat_turn(uuid, uuid, text, integer, text, jsonb, text, integer, text, text, text, uuid) is
  'Stores the physician + assistant rows of one chat turn in one transaction (clock_timestamp per row); key optional. Optionally replaces an orphaned question of the same key in the same transaction. Raises CT409 when the PLE is not active; a duplicate physician key (23505) stores neither row. Service role only.';
