#!/bin/bash
# Exercise db/migration-evaluator-lock-manifest.sql against a REAL, throwaway PostgreSQL — the hermetic
# jest suites mock Supabase and never run the DDL. Nothing here touches any shared database.
#
#   scripts/db/evaluator-lock-manifest-test.sh      # needs initdb/pg_ctl/psql on PATH (or PG_BIN)
#
# Asserts: run before its prerequisite it refuses with a clear message and changes nothing; with
# shadow_evaluations absent it applies, skips that column and says so; it applies twice (idempotent);
# the manifest columns land nullable with exactly one copy of each CHECK; a pre-existing lock row is
# untouched; the table's grants, RLS flag and deny-all policy are byte-identical before and after;
# anon/authenticated still see no row and cannot write one while the service role can; the CHECKs refuse
# a malformed sha and a half-written pair; shadow_evaluations.decoding is added once that table exists;
# db/migration-evaluator-lock-identity.sql (#430) refuses before its prerequisite, applies twice, keeps
# the pre-existing row as a weights lock, and its CHECK lets a row name the evaluator by a weights digest
# or by model id + system fingerprint, never both or neither; and db/schema.sql declares the same
# columns and constraints as prerequisite + both migrations.
set -euo pipefail
export LC_ALL=C LANG=C
export PGOPTIONS="-c client_min_messages=warning"   # the IF [NOT] EXISTS notices are expected; keep the output readable

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$ROOT/db/migration-evaluator-lock-manifest.sql"
PRE="$ROOT/db/migration-evaluator-model-lock.sql"
ID="$ROOT/db/migration-evaluator-lock-identity.sql"
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@17/bin/pg_ctl)")}"
DIR="$(mktemp -d)"
trap '"$PG_BIN/pg_ctl" -D "$DIR/data" stop -m fast >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT

"$PG_BIN/initdb" -D "$DIR/data" -U postgres -A trust -E UTF8 --locale=C >/dev/null
# TCP only: a socket path under a long TMPDIR exceeds the 103-byte Unix-socket limit on macOS. The first
# free port from PORT (default 55443) up: a port in use makes the postmaster exit, and we try the next.
START="${PORT:-55443}"
PORT=""
for p in $(seq "$START" $((START + 20))); do
  if "$PG_BIN/pg_ctl" -D "$DIR/data" -o "-p $p -c unix_socket_directories='' -c listen_addresses=127.0.0.1" \
       -l "$DIR/log" -w start >/dev/null 2>&1; then PORT="$p"; break; fi
done
[ -n "$PORT" ] || { echo "could not start PostgreSQL on ports $START..$((START + 20))"; cat "$DIR/log"; exit 1; }
echo "postgres $("$PG_BIN/postgres" --version | awk '{print $3}') on 127.0.0.1:$PORT"

