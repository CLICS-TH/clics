#!/bin/bash
# Exercise db/migration-booth-reply-cache.sql against a REAL, throwaway PostgreSQL: backend/tests/booth.test.js plays
# booth_reply_cache with an in-memory fake; this checks the SQL itself. Nothing here touches any shared database.
#
#   scripts/db/booth-reply-cache-test.sh            # needs initdb/pg_ctl/psql on PATH (or PG_BIN)
#
# Loads stand-in Supabase roles (with Supabase's default grants to anon and authenticated) and a stand-in
# app_settings, applies the migration twice, and asserts: the table has exactly its columns and no text column, RLS
# on and no policy, the lookup index; the switch is seeded 0 and a re-apply keeps an owner's 1; the CHECKs refuse a
# weaker tier, a reply with a safety field or any other shape, a 2-D, empty or null-holding embedding, a cue that is
# not a digest; anon and authenticated can neither read nor write it, and service_role can only read and append.
set -euo pipefail
export LC_ALL=C LANG=C
export PGOPTIONS="-c client_min_messages=warning"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$ROOT/db/migration-booth-reply-cache.sql"
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@17/bin/pg_ctl)")}"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/booth-reply-cache.XXXXXX")"
trap '"$PG_BIN/pg_ctl" -D "$DIR/data" stop -m fast >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT

"$PG_BIN/initdb" -D "$DIR/data" -U postgres -A trust -E UTF8 --locale=C >/dev/null
# TCP only: a socket path under a long TMPDIR exceeds the 103-byte Unix-socket limit on macOS. The first
# free port from PORT (default 55481) up: a port in use makes the postmaster exit, and we try the next.
START="${PORT:-55481}"
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
# object by default, as Supabase does until migration-postgrest-closed.sql; and app_settings as the booth reads it.
P <<'SQL'
create role anon; create role authenticated; create role service_role bypassrls;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to service_role, anon, authenticated;
create table public.app_settings (key text primary key, value numeric not null, value_text text, updated_at timestamptz default now());
SQL

echo "migration"
RUNS=""
for _ in 1 2; do
  if P -f "$MIG" >/dev/null; then RUNS="$RUNS ok"; else RUNS="$RUNS fail"; fi
done
expect "applied twice" " ok ok" "$RUNS"
expect "the columns are exactly the cache's, none for answer text" \
  "bank,case_id,case_version,created_at,cues,embedding,id,language,model,pick,reply,tier,tier_path" \
  "$(P -c "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name = 'booth_reply_cache'")"
expect "RLS on, no policy" "t|0" \
  "$(P -c "select relrowsecurity, (select count(*) from pg_policies where tablename = 'booth_reply_cache') from pg_class where relname = 'booth_reply_cache'")"
expect "the lookup index leads with the point of the case" "case_id, case_version, bank, tier_path, language, created_at DESC" \
  "$(P -c "select regexp_replace(pg_get_indexdef('booth_reply_cache_point_idx'::regclass), '^.*\((.*)\)$', '\1')")"

echo "the switch"
expect "seeded off" "0" "$(P -c "select value from app_settings where key = 'booth_reply_cache'")"
P -c "update app_settings set value = 1 where key = 'booth_reply_cache'"
P -f "$MIG" >/dev/null
expect "a re-apply keeps the owner's 1" "1" "$(P -c "select value from app_settings where key = 'booth_reply_cache'")"

SR() { echo "set role service_role; $1"; }
EMB="array_fill(0.125::real, array[384])"
CUE="'0123456789abcdef'"
REPLY="'{\"strength\":\"ดีครับ\",\"weigh\":\"ชั่งน้ำหนัก\",\"safety\":\"\"}'::jsonb"
row() { # row <embedding> <cues> <tier> <reply> [pick] → an insert as service_role
  echo "$(SR "insert into booth_reply_cache (case_id, case_version, bank, tier_path, language, model, embedding, cues, tier, reply, pick)
    values ('leptospirosis', '3', 'step2.B', 'B', 'th', 'm@1:q8', $1, $2, $3, $4, ${5:-null})")"
}
ROWS() { P -c "select count(*) from booth_reply_cache"; }

