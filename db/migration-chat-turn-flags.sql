-- db/migration-chat-turn-flags.sql
-- Per-turn middleware flags, the sticky deep-mode latch, and an ATOMIC superseded draft (chat router).
--
-- WHAT.
--   1. messages.middleware_flags jsonb: rimpl's per-turn flags on the ASSISTANT row — router_version, tier
--      (fast | deep | null), reason, thinking, thinking_budget, evidence_level, failed_over_from. The
--      backend whitelists them to exactly those keys with primitive values (services/middleware-flags.js);
--      this column never holds rimpl's JSON as it came. Provenance: not readable by client roles (the
--      column grant on messages, db/migration-message-provenance.sql, lists only the original columns).
--   2. ples.deep_mode_at timestamptz: stamped ONCE, on the session's first 'deep' turn whose thinking was
--      applied (tier deep AND thinking true; setting `chat_router_enabled`). The backend then sends
--      `deep_mode: true` on every later turn.
--   3. messages_superseded_reason_check also accepts 'evidence' (the evidence-marker rewrite, setting
--      `chat_evidence_marker`). Until now that reason was stored as NULL.
--   4. store_chat_turn() gains three trailing, defaulted params — p_middleware_flags, p_superseded_draft,
--      p_superseded_reason — written on the assistant row in the SAME transaction as the turn. Before this,
--      a streamed draft was a separate update after the turn: a crash in between lost what the physician
--      had been shown. Everything else the function does is unchanged: clock_timestamp() per row, the
--      CT409 ple-not-active refusal (and P0002 not-found), p_replace_physician_id, the return shape,
--      search_path, security invoker, and service-role-only execute. ONE function: the 12-param
--      signature is dropped, so an old-shape call (named or positional) resolves to this one through
--      the defaults, and PostgREST never sees two candidates.
--
-- ORDER: EITHER ORDER IS SAFE; APPLY THIS FIRST IF YOU CAN. Migration first: the deployed backend's old call
-- (the 12 old param names) resolves to the new function through the defaults, so nothing changes for it.
-- Code first: the new backend calls the new signature and, on a missing function (PGRST202 / 42883),
-- retries ONCE with the old params and writes the draft and the flags as separate, tolerant updates; a
-- missing deep_mode_at / middleware_flags column is logged (throttled) and skipped. Safe, but it costs a
-- failed RPC and a failed PATCH on every turn until this is applied. Apply it BEFORE setting
-- app_settings.chat_router_enabled to 1. Prerequisites: db/migration-message-provenance.sql,
-- db/migration-message-client-turn-id.sql (and db/migration-message-superseded-draft.sql — its two columns
-- are re-added here IF NOT EXISTS, so the CHECK below always has its column).
--
-- RE-RUNNING db/migration-message-client-turn-id.sql AFTER THIS ONE re-creates the 12-param overload
-- beside this function, and an old-shape named call becomes ambiguous. Re-run this file afterwards; it
-- drops that overload again.
--
-- Safe to re-run (idempotent): every statement is IF [NOT] EXISTS or CREATE OR REPLACE, and the CHECK is
-- dropped and re-added inside this one transaction. Additive + nullable: pre-existing rows stay NULL —
-- their flags were never recorded and must not be back-filled with a guess.
-- Checked against a throwaway PostgreSQL 17 by scripts/db/chat-turn-flags-test.sh (CI job chat-turn-flags).
-- ===========================================================================

begin;

alter table public.messages
  add column if not exists middleware_flags  jsonb,
  add column if not exists superseded_draft  text,
  add column if not exists superseded_reason text;

alter table public.ples
  add column if not exists deep_mode_at timestamptz;

-- Every value the old constraint accepted, plus 'evidence'. Existing rows hold only old values (or NULL),
-- so re-validating them cannot fail.
alter table public.messages drop constraint if exists messages_superseded_reason_check;
alter table public.messages add constraint messages_superseded_reason_check
  check (superseded_reason is null or superseded_reason in ('citation', 'language', 'rescue', 'evidence'));

comment on column public.messages.middleware_flags is
  'Assistant rows only: rimpl''s per-turn middleware flags, whitelisted by the backend to router_version, tier (fast|deep|null), reason, thinking, thinking_budget, evidence_level, failed_over_from (primitives only). NULL on physician rows, rows written before 2026-10, and turns from an rimpl that sent none.';
comment on column public.messages.superseded_reason is
  'Which post-check replaced superseded_draft: citation | language | rescue | evidence (rescue is never streamed today). NULL when the check was not one of these.';
comment on column public.ples.deep_mode_at is
  'When the chat router first served this session a deep turn with thinking applied (tier deep, thinking true; setting chat_router_enabled). Set once, never cleared; while set the backend sends deep_mode: true so the session stays deep. NULL = never deep.';

-- ---------------------------------------------------------------------------------------------------
-- store_chat_turn. Both earlier signatures go: the 11-param draft (as before) and the 12-param function
-- this replaces. CREATE OR REPLACE keeps a re-run of this file in place.
drop function if exists public.store_chat_turn(uuid, uuid, text, integer, text, jsonb, text, integer, text, text, text);
drop function if exists public.store_chat_turn(uuid, uuid, text, integer, text, jsonb, text, integer, text, text, text, uuid);

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
  p_replace_physician_id uuid default null,   -- an orphaned question of THIS key to replace (repair)
  p_middleware_flags     jsonb default null,  -- whitelisted by the backend; assistant row only
  p_superseded_draft     text default null,   -- a streamed draft a corrective retry replaced
  p_superseded_reason    text default null)   -- which check replaced it (messages_superseded_reason_check)
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
  -- the whole call, so neither row is stored (and a replaced orphan is restored). A reason the CHECK
  -- refuses (23514) aborts it the same way; the backend sends only reasons the constraint knows.
  insert into public.messages (ple_id, role, content, token_count, client_turn_id, created_at)
  values (p_ple_id, 'physician', p_physician_content, coalesce(p_physician_tokens, 0), p_client_turn_id, clock_timestamp())
  returning id into v_physician;
  insert into public.messages (ple_id, role, content, refs, socratic_question, token_count,
                               provider, model, prompt_version, client_turn_id,
                               middleware_flags, superseded_draft, superseded_reason, created_at)
  values (p_ple_id, 'assistant', p_assistant_content, coalesce(p_refs, '[]'::jsonb), p_socratic_question,
          coalesce(p_assistant_tokens, 0), p_provider, p_model, p_prompt_version, p_client_turn_id,
          p_middleware_flags, p_superseded_draft, p_superseded_reason, clock_timestamp())
  returning id into v_assistant;
  return query select v_physician, v_assistant;
end $$;

revoke all on function public.store_chat_turn(uuid, uuid, text, integer, text, jsonb, text, integer, text, text, text, uuid, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.store_chat_turn(uuid, uuid, text, integer, text, jsonb, text, integer, text, text, text, uuid, jsonb, text, text)
  to service_role;

comment on function public.store_chat_turn(uuid, uuid, text, integer, text, jsonb, text, integer, text, text, text, uuid, jsonb, text, text) is
  'Stores the physician + assistant rows of one chat turn in one transaction (clock_timestamp per row); key optional. Optionally replaces an orphaned question of the same key in the same transaction. The assistant row also carries middleware_flags and a superseded draft + reason when given. Raises CT409 when the PLE is not active; a duplicate physician key (23505) stores neither row. Service role only.';

-- PostgREST picks up the new signature (Supabase also reloads on DDL by itself). Delivered at commit.
notify pgrst, 'reload schema';

commit;
