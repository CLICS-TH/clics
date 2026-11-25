#!/bin/bash
# shellcheck disable=SC2001 # sed indents multi-line output
# Exercise deploy/vm1/db-move/move.sh and roles.sql against two REAL, throwaway PostgreSQL clusters (#432,
# ADR 0012), after scripts/db/postgrest-surface-test.sh (ADR 0007). Nothing here touches a shared database.
#
#   scripts/db/db-move-test.sh            # needs initdb/pg_ctl/psql/pg_dump on PATH (or PG_BIN), and openssl
#
# A "source" cluster stands in for Supabase: TLS on (a throwaway self-signed certificate, so the script's
# sslmode=require rule is met, not bypassed), the API roles, an auth schema, the audit_log hash chain from
# db/migration-audit-log-chain.sql, ADR 0007's db/migration-postgrest-closed.sql, the three booth tables,
# identity tables, sequences and an extension. A "target" cluster stands in for the data host: the same
# roles, and an auth schema "GoTrue" made with its columns in another order plus one more.
#
# Asserts: the preflight refuses a source without TLS, a missing data host, a target that is not empty or
# whose GoTrue has not run, and an unchained source unless AUDIT_CHAIN=checksum; `move` restores and its
# verify report passes, listing the three booth tables, every sequence, the anchored chain and an empty
# postgrest_exposure; the CONTROL: the same rows laid into a schema that already carries the chain trigger
# with triggers ON fail audit_log_verify against the source head, and the same path with the script's
# session_replication_role passes; the report fails on a source row written after the move, a target
# sequence set lower, a missing table, and an owner, grant, default privilege, row level security flag or
# policy that differs from the source's (a privilege from two grantors counts once; roles.sql's own grants
# are named, not failed, and only those its allow list makes, whose copy in move.sh must match roles.sql's;
# a report without the privileges fails); dump refuses a file; report + check round-trip (the backup drill);
# roles.sql leaves no app role a superuser, gives clics_analyst reads but no writes, no identity table or
# column, no auth, no SECURITY DEFINER call, and postgrest_exposure() still lists nothing. The data host's
# password on stdin (CLICS_DATA_PASSWORD=stdin) passes when right, is refused when wrong or absent, and never
# opens the source; run-move.sh, driven at a real terminal (python3's pty) with a stand-in docker, runs
# preflight and verify, echoes neither secret, puts neither in docker's argv, runs the container without a
# log, checks the data host against the CA certificate it mounts read-only (and refuses a server that CA did
# not sign), and refuses a pipe, another command, a file or directory others could change (db-move.conf,
# move.sh, the kit's directory, docker's directory, the CA's directory), a symlinked move.sh, and a
# db-move.conf line it does not know.
set -euo pipefail
export LC_ALL=C LANG=C
export PGOPTIONS="-c client_min_messages=warning"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MOVE="$ROOT/deploy/vm1/db-move/move.sh"
ROLES="$ROOT/deploy/vm1/db-move/roles.sql"
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@17/bin/pg_ctl)")}"
export PG_BIN
DIR="$(mktemp -d "${TMPDIR:-/tmp}/db-move-test.XXXXXX")"
# shellcheck disable=SC2154 # c is the loop variable inside the trap string
trap 'for c in src dst plain; do "$PG_BIN/pg_ctl" -D "$DIR/$c" stop -m fast >/dev/null 2>&1 || true; done; rm -rf "$DIR"' EXIT

# TCP only: a socket path under a long TMPDIR exceeds the 103-byte Unix-socket limit on macOS. The first
# free port from START up: a port in use makes the postmaster exit, and we try the next.
start_cluster() { # start_cluster <name> <first port> [extra -c options] -> prints the port
  local name=$1 start=$2 extra=${3:-} p
  "$PG_BIN/initdb" -D "$DIR/$name" -U postgres -A trust -E UTF8 --locale=C >/dev/null
  [ -z "${CERT:-}" ] || { cp "$DIR/server.crt" "$DIR/server.key" "$DIR/$name/"; chmod 600 "$DIR/$name/server.key"; }
  for p in $(seq "$start" $((start + 20))); do
    if "$PG_BIN/pg_ctl" -D "$DIR/$name" -o "-p $p -c unix_socket_directories='' -c listen_addresses=127.0.0.1 $extra" \
         -l "$DIR/$name.log" -w start >/dev/null 2>&1; then echo "$p"; return; fi
  done
  echo "could not start $name on ports $start..$((start + 20))" >&2; cat "$DIR/$name.log" >&2; exit 1
}
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
  -keyout "$DIR/server.key" -out "$DIR/server.crt" >/dev/null 2>&1
export CERT=1
SPORT=$(start_cluster src "${PORT:-55471}" "-c ssl=on")
DPORT=$(start_cluster dst $((SPORT + 21)) "-c ssl=on")
echo "postgres $("$PG_BIN/postgres" --version | awk '{print $3}'): source 127.0.0.1:$SPORT, target 127.0.0.1:$DPORT (both TLS)"