PDB() { local db="$1"; shift; "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 -X -q -At -P pager=off "$@"; }
P() { PDB t "$@"; }
"$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -X -q -c "create database t;" -c "create database s;"

FAIL=0
expect() { # expect <label> <want> <got>
  if [ "$2" == "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: want [$2] got [$3]"; FAIL=1; fi
}
sqlstate() { # sqlstate <sql> → the SQLSTATE it raised, or "ok"
  local out
  if out="$(P -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo ok; else
    echo "$out" | sed -n 's/^ERROR: *\([0-9A-Z]\{5\}\):.*/\1/p' | head -1; fi
}

# Supabase-shaped stand-ins, in both databases: the three API roles (service_role bypasses RLS, as on
# Supabase), auth.uid(), and Supabase's DEFAULT table grants to the API roles — so "grants unchanged"
# is checked against the ACL a real project would hand this table, not an empty one.
STUBS="
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql as \$\$ select null::uuid \$\$;
grant usage on schema public to service_role, anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.professionals (id uuid primary key default gen_random_uuid(), role text);
create table public.cles (id uuid primary key default gen_random_uuid());
"
P -c "create role anon; create role authenticated; create role service_role bypassrls;"
P -c "$STUBS"; PDB s -c "$STUBS"

COLS="select string_agg(column_name || ' ' || data_type || ' ' || is_nullable, ',' order by column_name)
        from information_schema.columns where table_schema = 'public' and table_name = 'evaluator_model_lock'"
CONS="select string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' order by conname)
        from pg_constraint where conrelid = 'public.evaluator_model_lock'::regclass and contype = 'c'"
SEC="select c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|' ||
            coalesce((select string_agg(a, ',' order by a) from unnest(c.relacl::text[]) a), '') || '|' ||
            coalesce((select string_agg(p.polname || ':' || p.polcmd::text || ':' || pg_get_expr(p.polqual, p.polrelid) || ':' ||
              coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-'), ',' order by p.polname)
              from pg_policy p where p.polrelid = c.oid), '')
       from pg_class c where c.oid = 'public.evaluator_model_lock'::regclass"

echo "prerequisite missing"
OUT="$(P -f "$MIG" 2>&1 || true)"
expect "refuses before migration-evaluator-model-lock.sql" "1" "$(echo "$OUT" | grep -c 'apply db/migration-evaluator-model-lock.sql first' || true)"
expect "  → and creates nothing" "" "$(P -c "select to_regclass('public.evaluator_model_lock')")"

P -f "$PRE" >/dev/null
# A lock declared before the manifest existed: the migration must leave it exactly as it was.
P -c "insert into evaluator_model_lock (id, locked_at, provider, model_version, weights_sha256, inference_engine,
        system_prompt_version, evaluator_prompt_version, rubric_version, gate)
      values ('00000000-0000-0000-0000-0000000000a1', '2026-10-01T00:00:00Z', 'local', 'CCME_LLM_v8.0+m',
        repeat('a', 64), 'vllm', 'sys', 'pis7-prompt-x', 'pis7-weights-y', '{\"state\":\"pass\"}')"
ROW="select md5(row(id, locked_at, provider, model_version, weights_sha256, inference_engine, system_prompt_version,
       evaluator_prompt_version, rubric_version, gate)::text) from evaluator_model_lock where id = '00000000-0000-0000-0000-0000000000a1'"
ROW_BEFORE="$(P -c "$ROW")"
SEC_BEFORE="$(P -c "$SEC")"
echo "before: rls|force|acl|policies = [$SEC_BEFORE]"

echo "migration (shadow_evaluations absent)"
if OUT="$(PGOPTIONS='-c client_min_messages=notice' P -f "$MIG" 2>&1)"; then R=ok; else R=fail; fi
expect "applies without shadow_evaluations" "ok" "$R"
expect "  → and says the decoding column was skipped" "1" "$(echo "$OUT" | grep -c 'decoding not added' || true)"
expect "  → shadow_evaluations still absent (not created by this file)" "" "$(P -c "select to_regclass('public.shadow_evaluations')")"

echo "migration (shadow_evaluations present), twice"
P -f "$ROOT/db/migration-shadow-evaluations.sql" >/dev/null
RUNS=""
for n in 1 2; do if P -f "$MIG" >/dev/null 2>&1; then RUNS="$RUNS ok"; else RUNS="$RUNS fail"; fi; done
expect "applies twice (idempotent)" " ok ok" "$RUNS"
expect "manifest + evaluator columns added, nullable" "evaluator_sha256 text YES|manifest jsonb YES|manifest_sha256 text YES" \
  "$(P -c "select string_agg(column_name || ' ' || data_type || ' ' || is_nullable, '|' order by column_name) from information_schema.columns
           where table_name = 'evaluator_model_lock' and column_name in ('manifest', 'manifest_sha256', 'evaluator_sha256')")"
expect "no unlock columns (unlocks live on the audit trail)" "0" \
  "$(P -c "select count(*) from information_schema.columns where table_name = 'evaluator_model_lock' and column_name like 'unlocked%'")"
expect "exactly one copy of each CHECK after two runs" "1|1|1" \
  "$(P -c "select count(*) filter (where conname = 'evaluator_model_lock_manifest_sha256_hex') || '|' ||
                 count(*) filter (where conname = 'evaluator_model_lock_evaluator_sha256_hex') || '|' ||
                 count(*) filter (where conname = 'evaluator_model_lock_manifest_pair')
           from pg_constraint where conrelid = 'public.evaluator_model_lock'::regclass")"
expect "shadow_evaluations.decoding added (jsonb, nullable)" "jsonb YES" \
  "$(P -c "select data_type || ' ' || is_nullable from information_schema.columns where table_name = 'shadow_evaluations' and column_name = 'decoding'")"
