-- db/migration-message-client-turn-id.sql
-- Idempotency key for a physician chat turn (POST /ples/:id/message `client_turn_id`).
--
-- WHY. A dropped connection used to be indistinguishable from a failed turn: the physician-ui showed
-- "something went wrong", restored the text and offered Retry, while the backend had very often already
-- stored both rows (it persists AFTER rimpl returns). Re-sending inserted the physician message a second
-- time into the scored transcript (CREC082: PLE transcripts are scored evidence). The client now
-- generates one UUID per typed turn and reuses it on retry; this column + unique index is what makes the
-- DATABASE the arbiter when the original request and its retry overlap.
--
-- SHAPE. client_turn_id is stamped on BOTH rows of a turn (the physician row and the assistant reply) so
-- a retry can fetch the stored pair by key without inferring it from timestamps. Uniqueness is enforced
-- on the PHYSICIAN row only (partial index), per PLE: the same UUID can never claim two physician turns
-- in one episode, and legacy / unkeyed rows (NULL) are unconstrained.
--
-- ORDER: DEPLOY THE BACKEND FIRST, then apply this. The backend feature-detects the column: until this
-- is applied it logs "[turn-idem] client_turn_id column missing" and behaves exactly as before (no
-- dedup), so code-before-migration is safe. The reverse is also safe (nothing reads the column until the
-- backend that names it ships). Additive + nullable, so no existing row or older code path is touched.
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