S() { local db=$1; shift; "$PG_BIN/psql" -h 127.0.0.1 -p "$SPORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 -X -q -At -P pager=off "$@"; }
D() { local db=$1; shift; "$PG_BIN/psql" -h 127.0.0.1 -p "$DPORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 -X -q -At -P pager=off "$@"; }
src_url() { echo "postgresql://postgres:unused@127.0.0.1:$SPORT/${1:-src}?sslmode=${2:-require}"; }
# The data host, as move.sh reads it. An empty pgpass file: trust auth needs no password, and the variable
# must still point somewhere, as on vm1.
: > "$DIR/pgpass"; chmod 600 "$DIR/pgpass"
export CLICS_DATA_HOST=127.0.0.1 CLICS_DATA_PORT=$DPORT CLICS_DATA_USER=supabase_admin PGPASSFILE="$DIR/pgpass"
mv_() { # mv_ <target db> <source db> <args...>   (the source URL on stdin, as on vm1)
  local tdb=$1 sdb=$2; shift 2
  src_url "$sdb" | CLICS_DATA_DB=$tdb bash "$MOVE" "$@"
}

FAIL=0
expect() { # expect <label> <want> <got>
  if [ "$2" == "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: want [$2] got [$3]"; FAIL=1; fi
}
has() { # has <label> <needle> <haystack>
  if grep -qF -- "$2" <<< "$3"; then echo "  ok   $1"; else echo "  FAIL $1: [$2] not in:"; sed 's/^/         /' <<< "$3"; FAIL=1; fi
}
rc() { "$@" >/dev/null 2>&1 && echo 0 || echo $?; }

# ---- the roles both clusters have (supabase/postgres makes them) ----------------------------------------
ROLES_SQL="
create role supabase_admin superuser login;
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role authenticator login noinherit; create role supabase_auth_admin login createrole;
grant anon, authenticated, service_role to authenticator;"
S postgres -c "$ROLES_SQL"
D postgres -c "$ROLES_SQL"

# ---- the source: Supabase-shaped ------------------------------------------------------------------------
source_db() { # source_db <name> <chain: yes|no>
  S postgres -c "create database $1"
  S "$1" <<'SQL'
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid $$;
create table auth.users (instance_id uuid, id uuid primary key, email text, encrypted_password text,
  created_at timestamptz not null default now());
create table auth.identities (id uuid primary key, user_id uuid not null references auth.users(id), provider text);
create table auth.refresh_tokens (id bigserial primary key, token text, user_id text);
create table auth.schema_migrations (version text primary key);
insert into auth.schema_migrations values ('hosted-1'), ('hosted-2');
grant usage on schema auth, public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create extension pg_trgm schema public;

create table public.councils (id uuid primary key default gen_random_uuid(), name_th text, name_en text);
create table public.professionals (id uuid primary key references auth.users(id) on delete cascade,
  role text not null, full_name_th text, full_name_en text, email text, pseudonym text);
create table public.ple_pii_map (ple_id uuid primary key, map_encrypted text);
create table public.oauth_identities (id uuid primary key, identity_encrypted text);
create table public.ples (id uuid primary key default gen_random_uuid(), physician_id uuid references public.professionals(id),
  code text, chief_complaint text, score numeric, ended_at timestamptz, flags jsonb, blob bytea, tags text[]);
create table public.booth_plays (id bigserial primary key, case_id text, tier int, transcript jsonb,
  started_at timestamptz default now());
create table public.booth_sort_memos (id bigint generated always as identity primary key, memo text);
create table public.booth_event_purges (id uuid primary key default gen_random_uuid(), purged int);
create sequence public.pseudonym_seq;
create function public.next_pseudonym() returns text language sql security definer as $$
  select 'P-' || lpad(nextval('public.pseudonym_seq')::text, 3, '0') $$;
alter table public.professionals enable row level security;
alter table public.ples enable row level security;
create policy "ples: own" on public.ples for select using (physician_id = auth.uid());
SQL
  S "$1" -f "$ROOT/db/migration-audit-log.sql"
  S "$1" <<'SQL'
insert into auth.users (id, email, encrypted_password, created_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@example.invalid', '$2a$10$hash-a', '2026-10-01 01:02:03.456789+00'),
  ('00000000-0000-0000-0000-0000000000a2', 'b@example.invalid', '$2a$10$hash-b', '2026-10-02 01:02:03+00');
insert into auth.identities values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'google');
insert into auth.refresh_tokens (token, user_id) select 't' || g, 'a1' from generate_series(1, 7) g;
insert into public.councils (name_th, name_en) values ('แพทยสภา', 'Medical Council');
insert into public.professionals values
  ('00000000-0000-0000-0000-0000000000a1', 'physician', 'นายแพทย์ ก', 'Dr A', 'a@example.invalid', 'P-001'),
  ('00000000-0000-0000-0000-0000000000a2', 'superadmin', 'นายแพทย์ ข', 'Dr B', 'b@example.invalid', 'P-002');
insert into public.ple_pii_map values ('00000000-0000-0000-0000-0000000000c1', 'enc:xyz');
insert into public.ples (physician_id, code, chief_complaint, score, ended_at, flags, blob, tags) values
  ('00000000-0000-0000-0000-0000000000a1', 'PLE-001', 'เจ็บหน้าอก 2 ชม.', 3.14159265358979, '2026-10-03 12:00:00.5+07',
   '{"b": 2, "a": [1, null]}', '\x00ff10', '{x,"y z"}'),
  ('00000000-0000-0000-0000-0000000000a1', 'PLE-002', null, 0.1, null, null, null, null);
insert into public.booth_plays (case_id, tier, transcript) select 'case-' || g, g % 3, jsonb_build_object('n', g) from generate_series(1, 25) g;
insert into public.booth_sort_memos (memo) values ('m1'), ('m2'), ('m3');
insert into public.booth_event_purges (purged) values (4);
select public.next_pseudonym() from generate_series(1, 5);
-- audit rows dated in the past, as production's are
insert into public.audit_log (actor_id, actor_role, action, metadata, created_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'physician', 'ple.create', '{"b": 2, "a": "x"}', now() - interval '3 day'),
  (null, null, 'consent', null, now() - interval '2 day'),
  ('00000000-0000-0000-0000-0000000000a2', 'superadmin', 'export', '{"k": 1}', now() - interval '1 day');
SQL
  if [ "$2" = yes ]; then
    S "$1" -f "$ROOT/db/migration-audit-log-chain.sql"
    S "$1" -c "insert into public.audit_log (action, target_type) select 'after-chain', 'n' || g from generate_series(1, 4) g;"
  fi
  S "$1" -f "$ROOT/db/migration-postgrest-closed.sql" >/dev/null
  # supabase_admin's own default privileges, as production keeps them: there the migration above may not
  # change them (postgres is not a member of supabase_admin), so anon and authenticated stay in them.
  S "$1" -c "alter default privileges for role supabase_admin in schema public grant all on tables to anon, authenticated, service_role;
             alter default privileges for role supabase_admin in schema public grant all on sequences to anon, authenticated, service_role;
             alter default privileges for role supabase_admin in schema public grant all on functions to anon, authenticated, service_role;"
  S "$1" -c "revoke all on function public.next_pseudonym() from public;"
}
source_db src yes
source_db nochain no
expect "source: chain installed, verifies" "t|7" "$(S src -c "select ok, checked from public.audit_log_verify()")"
expect "source: postgrest_exposure lists nothing" "0" "$(S src -c "select count(*) from public.postgrest_exposure()")"

# ---- the target: the data host, GoTrue already migrated ---------------------------------------------------
target_db() { # target_db <name>
  local T=${TCL:-D}   # TCL=S builds it in the source cluster, which has no clics_analyst role
  $T postgres -c "create database $1"
  $T "$1" <<'SQL'
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role' $$;
-- GoTrue's own migrations: columns in another order, and one the hosted project lacks.
create table auth.users (id uuid primary key, is_sso_user boolean not null default false, email text,
  created_at timestamptz not null default now(), encrypted_password text, instance_id uuid);
create table auth.identities (id uuid primary key, user_id uuid not null references auth.users(id), provider text);
create table auth.refresh_tokens (id bigserial primary key, token text, user_id text);
create table auth.schema_migrations (version text primary key);
insert into auth.schema_migrations values ('gotrue-v2.197.0');
grant usage on schema auth, public to anon, authenticated, service_role;
-- the image's extensions schema, which PostgREST searches
create schema extensions;
-- the image's default grants to the API roles, which the restore stream revokes before it creates a table
alter default privileges for role supabase_admin in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on functions to anon, authenticated, service_role;
SQL
}
for t in t1 t2 t3 t4 t5; do target_db "$t"; done

echo "preflight refusals"
expect "a source without TLS (sslmode=disable)" "1" \
  "$(rc bash -c "src_url() { :; }; echo 'postgresql://postgres:x@127.0.0.1:$SPORT/src?sslmode=disable' | CLICS_DATA_DB=t1 bash '$MOVE' preflight")"
has "  → says why" "must carry sslmode=require" \
  "$(echo "postgresql://postgres:x@127.0.0.1:$SPORT/src?sslmode=disable" | CLICS_DATA_DB=t1 bash "$MOVE" preflight 2>&1 || true)"
expect "no CLICS_DATA_HOST" "1" "$(rc bash -c "src_url | env -u CLICS_DATA_HOST CLICS_DATA_DB=t1 bash '$MOVE' preflight")"
D postgres -c "create database nogotrue"
has "a target GoTrue has not migrated" "start GoTrue against it once" "$(mv_ nogotrue src preflight 2>&1 || true)"
D t5 -c "create table public.stray (id int)"
has "a target whose public schema is not empty" "public schema is not empty" "$(mv_ t5 src preflight 2>&1 || true)"
has "an unchained source, AUDIT_CHAIN=required (the default)" "audit_chain=not_installed" "$(mv_ t3 nochain preflight 2>&1 || true)"
has "a plaintext data-host hop (CLICS_DATA_SSLMODE=prefer)" "lets the data host hop run in clear" \
  "$(src_url src | CLICS_DATA_DB=t1 CLICS_DATA_SSLMODE=prefer bash "$MOVE" preflight 2>&1 || true)"
S postgres -c "create role dashboard_user nologin"
S src -c "grant select on public.councils to dashboard_user"
has "a role the source grants to and the target lacks" "the target lacks what the restore or PostgREST needs: role dashboard_user" \
  "$(mv_ t1 src preflight 2>&1 || true)"
S src -c "revoke all on public.councils from dashboard_user"; S postgres -c "drop role dashboard_user"
S src -c "alter table auth.users add column dedicated_scope text"
has "a source auth column the target's GoTrue lacks (an older GoTrue)" "auth column users.dedicated_scope" \
  "$(mv_ t1 src preflight 2>&1 || true)"
S src -c "alter table auth.users drop column dedicated_scope"
D t1 -c "alter function auth.uid() rename to uid_x"
has "a target without auth.uid()" "function auth.uid()" "$(mv_ t1 src preflight 2>&1 || true)"
D t1 -c "alter function auth.uid_x() rename to uid"
has "a passing preflight" "preflight ok" "$(mv_ t1 src preflight 2>&1)"

echo "move.sh move (stream, restore with triggers off, sequences, verify)"
OUT="$(mv_ t1 src move 2>&1)" || true
echo "$OUT" | sed 's/^/       | /'
has "verify passes" "VERIFY: PASS" "$OUT"
for t in public.booth_plays public.booth_sort_memos public.booth_event_purges auth.users public.audit_log; do
  has "  → $t compared and the same" "same" "$(grep -E "^$t " <<< "$OUT")"
done
has "  → auth.schema_migrations left to GoTrue (not compared)" "" "$(grep -c '^auth.schema_migrations ' <<< "$OUT" | sed 's/^0$//')"
has "  → every sequence compared, none lower" "sequences: 4 compared, 0 lower" "$OUT"
has "  → the chain verifies, anchored at the source head" "audit_log_verify passes on the target, 7 rows, anchored at the source head seq 7" "$OUT"
has "  → postgrest_exposure lists nothing" "postgrest_exposure: lists nothing on the target" "$OUT"
expect "target: a row keeps its created_at and hash" \
  "$(S src -c "select created_at, encode(row_hash, 'hex') from public.audit_log where seq = 2")" \
  "$(D t1 -c "select created_at, encode(row_hash, 'hex') from public.audit_log where seq = 2")"
has "target: the chain trigger is back on and refuses an UPDATE" "append-only" \
  "$(D t1 -c "update public.audit_log set action = 'x' where seq = 1" 2>&1 || true)"
expect "target: a new audit row chains onto the source head" "t|8" \
  "$(D t1 -c "insert into public.audit_log (action) values ('after-move'); select ok, checked from public.audit_log_verify()" | tail -1)"
expect "target: nextval continues past the source (pseudonym)" "P-006" "$(D t1 -c "select public.next_pseudonym()")"
expect "target: identity column continues" "4" "$(D t1 -c "insert into public.booth_sort_memos (memo) values ('m4') returning id")"
expect "target: GoTrue's session state not moved (refresh_tokens empty, 7 on the source)" "0|7" \
  "$(D t1 -c "select count(*) from auth.refresh_tokens")|$(S src -c "select count(*) from auth.refresh_tokens")"
expect "target: GoTrue's own schema_migrations kept" "gotrue-v2.197.0" "$(D t1 -c "select string_agg(version, ',') from auth.schema_migrations")"
expect "target: no default grant to anon on a restored table" "f|f" \
  "$(D t1 -c "select has_table_privilege('anon', 'public.ples', 'SELECT'), has_table_privilege('authenticated', 'public.booth_plays', 'INSERT')")"
# undo the two writes above so t1 equals the source again for the checks that follow
D t1 -c "set session_replication_role = replica; delete from public.audit_log where seq = 8;
         delete from public.booth_sort_memos where id = 4;"
D t1 -c "select setval('public.pseudonym_seq', 5)" >/dev/null

echo "the CONTROL: the same rows into a schema that already has the chain trigger"
# The path the ADR's 'triggers off' guards against: the schema laid first (as running db/migration-*.sql on
# the data host would), then the data. pg_dump's own stream creates triggers after the data, so the
# control lays the schema first itself; the two legs differ in the session_replication_role line only.
control() { # control <target db> <replica: on|off>
  { echo "begin;"
    [ "$2" = on ] && echo "set session_replication_role = replica;"
    "$PG_BIN/pg_dump" -h 127.0.0.1 -p "$SPORT" -U postgres -d src --no-owner --no-privileges --data-only --schema=auth --exclude-table=auth.schema_migrations
    "$PG_BIN/pg_dump" -h 127.0.0.1 -p "$SPORT" -U postgres -d src --no-owner --schema-only --schema=public | sed '/^CREATE SCHEMA public;$/d'
    echo "commit;"; } | D "$1" >/dev/null
  { echo "begin;"
    [ "$2" = on ] && echo "set session_replication_role = replica;"
    "$PG_BIN/pg_dump" -h 127.0.0.1 -p "$SPORT" -U postgres -d src --no-owner --data-only --schema=public
    echo "commit;"; } | D "$1" >/dev/null
}
control t2 off
OUT="$(mv_ t2 src verify 2>&1)" || true
has "triggers ON: the report fails" "VERIFY: FAIL" "$OUT"
has "  → audit_log_verify fails against the source head" "audit_log_verify FAILS on the target" "$OUT"
has "  → audit_log rows differ (re-dated, re-hashed)" "DIFFERS" "$(grep '^public.audit_log ' <<< "$OUT")"
expect "  → the trigger re-stamped created_at" "f" \
  "$(D t2 -c "select bool_and(created_at < now() - interval '1 hour') from public.audit_log where action <> 'after-chain'")"
control t4 on
OUT="$(mv_ t4 src verify 2>&1)" || true
has "triggers OFF (the script's session_replication_role): the same path passes" "VERIFY: PASS" "$OUT"
has "  → anchored at the source head" "anchored at the source head seq 7" "$OUT"

echo "the report fails when it should"
S src -c "insert into public.booth_plays (case_id, tier) values ('late', 1)"
OUT="$(mv_ t1 src verify 2>&1)" || true
has "a row written to the source after the move" "DIFFERS" "$(grep '^public.booth_plays ' <<< "$OUT")"
has "  → and the booth table is named" "required table public.booth_plays: NOT EQUAL ON THE TARGET" "$OUT"
S src -c "delete from public.booth_plays where case_id = 'late'; select setval('public.booth_plays_id_seq', 25)" >/dev/null
expect "  → undone: passes again" "VERIFY: PASS" "$(mv_ t1 src verify 2>&1 | tail -1)"
D t1 -c "select setval('auth.refresh_tokens_id_seq', 2)" >/dev/null
has "a target sequence lower than the source" "sequence auth.refresh_tokens_id_seq: target next 3 is LOWER than the source next 8" \
  "$(mv_ t1 src verify 2>&1 || true)"
D t1 -c "select setval('auth.refresh_tokens_id_seq', 7)" >/dev/null
D t1 -c "alter table public.booth_event_purges rename to booth_event_purges_x"
has "a table missing on the target" "public.booth_event_purges" "$(mv_ t1 src verify 2>&1 | grep 'MISSING ON TARGET' || true)"
D t1 -c "alter table public.booth_event_purges_x rename to booth_event_purges"
expect "  → undone: passes again" "VERIFY: PASS" "$(mv_ t1 src verify 2>&1 | tail -1)"

echo "the report fails on a privilege difference (grants, default privileges, row level security, policies)"
has "a passing report compares them" ", 0 differ" "$(mv_ t1 src verify 2>&1 | grep '^privileges: ')"
drift() { # drift <label> <the report line> <sql that makes the difference on t1> <sql that undoes it>
  D t1 -c "$3" >/dev/null
  has "$1" "$2" "$(mv_ t1 src verify 2>&1 || true)"
  D t1 -c "$4" >/dev/null
}
drift "a table grant the source lacks" "grant on table public.councils to authenticator: NOT ON THE SOURCE (SELECT on the target)" \
  "grant select on public.councils to authenticator" "revoke select on public.councils from authenticator"
# MAINTAIN sits between INSERT and REFERENCES from PostgreSQL 17 on, so the line is matched at its two ends.
D t1 -c "revoke update on public.ples from service_role"
OUT="$(mv_ t1 src verify 2>&1 | grep '^grant on table public.ples to service_role: ' || true)"
has "a grant narrower than the source's" "UPDATE on the source, DELETE,INSERT," "$OUT"
has "  → names what the target holds" ",TRUNCATE on the target" "$OUT"
D t1 -c "grant update on public.ples to service_role"
drift "a column grant the source lacks" "grant on column public.councils.name_th to authenticator: NOT ON THE SOURCE (SELECT on the target)" \
  "grant select (name_th) on public.councils to authenticator" "revoke select (name_th) on public.councils from authenticator"
drift "a function grant the source lacks" "grant on function public.next_pseudonym() to authenticator: NOT ON THE SOURCE (EXECUTE on the target)" \
  "grant execute on function public.next_pseudonym() to authenticator" "revoke execute on function public.next_pseudonym() from authenticator"
drift "a grant option the source lacks" ",SELECT*,TRIGGER," \
  "grant select on public.councils to service_role with grant option" "revoke grant option for select on public.councils from service_role"
drift "a default privilege the source lacks" \
  "default privileges of postgres on tables to authenticator: NOT ON THE SOURCE (SELECT on the target)" \
  "alter default privileges for role postgres in schema public grant select on tables to authenticator" \
  "alter default privileges for role postgres in schema public revoke select on tables from authenticator"
drift "row level security off" "row level security on public.ples: enabled on the source, disabled on the target" \
  "alter table public.ples disable row level security" "alter table public.ples enable row level security"
drift "row level security forced" "row level security on public.ples: enabled on the source, enabled and forced on the target" \
  "alter table public.ples force row level security" "alter table public.ples no force row level security"
drift "a policy missing" 'policy "ples: own" on public.ples: MISSING ON TARGET' \
  'drop policy "ples: own" on public.ples' 'create policy "ples: own" on public.ples for select using (physician_id = auth.uid())'
drift "a policy with another expression" 'policy "ples: own" on public.ples: DIFFERS (its command, roles or expressions)' \
  'alter policy "ples: own" on public.ples using (true)' 'alter policy "ples: own" on public.ples using (physician_id = auth.uid())'
drift "a policy for other roles" 'policy "ples: own" on public.ples: DIFFERS (its command, roles or expressions)' \
  'alter policy "ples: own" on public.ples to authenticated' 'alter policy "ples: own" on public.ples to public'
drift "a policy the source lacks" "policy open on public.ples: NOT ON THE SOURCE" \
  "create policy open on public.ples for select using (true)" "drop policy open on public.ples"
# The owner holds every privilege and bypasses RLS: a table or a function handed to an app role is a difference.
drift "a table owned by an app role" "owner of table public.councils: admin on the source, authenticator on the target" \
  "alter table public.councils owner to authenticator" "alter table public.councils owner to supabase_admin"
drift "a function owned by an app role" \
  "owner of function public.next_pseudonym(): admin on the source, service_role on the target" \
  "alter function public.next_pseudonym() owner to service_role" \
  "alter function public.next_pseudonym() owner to supabase_admin; grant execute on function public.next_pseudonym() to service_role"
expect "  → undone: passes again" "VERIFY: PASS" "$(mv_ t1 src verify 2>&1 | tail -1)"
# One privilege from two grantors counts once: the source's SELECT to authenticator comes from the owner and
# from supabase_auth_admin (given the grant option), the target's from the owner only.
S src -c "grant select on public.councils to supabase_auth_admin with grant option" \
      -c "grant select on public.councils to authenticator" \
      -c "set role supabase_auth_admin" -c "grant select on public.councils to authenticator"
D t1 -c "grant select on public.councils to supabase_auth_admin with grant option" -c "grant select on public.councils to authenticator"
expect "a privilege from two grantors on the source" "2" \
  "$(S src -c "select count(*) from pg_class c, aclexplode(c.relacl) x where c.oid = 'public.councils'::regclass and x.grantee = 'authenticator'::regrole")"
expect "  → counts once: passes" "VERIFY: PASS" "$(mv_ t1 src verify 2>&1 | tail -1)"
for c in S D; do db=src; [ "$c" = D ] && db=t1
  $c "$db" -c "revoke select on public.councils from authenticator" -c "revoke select on public.councils from supabase_auth_admin cascade"
done
expect "  → undone: passes again" "VERIFY: PASS" "$(mv_ t1 src verify 2>&1 | tail -1)"

echo "AUDIT_CHAIN=checksum (option b) on an unchained source"
OUT="$(src_url nochain | CLICS_DATA_DB=t3 AUDIT_CHAIN=checksum bash "$MOVE" move 2>&1)" || true
has "passes, saying what replaced the chain" "replaced by public.audit_log row checksum, equal (AUDIT_CHAIN=checksum)" "$OUT"
has "  → VERIFY: PASS" "VERIFY: PASS" "$OUT"
expect "the same report with AUDIT_CHAIN=required fails" "1" "$(rc mv_ t3 nochain verify)"

echo "dump, report, check (the backup and the restore drill)"
expect "dump refuses a file" "1" "$(rc bash -c "src_url | bash '$MOVE' dump > '$DIR/plain.sql'")"
expect "  → and wrote nothing into it" "0" "$(wc -c < "$DIR/plain.sql" | tr -d ' ')"
src_url | CLICS_DATA_DB=t1 bash "$MOVE" report target > "$DIR/t1.report" 2>/dev/null
expect "a report holds no row: no email, no transcript text" "0" "$(grep -cE 'example.invalid|เจ็บ|case-' "$DIR/t1.report" || true)"
grep -v '^priv|' "$DIR/t1.report" > "$DIR/old.report"
has "check fails a report without privileges (an older move.sh's)" "privileges: NOT IN THE REPORT" \
  "$(CLICS_DATA_DB=t1 bash "$MOVE" check "$DIR/old.report" 2>&1 || true)"
# A fresh data host, GoTrue migrated, as the drill starts from: in the other cluster, so it lacks the
# clics_analyst role that roles.sql made on the data host (a real restore target lacks it too).
TCL=S target_db drill
expect "the drill's cluster has no clics_analyst role" "0" "$(S postgres -c "select count(*) from pg_roles where rolname = 'clics_analyst'")"
# roles.sql has run on the data host before any nightly backup (the window's order), so the dump carries
# grants to clics_analyst and clics_backup.
D t1 -f "$ROLES" >/dev/null
# the nightly backup: the data host is the source, read in one exported snapshot, its report inside, as
# clics_backup (not a superuser), the login backup.env names
CLICS_DATA_DB=t1 CLICS_DATA_USER=clics_backup bash "$MOVE" backup < /dev/null | cat > "$DIR/backup.sql"
expect "backup runs as clics_backup, not a superuser" "f" "$(D postgres -c "select rolsuper from pg_roles where rolname = 'clics_backup'")"
expect "backup carries roles.sql's grants to clics_analyst" "t" \
  "$(grep -q 'TO clics_analyst;' "$DIR/backup.sql" && echo t || echo f)"
expect "  → and to clics_backup (the drill makes both roles)" "t" \
  "$(grep -q 'TO clics_backup;' "$DIR/backup.sql" && echo t || echo f)"
expect "  → and every auth row (RLS hides none from clics_backup)" "t" \
  "$(grep -q "^-- clics-report table|auth.users|$(D t1 -c 'select count(*) from auth.users')|" "$DIR/backup.sql" && echo t || echo f)"
expect "backup carries its report as SQL comments" "t" \
  "$(grep -q '^-- clics-report table|public.booth_plays|25|' "$DIR/backup.sql" && echo t || echo f)"
expect "  → and the anchored chain head" "t" "$(grep -q '^-- clics-report audit_head|7|' "$DIR/backup.sql" && echo t || echo f)"
expect "  → and its source's PostgreSQL version (pg_dump's header)" "t" \
  "$(grep -q '^-- Dumped from database version [0-9]' "$DIR/backup.sql" && echo t || echo f)"
# A backup from a newer major than the drill database's (PostgreSQL 18's data host into a 17 drill): refused
# before its first row, and the load's transaction never commits.
EXTS="$(S drill -c "select count(*) from pg_extension")"
OUT="$(sed 's/^-- Dumped from database version [0-9]*/-- Dumped from database version 99/' "$DIR/backup.sql" |
  CLICS_DATA_PORT=$SPORT CLICS_DATA_DB=drill bash "$MOVE" drill 2>&1)" && RC=0 || RC=$?
expect "restore drill refuses a backup from a newer PostgreSQL than its own" "3" "$RC"
has "  → says which versions" "comes from PostgreSQL 99 and this drill database runs" "$OUT"
expect "  → and leaves the drill database as it was" "0|$EXTS|0" \
  "$(S drill -c "select (select count(*) from pg_class where relnamespace = 'public'::regnamespace), (select count(*) from pg_extension), (select count(*) from auth.users)")"
OUT="$(CLICS_DATA_PORT=$SPORT CLICS_DATA_DB=drill bash "$MOVE" drill < "$DIR/backup.sql" 2>&1)" || true
has "restore drill: the backup restores and passes its own report" "VERIFY: PASS" "$OUT"
D t1 -c "insert into public.booth_sort_memos (memo) values ('after the backup')"
expect "check against an older report fails once the data host moved on" "1" \
  "$(rc env CLICS_DATA_DB=t1 bash "$MOVE" check "$DIR/t1.report")"
D t1 -c "delete from public.booth_sort_memos where memo = 'after the backup'"
expect "backup refuses a file" "1" "$(rc env CLICS_DATA_DB=t1 bash "$MOVE" backup)"
rm -f "$DIR/backup.sql"

echo "roles.sql"
RUNS=""
for _ in 1 2; do if D t1 -f "$ROLES" >/dev/null; then RUNS="$RUNS ok"; else RUNS="$RUNS fail"; fi; done
expect "applies twice (idempotent)" " ok ok" "$RUNS"
expect "no app role, nor the analyst, is a superuser" "0" \
  "$(D t1 -c "select count(*) from pg_roles where rolsuper and rolname in ('authenticator','supabase_auth_admin','service_role','anon','authenticated','clics_analyst')")"
expect "clics_analyst: login, bypassrls, no create/replication" "t|t|f|f|f" \
  "$(D t1 -c "select rolcanlogin, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication from pg_roles where rolname = 'clics_analyst'")"
A() { D t1 -c "set role clics_analyst; $1" 2>&1 | head -1; }
expect "analyst reads ples (RLS on) and booth_plays" "2|25" "$(A "select (select count(*) from public.ples), (select count(*) from public.booth_plays)")"
expect "analyst reads professionals.role" "physician" "$(A "select role from public.professionals where pseudonym = 'P-001'")"
has "analyst cannot read professionals.email" "permission denied" "$(A "select email from public.professionals")"
has "analyst cannot read free text (ples.chief_complaint)" "permission denied" "$(A "select chief_complaint from public.ples")"
has "analyst cannot read a text column outside the allow list (ples.code)" "permission denied" "$(A "select code from public.ples")"
has "analyst cannot read jsonb (booth_plays.transcript)" "permission denied" "$(A "select transcript from public.booth_plays")"
has "analyst cannot read text arrays (ples.tags)" "permission denied" "$(A "select tags from public.ples")"
expect "analyst reads numbers and times (ples.score, booth_plays.tier)" "t" \
  "$(A "select (select count(score) from public.ples) >= 0 and (select count(tier) from public.booth_plays) >= 0")"
has "analyst cannot read professionals.full_name_th" "permission denied" "$(A "select full_name_th from public.professionals")"
has "analyst cannot read ple_pii_map" "permission denied" "$(A "select * from public.ple_pii_map")"
has "analyst cannot read oauth_identities" "permission denied" "$(A "select id from public.oauth_identities")"
has "analyst cannot read auth.users" "permission denied" "$(A "select count(*) from auth.users")"
has "analyst cannot insert" "permission denied" "$(A "set transaction read write; insert into public.booth_plays (case_id) values ('x')")"
has "analyst cannot update" "permission denied" "$(A "set default_transaction_read_only = off; update public.ples set score = 0")"
has "analyst cannot call nextval" "permission denied" "$(A "select nextval('public.pseudonym_seq')")"
has "analyst cannot call the SECURITY DEFINER function" "permission denied" "$(A "select public.next_pseudonym()")"
expect "postgrest_exposure still lists nothing" "0" "$(D t1 -c "select count(*) from public.postgrest_exposure()")"
expect "clics_backup: login, bypassrls, no superuser/create/replication, reads all data" "t|t|f|f|f|f|t" \
  "$(D t1 -c "select rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
                     pg_has_role(oid, 'pg_read_all_data', 'USAGE') from pg_roles where rolname = 'clics_backup'")"
B() { D t1 -c "set role clics_backup; $1" 2>&1 | head -1; }
expect "backup reads auth.users and the identity tables, every row" \
  "$(D t1 -c "select (select count(*) from auth.users), (select count(*) from public.ple_pii_map)")" \
  "$(B "select (select count(*) from auth.users), (select count(*) from public.ple_pii_map)")"
expect "backup reads the chain head" "7" "$(B "select head_seq from public.audit_log_head()")"
has "backup cannot insert" "permission denied" "$(B "set transaction read write; insert into public.booth_plays (case_id) values ('x')")"
has "backup cannot update" "permission denied" "$(B "set default_transaction_read_only = off; update public.ples set score = 0")"
has "backup cannot call the SECURITY DEFINER function" "permission denied" "$(B "select public.next_pseudonym()")"
D t1 -c "grant insert on public.ples to clics_backup"
has "roles.sql refuses a clics_backup that can write" "clics_backup can write to public.ples" "$(D t1 -f "$ROLES" 2>&1 || true)"
D t1 -c "revoke insert on public.ples from clics_backup; grant service_role to clics_backup"
has "roles.sql refuses a clics_backup holding another role" "clics_backup is a member of service_role" "$(D t1 -f "$ROLES" 2>&1 || true)"
D t1 -c "revoke service_role from clics_backup"
expect "  → and passes again once that is undone" "0" "$(rc D t1 -f "$ROLES")"
D t1 -c "grant execute on function public.next_pseudonym() to public"
has "roles.sql refuses a SECURITY DEFINER function the analyst could call" "can execute SECURITY DEFINER functions" \
  "$(D t1 -f "$ROLES" 2>&1 || true)"
D t1 -c "revoke execute on function public.next_pseudonym() from public; alter role authenticator superuser"
has "roles.sql refuses an app role that is a superuser" "role authenticator is a superuser" "$(D t1 -f "$ROLES" 2>&1 || true)"
D t1 -c "alter role authenticator nosuperuser; grant select on public.ples to anon"
has "roles.sql refuses a schema whose postgrest_exposure lists a grant" "ADR 0007 wants none" "$(D t1 -f "$ROLES" 2>&1 || true)"

echo "plain PostgreSQL target (prepare-plain-pg.sql, database clics_mentor, superuser postgres)"
# A cluster with none of the image's roles: what CME's plain PostgreSQL starts as.
PPORT=$(start_cluster plain $((DPORT + 21)) "-c ssl=on")
P() { local db=$1; shift; "$PG_BIN/psql" -h 127.0.0.1 -p "$PPORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 -X -q -At -P pager=off "$@"; }
P postgres -c "create database clics_mentor"
mvp() { src_url src | CLICS_DATA_PORT=$PPORT CLICS_DATA_DB=clics_mentor CLICS_DATA_USER=postgres bash "$MOVE" "$@"; }
RUNS=""
for _ in 1 2; do if P clics_mentor -f "$ROOT/deploy/vm1/db-move/prepare-plain-pg.sql" >/dev/null; then RUNS="$RUNS ok"; else RUNS="$RUNS fail"; fi; done
expect "prepare-plain-pg.sql applies twice (idempotent)" " ok ok" "$RUNS"
expect "  → the image's roles, none a superuser, supabase_admin without login" "6|0|f" \
  "$(P postgres -c "select count(*), count(*) filter (where rolsuper), bool_or(rolcanlogin and rolname = 'supabase_admin') from pg_roles
                    where rolname in ('anon','authenticated','service_role','authenticator','supabase_auth_admin','supabase_admin')")"
expect "  → auth is supabase_auth_admin's; authenticator can switch to service_role" "supabase_auth_admin|t" \
  "$(P clics_mentor -c "select nspowner::regrole, pg_has_role('authenticator', 'service_role', 'MEMBER') from pg_namespace where nspname = 'auth'")"
expect "  → the extensions schema PostgREST searches, usable by service_role; no default privileges yet" "t|0" \
  "$(P clics_mentor -c "select has_schema_privilege('service_role', 'extensions', 'USAGE'), (select count(*) from pg_default_acl)")"
has "preflight before GoTrue ran" "start GoTrue against it once" "$(mvp preflight 2>&1 || true)"
# GoTrue's first start, as supabase_auth_admin (it owns auth): its tables and functions.
P clics_mentor <<'SQL'
set role supabase_auth_admin;
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role' $$;
create table auth.users (id uuid primary key, is_sso_user boolean not null default false, email text,
  created_at timestamptz not null default now(), encrypted_password text, instance_id uuid);
create table auth.identities (id uuid primary key, user_id uuid not null references auth.users(id), provider text);
create table auth.refresh_tokens (id bigserial primary key, token text, user_id text);
create table auth.schema_migrations (version text primary key);
insert into auth.schema_migrations values ('gotrue-v2.197.0');
SQL
P clics_mentor -c "drop schema extensions"
has "preflight stops on a target without the extensions schema" "schema extensions (PostgREST searches it)" \
  "$(mvp preflight 2>&1 || true)"
P clics_mentor -f "$ROOT/deploy/vm1/db-move/prepare-plain-pg.sql" >/dev/null

# The data host's password on stdin, the line after the URL (CLICS_DATA_PASSWORD=stdin): how run-move.sh hands
# it over, so no file on vm1 holds it. A superuser that must give its password; the clusters trust the rest.
P postgres -c "create role mover superuser login password 'mover-test-pw'"
{ echo 'hostssl all mover 127.0.0.1/32 scram-sha-256'; cat "$DIR/plain/pg_hba.conf"; } > "$DIR/hba"
mv "$DIR/hba" "$DIR/plain/pg_hba.conf"
P postgres -c "select pg_reload_conf()" >/dev/null
mvs() { # mvs <the line after the URL, or -none> <args...>
  local pw=$1; shift
  { src_url src; [ "$pw" = -none ] || echo "$pw"; } |
    CLICS_DATA_PORT=$PPORT CLICS_DATA_DB=clics_mentor CLICS_DATA_USER=mover CLICS_DATA_PASSWORD=stdin bash "$MOVE" "$@"
}
has "password on stdin: the right one passes the preflight" "preflight ok" "$(mvs mover-test-pw preflight 2>&1 || true)"
has "  → a wrong one is refused by the data host" 'password authentication failed for user "mover"' \
  "$(mvs wrong-pw preflight 2>&1 || true)"
has "  → none after the URL stops before any connection" "no data host password on the stdin line" \
  "$(mvs -none preflight 2>&1 || true)"
# The source's own login, with the data host's password: the URL's (wrong) password must be the one tried.
S postgres -c "create role srcmover login password 'mover-test-pw'"
{ echo 'hostssl all srcmover 127.0.0.1/32 scram-sha-256'; cat "$DIR/src/pg_hba.conf"; } > "$DIR/hba"
mv "$DIR/hba" "$DIR/src/pg_hba.conf"
S postgres -c "select pg_reload_conf()" >/dev/null
has "  → the data host's password never opens the source" 'password authentication failed for user "srcmover"' \
  "$(printf 'postgresql://srcmover:wrong-pw@127.0.0.1:%s/src?sslmode=require\nmover-test-pw\n' "$SPORT" |
     CLICS_DATA_PORT=$PPORT CLICS_DATA_DB=clics_mentor CLICS_DATA_USER=mover CLICS_DATA_PASSWORD=stdin \
     bash "$MOVE" preflight 2>&1 || true)"
has "  → a command that reads no URL refuses it" "works with preflight, move, verify" \
  "$(CLICS_DATA_PASSWORD=stdin bash "$MOVE" report target 2>&1 < /dev/null || true)"
OUT="$(CLICS_DATA_PASSWORD=pw-canary-77 bash "$MOVE" preflight 2>&1 < /dev/null || true)"
has "  → a value other than 'stdin' is refused" "names where the password comes from" "$OUT"
expect "  → and not printed" "0" "$(grep -c pw-canary-77 <<< "$OUT" || true)"

echo "run-move.sh: the move under CME's rules (sudo runs it; both secrets typed at a terminal, never a file)"
KIT="$DIR/kit"
mkdir -m 755 "$KIT" "$DIR/bin"
cp "$ROOT/deploy/vm1/db-move/run-move.sh" "$MOVE" "$KIT/"
chmod 755 "$KIT/run-move.sh" "$KIT/move.sh"
cat > "$KIT/db-move.conf" <<EOF
# CME writes this file; no secret in it
CLICS_PG_IMAGE=stand-in/postgres:test
CLICS_DATA_HOST=127.0.0.1
CLICS_DATA_PORT=$PPORT
CLICS_DATA_DB=clics_mentor
CLICS_DATA_USER=mover
CLICS_DATA_SSLMODE=require
EOF
chmod 644 "$KIT/db-move.conf"
# A stand-in for `docker run`: records its argv, then runs the mounted move.sh here with only the environment
# the container would get. An unknown flag fails, so a change to the wrapper's docker line shows here.
cat > "$DIR/bin/docker" <<'STUB'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" > "$STUB_ARGV"
[ "${1:-}" = run ] || { echo "stand-in docker: run only" >&2; exit 2; }
shift
envs=() script='' ca=''
while [ $# -gt 0 ]; do
  case "$1" in
    --rm|-i|--read-only) shift ;;
    --log-driver|--network|--tmpfs|--cap-drop|--security-opt|--pids-limit|--entrypoint) shift 2 ;;
    -e) envs+=("$2"); shift 2 ;;
    -v) case "$2" in
          *:/db-move/move.sh:ro) script=${2%%:*} ;;
          *:/run/data-ca.crt:ro) ca=${2%%:*} ;;
          *) echo "stand-in docker: unexpected mount $2" >&2; exit 2 ;;
        esac; shift 2 ;;
    -*) echo "stand-in docker: unknown flag $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