expect "column comments present" "4" \
  "$(P -c "select count(*) from (values ('evaluator_model_lock', 'manifest_sha256'), ('evaluator_model_lock', 'manifest'),
             ('evaluator_model_lock', 'evaluator_sha256'), ('shadow_evaluations', 'decoding')) v(t, c)
           where col_description(('public.' || t)::regclass, (select attnum from pg_attribute where attrelid = ('public.' || t)::regclass and attname = c)) is not null")"
expect "pre-existing lock row untouched" "$ROW_BEFORE" "$(P -c "$ROW")"
expect "  → its manifest columns are NULL (locked before the manifest)" "t" \
  "$(P -c "select manifest_sha256 is null and manifest is null and evaluator_sha256 is null from evaluator_model_lock where id = '00000000-0000-0000-0000-0000000000a1'")"

echo "grants and RLS"
expect "RLS flag, ACL and deny-all policy byte-identical" "$SEC_BEFORE" "$(P -c "$SEC")"
expect "  → RLS on, deny-all policy for ALL commands" "t" \
  "$(P -c "select c.relrowsecurity and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'evaluator_model_lock_no_access'
             and p.polcmd::text = '*' and pg_get_expr(p.polqual, p.polrelid) = 'false') from pg_class c where c.oid = 'public.evaluator_model_lock'::regclass")"
expect "anon sees no lock row" "0" "$(P -c "set role anon; select count(*) from evaluator_model_lock" | tail -1)"
expect "authenticated sees no lock row" "0" "$(P -c "set role authenticated; select count(*) from evaluator_model_lock" | tail -1)"
expect "authenticated cannot read the new columns' rows either" "0" \
  "$(P -c "set role authenticated; select count(manifest_sha256) from evaluator_model_lock" | tail -1)"
GOOD="repeat('b', 64)"
INS() { echo "insert into evaluator_model_lock (weights_sha256, inference_engine, system_prompt_version, evaluator_prompt_version,
  rubric_version, manifest_sha256, manifest, evaluator_sha256) values (repeat('c', 64), 'vllm', 's', 'p', 'r', $1, $2, ${3:-repeat('d', 64)})"; }
expect "authenticated cannot write a lock row (RLS 42501)" "42501" "$(sqlstate "set role authenticated; $(INS "$GOOD" "'{}'::jsonb")")"
expect "the service role sees every row" "1" "$(P -c "set role service_role; select count(*) from evaluator_model_lock" | tail -1)"

echo "constraints"
expect "service role writes a manifest-bound lock" "ok" "$(sqlstate "set role service_role; $(INS "$GOOD" "'{\"code\":{}}'::jsonb")")"
expect "an upper-case sha is refused (23514)" "23514" "$(sqlstate "$(INS "upper($GOOD)" "'{}'::jsonb")")"
expect "a short sha is refused (23514)" "23514" "$(sqlstate "$(INS "'abc123'" "'{}'::jsonb")")"
expect "a sha without its manifest is refused (23514)" "23514" "$(sqlstate "$(INS "$GOOD" "null")")"
expect "a manifest without its sha is refused (23514)" "23514" "$(sqlstate "$(INS "null" "'{}'::jsonb")")"
expect "both NULL is still accepted (a lock without a manifest stays expressible)" "ok" "$(sqlstate "$(INS "null" "null" "null")")"
expect "an upper-case evaluator sha is refused (23514)" "23514" "$(sqlstate "$(INS "$GOOD" "'{}'::jsonb" "upper(repeat('d', 64))")")"
expect "a short evaluator sha is refused (23514)" "23514" "$(sqlstate "$(INS "$GOOD" "'{}'::jsonb" "'abc'")")"
expect "the evaluator sha alone may be NULL (a pre-binding row)" "ok" "$(sqlstate "$(INS "$GOOD" "'{}'::jsonb" "null")")"

echo "identity migration (#430)"
if OUT="$(PDB s -f "$ID" 2>&1)"; then R=applied; else R=refused; fi
expect "refuses before migration-evaluator-model-lock.sql" "refused 1" \
  "$R $(echo "$OUT" | grep -c 'apply db/migration-evaluator-model-lock.sql first' || true)"
