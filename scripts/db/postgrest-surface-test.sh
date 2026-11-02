#!/bin/bash
# Exercise db/migration-postgrest-closed.sql against a REAL, throwaway PostgreSQL (#281, ADR 0007). Nothing
# here touches any shared database.
#
#   scripts/db/postgrest-surface-test.sh            # needs initdb/pg_ctl/psql on PATH (or PG_BIN)
#
# Builds Supabase-shaped stand-ins (the three API roles, an auth.uid() that reads request.jwt.claims, the
# default ACLs that grant every new object to the API roles) with the real RLS policies on ples, messages and
# audit_scores, shows the hole is open, applies the migration twice, then asserts: anon, the assigned auditor
# and the owning physician get permission denied on reads, writes and app functions; service_role still reads,
# writes and executes; extension functions are left alone; postgrest_exposure() is empty, lists a deliberate
# re-grant (table, column, function), and a re-run closes it; tables and sequences created later arrive
# closed, and a new function is listed until PUBLIC is revoked; and db/schema.sql carries the same
# postgrest_exposure() byte for byte.
set -euo pipefail
export LC_ALL=C LANG=C
export PGOPTIONS="-c client_min_messages=warning"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$ROOT/db/migration-postgrest-closed.sql"
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
# RLS refusals share 42501 with privilege refusals; only a privilege refusal says "permission denied for".
denied() { # denied <sql> → "denied <table|function|...>" for a privilege refusal, else the SQLSTATE or "ok"
  local out
  if out="$(P -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo ok
  elif echo "$out" | grep -q '^ERROR: *42501: permission denied for'; then
    echo "denied $(echo "$out" | sed -n 's/^ERROR: *42501: permission denied for \([a-z]*\).*/\1/p' | head -1)"
  else echo "$out" | sed -n 's/^ERROR: *\([0-9A-Z]\{5\}\):.*/\1/p' | head -1; fi
}

PHYS='00000000-0000-0000-0000-0000000000a1'
AUD='00000000-0000-0000-0000-0000000000b1'
PLE='00000000-0000-0000-0000-0000000000c1'
MSG='00000000-0000-0000-0000-0000000000d1'
AS() { # AS <anon|physician|auditor|service_role> <sql>
  case "$1" in
    anon)         echo "set role anon; $2" ;;
    physician)    echo "set role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$PHYS\"}', false); $2" ;;
    auditor)      echo "set role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$AUD\"}', false); $2" ;;
    service_role) echo "set role service_role; $2" ;;
  esac
}

P <<'SQL'
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
$$;
grant usage on schema auth, public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create extension if not exists pg_trgm schema public;

create table public.professionals (id uuid primary key, role text not null);
create table public.ples (
  id uuid primary key default gen_random_uuid(),
  physician_id uuid not null references public.professionals(id),
  auditor_id uuid references public.professionals(id),
  title text, chief_complaint text,
  status text not null default 'active',
  stamped boolean not null default false);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  ple_id uuid not null references public.ples(id) on delete cascade,
  role text not null check (role in ('physician','assistant')),
  content text not null, refs jsonb default '[]'::jsonb, socratic_question text,
  token_count integer default 0, created_at timestamptz default now());
create table public.audit_scores (
  id uuid primary key default gen_random_uuid(),
  ple_id uuid not null references public.ples(id) on delete cascade,
  auditor_id uuid not null references public.professionals(id),
  score numeric not null);
create table public.ple_code_migration (
  ple_id uuid primary key references public.ples(id) on delete cascade,
  old_code text not null, new_code text not null, migrated_at timestamptz not null default now());
alter table public.professionals enable row level security;
alter table public.ples enable row level security;
alter table public.messages enable row level security;
alter table public.audit_scores enable row level security;

create policy "ples: physician own"
  on public.ples for select using (physician_id = auth.uid());
create policy "ples: auditor assigned"
  on public.ples for select using (auditor_id = auth.uid());
