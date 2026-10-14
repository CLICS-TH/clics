#!/bin/bash
# Exercise db/migration-audit-log-chain.sql against a REAL, throwaway PostgreSQL — the hermetic jest
# suites mock Supabase and cannot run a trigger. Nothing here touches any shared database.
#
#   scripts/db/audit-chain-tamper-test.sh            # needs initdb/pg_ctl/psql on PATH (or PG_BIN)
#
# Asserts: backfill chains pre-existing rows; the migration is idempotent; 50 concurrent inserts give
# a contiguous 1..n chain that verifies; the verdict does not depend on TimeZone; UPDATE / DELETE /
# TRUNCATE are refused even for the service role and a superuser; purging a referenced user works and
# keeps actor_id; a caller cannot supply its own seq or hash; anon/authenticated cannot call verify;
# and with the triggers forcibly disabled, an edited row and a deleted row are both reported.
set -euo pipefail
export LC_ALL=C LANG=C

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@17/bin/pg_ctl)")}"
PORT="${PORT:-55439}"
DIR="$(mktemp -d)"
trap '"$PG_BIN/pg_ctl" -D "$DIR/data" stop -m fast >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT

"$PG_BIN/initdb" -D "$DIR/data" -U postgres -A trust -E UTF8 --locale=C >/dev/null
# TCP only: a socket path under a long TMPDIR exceeds the 103-byte Unix-socket limit on macOS.
"$PG_BIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -c unix_socket_directories='' -c listen_addresses=127.0.0.1" \
  -l "$DIR/log" -w start >/dev/null

P() { "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d t -v ON_ERROR_STOP=1 -q -At -P pager=off "$@"; }
"$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -q -c "create database t;"

FAIL=0
expect() { # expect <label> <want> <got>
  if [ "$2" == "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: want [$2] got [$3]"; FAIL=1; fi
}
refused() { # refused <label> <sql>
  if P -c "$2" >/dev/null 2>&1; then echo "  FAIL $1: was allowed"; FAIL=1; else echo "  ok   $1"; fi
}

# Supabase-shaped stubs: the three API roles (service_role bypasses RLS, as on Supabase) + auth.uid().
P <<'SQL'
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create table public.councils (id uuid primary key default gen_random_uuid());
create table public.professionals (id uuid primary key default gen_random_uuid(), role text);
SQL
P -f "$ROOT/db/migration-audit-log.sql" 2>/dev/null
P <<'SQL'
grant usage on schema public to service_role, anon, authenticated;
grant all on public.audit_log to service_role;
insert into professionals(id, role) values ('11111111-1111-1111-1111-111111111111', 'admin');
insert into audit_log(actor_id, actor_role, action, metadata, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'admin', 'user.provision', '{"b": 2, "a": "x"}', now() - interval '2 day'),
  (null, null, 'consent', null, now() - interval '1 day');
SQL

echo "migration"
P -f "$ROOT/db/migration-audit-log-chain.sql" 2>/dev/null
expect "backfill chains existing rows" "2|t" "$(P -c "select count(*), bool_and(seq is not null) from audit_log")"
P -f "$ROOT/db/migration-audit-log-chain.sql" 2>/dev/null
expect "idempotent re-run keeps the chain" "t|2" "$(P -c "select ok, checked from audit_log_verify()")"

echo "concurrency"
for i in $(seq 1 50); do
  P -c "set role service_role; insert into audit_log(action, metadata) values ('load', jsonb_build_object('i', $i))" &
done
wait
expect "52 rows, contiguous 1..52" "52|1|52|52" "$(P -c "select count(*), min(seq), max(seq), count(distinct seq) from audit_log")"
expect "chain verifies" "t|52" "$(P -c "select ok, checked from audit_log_verify()")"
expect "verdict independent of TimeZone" "t" "$(P -c "set timezone = 'America/Los_Angeles'; select ok from audit_log_verify()")"

echo "append-only"
refused "service_role UPDATE" "set role service_role; update audit_log set action = 'x' where seq = 1"
refused "service_role DELETE" "set role service_role; delete from audit_log where seq = 1"
refused "service_role TRUNCATE" "set role service_role; truncate audit_log"
refused "superuser UPDATE" "update audit_log set action = 'x' where seq = 1"
P -c "delete from professionals where id = '11111111-1111-1111-1111-111111111111'"
expect "purging a referenced user keeps actor_id" "11111111-1111-1111-1111-111111111111" \
  "$(P -c "select actor_id from audit_log where seq = 1")"

echo "spoofing + access"
P -c "set role service_role; insert into audit_log(action, seq, row_hash, prev_hash) values ('spoof', 1, '\\x00', '\\x00')"
expect "caller-supplied seq/hash ignored" "53|32" "$(P -c "select seq, length(row_hash) from audit_log where action = 'spoof'")"
expect "still verifies after spoof attempt" "t" "$(P -c "select ok from audit_log_verify()")"
refused "anon cannot verify" "set role anon; select * from audit_log_verify()"
refused "authenticated cannot read head" "set role authenticated; select * from audit_log_head()"

echo "tamper detection (triggers forcibly disabled — what the table owner could still do)"
tamper() { P -c "alter table audit_log disable trigger audit_log_no_update; $1; alter table audit_log enable trigger audit_log_no_update"; }
tamper "update audit_log set metadata = '{\"i\": 999}' where seq = 20"
expect "edited row reported" "f|20|row_hash_mismatch" "$(P -c "select ok, first_bad_seq, reason from audit_log_verify()")"

# Fresh chain for the deletion case (the edit above cannot be undone without its original value).
P -c "alter table audit_log disable trigger audit_log_no_update; alter table audit_log disable trigger audit_log_no_truncate; truncate audit_log; alter table audit_log enable trigger audit_log_no_update; alter table audit_log enable trigger audit_log_no_truncate"
for i in $(seq 1 10); do P -c "insert into audit_log(action) values ('x$i')"; done
tamper "delete from audit_log where seq = 7"
expect "deleted row reported" "f|8|seq_gap" "$(P -c "select ok, first_bad_seq, reason from audit_log_verify()")"

if [ "$FAIL" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