RUNS=""
for n in 1 2; do if P -f "$ID" >/dev/null 2>&1; then RUNS="$RUNS ok"; else RUNS="$RUNS fail"; fi; done
expect "applies twice (idempotent)" " ok ok" "$RUNS"
expect "identity_basis not null, system_fingerprint and weights_sha256 nullable" \
  "identity_basis text NO|system_fingerprint text YES|weights_sha256 text YES" \
  "$(P -c "select string_agg(column_name || ' ' || data_type || ' ' || is_nullable, '|' order by column_name) from information_schema.columns
           where table_name = 'evaluator_model_lock' and column_name in ('identity_basis', 'system_fingerprint', 'weights_sha256')")"
expect "exactly one copy of the identity CHECK" "1" \
  "$(P -c "select count(*) from pg_constraint where conrelid = 'public.evaluator_model_lock'::regclass and conname = 'evaluator_model_lock_identity_basis'")"
expect "pre-existing lock row untouched" "$ROW_BEFORE" "$(P -c "$ROW")"
expect "  → and reads as a weights lock" "weights_sha256" \
  "$(P -c "select identity_basis from evaluator_model_lock where id = '00000000-0000-0000-0000-0000000000a1'")"
IDINS() { echo "insert into evaluator_model_lock (identity_basis, weights_sha256, model_version, system_fingerprint, inference_engine,
  system_prompt_version, evaluator_prompt_version, rubric_version) values ($1, $2, $3, $4, 'vllm', 's', 'p', 'r')"; }
expect "a model-identity lock with no digest is accepted" "ok" \
  "$(sqlstate "set role service_role; $(IDINS "'model_id+system_fingerprint'" "null" "'CCME_LLM_v8.0+DeepSeek-V4.1-Flash-1017'" "'fp'")")"
expect "a model-identity lock with a digest is refused (23514)" "23514" \
  "$(sqlstate "$(IDINS "'model_id+system_fingerprint'" "repeat('e', 64)" "'m'" "'fp'")")"
expect "a model-identity lock with no fingerprint is refused (23514)" "23514" \
  "$(sqlstate "$(IDINS "'model_id+system_fingerprint'" "null" "'m'" "null")")"
expect "a model-identity lock with no model id is refused (23514)" "23514" \
  "$(sqlstate "$(IDINS "'model_id+system_fingerprint'" "null" "null" "'fp'")")"
expect "a weights lock with no digest is refused (23514)" "23514" "$(sqlstate "$(IDINS "'weights_sha256'" "null" "'m'" "null")")"
expect "an unknown basis is refused (23514)" "23514" "$(sqlstate "$(IDINS "'neither'" "null" "'m'" "'fp'")")"
expect "RLS flag, ACL and deny-all policy still byte-identical" "$SEC_BEFORE" "$(P -c "$SEC")"

echo "db/schema.sql agrees with prerequisite + both migrations"
# The table's block in schema.sql, applied alone to a fresh database with the same stubs.
sed -n '/^create table public.evaluator_model_lock (/,/^create policy evaluator_model_lock_no_access/p' "$ROOT/db/schema.sql" > "$DIR/schema-block.sql"
expect "schema.sql declares the table" "1" "$(grep -c '^create table public.evaluator_model_lock (' "$DIR/schema-block.sql" || true)"
PDB s -f "$DIR/schema-block.sql" >/dev/null
expect "same columns, types and nullability" "$(P -c "$COLS")" "$(PDB s -c "$COLS")"
expect "same CHECK constraints" "$(P -c "$CONS")" "$(PDB s -c "$CONS")"
expect "same RLS flag and policy" "$(P -c "$SEC" | cut -d'|' -f1,2,4)" "$(PDB s -c "$SEC" | cut -d'|' -f1,2,4)"
expect "  → and the migrations are a no-op on a schema.sql install" "ok" \
  "$(PDB s -f "$PRE" >/dev/null 2>&1 && PDB s -f "$MIG" >/dev/null 2>&1 && PDB s -f "$ID" >/dev/null 2>&1 && echo ok || echo fail)"
expect "  → columns still match after it" "$(P -c "$COLS")" "$(PDB s -c "$COLS")"

if [ "$FAIL" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
