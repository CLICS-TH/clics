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
-- ORDER: DEPLOY THE BACKEND FIRST, then apply this. The backend feature-detects both objects: until this
-- is applied it logs "[turn-idem] ... missing" (throttled) and behaves exactly as before (no dedup), so
-- code-before-migration is safe. Additive + nullable: no existing row or older code path is touched.
-- Safe to re-run (idempotent). Pre-existing rows stay NULL: they were never keyed and must not be
-- back-filled with a guess.
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