shift   # the image
[ "${1:-}" = /db-move/move.sh ] || { echo "stand-in docker: unexpected command ${1:-}" >&2; exit 2; }
shift
# The container would see the CA at /run/data-ca.crt; here that is the host file the mount names.
for i in "${!envs[@]}"; do
  [ "${envs[$i]}" != CLICS_DATA_SSLROOTCERT=/run/data-ca.crt ] || envs[i]="CLICS_DATA_SSLROOTCERT=$ca"
done
exec env -i PATH="$PATH" PG_BIN="$PG_BIN" TMPDIR="${TMPDIR:-/tmp}" "${envs[@]}" bash "$script" "$@"
STUB
chmod 755 "$DIR/bin/docker"
# A terminal: answers each "not shown): " prompt in turn, as a person would, then prints what the screen showed.
cat > "$DIR/pty.py" <<'PY'
import os, pty, select, sys, time
args = sys.argv[1:]
cut = args.index('--')
answers, cmd = args[:cut], args[cut + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
out, sent, deadline = b'', 0, time.time() + 90
while time.time() < deadline:
    if not select.select([fd], [], [], 1)[0]:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    while sent < len(answers) and out.count(b'not shown): ') > sent:
        time.sleep(0.5)  # a person types after the prompt, once read -s has turned echo off
        os.write(fd, answers[sent].encode() + b'\n')
        sent += 1
else:
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors='replace').replace('\r\n', '\n'))
sys.exit(os.waitstatus_to_exitcode(status))
PY
export STUB_ARGV="$DIR/docker-argv"
URL=$(src_url src)
wrap() { PATH="$DIR/bin:$PATH" python3 -I "$DIR/pty.py" "$@"; }   # wrap <answers...> -- <command...>
runm() { PATH="$DIR/bin:$PATH" bash "$KIT/run-move.sh" "$@" 2>&1 < /dev/null || true; }
# The terminal needs python3. The data-host image has none, so a run inside it skips these; CI must not.
PTY=1
if ! command -v python3 >/dev/null; then
  PTY=''
  if [ -n "${CI:-}" ]; then echo "  FAIL python3 is missing: CI runs the terminal checks"; FAIL=1
  else echo "  SKIP the terminal checks (no python3 here)"; fi