create policy "ples: superadmin all"
  on public.ples for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin'));
create policy "ples: physician insert"
  on public.ples for insert with check (physician_id = auth.uid());
create policy "ples: physician update own"
  on public.ples for update using (physician_id = auth.uid());
create policy "msg: physician own ple"
  on public.messages for select using (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.physician_id = auth.uid()));
create policy "msg: auditor assigned ple"
  on public.messages for select using (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.auditor_id = auth.uid()));
create policy "msg: physician insert"
  on public.messages for insert with check (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.physician_id = auth.uid()));
create policy "audit: auditor own"
  on public.audit_scores for all using (auditor_id = auth.uid());

create sequence public.pseudonym_seq;
create function public.next_pseudonym() returns text language sql as $$
  select 'P-' || lpad(nextval('public.pseudonym_seq')::text, 3, '0');
$$;
create function public.ples_stamp() returns trigger language plpgsql as $$
begin
  new.stamped := true;
  return new;
end $$;
create trigger ples_stamp before insert on public.ples for each row execute function public.ples_stamp();
SQL
# Apply the provenance migration's messages grants verbatim; the rest of that file needs audit_discussions.
sed -n '/^revoke select on public.messages from anon, authenticated;/,/on public.messages to authenticated;/p' \
  "$ROOT/db/migration-message-provenance.sql" > "$DIR/provenance-grants.sql"
expect "provenance grant block found" "3" "$(wc -l < "$DIR/provenance-grants.sql" | tr -d ' ')"
P -f "$DIR/provenance-grants.sql"

P <<SQL
insert into public.professionals (id, role) values ('$PHYS', 'physician'), ('$AUD', 'auditor');
insert into public.ples (id, physician_id, auditor_id, title, chief_complaint)
  values ('$PLE', '$PHYS', '$AUD', 'Chest pain case', 'crushing chest pain since 2 h');
insert into public.messages (id, ple_id, role, content) values ('$MSG', '$PLE', 'physician', 'what is the ECG?');
insert into public.audit_scores (ple_id, auditor_id, score) values ('$PLE', '$AUD', 3);
insert into public.ple_code_migration (ple_id, old_code, new_code) values ('$PLE', 'CLE-001', 'PLE-001');
SQL

echo "before the migration: the hole is open"
expect "assigned auditor reads ples.chief_complaint" "crushing chest pain since 2 h" \
  "$(P -c "$(AS auditor "select chief_complaint from public.ples where id = '$PLE'")" | tail -1)"
expect "assigned auditor reads messages.content" "what is the ECG?" \
  "$(P -c "$(AS auditor "select content from public.messages where id = '$MSG'")" | tail -1)"
expect "owning physician inserts a message" "ok" \
  "$(denied "$(AS physician "insert into public.messages (ple_id, role, content) values ('$PLE', 'physician', 'pre')")")"
expect "anon executes the app function" "ok" "$(denied "$(AS anon "select public.next_pseudonym()")")"
expect "anon reads ple_code_migration (no RLS)" "ok" "$(denied "$(AS anon "select * from public.ple_code_migration")")"
expect "messages carries column grants" "t" \
  "$(P -c "select count(*) > 0 from pg_attribute where attrelid = 'public.messages'::regclass and attacl is not null")"

echo "migration"
RUNS=""
for n in 1 2; do if P -f "$MIG" >/dev/null; then RUNS="$RUNS ok"; else RUNS="$RUNS fail"; fi; done
expect "applies twice (idempotent)" " ok ok" "$RUNS"
expect "column grants on messages are gone" "0" \
  "$(P -c "select count(*) from pg_attribute where attrelid = 'public.messages'::regclass and attacl is not null")"
expect "ple_code_migration has RLS" "t" "$(P -c "select relrowsecurity from pg_class where oid = 'public.ple_code_migration'::regclass")"
expect "every RLS policy kept" "9" "$(P -c "select count(*) from pg_policy")"
expect "postgrest_exposure: stable, invoker, search_path ''" "s|f|search_path=\"\"" \
  "$(P -c "select provolatile, prosecdef, array_to_string(proconfig, ',') from pg_proc where proname = 'postgrest_exposure'")"

