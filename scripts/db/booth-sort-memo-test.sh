#!/bin/bash
# Exercise db/migration-booth-sort-memo.sql against a REAL, throwaway PostgreSQL: backend/tests/booth.test.js plays
# booth_sort_memo with an in-memory fake; this checks the SQL itself. Nothing here touches any shared database.
#
#   scripts/db/booth-sort-memo-test.sh            # needs initdb/pg_ctl/psql on PATH (or PG_BIN)
#
# Loads stand-in Supabase roles (with Supabase's default grants to anon and authenticated), applies the migration
# twice, and asserts: the table has only key, tier and created_at, RLS on and no policy; a lookup returns null for
# an unknown key and inserts nothing; the first tier kept is the one every later call returns; with two sessions
# interleaved, the second keep waits for the first's commit and returns its tier; the CHECKs refuse a key that is
# not 64 hex and a tier outside B/R/W; anon and authenticated can neither read the table nor execute the function,
# and service_role can execute it.
set -euo pipefail
export LC_ALL=C LANG=C
export PGOPTIONS="-c client_min_messages=warning"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$ROOT/db/migration-booth-sort-memo.sql"
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@17/bin/pg_ctl)")}"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/booth-sort-memo.XXXXXX")"
trap '"$PG_BIN/pg_ctl" -D "$DIR/data" stop -m fast >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT

"$PG_BIN/initdb" -D "$DIR/data" -U postgres -A trust -E UTF8 --locale=C >/dev/null
# TCP only: a socket path under a long TMPDIR exceeds the 103-byte Unix-socket limit on macOS. The first
# free port from PORT (default 55461) up: a port in use makes the postmaster exit, and we try the next.
START="${PORT:-55461}"
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

# Supabase-shaped stand-ins: the three API roles (service_role bypasses RLS, as on Supabase), each granted every new
# object by default, as Supabase does until migration-postgrest-closed.sql.
P <<'SQL'
create role anon; create role authenticated; create role service_role bypassrls;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to service_role, anon, authenticated;
SQL

echo "migration"
RUNS=""
for _ in 1 2; do
  if P -f "$MIG" >/dev/null; then RUNS="$RUNS ok"; else RUNS="$RUNS fail"; fi
done
expect "applied twice" " ok ok" "$RUNS"
expect "exactly one booth_sort_memo" "1" "$(P -c "select count(*) from pg_proc where proname = 'booth_sort_memo'")"
expect "the columns are key, tier and created_at only" "created_at,key,tier" \
  "$(P -c "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name = 'booth_sort_memos'")"
expect "RLS on, no policy" "t|0" \
  "$(P -c "select relrowsecurity, (select count(*) from pg_policies where tablename = 'booth_sort_memos') from pg_class where relname = 'booth_sort_memos'")"

SR() { echo "set role service_role; $1"; }
MEMO() { P -c "$(SR "select coalesce(booth_sort_memo($1), 'null')")" | tail -1; }
K1="'$(printf 'a%.0s' $(seq 64))'"
K2="'$(printf 'b%.0s' $(seq 64))'"
K3="'$(printf 'c%.0s' $(seq 64))'"
K4="'$(printf 'd%.0s' $(seq 64))'"
ROWS() { P -c "select count(*) from booth_sort_memos"; }

echo "lookup and keep"
expect "a lookup of an unknown key returns null" "null" "$(MEMO "$K1")"
expect "a lookup with an explicit null tier returns null too" "null" "$(MEMO "$K1, null")"
expect "  → and inserts nothing" "0" "$(ROWS)"
expect "the first keep returns the tier it kept" "R" "$(MEMO "$K1, 'R'")"
expect "a later keep of another tier returns the first" "R" "$(MEMO "$K1, 'B'")"
expect "a lookup returns the first" "R" "$(MEMO "$K1")"
expect "  → one row, still R" "1|R" "$(P -c "select count(*), max(tier) from booth_sort_memos where key = $K1")"
expect "another key keeps its own tier" "W" "$(MEMO "$K2, 'W'")"

echo "CHECKs"
expect "a key that is not 64 hex is refused" "23514" "$(sqlstate "$(SR "select booth_sort_memo('$(printf 'A%.0s' $(seq 64))', 'B')")")"
expect "a 63-hex key is refused" "23514" "$(sqlstate "$(SR "select booth_sort_memo('$(printf 'e%.0s' $(seq 63))', 'B')")")"
expect "a tier outside B/R/W is refused" "23514" "$(sqlstate "$(SR "select booth_sort_memo($K3, 'best')")")"
expect "  → nothing kept" "2" "$(ROWS)"

echo "privileges"
for role in anon authenticated; do
  expect "$role holds no EXECUTE on booth_sort_memo" "f" \
    "$(P -c "select has_function_privilege('$role', 'public.booth_sort_memo(text, text)', 'execute')")"
  expect "$role cannot execute it" "42501" "$(sqlstate "set role $role; select booth_sort_memo($K3, 'B')")"
  expect "$role cannot read booth_sort_memos" "42501" "$(sqlstate "set role $role; select count(*) from booth_sort_memos")"
  expect "$role cannot write booth_sort_memos" "42501" "$(sqlstate "set role $role; insert into booth_sort_memos (key, tier) values ($K3, 'B')")"
done
expect "service_role can execute it" "ok" "$(sqlstate "$(SR "select booth_sort_memo($K3)")")"

# Two sessions, one in the background: clock_timestamp() stamps show who waited for whom.
P -c "create table probe (label text primary key, at timestamptz not null); grant all on probe to service_role"
stamp() { echo "insert into probe values ('$1', clock_timestamp());"; }

echo "interleaving: two plays keep the same key at once"
P -c "$(SR "begin; select booth_sort_memo($K4, 'B'); select pg_sleep(2); $(stamp first_commit) commit;")" >"$DIR/a.out" 2>&1 &
A=$!
sleep 0.5
SECOND="$(P -c "$(SR "select booth_sort_memo($K4, 'W'); $(stamp second_done)")" | head -1)"
wait "$A"
expect "the first writer's tier won" "B" "$(sed -n 1p "$DIR/a.out")"
expect "the second keep returned the first writer's tier" "B" "$SECOND"
expect "  → after waiting for the first to commit" "t" \
  "$(P -c "select (select at from probe where label = 'second_done') >= (select at from probe where label = 'first_commit')")"
expect "  → one row, B" "1|B" "$(P -c "select count(*), max(tier) from booth_sort_memos where key = $K4")"

if [ "$FAIL" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
