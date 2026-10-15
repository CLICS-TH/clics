#!/bin/bash
# Exercise db/migration-chat-turn-flags.sql against a REAL, throwaway PostgreSQL — the hermetic jest suites
# play store_chat_turn() with an in-memory model; this checks the SQL itself. Nothing here touches any
# shared database.
#
#   scripts/db/chat-turn-flags-test.sh            # needs initdb/pg_ctl/psql on PATH (or PG_BIN)
#
# Loads the prerequisite migrations onto stand-in Supabase roles and tables, then asserts: the migration
# applies twice (idempotent) and leaves exactly ONE store_chat_turn; security mode, search_path and the
# grants are what the old function had; an old-shape call (named and positional) still resolves through
# the defaults; the new params land on the ASSISTANT row only; rows keep clock_timestamp order; 'evidence'
# passes the widened CHECK and a bogus reason fails it (directly, and inside the store, storing nothing);
# the ple-not-active refusal still raises CT409 (old and new shape) and stores nothing; duplicate key
# 23505 and the repair path still behave; anon/authenticated cannot execute or read middleware_flags;
# the deep_mode_at set-once write matches once; re-running the OLD client-turn-id migration re-creates
# the 12-param overload and re-running this one removes it again.
set -euo pipefail
export LC_ALL=C LANG=C
export PGOPTIONS="-c client_min_messages=warning"   # the IF [NOT] EXISTS notices are expected; keep the output readable

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$ROOT/db/migration-chat-turn-flags.sql"
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@17/bin/pg_ctl)")}"
DIR="$(mktemp -d)"
trap '"$PG_BIN/pg_ctl" -D "$DIR/data" stop -m fast >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT

"$PG_BIN/initdb" -D "$DIR/data" -U postgres -A trust -E UTF8 --locale=C >/dev/null
# TCP only: a socket path under a long TMPDIR exceeds the 103-byte Unix-socket limit on macOS. The first
# free port from PORT (default 55441) up: a port in use makes the postmaster exit, and we try the next.
START="${PORT:-55441}"
PORT=""
for p in $(seq "$START" $((START + 20))); do
  if "$PG_BIN/pg_ctl" -D "$DIR/data" -o "-p $p -c unix_socket_directories='' -c listen_addresses=127.0.0.1" \
       -l "$DIR/log" -w start >/dev/null 2>&1; then PORT="$p"; break; fi
done
[ -n "$PORT" ] || { echo "could not start PostgreSQL on ports $START..$((START + 20))"; cat "$DIR/log"; exit 1; }
echo "postgres $("$PG_BIN/postgres" --version | awk '{print $3}') on 127.0.0.1:$PORT"