echo "client roles: permission denied"
for who in anon auditor physician; do
  for col in ples.chief_complaint ples.title messages.content; do
    expect "$who SELECT $col" "denied table" "$(denied "$(AS $who "select ${col#*.} from public.${col%%.*}")")"
  done
  expect "$who INSERT ples" "denied table" \
    "$(denied "$(AS $who "insert into public.ples (physician_id, title) values ('$PHYS', 'x')")")"
  expect "$who UPDATE ples" "denied table" "$(denied "$(AS $who "update public.ples set title = 'x' where id = '$PLE'")")"
  expect "$who DELETE ples" "denied table" "$(denied "$(AS $who "delete from public.ples where id = '$PLE'")")"
  expect "$who INSERT messages" "denied table" \
    "$(denied "$(AS $who "insert into public.messages (ple_id, role, content) values ('$PLE', 'physician', 'x')")")"
  expect "$who UPDATE messages" "denied table" "$(denied "$(AS $who "update public.messages set content = 'x' where id = '$MSG'")")"
  expect "$who DELETE messages" "denied table" "$(denied "$(AS $who "delete from public.messages where id = '$MSG'")")"
  expect "$who INSERT audit_scores" "denied table" \
    "$(denied "$(AS $who "insert into public.audit_scores (ple_id, auditor_id, score) values ('$PLE', '$AUD', 5)")")"
  expect "$who UPDATE audit_scores" "denied table" "$(denied "$(AS $who "update public.audit_scores set score = 5")")"
  expect "$who DELETE audit_scores" "denied table" "$(denied "$(AS $who "delete from public.audit_scores")")"
  expect "$who EXECUTE next_pseudonym()" "denied function" "$(denied "$(AS $who "select public.next_pseudonym()")")"
  expect "$who EXECUTE postgrest_exposure()" "denied function" "$(denied "$(AS $who "select * from public.postgrest_exposure()")")"
done
expect "anon SELECT ple_code_migration" "denied table" "$(denied "$(AS anon "select * from public.ple_code_migration")")"

echo "service_role: unchanged"
expect "selects ples, messages, audit_scores" "1|2|1" \
  "$(P -c "$(AS service_role "select (select count(*) from public.ples), (select count(*) from public.messages), (select count(*) from public.audit_scores)")" | tail -1)"
NEW_PLE="$(P -c "$(AS service_role "insert into public.ples (physician_id, title) values ('$PHYS', 'sr') returning id")" | tail -1)"
expect "inserts a PLE, and the trigger fires" "t" "$(P -c "select stamped from public.ples where id = '$NEW_PLE'")"
expect "inserts a message" "ok" \
  "$(denied "$(AS service_role "insert into public.messages (ple_id, role, content) values ('$NEW_PLE', 'assistant', 'sr')")")"
expect "inserts an audit score" "ok" \
  "$(denied "$(AS service_role "insert into public.audit_scores (ple_id, auditor_id, score) values ('$NEW_PLE', '$AUD', 4)")")"
expect "updates all three" "ok" "$(denied "$(AS service_role "update public.ples set title = 'u' where id = '$NEW_PLE';
  update public.messages set content = 'u' where ple_id = '$NEW_PLE'; update public.audit_scores set score = 2 where ple_id = '$NEW_PLE'")")"
expect "deletes all three" "ok" "$(denied "$(AS service_role "delete from public.audit_scores where ple_id = '$NEW_PLE';
  delete from public.messages where ple_id = '$NEW_PLE'; delete from public.ples where id = '$NEW_PLE'")")"
expect "executes next_pseudonym()" "P-" "$(P -c "$(AS service_role "select left(public.next_pseudonym(), 2)")" | tail -1)"

