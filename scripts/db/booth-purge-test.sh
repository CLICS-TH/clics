#!/bin/bash
# Exercise db/migration-booth-purge.sql against a REAL, throwaway PostgreSQL: purge-event.mjs's tests play the
# function with a fake backend; this checks the SQL itself. Nothing here touches any shared database.
#
#   scripts/db/booth-purge-test.sh            # needs initdb/pg_ctl/psql on PATH (or PG_BIN)
#
# Loads stand-in Supabase roles (with Supabase's default grants to anon and authenticated) and app_settings, applies
# migration-booth-plays.sql then migration-booth-purge.sql (each twice), and asserts: the summary math against
# hand-computed values; a delete removes only that event's rows and returns their summary; any delete while
# booth_enabled = 1 raises BP409 and deletes nothing, whatever booth_event_code holds (padded with whitespace JS
# trim() strips, or another event); a purge records its summary and a rerun returns it under `recorded`; an empty
# event returns plays 0; anon/authenticated cannot execute or read booth_event_purges; and, with two sessions
# interleaved, a switch-on waits for an open purge, a purge waits for an open switch-on and then refuses, a play
# start waits for an open purge and then starts nothing while the booth is off, and a score that lands before or
# during the purge leaves the returned summary equal to the rows deleted.
#
# #217 round 2 changed both migrations (the fail-closed refusal, booth_event_purges, booth_start_play's switch
# check): the owner re-applies migration-booth-plays.sql, then migration-booth-purge.sql, before the Sun 1 Nov
# 18:00 freeze.
set -euo pipefail
export LC_ALL=C LANG=C
export PGOPTIONS="-c client_min_messages=warning"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$ROOT/db/migration-booth-purge.sql"
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@17/bin/pg_ctl)")}"
DIR="$(mktemp -d)"
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

# Supabase-shaped stand-ins: the three API roles (service_role bypasses RLS, as on Supabase) and app_settings with
# the value_text column booth_plays' seed writes.
P <<'SQL'
create role anon; create role authenticated; create role service_role bypassrls;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create table public.app_settings (key text primary key, value numeric not null, value_text text,
  updated_at timestamptz default now());
grant usage on schema public to service_role, anon, authenticated;
grant select, insert, update, delete on public.app_settings to service_role, anon, authenticated;
SQL

echo "migrations"
RUNS=""
for f in "$ROOT/db/migration-booth-plays.sql" "$MIG" "$ROOT/db/migration-booth-plays.sql" "$MIG"; do
  if P -f "$f" >/dev/null; then RUNS="$RUNS ok"; else RUNS="$RUNS fail"; fi
done
expect "booth-plays then booth-purge, each applied twice" " ok ok ok ok" "$RUNS"
expect "exactly one booth_event_summary" "1" "$(P -c "select count(*) from pg_proc where proname = 'booth_event_summary'")"
P -c "grant select, insert, update, delete on public.booth_plays to service_role"