fi
if [ -n "$PTY" ]; then
  OUT="$(wrap "$URL" mover-test-pw -- bash "$KIT/run-move.sh" preflight 2>&1)" || true
  has "run-move.sh preflight, the URL and the password typed at a terminal" "preflight ok" "$OUT"
  has "  → it names the kit and image it ran" "[run-move] kit: run-move.sh " "$OUT"
  expect "  → neither secret is echoed" "0" "$(grep -cF -e mover-test-pw -e "$URL" <<< "$OUT" || true)"
  expect "  → nor in docker's argv" "0" "$(grep -cF -e mover-test-pw -e "$URL" -e unused "$STUB_ARGV" || true)"
  expect "  → the container keeps no log" "none" "$(grep -A1 -x -- --log-driver "$STUB_ARGV" | tail -1)"
fi
has "  → refuses secrets on a pipe" "stdin must be a terminal" \
  "$(printf '%s\nmover-test-pw\n' "$URL" | PATH="$DIR/bin:$PATH" bash "$KIT/run-move.sh" preflight 2>&1 || true)"
expect "  → refuses any other command" "64" "$(rc env PATH="$DIR/bin:$PATH" bash "$KIT/run-move.sh" dump)"
chmod 664 "$KIT/db-move.conf"
has "  → refuses a db-move.conf its group could change" "db-move.conf can be changed by its group" "$(runm preflight)"
chmod 644 "$KIT/db-move.conf"; chmod 757 "$KIT/move.sh"
has "  → and a move.sh anyone could change" "move.sh can be changed by its group" "$(runm preflight)"
chmod 755 "$KIT/move.sh"; chmod 777 "$KIT"
has "  → and a directory above them anyone could write" "/kit can be changed by its group" "$(runm preflight)"
chmod 755 "$KIT"; cp "$KIT/db-move.conf" "$DIR/conf.keep"; echo 'PGPASSWORD=conf-canary-5' >> "$KIT/db-move.conf"
OUT="$(runm preflight)"
has "  → refuses a db-move.conf line it does not know" "db-move.conf line 8: not one of the names" "$OUT"
expect "  → without printing it" "0" "$(grep -c conf-canary-5 <<< "$OUT" || true)"
mv "$DIR/conf.keep" "$KIT/db-move.conf"
mv "$KIT/move.sh" "$DIR/move-real.sh"; ln -s "$DIR/move-real.sh" "$KIT/move.sh"
has "  → refuses a move.sh that is a symlink" "move.sh is a symlink" "$(runm preflight)"
rm "$KIT/move.sh"; mv "$DIR/move-real.sh" "$KIT/move.sh"; chmod 777 "$DIR/bin"
has "  → refuses a docker in a directory anyone could write" "/bin can be changed by its group" "$(runm preflight)"
chmod 755 "$DIR/bin"
# The data host's CA (verify-ca here: the test certificate names localhost, the clusters listen on
# 127.0.0.1; verify-full adds only libpq's host-name check to the same file).
mkdir -m 755 "$DIR/ca"; cp "$DIR/server.crt" "$DIR/ca/data-ca.crt"; chmod 644 "$DIR/ca/data-ca.crt"
cp "$KIT/db-move.conf" "$DIR/conf.keep"
{ grep -v '^CLICS_DATA_SSLMODE=' "$DIR/conf.keep"
  echo CLICS_DATA_SSLMODE=verify-ca; echo "CLICS_DATA_SSLROOTCERT=$DIR/ca/data-ca.crt"; } > "$KIT/db-move.conf"