echo "CHECKs"
expect "a B row with a pick is kept" "ok" \
  "$(sqlstate "$(row "$EMB" "array[$CUE]" "'B'" "$REPLY" "'{\"variant_id\":\"q1\",\"bridge\":\"\",\"option_ids\":[\"a\",\"b\",\"c\"]}'::jsonb")")"
expect "an R row with no cues and no pick is kept" "ok" "$(sqlstate "$(row "$EMB" "'{}'" "'R'" "$REPLY")")"
expect "a weaker tier is refused" "23514" "$(sqlstate "$(row "$EMB" "'{}'" "'W'" "$REPLY")")"
expect "a reply with a safety field is refused" "23514" \
  "$(sqlstate "$(row "$EMB" "'{}'" "'B'" "'{\"strength\":\"a\",\"weigh\":\"b\",\"safety\":\"อันตราย\"}'::jsonb")")"
expect "a reply missing safety is refused" "23514" "$(sqlstate "$(row "$EMB" "'{}'" "'B'" "'{\"strength\":\"a\",\"weigh\":\"b\"}'::jsonb")")"
expect "a reply with another key is refused" "23514" \
  "$(sqlstate "$(row "$EMB" "'{}'" "'B'" "'{\"strength\":\"a\",\"weigh\":\"b\",\"safety\":\"\",\"answer\":\"x\"}'::jsonb")")"
expect "a reply field that is not a string is refused" "23514" \
  "$(sqlstate "$(row "$EMB" "'{}'" "'B'" "'{\"strength\":1,\"weigh\":\"b\",\"safety\":\"\"}'::jsonb")")"
expect "a reply that is not an object is refused" "23514" "$(sqlstate "$(row "$EMB" "'{}'" "'B'" "'\"text\"'::jsonb")")"
expect "a 2-D embedding is refused" "23514" "$(sqlstate "$(row "array_fill(0.5::real, array[2, 384])" "'{}'" "'B'" "$REPLY")")"
expect "an empty embedding is refused" "23514" "$(sqlstate "$(row "'{}'::real[]" "'{}'" "'B'" "$REPLY")")"
expect "an embedding under 16 numbers is refused" "23514" "$(sqlstate "$(row "array_fill(0.5::real, array[15])" "'{}'" "'B'" "$REPLY")")"
expect "an embedding holding a null is refused" "23514" \
  "$(sqlstate "$(row "array_append(array_fill(0.5::real, array[383]), null)" "'{}'" "'B'" "$REPLY")")"
expect "a cue that is text, not a digest, is refused" "23514" "$(sqlstate "$(row "$EMB" "array['ไม่ให้ยา']" "'B'" "$REPLY")")"
expect "a tier path of five letters is refused" "23514" \
  "$(sqlstate "$(SR "insert into booth_reply_cache (case_id, case_version, bank, tier_path, language, model, embedding, tier, reply)
    values ('leptospirosis', '3', 'step2.B', 'BBBBB', 'th', 'm', $EMB, 'B', $REPLY)")")"
expect "a language outside th/en is refused" "23514" \
  "$(sqlstate "$(SR "insert into booth_reply_cache (case_id, case_version, bank, tier_path, language, model, embedding, tier, reply)
    values ('leptospirosis', '3', 'step1', '', 'fr', 'm', $EMB, 'B', $REPLY)")")"
expect "  → two rows kept" "2" "$(ROWS)"

echo "privileges"
for role in anon authenticated; do
  expect "$role cannot read booth_reply_cache" "42501" "$(sqlstate "set role $role; select count(*) from booth_reply_cache")"
  expect "$role cannot write booth_reply_cache" "42501" \
    "$(sqlstate "set role $role; insert into booth_reply_cache (case_id, case_version, bank, tier_path, language, model, embedding, tier, reply)
      values ('leptospirosis', '3', 'step1', '', 'th', 'm', $EMB, 'B', $REPLY)")"
done
expect "service_role can read it" "ok" "$(sqlstate "$(SR "select count(*) from booth_reply_cache")")"
expect "service_role cannot update a row" "42501" "$(sqlstate "$(SR "update booth_reply_cache set tier = 'B'")")"
expect "service_role cannot delete a row" "42501" "$(sqlstate "$(SR "delete from booth_reply_cache")")"
expect "  → still two rows" "2" "$(ROWS)"

if [ "$FAIL" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