SR() { echo "set role service_role; $1"; }
SUMMARY() { echo "select booth_event_summary('$1', $2)"; }
J() { P -c "$(SR "$(SUMMARY "$1" "$2")")" | tail -1; }
scored() { # scored <event> <tag> <composite> <d1> <ranked> [created_at]
  echo "insert into booth_plays (event_code, tag, status, composite, d1, d2, d3, d4, d5, d6, d7, scored_at, ranked, spend_usd, created_at)
        values ('$1', $2, 'scored', $3, $4, 4, 3, 2, 3, 2, 3, now(), $5, 0.09, ${6:-'2026-11-06T00:00:00Z'});"; }
play() { # play <event> <tag> <status> <spend>
  echo "insert into booth_plays (event_code, tag, status, spend_usd, created_at) values ('$1', $2, '$3', $4, '2026-11-06T12:00:00Z');"; }
setting() { P -c "update app_settings set value = $2, value_text = $3 where key = '$1'"; }

echo "summary math (composites 40/50/60/80 hand-computed)"
P -c "$(scored EVT-A 1 60 3 true "'2026-11-07T20:15:00Z'") $(scored EVT-A 2 40 1 false) $(scored EVT-A 3 80 5 true)
      $(scored EVT-A 4 50 2 true "'2026-11-05T01:00:00Z'") $(play EVT-A 5 unavailable 0.30) $(play EVT-A 6 abandoned 0.05)
      $(play EVT-A 7 started 0) $(scored OTHER-1 1 99 5 true)"
S="$(J EVT-A false)"
expect "plays, scored, unavailable, abandoned, started, ranked" "7|4|1|1|1|3" \
  "$(P -c "select j->>'plays', j->>'scored', j->>'unavailable', j->>'abandoned', j->>'started', j->>'ranked' from (select '$S'::jsonb j) s")"
expect "min p25 median p75 max mean" "40|47.5|55|65|80|57.5" \
  "$(P -c "select (j->'spread'->>'min')::float8, (j->'spread'->>'p25')::float8, (j->'spread'->>'median')::float8,
           (j->'spread'->>'p75')::float8, (j->'spread'->>'max')::float8, round((j->'spread'->>'mean')::numeric, 4)::float8
           from (select '$S'::jsonb j) s")"
expect "population SD 14.79 (sqrt 218.75)" "14.79" "$(P -c "select round((j->'spread'->>'sd')::numeric, 2) from (select '$S'::jsonb j) s")"
expect "domain means over scored plays only: d1 2.75, d2 4" "2.75|4.00" \
  "$(P -c "select round((j->'domain_mean'->>'d1')::numeric, 2), round((j->'domain_mean'->>'d2')::numeric, 2) from (select '$S'::jsonb j) s")"
expect "spend over every play of the event" "0.710000" "$(P -c "select (j->>'spend_usd')::numeric(10,6) from (select '$S'::jsonb j) s")"
expect "first and last play over every play of the event" "2026-11-05 01:00:00+00|2026-11-07 20:15:00+00" \
  "$(P -c "set timezone = 'UTC'; select (j->>'first_play_at')::timestamptz, (j->>'last_play_at')::timestamptz from (select '$S'::jsonb j) s")"
expect "no id or tag in the result" "0" "$(echo "$S" | grep -c '"id"\|"tag"' || true)"
expect "a dry run deletes nothing" "8" "$(P -c "select count(*) from booth_plays")"

echo "one scored play, an empty event"
P -c "$(scored EVT-B 1 61.25 3 true)"
expect "one scored play: every spread figure is its composite, SD 0" "61.25|61.25|61.25|61.25|0" \
  "$(P -c "select (j->'spread'->>'min')::float8, (j->'spread'->>'p25')::float8, (j->'spread'->>'median')::float8,
           (j->'spread'->>'max')::float8, (j->'spread'->>'sd')::float8 from (select '$(J EVT-B false)'::jsonb j) s")"
E="$(J NONE-1 false)"
expect "an empty event: plays 0, spend 0, null spread and dates" "0|0|t|t|t|t" \
  "$(P -c "select j->>'plays', j->>'spend_usd', j->'spread'->'median' = 'null', j->'spread'->'sd' = 'null', j->'first_play_at' = 'null',
           j->'domain_mean'->'d1' = 'null' from (select '$E'::jsonb j) s")"

echo "delete"
setting booth_event_code 0 "'EVT-A'"; setting booth_enabled 1 null
expect "refused while EVT-A is switched on: BP409" "BP409" "$(sqlstate "$(SR "$(SUMMARY EVT-A true)")")"
expect "  → the message names booth_event_switched_on" "1" \
  "$(P -c "$(SR "$(SUMMARY EVT-A true)")" 2>&1 | grep -c booth_event_switched_on || true)"
expect "  → nothing deleted" "7" "$(P -c "select count(*) from booth_plays where event_code = 'EVT-A'")"
expect "another event is refused too while the booth is on: BP409" "BP409" "$(sqlstate "$(SR "$(SUMMARY EVT-B true)")")"
expect "  → nothing deleted" "1" "$(P -c "select count(*) from booth_plays where event_code = 'EVT-B'")"
for padded in "E'EVT-A\\n'" "chr(160) || 'EVT-A' || chr(160)" "'OTHER-9'"; do
  setting booth_event_code 0 "$padded"
  expect "booth_event_code = $padded, booth_enabled = 1: BP409" "BP409" "$(sqlstate "$(SR "$(SUMMARY EVT-A true)")")"
  expect "  → nothing deleted" "7" "$(P -c "select count(*) from booth_plays where event_code = 'EVT-A'")"
done
setting booth_event_code 0 "'EVT-A'"; setting booth_enabled 0 null
expect "switched off: another event deletes" "ok" "$(sqlstate "$(SR "$(SUMMARY EVT-B true)")")"
D="$(J EVT-A true)"
expect "switched off: the delete returns the same summary the dry run gave" "t" "$(P -c "select '$D'::jsonb = '$S'::jsonb")"
expect "  → nothing was recorded before this first purge" "t" "$(P -c "select j->'recorded' = 'null' from (select '$D'::jsonb j) s")"
expect "  → only EVT-A's rows are gone" "0|1" \
  "$(P -c "select (select count(*) from booth_plays where event_code = 'EVT-A'), (select count(*) from booth_plays where event_code = 'OTHER-1')")"
expect "  → its summary is recorded once, without ids or tags" "1|0" \
  "$(P -c "select count(*), count(*) filter (where summary::text ~ '\"(id|tag|recorded)\"') from booth_event_purges where event_code = 'EVT-A'")"
for del in false true; do
  R="$(J EVT-A $del)"
  expect "a rerun (p_delete $del) returns plays 0 and the first purge's summary under recorded" "0|t|t" \
    "$(P -c "select j->>'plays', j->'recorded'->'summary' = ('$D'::jsonb - 'recorded' - 'attempt'), (j->'recorded'->>'purged_at')::timestamptz <= now()
             from (select '$R'::jsonb j) s")"
done
expect "  → an empty rerun records nothing" "1" "$(P -c "select count(*) from booth_event_purges where event_code = 'EVT-A'")"

echo "attempt ids: a later call finds a delete's record exactly when that delete committed"
ATT() { echo "select booth_event_summary('$1', $2, '$3'::uuid)"; }
JA() { P -c "$(SR "$(ATT "$1" "$2" "$3")")" | tail -1; }
A1=11111111-1111-4111-8111-111111111111; A2=22222222-2222-4222-8222-222222222222; A3=33333333-3333-4333-8333-333333333333
P -c "$(play EVT-T 1 abandoned 0.1) $(play EVT-T 2 abandoned 0.2)"
setting booth_enabled 1 null
expect "a delete refused while switched on (attempt A1)" "BP409" "$(sqlstate "$(SR "$(ATT EVT-T true $A1)")")"
setting booth_enabled 0 null
expect "  → A1 did not commit: its attempt is null, the plays are still there" "null|2" \
  "$(P -c "select coalesce(j->>'attempt', 'null'), j->>'plays' from (select '$(JA EVT-T false $A1)'::jsonb j) s")"
DT="$(JA EVT-T true $A2)"
expect "a delete under attempt A2 commits 2 plays" "2" "$(P -c "select j->>'plays' from (select '$DT'::jsonb j) s")"
P -c "$(play EVT-T 3 abandoned 0.3)"
expect "  → later, with a new play: attempt A2 returns its own summary, not the live play" "1|2|t" \
  "$(P -c "select j->>'plays', j->'attempt'->'summary'->>'plays', j->'attempt'->'summary' = ('$DT'::jsonb - 'recorded' - 'attempt') from (select '$(JA EVT-T false $A2)'::jsonb j) s")"
expect "  → an attempt id no delete used returns null" "null" \
  "$(P -c "select coalesce(j->>'attempt', 'null') from (select '$(JA EVT-T false $A3)'::jsonb j) s")"
expect "  → the record stores A2" "1" "$(P -c "select count(*) from booth_event_purges where attempt_id = '$A2'")"

echo "privileges"
# Asked of the catalog, not by calling: a call by anon also fails on booth_plays' own revoke, so it would stay 42501
# with the function's EXECUTE restored.
for role in anon authenticated; do
  expect "$role holds no EXECUTE on booth_event_summary" "f" \
    "$(P -c "select has_function_privilege('$role', 'public.booth_event_summary(text, boolean, uuid)', 'execute')")"
  expect "$role holds no privilege on booth_event_purges_id_seq" "f|f|f" \
    "$(P -c "select has_sequence_privilege('$role', 'public.booth_event_purges_id_seq', 'usage'), has_sequence_privilege('$role', 'public.booth_event_purges_id_seq', 'select'), has_sequence_privilege('$role', 'public.booth_event_purges_id_seq', 'update')")"
done
expect "anon cannot execute" "42501" "$(sqlstate "set role anon; $(SUMMARY EVT-A false)")"
expect "service_role can" "ok" "$(sqlstate "$(SR "$(SUMMARY EVT-A false)")")"
for role in anon authenticated; do
  expect "$role cannot read booth_event_purges" "42501" "$(sqlstate "set role $role; select count(*) from booth_event_purges")"
  expect "$role cannot write booth_event_purges" "42501" \
    "$(sqlstate "set role $role; insert into booth_event_purges (event_code, summary) values ('EVT-Z', '{}')")"
done
expect "booth_event_purges: RLS on, no policy" "t|0" \
  "$(P -c "select relrowsecurity, (select count(*) from pg_policies where tablename = 'booth_event_purges') from pg_class where relname = 'booth_event_purges'")"

# Interleavings: one session runs in the background, the other in the foreground; clock_timestamp() stamps show
# who waited for whom.
P -c "create table probe (label text primary key, at timestamptz not null); grant all on probe to service_role"
stamp() { echo "insert into probe values ('$1', clock_timestamp());"; }
waited() { # waited <first> <second> → t when <second> was stamped after <first>
  P -c "select (select at from probe where label = '$2') >= (select at from probe where label = '$1')"; }
bg() { P -c "$1" >"$DIR/$2.out" 2>&1 & }   # the caller reads $!

echo "interleaving: a switch-on while a purge is open"
P -c "$(play EVT-C 1 abandoned 0.1) $(play EVT-C 2 abandoned 0.1)"
setting booth_event_code 0 "'EVT-C'"; setting booth_enabled 0 null
bg "$(SR "begin; $(SUMMARY EVT-C true); select pg_sleep(2); $(stamp purge_commit) commit;")" a; A=$!
sleep 0.5
P -c "$(stamp switch_start) insert into app_settings (key, value, value_text, updated_at) values ('booth_enabled', 1, null, clock_timestamp())
      on conflict (key) do update set value = excluded.value, updated_at = clock_timestamp(); $(stamp switch_done)" >/dev/null
wait "$A"
expect "the switch-on waited for the purge to commit" "t" "$(waited purge_commit switch_done)"
expect "  → its row write landed after the commit too" "t" \
  "$(P -c "select (select updated_at from app_settings where key = 'booth_enabled') >= (select at from probe where label = 'purge_commit')")"
expect "  → and was asked before the commit" "t" "$(waited switch_start purge_commit)"
expect "  → the purge deleted the event's rows" "0" "$(P -c "select count(*) from booth_plays where event_code = 'EVT-C'")"

echo "interleaving: a purge while a switch-on is open"
P -c "truncate probe; $(play EVT-C 1 abandoned 0.1)"
setting booth_enabled 0 null
bg "begin; update app_settings set value = 1 where key = 'booth_enabled'; select pg_sleep(2); $(stamp switch_commit) commit;" b; B=$!
sleep 0.5
R="$(sqlstate "$(SR "$(SUMMARY EVT-C true)")")"
wait "$B"
expect "the purge waited and then refused: BP409" "BP409" "$R"
expect "  → nothing deleted" "1" "$(P -c "select count(*) from booth_plays where event_code = 'EVT-C'")"

echo "interleaving: a play start while a purge is open"
setting booth_enabled 0 null
P -c "truncate probe"
bg "$(SR "begin; $(SUMMARY EVT-C true); select pg_sleep(2); $(stamp purge_commit) commit;")" a; A=$!
sleep 0.5
STARTED="$(P -c "$(SR "with s as (select * from booth_start_play('EVT-C')) select count(*) from s; $(stamp start_done)")")"
wait "$A"
expect "booth_start_play waited for the purge (same advisory lock)" "t" "$(waited purge_commit start_done)"
expect "  → and, the booth being off, started nothing: no row returned, none left" "0|0" \
  "$STARTED|$(P -c "select count(*) from booth_plays where event_code = 'EVT-C'")"
setting booth_enabled 1 null
expect "with booth_enabled = 1 a start gets tag 1" "1" "$(P -c "$(SR "select play_tag from booth_start_play('EVT-C')")" | tail -1)"
setting booth_enabled 0 null

echo "interleaving: a score that commits while the purge waits on its row"
P -c "delete from booth_plays where event_code = 'EVT-D'; $(play EVT-D 1 unavailable 0.3) $(play EVT-D 2 abandoned 0.1)"
FINISH="update booth_plays set status = 'scored', composite = 70, d1 = 4, d2 = 4, d3 = 4, d4 = 4, d5 = 4, d6 = 4, d7 = 4,
  scored_at = now(), ranked = true where event_code = 'EVT-D' and tag = 1 and status = 'unavailable' and scored_at is null"
bg "begin; $FINISH; select pg_sleep(2); commit;" b; B=$!
sleep 0.5
D="$(J EVT-D true)"
wait "$B"
expect "the summary counts the score that landed first" "2|1|70|0" \
  "$(P -c "select j->>'plays', j->>'scored', (j->'spread'->>'median')::numeric, j->>'unavailable' from (select '$D'::jsonb j) s")"
expect "  → and those rows are gone" "0" "$(P -c "select count(*) from booth_plays where event_code = 'EVT-D'")"

echo "interleaving: a score that tries to land while the purge is open"
P -c "$(play EVT-D 1 unavailable 0.3) $(play EVT-D 2 abandoned 0.1)"
bg "$(SR "begin; $(SUMMARY EVT-D true); select pg_sleep(2); commit;")" a; A=$!
sleep 0.5
N="$(P -c "with u as ($FINISH returning 1) select count(*) from u")"
wait "$A"
D="$(grep '^{' "$DIR/a.out")"
expect "the late score finds no row (finish answers unavailable)" "0" "$N"
expect "  → the summary describes the deleted rows: 2 plays, 0 scored, 1 unavailable" "2|0|1" \
  "$(P -c "select j->>'plays', j->>'scored', j->>'unavailable' from (select '$D'::jsonb j) s")"

if [ "$FAIL" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