chmod 777 "$DIR/ca"
has "  → refuses a CA certificate in a directory anyone could write" "/ca can be changed by its group" "$(runm preflight)"
chmod 755 "$DIR/ca"
if [ -n "$PTY" ]; then
  has "  → verify-ca against the CA certificate CME installs" "preflight ok" \
    "$(wrap "$URL" mover-test-pw -- bash "$KIT/run-move.sh" preflight 2>&1 || true)"
  has "  → which goes into the container read-only" ":/run/data-ca.crt:ro" "$(cat "$STUB_ARGV")"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -keyout "$DIR/other.key" -out "$DIR/ca/data-ca.crt" >/dev/null 2>&1
  has "  → and a server the CA did not sign is refused" "certificate verify failed" \
    "$(wrap "$URL" mover-test-pw -- bash "$KIT/run-move.sh" preflight 2>&1 || true)"
fi
mv "$DIR/conf.keep" "$KIT/db-move.conf"

OUT="$(mvp move 2>&1)" || true
has "move into plain PostgreSQL: VERIFY: PASS" "VERIFY: PASS" "$OUT"
has "  → anchored at the source head" "anchored at the source head seq 7" "$OUT"
has "  → grants, default privileges, row level security and policies as on the source" ", 0 differ" \
  "$(grep '^privileges: ' <<< "$OUT")"