echo "extension functions: left alone"
expect "anon still executes pg_trgm's similarity()" "ok" "$(denied "$(AS anon "select public.similarity('chest', 'chest pain')")")"
expect "listing is empty (extension members not listed)" "0" \
  "$(P -c "$(AS service_role "select count(*) from public.postgrest_exposure()")" | tail -1)"

echo "objects created after the migration"
P -c "create table public.after_mig (id int); create sequence public.after_seq;
      create function public.after_fn() returns int language sql as 'select 1';"
expect "new table not granted to anon/authenticated" "f|f" \
  "$(P -c "select has_table_privilege('anon', 'public.after_mig', 'SELECT'), has_table_privilege('authenticated', 'public.after_mig', 'INSERT')")"
expect "new sequence not granted to anon/authenticated" "f|f" \
  "$(P -c "select has_sequence_privilege('anon', 'public.after_seq', 'USAGE'), has_sequence_privilege('authenticated', 'public.after_seq', 'USAGE')")"
expect "service_role still gets the new table" "t" "$(P -c "select has_table_privilege('service_role', 'public.after_mig', 'SELECT')")"
expect "a new function keeps the built-in PUBLIC execute, and the listing names it" \
  "after_fn()|function|anon|EXECUTE;after_fn()|function|authenticated|EXECUTE" \
  "$(P -c "$(AS service_role "select string_agg(object_name || '|' || object_kind || '|' || grantee || '|' || privilege, ';') from public.postgrest_exposure()")" | tail -1)"
P -c "revoke all on function public.after_fn() from public"
expect "  → once its migration revokes PUBLIC, the listing is empty" "0" \
  "$(P -c "$(AS service_role "select count(*) from public.postgrest_exposure()")" | tail -1)"

echo "the listing sees a re-grant"
P -c "grant select on public.ples to authenticated; grant select (content) on public.messages to anon;
      grant execute on function public.next_pseudonym() to anon;"
expect "lists exactly the table, the column and the function" \
  "messages.content|column|anon|SELECT;next_pseudonym()|function|anon|EXECUTE;ples|table|authenticated|SELECT" \
  "$(P -c "$(AS service_role "select string_agg(object_name || '|' || object_kind || '|' || grantee || '|' || privilege, ';' order by object_name) from public.postgrest_exposure()")" | tail -1)"
P -c "grant select on public.pseudonym_seq to anon; grant execute on function public.next_pseudonym() to public;"
expect "a PUBLIC execute grant counts for both roles, and a sequence is listed" \
  "next_pseudonym()|function|anon;next_pseudonym()|function|authenticated;pseudonym_seq|sequence|anon" \
  "$(P -c "$(AS service_role "select string_agg(object_name || '|' || object_kind || '|' || grantee, ';' order by object_name, grantee) from public.postgrest_exposure() where object_kind in ('function', 'sequence')")" | tail -1)"
P -f "$MIG" >/dev/null
expect "re-running the migration closes them (listing empty)" "0" \
  "$(P -c "$(AS service_role "select count(*) from public.postgrest_exposure()")" | tail -1)"
expect "  → auditor denied ples again" "denied table" "$(denied "$(AS auditor "select chief_complaint from public.ples")")"

echo "db/schema.sql"
sed -n '/^create or replace function public.postgrest_exposure()/,/^\$\$;/p' "$MIG" > "$DIR/fn-mig.sql"
sed -n '/^create or replace function public.postgrest_exposure()/,/^\$\$;/p' "$ROOT/db/schema.sql" > "$DIR/fn-schema.sql"
expect "migration defines postgrest_exposure()" "t" "$([ -s "$DIR/fn-mig.sql" ] && echo t || echo f)"
expect "schema.sql's postgrest_exposure() is byte-identical" "same" \
  "$(cmp -s "$DIR/fn-mig.sql" "$DIR/fn-schema.sql" && echo same || echo differs)"

if [ "$FAIL" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