P() { "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d t -v ON_ERROR_STOP=1 -X -q -At -P pager=off "$@"; }
"$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -X -q -c "create database t;"

FAIL=0
expect() { # expect <label> <want> <got>
  if [ "$2" == "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: want [$2] got [$3]"; FAIL=1; fi
}
sqlstate() { # sqlstate <sql> → the SQLSTATE it raised, or "ok"
  local out
  if out="$(P -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo ok; else
    echo "$out" | sed -n 's/^ERROR: *\([0-9A-Z]\{5\}\):.*/\1/p' | head -1; fi
}

# Supabase-shaped stand-ins: the three API roles (service_role bypasses RLS, as on Supabase) and the two
# tables store_chat_turn touches, in their pre-2026-10 shape. Supabase grants table access to the API roles
# by default; the provenance migration then narrows messages for anon/authenticated.
P <<'SQL'
create role anon; create role authenticated; create role service_role bypassrls;
create table public.ples (id uuid primary key default gen_random_uuid(), status text not null default 'active');
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  ple_id uuid not null references public.ples(id) on delete cascade,
  role text not null check (role in ('physician','assistant')),
  content text not null, refs jsonb default '[]'::jsonb, socratic_question text,
  token_count integer default 0, created_at timestamptz default now());
create table public.audit_discussions (id uuid primary key default gen_random_uuid());
grant usage on schema public to service_role, anon, authenticated;
grant select, insert, update, delete on public.ples, public.messages to service_role, anon, authenticated;
SQL
for f in migration-message-provenance.sql migration-message-client-turn-id.sql migration-message-superseded-draft.sql; do
  P -f "$ROOT/db/$f" >/dev/null
done

FN="store_chat_turn"
fn_props() { P -c "select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''),
  coalesce((select string_agg(a, ',' order by a) from unnest(p.proacl::text[]) a), '')
  from pg_proc p where p.proname = '$FN'"; }
BEFORE="$(fn_props)"
echo "before: one 12-param function, props [$BEFORE]"

# Fixtures: an active PLE, an ended one, and a key-carrying row set from the OLD function, written before the migration.
P -c "insert into ples(id, status) values
  ('00000000-0000-0000-0000-00000000000a', 'active'),
  ('00000000-0000-0000-0000-00000000000e', 'ended')"
A='00000000-0000-0000-0000-00000000000a'; E='00000000-0000-0000-0000-00000000000e'
OLD_NAMED() { # OLD_NAMED <ple> <key|null> <answer> — exactly the call the deployed backend makes today
  echo "select physician_id || '|' || assistant_id from store_chat_turn(p_ple_id => '$1', p_client_turn_id => $2,
    p_physician_content => 'q', p_physician_tokens => 3, p_assistant_content => '$3', p_refs => null,
    p_socratic_question => null, p_assistant_tokens => 120, p_provider => 'local', p_model => 'm',
    p_prompt_version => 'pv', p_replace_physician_id => null)"; }
NEW_NAMED() { # NEW_NAMED <ple> <key|null> <answer> <flags-json|null> <draft|null> <reason|null>
  echo "select physician_id || '|' || assistant_id from store_chat_turn(p_ple_id => '$1', p_client_turn_id => $2,
    p_physician_content => 'q', p_physician_tokens => 3, p_assistant_content => '$3', p_refs => null,
    p_socratic_question => null, p_assistant_tokens => 120, p_provider => 'local', p_model => 'm',
    p_prompt_version => 'pv', p_replace_physician_id => null,
    p_middleware_flags => $4, p_superseded_draft => $5, p_superseded_reason => $6)"; }
AS_SR() { echo "set role service_role; $1"; }
P -c "$(AS_SR "$(OLD_NAMED $A null 'pre-migration answer')")" >/dev/null

echo "migration"
RUNS=""
for n in 1 2; do if P -f "$MIG" >/dev/null; then RUNS="$RUNS ok"; else RUNS="$RUNS fail"; fi; done
expect "applies twice (idempotent)" " ok ok" "$RUNS"
expect "exactly ONE store_chat_turn, 15 params" "1|15" "$(P -c "select count(*), max(pronargs) from pg_proc where proname = '$FN'")"
expect "the 3 new params default to NULL (15 args, 4 defaulted)" "4" "$(P -c "select pronargdefaults from pg_proc where proname = '$FN'")"
AFTER="$(fn_props)"
expect "security mode, search_path and ACL unchanged" "$BEFORE" "$AFTER"
expect "security invoker (as before) + search_path=public" "f|search_path=public" "$(P -c "select prosecdef, array_to_string(proconfig, ',') from pg_proc where proname = '$FN'")"
expect "return shape unchanged" "physician_id uuid, assistant_id uuid" \
  "$(P -c "select pg_get_function_result(oid) from pg_proc where proname = '$FN'" | sed 's/^TABLE(\(.*\))$/\1/')"
expect "columns added (nullable)" "messages.middleware_flags jsonb YES|ples.deep_mode_at timestamp with time zone YES" \
  "$(P -c "select string_agg(table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable, '|' order by table_name)
           from information_schema.columns where (table_name, column_name) in (('messages','middleware_flags'), ('ples','deep_mode_at'))")"
expect "CHECK lists the old values plus evidence" \
  "CHECK (((superseded_reason IS NULL) OR (superseded_reason = ANY (ARRAY['citation'::text, 'language'::text, 'rescue'::text, 'evidence'::text]))))" \
  "$(P -c "select pg_get_constraintdef(oid) from pg_constraint where conname = 'messages_superseded_reason_check'")"
expect "pre-migration rows untouched (flags NULL)" "2|0" \
  "$(P -c "select count(*), count(middleware_flags) from messages where ple_id = '$A'")"

echo "old-shape calls (the backend before this deploy, or its old-signature fallback)"
R="$(P -c "$(AS_SR "$(OLD_NAMED $A null 'old named')")")"
expect "old named args resolve via the defaults" "2" "$(echo "$R" | tr '|' '\n' | grep -c .)"
expect "  → assistant row has no flags/draft" "||" \
  "$(P -c "select coalesce(middleware_flags::text, '') || '|' || coalesce(superseded_draft, '') || '|' || coalesce(superseded_reason, '') from messages where content = 'old named'")"
expect "old POSITIONAL call (12 args) resolves" "ok" \
  "$(sqlstate "set role service_role; select * from store_chat_turn('$A', null, 'q', 3, 'old positional', null, null, 120, 'local', 'm', 'pv', null)")"

echo "new-shape call"
FLAGS="'{\"router_version\":\"r1\",\"tier\":\"deep\",\"reason\":\"complex\",\"thinking\":true,\"thinking_budget\":4096,\"evidence_level\":\"moderate\",\"failed_over_from\":null}'::jsonb"
K1="'11111111-1111-4111-8111-111111111111'"
R="$(P -c "$(AS_SR "$(NEW_NAMED $A "$K1" 'new answer' "$FLAGS" "'the shown draft'" "'evidence'")")")"
PHYS="${R%%|*}"; ASST="${R##*|}"
expect "returns two ids" "2" "$(echo "$R" | tr '|' '\n' | grep -c .)"
expect "flags + draft + reason land on the ASSISTANT row" "deep|4096|the shown draft|evidence|assistant" \
  "$(P -c "select middleware_flags->>'tier', middleware_flags->>'thinking_budget', superseded_draft, superseded_reason, role from messages where id = '$ASST'")"
expect "  → the whole flags object, as given" "7|t" \
  "$(P -c "select (select count(*) from jsonb_object_keys(middleware_flags)), middleware_flags = $FLAGS from messages where id = '$ASST'")"
expect "  → the physician row carries none of them" "||" \
  "$(P -c "select coalesce(middleware_flags::text, '') || '|' || coalesce(superseded_draft, '') || '|' || coalesce(superseded_reason, '') from messages where id = '$PHYS'")"
expect "  → reply stamped strictly after the question (clock_timestamp)" "t" \
  "$(P -c "select (select created_at from messages where id = '$ASST') > (select created_at from messages where id = '$PHYS')")"
expect "  → both rows keyed" "2" "$(P -c "select count(*) from messages where client_turn_id = $K1")"
expect "an unkeyed new-shape call stores both rows" "ok" \
  "$(sqlstate "$(AS_SR "$(NEW_NAMED $A null 'unkeyed new' null "'d'" "'citation'")")")"

echo "CHECK constraint"
expect "'evidence' passes (direct update)" "ok" "$(sqlstate "update messages set superseded_draft = 'x', superseded_reason = 'evidence' where id = '$ASST'")"
for r in citation language rescue; do
  expect "'$r' still passes" "ok" "$(sqlstate "update messages set superseded_reason = '$r' where id = '$ASST'")"
done
expect "a bogus reason fails (direct update) 23514" "23514" "$(sqlstate "update messages set superseded_reason = 'bogus' where id = '$ASST'")"
N0="$(P -c "select count(*) from messages")"
expect "a bogus reason inside store_chat_turn fails 23514" "23514" \
  "$(sqlstate "$(AS_SR "$(NEW_NAMED $A null 'bogus reason' null "'d'" "'bogus'")")")"
expect "  → and stores NEITHER row" "$N0" "$(P -c "select count(*) from messages")"

echo "refusals (unchanged)"
N0="$(P -c "select count(*) from messages")"
expect "ended PLE, new shape: CT409" "CT409" "$(sqlstate "$(AS_SR "$(NEW_NAMED $E null 'late' "$FLAGS" "'d'" "'evidence'")")")"
expect "ended PLE, old shape: CT409" "CT409" "$(sqlstate "$(AS_SR "$(OLD_NAMED $E null 'late old')")")"
expect "  → message still names ple_not_active (the backend also matches on it)" "1" \
  "$(P -c "$(AS_SR "$(NEW_NAMED $E null 'late' null null null)")" 2>&1 | grep -c 'ple_not_active' || true)"
expect "  → nothing stored" "$N0" "$(P -c "select count(*) from messages")"
expect "unknown PLE: P0002" "P0002" "$(sqlstate "$(AS_SR "$(OLD_NAMED 00000000-0000-0000-0000-0000000000ff null 'nowhere')")")"
expect "duplicate key: 23505" "23505" "$(sqlstate "$(AS_SR "$(NEW_NAMED $A "$K1" 'dup' "$FLAGS" null null)")")"
expect "  → nothing stored" "$N0" "$(P -c "select count(*) from messages")"
K2="'22222222-2222-4222-8222-222222222222'"
ORPHAN="$(P -c "insert into messages (ple_id, role, content, client_turn_id) values ('$A', 'physician', 'q', $K2) returning id")"
P -c "$(AS_SR "select * from store_chat_turn(p_ple_id => '$A', p_client_turn_id => $K2, p_physician_content => 'q',
  p_physician_tokens => 3, p_assistant_content => 'repaired', p_refs => null, p_socratic_question => null,
  p_assistant_tokens => 1, p_provider => null, p_model => null, p_prompt_version => null,
  p_replace_physician_id => '$ORPHAN', p_middleware_flags => '{\"tier\":\"fast\"}'::jsonb)")" >/dev/null
expect "repair: orphan replaced, the key holds one pair, flags on the reply" "0|2|fast" \
  "$(P -c "select (select count(*) from messages where id = '$ORPHAN'), (select count(*) from messages where client_turn_id = $K2),
           (select middleware_flags->>'tier' from messages where client_turn_id = $K2 and role = 'assistant')")"

echo "privileges"
expect "anon cannot execute" "42501" "$(sqlstate "set role anon; $(OLD_NAMED $A null 'x')")"
expect "authenticated cannot execute" "42501" "$(sqlstate "set role authenticated; $(NEW_NAMED $A null 'x' null null null)")"
expect "authenticated cannot read middleware_flags" "42501" "$(sqlstate "set role authenticated; select middleware_flags from messages limit 1")"
expect "authenticated still reads the granted columns" "ok" "$(sqlstate "set role authenticated; select id, content from messages limit 1")"

echo "deep_mode_at latch (the backend's set-once write)"
LATCH="with u as (update ples set deep_mode_at = clock_timestamp() where id = '$A' and deep_mode_at is null returning 1) select count(*) from u"
expect "before any deep turn: NULL" "t" "$(P -c "select deep_mode_at is null from ples where id = '$A'")"
expect "first deep turn: one row" "1" "$(P -c "set role service_role; $LATCH" | tail -1)"
FIRST="$(P -c "select deep_mode_at from ples where id = '$A'")"
expect "second deep turn: no row" "0" "$(P -c "set role service_role; $LATCH" | tail -1)"
expect "  → the stamp is the first one" "$FIRST" "$(P -c "select deep_mode_at from ples where id = '$A'")"

echo "re-running the OLD migration after this one"
P -f "$ROOT/db/migration-message-client-turn-id.sql" >/dev/null
expect "re-creates the 12-param overload beside this one" "2" "$(P -c "select count(*) from pg_proc where proname = '$FN'")"
expect "  → an old-shape named call is then ambiguous (42725)" "42725" "$(sqlstate "$(AS_SR "$(OLD_NAMED $A null 'x')")")"
P -f "$MIG" >/dev/null
expect "re-running this migration drops it again" "1|15" "$(P -c "select count(*), max(pronargs) from pg_proc where proname = '$FN'")"
expect "  → old-shape call resolves again" "ok" "$(sqlstate "$(AS_SR "$(OLD_NAMED $A null 'x again')")")"

if [ "$FAIL" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