[ -z "$PTY" ] || has "  → run-move.sh verify, through the terminal, agrees" "VERIFY: PASS" \
  "$(wrap "$URL" mover-test-pw -- bash "$KIT/run-move.sh" verify 2>&1 || true)"
# The backend reads every table as service_role: the dump carries each table's grants, and, at its end, the
# source's default privileges, so a table a later migration makes is service_role's too.
expect "  → service_role holds the source's grants and default privileges" "t|t|t" \
  "$(P clics_mentor -c "select has_table_privilege('service_role', 'public.ples', 'SELECT,INSERT,UPDATE,DELETE'),
    has_table_privilege('service_role', 'public.audit_log', 'SELECT'),
    exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) a
             where d.defaclobjtype = 'r' and d.defaclnamespace = 'public'::regnamespace
               and pg_get_userbyid(d.defaclrole) = 'postgres' and a.grantee = 'service_role'::regrole)")"
expect "  → roles.sql then passes there" "0" "$(rc P clics_mentor -f "$ROLES")"
OUT="$(mvp verify 2>&1)" || true
has "  → verify after roles.sql passes" "VERIFY: PASS" "$OUT"
has "  → and names roles.sql's grants, which the source lacks" "more on the target are roles.sql's (clics_analyst, clics_backup)" "$OUT"
P clics_mentor -c "grant insert on public.booth_plays to clics_analyst"
has "  → a write grant to clics_analyst is not roles.sql's: it fails" \
  "grant on table public.booth_plays to clics_analyst: NOT ON THE SOURCE (INSERT on the target)" "$(mvp verify 2>&1 || true)"
P clics_mentor -c "revoke insert on public.booth_plays from clics_analyst"
P clics_mentor -c "grant select (chief_complaint) on public.ples to clics_analyst"
has "  → nor is a free-text column roles.sql's list leaves out" \
  "grant on column public.ples.chief_complaint to clics_analyst: NOT ON THE SOURCE (SELECT on the target)" "$(mvp verify 2>&1 || true)"
P clics_mentor -c "revoke select (chief_complaint) on public.ples from clics_analyst; grant select (ple_id) on public.ple_pii_map to clics_analyst"
has "  → nor a uuid column of an identity table" \
  "grant on column public.ple_pii_map.ple_id to clics_analyst: NOT ON THE SOURCE (SELECT on the target)" "$(mvp verify 2>&1 || true)"
P clics_mentor -c "revoke select (ple_id) on public.ple_pii_map from clics_analyst"
expect "  → undone: passes again" "VERIFY: PASS" "$(mvp verify 2>&1 | tail -1)"
# move.sh carries a copy of roles.sql's allow list (it runs where roles.sql is not): the two must not drift.
lst() { tr '\n' ' ' < "$1" | sed -E "s/.*$2.*/\\1/" | tr -d ' '; }
for n in deny_tables allow_text; do
  expect "move.sh's copy of roles.sql's $n is the same list" "$(lst "$ROLES" "$n text\[\] := array\[([^]]*)\]")" \
    "$(lst "$MOVE" "array\[([^]]*)\] $n")"
done
ty="typcategory in ([^)]*) or ty.oid = '[^']*'::regtype"
expect "  → and the same column types (uuid included)" "$(grep -o "$ty" "$ROLES" || echo 'not in roles.sql')" \
  "$(grep -o "$ty" "$MOVE" || echo 'not in move.sh')"
expect "  → and both drop the denied tables" "1|1" \
  "$(grep -c -E "relname <> all \(deny_tables\)" "$ROLES")|$(grep -c -E "relname <> all \(rule\.deny_tables\)" "$MOVE")"
expect "  → PUBLIC cannot connect; the CLICS logins, the analyst and the backup can" "f|t|t|t" \
  "$(P postgres -c "select has_database_privilege('anon', 'clics_mentor', 'CONNECT'), has_database_privilege('authenticator', 'clics_mentor', 'CONNECT'), has_database_privilege('clics_analyst', 'clics_mentor', 'CONNECT'), has_database_privilege('clics_backup', 'clics_mentor', 'CONNECT')")"
P postgres -c "create database clics_evaluator"
has "prepare-plain-pg.sql stops on a shared cluster whose roles exist" "may be another service's logins" \
  "$(P clics_mentor -f "$ROOT/deploy/vm1/db-move/prepare-plain-pg.sql" 2>&1 || true)"
expect "  → and goes on once the operator confirms (clics.shared_roles_ok=on)" "0" \
  "$(rc env PGOPTIONS='-c clics.shared_roles_ok=on' "$PG_BIN/psql" -h 127.0.0.1 -p "$PPORT" -U postgres -d clics_mentor -v ON_ERROR_STOP=1 -X -q -f "$ROOT/deploy/vm1/db-move/prepare-plain-pg.sql")"

if [ "$FAIL" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
