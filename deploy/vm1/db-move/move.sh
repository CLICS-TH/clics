#!/bin/bash
# The database move (#432, ADR 0012): Supabase -> the private data host, run on vm1. README.md in this
# directory is the runbook and says when to run which command.
#
#   move.sh preflight        < supabase-url   both ends reachable, source over TLS, target empty and ready
#   move.sh move             < supabase-url   preflight, stream the dump into the data host, then verify
#   move.sh verify           < supabase-url   the verify report only (source against the data host)
#   move.sh report source    < supabase-url   one database's report (counts, checksums, sequences, chain head)
#   move.sh report target                     the same for the data host (backup.sh, the restore drill)
#   move.sh check REPORT                      the verify report of the data host against a saved report
#   move.sh dump             < supabase-url | ...    the restore stream, to a pipe only
#   ... | move.sh load                        a restore stream into the data host
#   move.sh backup | ...                      the data host's stream in one snapshot, its report inside (backup.sh)
#   ... | move.sh drill                       restore a backup stream into a throwaway data host, then check it
#
# Source: the Supabase connection URL, one line on stdin (the session pooler URL, password URL-encoded,
# with sslmode=require or stricter). It is split into libpq variables set only on the source commands, so
# it is never in an argv (ps). SRC_FROM=data-host makes the data host the source instead (backup.sh).
# Target: CLICS_DATA_HOST (required; a name or address from the environment, never one in this kit),
# CLICS_DATA_PORT (5432), CLICS_DATA_DB (postgres), CLICS_DATA_USER (supabase_admin, a superuser:
# session_replication_role needs one), CLICS_DATA_SSLMODE (require; verify-ca or verify-full are
# stronger; the participant data crosses the tailnet to another host, so the hop is TLS too), and the
# password: from a pgpass file (PGPASSFILE), or, with CLICS_DATA_PASSWORD=stdin, as the stdin line after the
# source URL (run-move.sh, so on vm1 no file ever holds it). A plaintext hop (CLICS_DATA_SSLMODE=disable, allow or prefer)
# is refused unless CLICS_DATA_PLAINTEXT_OK=1 is also set, for a throwaway target only.
# AUDIT_CHAIN=required (the default) fails the report when the source has no audit_log chain;
# AUDIT_CHAIN=checksum accepts audit_log's row checksum in its place (README.md, "Audit chain").
# SNAPSHOT=<exported snapshot id> makes every source read, pg_dump included, see that one snapshot.
# PG_BIN: the directory of pg_dump and psql, when they are not on PATH.
#
# Nothing here writes a file of data: the dump goes from pg_dump's stdout to psql's stdin. The report holds
# table names, column names, row counts, checksums, sequence values, grants and policy checksums, never a row.
set -euo pipefail
export LC_ALL=C LANG=C
# Only what this script sets reaches libpq: a PGHOST or PGPASSWORD inherited from the caller's shell
# would otherwise point one end somewhere else. PGPASSFILE is kept: it is one way the target's password comes in.
unset PGHOST PGHOSTADDR PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE PGSERVICE PGSERVICEFILE PGOPTIONS PGTARGETSESSIONATTRS \
  PGSSLROOTCERT
REQUIRED_TABLES=(public.booth_plays public.booth_sort_memos public.booth_event_purges)
AUDIT_CHAIN=${AUDIT_CHAIN:-required}
SRC_FROM=${SRC_FROM:-stdin}
SNAPSHOT=${SNAPSHOT:-}
CLICS_DATA_PASSWORD=${CLICS_DATA_PASSWORD:-}
DPW=''

log() { echo "[db-move] $*" >&2; }
die() { echo "[db-move] ERROR: $*" >&2; exit 1; }

case "$AUDIT_CHAIN" in required|checksum) ;; *) die "AUDIT_CHAIN must be required or checksum, not '$AUDIT_CHAIN'" ;; esac
case "$SRC_FROM" in stdin|data-host) ;; *) die "SRC_FROM must be stdin or data-host, not '$SRC_FROM'" ;; esac
case "$CLICS_DATA_PASSWORD" in ''|stdin) ;; *) die "CLICS_DATA_PASSWORD must be stdin or unset (it names where the password comes from, never the password)" ;; esac
[[ -z "$SNAPSHOT" || "$SNAPSHOT" =~ ^[0-9A-Fa-f-]+$ ]] || die "SNAPSHOT is not a snapshot id"

# ---- connections ----------------------------------------------------------------------------------------
dst() {
  [ -n "${CLICS_DATA_HOST:-}" ] || die "CLICS_DATA_HOST is not set (the data host's tailnet name or address)"
  # A subshell, so the data host's root certificate (verify-full) never reaches a source command.
  ( [ -z "${CLICS_DATA_SSLROOTCERT:-}" ] || export PGSSLROOTCERT=$CLICS_DATA_SSLROOTCERT
    [ -z "$DPW" ] || export PGPASSWORD=$DPW
    PGHOST=$CLICS_DATA_HOST PGPORT=${CLICS_DATA_PORT:-5432} PGDATABASE=${CLICS_DATA_DB:-postgres} \
      PGUSER=${CLICS_DATA_USER:-supabase_admin} PGSSLMODE=${CLICS_DATA_SSLMODE:-require} PGAPPNAME=clics-db-move "$@" )
}
case "${CLICS_DATA_SSLMODE:-require}" in
  require|verify-ca|verify-full) ;;
  disable|allow|prefer)
    [ "${CLICS_DATA_PLAINTEXT_OK:-}" = 1 ] ||
      die "CLICS_DATA_SSLMODE=${CLICS_DATA_SSLMODE} lets the data host hop run in clear: use require or stricter (CLICS_DATA_PLAINTEXT_OK=1 for a throwaway target only)" ;;
  *) die "CLICS_DATA_SSLMODE must be require, verify-ca or verify-full, not '${CLICS_DATA_SSLMODE}'" ;;
esac

SU='' SP='' SH='' SPORT='' SDB='' SSL=''
read_source() {
  if [ "$SRC_FROM" = data-host ]; then return; fi
  local url re
  IFS= read -r url || die "no source URL on stdin"
  re='^postgres(ql)?://([^:@/]+):([^@]*)@([^:/?]+)(:([0-9]+))?/([^?]+)(\?(.*))?$'
  [[ $url =~ $re ]] || die "the source is not a postgres://user:password@host[:port]/db URL"
  dec() { local v=${1//+/ }; printf '%b' "${v//%/\\x}"; }
  SU=$(dec "${BASH_REMATCH[2]}") SP=$(dec "${BASH_REMATCH[3]}") SH=${BASH_REMATCH[4]}
  SPORT=${BASH_REMATCH[6]:-5432} SDB=${BASH_REMATCH[7]}
  SSL=$(sed -n 's/.*sslmode=\([a-z-]*\).*/\1/p' <<< "${BASH_REMATCH[9]}")
  unset url
  # Supabase is reached over the internet: the dump of participant data must be encrypted in transit.
  case "$SSL" in require|verify-ca|verify-full) ;;
    *) die "the source URL must carry sslmode=require, verify-ca or verify-full (it has '${SSL:-none}')" ;; esac
  if [ "$CLICS_DATA_PASSWORD" = stdin ]; then
    IFS= read -r DPW || true
    [ -n "$DPW" ] || die "no data host password on the stdin line after the URL (CLICS_DATA_PASSWORD=stdin)"
  fi
}
src() {
  if [ "$SRC_FROM" = data-host ]; then dst "$@"; return; fi
  PGUSER=$SU PGPASSWORD=$SP PGHOST=$SH PGPORT=$SPORT PGDATABASE=$SDB PGSSLMODE=$SSL PGAPPNAME=clics-db-move "$@"
}

# Every read of a side goes through these: no psqlrc, stop on the first error, unaligned, '|' separated.
# The session settings fix every text form a checksum depends on, and row_security=off makes a row that
# RLS would hide an error instead of a silent undercount.
SETTINGS="set timezone = 'UTC'; set datestyle = 'ISO, YMD'; set intervalstyle = 'postgres';
  set extra_float_digits = 3; set bytea_output = 'hex'; set row_security = off; set statement_timeout = 0;"
q_src() {
  local begin="begin isolation level repeatable read read only;"
  [ -z "$SNAPSHOT" ] || begin="$begin set transaction snapshot '$SNAPSHOT';"
  { echo "$begin $SETTINGS"; cat; echo "commit;"; } | src "$(tool_path psql)" -X -q -At -F '|' -v ON_ERROR_STOP=1 -P pager=off
}
q_dst() {
  { echo "begin isolation level repeatable read read only; $SETTINGS"; cat; echo "commit;"; } |
    dst "$(tool_path psql)" -X -q -At -F '|' -v ON_ERROR_STOP=1 -P pager=off
}
tool_path() { echo "${PG_BIN:+$PG_BIN/}$1"; }
q_side() { if [ "$1" = source ]; then q_src; else q_dst; fi; }

# ---- the report -----------------------------------------------------------------------------------------
# One line per fact, so a saved report can be checked later (the backup and the restore drill):
#   col|schema.table|"schema"."table"|t."a", t."b"     the columns a table's checksum covers, in order
#   table|schema.table|rows|md5                          row count and checksum
#   seqname|schema.seq|"schema"."seq"                    a sequence
#   seq|schema.seq|next                                  the value its next nextval() returns
#   audit_head|seq|hash  or  audit_head|empty  or  audit_head|not_installed
#   priv|...                                             grants, row level security and policies (privs_sql)
# The tables are every ordinary table in public and auth, except auth.schema_migrations (GoTrue keeps its
# own), GoTrue's session state (AUTH_SESSION_TABLES: not moved) and extension members (pg_dump does not dump
# them). The checksum is md5 over the sorted md5s of each
# row's text form, columns in the source's order, so a target whose GoTrue added columns or ordered them
# differently still compares on the source's columns.
# GoTrue's session state is not moved: every session ends at the move anyway (the new GoTrue signs with a
# new secret), a refresh token carried over would stay usable against the new GoTrue, and an open browser
# tab refreshing its token against Supabase during the window would otherwise make the report differ.
AUTH_SESSION_TABLES=(sessions refresh_tokens mfa_amr_claims flow_state one_time_tokens)
catalog_sql() {
  local list
  list=$(printf "'%s', " "${AUTH_SESSION_TABLES[@]}"); list=${list%, }
  sed "s/AUTH_SESSION_LIST/$list/" <<'SQL'
select 'col|' || n.nspname || '.' || c.relname || '|' || format('%I.%I', n.nspname, c.relname) || '|'
       || string_agg(format('t.%I', a.attname), ', ' order by a.attnum)
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
 where n.nspname in ('public', 'auth') and c.relkind = 'r'
   and not (n.nspname = 'auth' and c.relname in ('schema_migrations', AUTH_SESSION_LIST))
   and not exists (select 1 from pg_catalog.pg_depend d
                    where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
 group by n.nspname, c.relname order by 1;
select 'seqname|' || n.nspname || '.' || c.relname || '|' || format('%I.%I', n.nspname, c.relname)
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public', 'auth') and c.relkind = 'S'
   and not exists (select 1 from pg_catalog.pg_depend d
                    where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
 order by 1;
SQL
}
lit() { local v=${1//\'/\'\'}; printf "'%s'" "$v"; }
# stdin: col lines -> one checksum query per table
table_sql() {
  local name qual cols
  while IFS='|' read -r _ name qual cols; do
    printf "select 'table|' || %s || '|' || count(*) || '|' || coalesce(md5(string_agg(h, '' order by h)), md5('')) from (select md5(row(%s)::text) h from %s t) x;\n" \
      "$(lit "$name")" "$cols" "$qual"
  done
}
# stdin: seqname lines -> one query per sequence
seq_sql() {
  local name qual
  while IFS='|' read -r _ name qual; do
    printf "select 'seq|' || %s || '|' || case when s.is_called then s.last_value + q.seqincrement else s.last_value end from %s s, pg_catalog.pg_sequence q where q.seqrelid = %s::regclass;\n" \
      "$(lit "$name")" "$qual" "$(lit "$qual")"
  done
}
# A function or table is looked up before a query names it: PostgreSQL resolves every name in a statement,
# even in a CASE branch that never runs, so one query cannot both test for a function and call it.
has() { # has source|target 'public.fn()'|'schema.table' -> true|false
  echo "select (pg_catalog.to_regprocedure($(lit "$2")) is not null or pg_catalog.to_regclass($(lit "$2")) is not null)::text;" |
    q_side "$1"
}
audit_head_sql() { # audit_head_sql source|target
  if [ "$(has "$1" 'public.audit_log_head()')" = true ]; then
    echo "select coalesce((select 'audit_head|' || head_seq || '|' || head_hash from public.audit_log_head()), 'audit_head|empty');"
  else
    echo "select 'audit_head|not_installed';"
  fi
}

# Who owns and who may read and write what in public, one line per fact, the value last (check compares the
# values by key):
#   priv|scope|public                                   always there, so a report without these lines is caught
#   priv|owner|table public.t|admin                     an object's owner; postgres, supabase_admin and any
#                                                       superuser print as admin (they hold everything anyway,
#                                                       and which of them ran the restore owns its objects)
#   priv|grant|table public.t|grantee|SELECT,UPDATE*    an object's grants to one role (* = with grant option);
#                                                       also column, sequence, view, function and schema public
#   priv|default|postgres tables|grantee|SELECT         the default privileges in public
#   priv|rls|public.t|enabled  (disabled, ... and forced) row level security
#   priv|policy|"name" on public.t|md5                  a policy: command, permissive, roles, both expressions
#   roles|column public.t.c                             a column clics_analyst holds a grant on that roles.sql's
#                                                       allow list gives it (check accepts only these as roles.sql's)
# Left out: the owner's own grants, grants to the admin roles above, and extension members (as in the report).
# A privilege granted by two grantors counts once. search_path is pg_catalog only, so a function's signature
# and a policy's expression print every name schema-qualified, the same on both sides.
privs_sql() {
  cat <<'SQL'
set search_path = pg_catalog;
select 'priv|scope|public';
with admin as (
  select oid from pg_roles where rolsuper or rolname in ('postgres', 'supabase_admin')
), rule as (
  -- roles.sql's allow list for clics_analyst, word for word (db-move-test.sh checks that the two match)
  select array['access_requests', 'invites', 'oauth_identities', 'license_verifications',
    'identity_verifications', 'ple_pii_map', 'cle_pii_map', 'ple_patient_refs', 'payment_info', 'payouts'] deny_tables,
         array['councils.code', 'councils.name_th', 'councils.name_en',
    'specialties.code', 'specialties.name_th', 'specialties.name_en',
    'professionals.role', 'professionals.position', 'professionals.status', 'professionals.pseudonym',
    'professionals.exp_code', 'ples.status',
    'ai_evaluations.model_version', 'ai_evaluations.prompt_version', 'ai_evaluations.rubric_version'] allow_text
), rel as (
  select c.oid, c.relname, c.relkind, c.relowner, c.relacl, format('%I.%I', n.nspname, c.relname) qual
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
     and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
), obj as (
  select case r.relkind when 'S' then 'sequence ' when 'v' then 'view ' when 'm' then 'materialized view '
                        when 'f' then 'foreign table ' else 'table ' end || r.qual o, r.relowner own,
         coalesce(r.relacl, acldefault(case r.relkind when 'S' then 's' else 'r' end::"char", r.relowner)) acl,
         null::boolean analyst_ok
    from rel r
  union all
  select 'column ' || r.qual || '.' || quote_ident(a.attname), r.relowner, a.attacl,
         r.relkind <> 'S' and r.relname <> all (rule.deny_tables)
           and (ty.typcategory in ('N', 'B', 'D', 'T', 'E') or ty.oid = 'pg_catalog.uuid'::regtype
                or (r.relname || '.' || a.attname) = any (rule.allow_text))
    from rel r join pg_attribute a on a.attrelid = r.oid join pg_type ty on ty.oid = a.atttypid cross join rule
   where a.attnum > 0 and not a.attisdropped and a.attacl is not null
  union all
  select 'function ' || p.oid::regprocedure::text, p.proowner, coalesce(p.proacl, acldefault('f', p.proowner)), null
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  union all
  select 'schema public', n.nspowner, coalesce(n.nspacl, acldefault('n', n.nspowner)), null
    from pg_namespace n where n.nspname = 'public'
), g as (
  select o.o, o.analyst_ok, case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end grantee,
         x.privilege_type p, bool_or(x.is_grantable) grantable
    from obj o cross join lateral aclexplode(o.acl) x
   where x.grantee <> o.own and x.grantee not in (select oid from admin)
   group by 1, 2, 3, 4
)
select line from (
  select 'priv|owner|' || o.o || '|' || case when o.own in (select oid from admin) then 'admin' else pg_get_userbyid(o.own) end line
    from obj o where o.o not like 'column %'
  union all
  select 'priv|grant|' || g.o || '|' || g.grantee || '|'
         || string_agg(g.p || case when g.grantable then '*' else '' end, ',' order by g.p)
    from g group by g.o, g.grantee
  union all
  select distinct 'roles|' || g.o from g where g.grantee = 'clics_analyst' and g.analyst_ok
) l order by 1;
select 'priv|default|' || pg_get_userbyid(g.defaclrole) || ' '
       || case g.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions'
                               when 'T' then 'types' else g.defaclobjtype::text end || '|' || g.grantee || '|'
       || string_agg(g.p || case when g.grantable then '*' else '' end, ',' order by g.p)
  from (select d.defaclrole, d.defaclobjtype, case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end grantee,
               x.privilege_type p, bool_or(x.is_grantable) grantable
          from pg_default_acl d cross join lateral aclexplode(d.defaclacl) x
         where d.defaclnamespace = 'public'::regnamespace and x.grantee <> d.defaclrole
           and x.grantee not in (select oid from pg_roles where rolsuper or rolname in ('postgres', 'supabase_admin'))
         group by 1, 2, 3, 4) g
 group by g.defaclrole, g.defaclobjtype, g.grantee order by 1;
with rel as (
  select c.oid, c.relrowsecurity, c.relforcerowsecurity, format('%I.%I', n.nspname, c.relname) qual
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
     and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
)
select line from (
  select 'priv|rls|' || r.qual || '|' || case when r.relrowsecurity then 'enabled' else 'disabled' end
         || case when r.relforcerowsecurity then ' and forced' else '' end line
    from rel r
  union all
  select 'priv|policy|' || quote_ident(p.polname) || ' on ' || r.qual || '|'
         || md5(concat_ws(E'\n', p.polcmd::text, p.polpermissive::text,
              (select string_agg(case when x = 0 then 'PUBLIC' else pg_get_userbyid(x) end, ','
                                 order by case when x = 0 then 'PUBLIC' else pg_get_userbyid(x) end)
                 from unnest(p.polroles) x),
              coalesce(pg_get_expr(p.polqual, p.polrelid), ''), coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')))
    from pg_policy p join rel r on r.oid = p.polrelid
) l order by 1;
SQL
}

report() { # report source|target
  local side=$1 cat
  cat=$(catalog_sql | q_side "$side")
  printf '%s\n' "$cat"
  { { grep '^col|' <<< "$cat" || true; } | table_sql; { grep '^seqname|' <<< "$cat" || true; } | seq_sql; audit_head_sql "$side"
    privs_sql; } | q_side "$side"
}

# ---- check: the data host against a report --------------------------------------------------------------
check() { # check REPORT_FILE -> prints the verify report, exits 1 unless it passes
  local expected=$1 present measured exposure chain chain_line
  [ -s "$expected" ] || die "no report to check against: $expected"
  # Which of the expected relations exist on the target: a missing one is a FAIL line, not a psql error.
  present=$({ grep -E '^(col|seqname)\|' "$expected" || true; } | cut -d'|' -f3 | sort -u |
    sed "s/'/''/g; s/.*/select '&' where pg_catalog.to_regclass('&') is not null;/" | q_dst)
  # ENVIRON, not -v: a -v value may not hold a newline in every awk.
  # shellcheck disable=SC2016
  local keep='BEGIN { n = split(ENVIRON["PRESENT"], a, "\n"); for (i = 1; i <= n; i++) ok[a[i]] = 1 } ok[$3]'
  measured=$({
    { grep '^col|' "$expected" || true; } | PRESENT=$present awk -F'|' "$keep" | table_sql
    { grep '^seqname|' "$expected" || true; } | PRESENT=$present awk -F'|' "$keep" | seq_sql
    privs_sql
  } | q_dst)

  # The chain: the source's head (seq, hash) is the anchor for the target's walk, so a re-chained,
  # re-stamped or cut audit_log fails even when it is internally consistent.
  chain=$({ grep '^audit_head|' "$expected" || true; } | head -1)
  case "$chain" in
    audit_head\|not_installed|audit_head\|empty|'') chain_line="$chain" ;;
    *)
      local hseq hhash
      IFS='|' read -r _ hseq hhash <<< "$chain"
      [[ "$hseq" =~ ^[0-9]+$ && "$hhash" =~ ^[0-9a-f]{64}$ ]] || die "malformed audit_head line in the report"
      if [ "$(has target 'public.audit_log_verify(bigint,text)')" != true ]; then
        chain_line="verify|false|false|0|audit_log_verify() is not on the target"
      else chain_line=$(printf "select 'verify|' || ok || '|' || coalesce(anchored, false) || '|' || checked || '|' || coalesce(reason, '') from public.audit_log_verify(%s, '%s');\n" "$hseq" "$hhash" |
        q_dst 2>&1 | tail -1) || true
      fi
      chain_line="anchor|$hseq|$hhash|$chain_line"
      ;;
  esac
  exposure=absent
  [ "$(has target 'public.postgrest_exposure()')" != true ] ||
    exposure=$(echo "select count(*) from public.postgrest_exposure();" | q_dst)

  printf '%s\n' "$measured" | awk -F'|' -v chain="$chain_line" -v want_chain="$AUDIT_CHAIN" -v exposure="$exposure" \
    -v required="${REQUIRED_TABLES[*]}" -v expected_file="$expected" '
    BEGIN {
      while ((getline line < expected_file) > 0) {
        split(line, f, "|")
        if (f[1] == "table") { erows[f[2]] = f[3]; esum[f[2]] = f[4]; order[++nt] = f[2] }
        if (f[1] == "seq") { eseq[f[2]] = f[3]; sorder[++ns] = f[2] }
        if (f[1] == "priv") { k = pkey(line); if (!(k in epriv)) porder[++np] = k; epriv[k] = pval(line) }
      }
    }
    # A priv line is its key, then "|" and its value.
    function pkey(l) { return substr(l, 1, length(l) - length(pval(l)) - 1) }
    function pval(l) { return substr(l, match(l, /[^|]*$/)) }
    function pshow(k,  f, d) {
      split(k, f, "|")
      if (f[2] == "grant") return "grant on " f[3] " to " f[4]
      if (f[2] == "default") { split(f[3], d, " "); return "default privileges of " d[1] " on " d[2] " to " f[4] }
      if (f[2] == "rls") return "row level security on " f[3]
      if (f[2] == "policy") return "policy " f[3]
      if (f[2] == "owner") return "owner of " f[3]
      return substr(k, 6)
    }
    # What roles.sql grants on the data host after the move, which no source has: clics_analyst reads the
    # columns its allow list names (the target marks them with roles lines) and uses the schema; clics_backup
    # runs audit_log_head(). Anything more for them is a difference.
    function roles_sql(k, v,  f) {
      split(k, f, "|")
      if (f[2] != "grant") return 0
      if (f[4] == "clics_analyst") return ((f[3] in analyst_ok) && v == "SELECT") || (f[3] == "schema public" && v == "USAGE")
      if (f[4] == "clics_backup") return f[3] == "function public.audit_log_head()" && v == "EXECUTE"
      return 0
    }
    $1 == "table" { arows[$2] = $3; asum[$2] = $4 }
    $1 == "seq" { aseq[$2] = $3 }
    $1 == "priv" { k = pkey($0); if (!(k in apriv)) aorder[++na] = k; apriv[k] = pval($0) }
    $1 == "roles" { analyst_ok[$2] = 1 }
    END {
      bad = 0
      printf "== CLICS database move: verify report ==\n"
      printf "%-44s %10s %10s  %s\n", "TABLE", "SOURCE", "TARGET", "CHECKSUM"
      for (i = 1; i <= nt; i++) {
        t = order[i]
        if (!(t in arows)) { printf "%-44s %10s %10s  %s\n", t, erows[t], "-", "MISSING ON TARGET"; bad++; tbad++; continue }
        s = (esum[t] == asum[t] && erows[t] == arows[t]) ? "same" : "DIFFERS"
        if (s != "same") { bad++; tbad++ }
        printf "%-44s %10s %10s  %s\n", t, erows[t], arows[t], s
      }
      printf "tables: %d compared, %d differ\n", nt, tbad + 0
      for (i = 1; i <= ns; i++) {
        q = sorder[i]
        if (!(q in aseq)) { printf "sequence %s: MISSING ON TARGET\n", q; bad++; sbad++; continue }
        if (aseq[q] + 0 < eseq[q] + 0) { printf "sequence %s: target next %s is LOWER than the source next %s\n", q, aseq[q], eseq[q]; bad++; sbad++ }
      }
      printf "sequences: %d compared, %d lower than the source or missing\n", ns, sbad + 0
      n = split(required, req, " ")
      for (i = 1; i <= n; i++) {
        if (!(req[i] in erows)) { printf "required table %s: NOT IN THE SOURCE\n", req[i]; bad++ }
        else if (!(req[i] in arows) || esum[req[i]] != asum[req[i]]) { printf "required table %s: NOT EQUAL ON THE TARGET\n", req[i]; bad++ }
      }
      printf "required tables in this report: %s\n", required
      split(chain, c, "|")
      if (chain == "audit_head|not_installed") {
        if (want_chain == "checksum" && ("public.audit_log" in arows) && esum["public.audit_log"] == asum["public.audit_log"])
          printf "audit chain: not installed on the source; replaced by public.audit_log row checksum, equal (AUDIT_CHAIN=checksum)\n"
        else if (want_chain == "checksum") { printf "audit chain: not installed on the source, and public.audit_log does not match\n"; bad++ }
        else { printf "audit chain: NOT INSTALLED on the source (audit_chain=not_installed); see README.md, Audit chain\n"; bad++ }
      } else if (chain == "audit_head|empty") {
        printf "audit chain: installed, audit_log empty on the source\n"
      } else if (c[1] == "anchor" && c[4] == "verify" && c[5] == "true" && c[6] == "true") {
        printf "audit chain: audit_log_verify passes on the target, %s rows, anchored at the source head seq %s hash %s\n", c[7], c[2], c[3]
      } else if (c[1] == "anchor") {
        printf "audit chain: audit_log_verify FAILS on the target against the source head seq %s hash %s (%s)\n", c[2], c[3], chain; bad++
      } else { printf "audit chain: no head in the report\n"; bad++ }
      if (!("priv|scope" in epriv)) { printf "privileges: NOT IN THE REPORT (an older move.sh made it?)\n"; bad++ }
      else {
        for (i = 1; i <= np; i++) {
          k = porder[i]
          policy = k ~ /^priv\|policy\|/
          if (!(k in apriv)) {
            printf "%s: MISSING ON TARGET%s\n", pshow(k), policy ? "" : " (" epriv[k] " on the source)"; pbad++
          } else if (apriv[k] != epriv[k]) {
            if (policy) printf "%s: DIFFERS (its command, roles or expressions)\n", pshow(k)
            else printf "%s: %s on the source, %s on the target\n", pshow(k), epriv[k], apriv[k]
            pbad++
          }
        }
        for (i = 1; i <= na; i++) {
          k = aorder[i]
          if (k in epriv) continue
          if (roles_sql(k, apriv[k])) { racc++; continue }
          printf "%s: NOT ON THE SOURCE%s\n", pshow(k), k ~ /^priv\|policy\|/ ? "" : " (" apriv[k] " on the target)"; pbad++
        }
        printf "privileges: %d compared (owners, grants, default privileges, row level security, policies in public), %d differ\n", np, pbad + 0
        if (racc) printf "privileges: %d more on the target are roles.sql'\''s (clics_analyst, clics_backup)\n", racc
        bad += pbad
      }
      if (exposure == "absent") { printf "postgrest_exposure: not defined on the target\n"; bad++ }
      else if (exposure != "0") { printf "postgrest_exposure: %s grants to anon/authenticated on the target (ADR 0007 wants none)\n", exposure; bad++ }
      else printf "postgrest_exposure: lists nothing on the target\n"
      printf "VERIFY: %s\n", bad ? "FAIL (" bad " problem" (bad > 1 ? "s" : "") ")" : "PASS"
      exit bad ? 1 : 0
    }'
}

# ---- the restore stream ---------------------------------------------------------------------------------
# GoTrue has already migrated the target's empty auth schema, so auth is restored data-only into GoTrue's
# own tables (a column the hosted GoTrue has and this one lacks fails here, by name), then public whole:
# schema, data, grants. The same shape as rehearsal/run.sh vm1-up.
stream() {
  local snap=() auth_skip=() t
  [ -z "$SNAPSHOT" ] || snap=(--snapshot="$SNAPSHOT")
  for t in "${AUTH_SESSION_TABLES[@]}"; do auth_skip+=(--exclude-table-data="auth.$t"); done
  echo "begin;"
  # Triggers off for the whole load. audit_log's chain trigger would otherwise renumber, re-date and
  # re-hash every row it sees inserted, and the FK triggers would check auth rows in dump order.
  echo "set session_replication_role = replica;"
  # Tables the restore creates must not pick up the image's default grants to anon and authenticated
  # (ADR 0007; db/migration-postgrest-closed.sql does the same on Supabase).
  for r in supabase_admin postgres; do for k in tables sequences functions; do
    echo "do \$\$ begin if exists (select 1 from pg_roles where rolname = '$r') and exists (select 1 from pg_roles where rolname = 'anon') then
      execute 'alter default privileges for role $r in schema public revoke all on $k from anon, authenticated'; end if; end \$\$;"
  done; done
  # pg_dump --schema leaves extensions out; the ones the source keeps in public must exist first.
  echo "select format('create extension if not exists %I with schema public;', e.extname)
          from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace where n.nspname = 'public';" | q_src
  # auth data first: adding public.professionals_id_fkey checks its rows against auth.users, and
  # session_replication_role skips triggers, not that check.
  src "$(tool_path pg_dump)" ${snap[@]+"${snap[@]}"} --no-owner --no-privileges --data-only --schema=auth --exclude-table=auth.schema_migrations \
    "${auth_skip[@]}"
  # After roles.sql has run on the source (a backup of the data host), the public dump carries grants to
  # clics_analyst and clics_backup; a fresh restore target lacks those roles. Made here without login;
  # roles.sql sets the rest.
  for r in clics_analyst clics_backup; do
    echo "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '$r') then
    create role $r nologin; end if; end \$\$;"
  done
  # The target already has the (empty) public schema, and its default ACLs hang off it: keep it.
  src "$(tool_path pg_dump)" ${snap[@]+"${snap[@]}"} --no-owner --schema=public | sed '/^CREATE SCHEMA public;$/d'
  # Every sequence in public and auth, set from the source, after pg_dump's own setval lines.
  catalog_sql | q_src | { grep '^seqname|' || true; } | while IFS='|' read -r _ _ qual; do
    printf "select format('select pg_catalog.setval(%%L, %%s, %%s);', %s, s.last_value, s.is_called::text) from %s s;\n" "$(lit "$qual")" "$qual"
  done | q_src
  echo "commit;"
}
load() { dst "$(tool_path psql)" -X -q -v ON_ERROR_STOP=1 -P pager=off >/dev/null; }

# ---- preflight ------------------------------------------------------------------------------------------
preflight() {
  local out
  out=$(echo "select 'version|' || current_setting('server_version_num') || '|' || current_setting('server_version');
              select 'ssl|' || coalesce((select ssl::text from pg_catalog.pg_stat_ssl where pid = pg_catalog.pg_backend_pid()), 'false');
              select 'sysid|' || system_identifier from pg_catalog.pg_control_system();" | q_src 2>/dev/null) ||
    out=$(echo "select 'version|' || current_setting('server_version_num') || '|' || current_setting('server_version');
                select 'ssl|' || coalesce((select ssl::text from pg_catalog.pg_stat_ssl where pid = pg_catalog.pg_backend_pid()), 'false');" | q_src) ||
    die "cannot read the source"
  local sver sssl ssys
  sver=$(awk -F'|' '$1 == "version" { print $2 }' <<< "$out")
  sssl=$(awk -F'|' '$1 == "ssl" { print $2 }' <<< "$out")
  ssys=$(awk -F'|' '$1 == "sysid" { print $2 }' <<< "$out")
  log "source: PostgreSQL $(awk -F'|' '$1 == "version" { print $3 }' <<< "$out")"
  [ "$SRC_FROM" = data-host ] || [ "$sssl" = true ] || die "the source connection is not TLS"

  out=$(echo "select 'version|' || current_setting('server_version_num') || '|' || current_setting('server_version');
              select 'sysid|' || system_identifier from pg_catalog.pg_control_system();
              select 'super|' || rolsuper::text from pg_catalog.pg_roles where rolname = current_user;
              select 'public|' || count(*) from pg_catalog.pg_class
                where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'S', 'f');
              select 'ssl|' || coalesce((select ssl::text from pg_catalog.pg_stat_ssl where pid = pg_catalog.pg_backend_pid()), 'false');
" | q_dst) || die "cannot read the data host"
  if [ "$(awk -F'|' '$1 == "ssl" { print $2 }' <<< "$out")" != true ]; then
    [ "${CLICS_DATA_PLAINTEXT_OK:-}" = 1 ] || die "the data host connection is not TLS"
    log "WARNING: the data host connection is not TLS (CLICS_DATA_PLAINTEXT_OK=1)"
  fi
  if [ "$(has target auth.users)" = true ]; then
    out="$out
auth_users|$(echo 'select count(*) from auth.users;' | q_dst)"
  else
    out="$out
auth_users|absent"
  fi
  local dver dsys
  dver=$(awk -F'|' '$1 == "version" { print $2 }' <<< "$out")
  dsys=$(awk -F'|' '$1 == "sysid" { print $2 }' <<< "$out")
  log "target: PostgreSQL $(awk -F'|' '$1 == "version" { print $3 }' <<< "$out") on ${CLICS_DATA_HOST}"
  [ -z "$ssys" ] || [ "$ssys" != "$dsys" ] || die "the source and the target are the same cluster"
  [ "$(awk -F'|' '$1 == "super" { print $2 }' <<< "$out")" = true ] ||
    die "the target user is not a superuser (session_replication_role needs one): set CLICS_DATA_USER"
  [ "$(awk -F'|' '$1 == "public" { print $2 }' <<< "$out")" = 0 ] ||
    die "the target's public schema is not empty: the move restores into a fresh database only"
  case "$(awk -F'|' '$1 == "auth_users" { print $2 }' <<< "$out")" in
    0) ;;
    absent) die "the target has no auth.users: start GoTrue against it once, so its migrations make the auth schema" ;;
    *) die "the target's auth.users is not empty" ;;
  esac
  # What the restore stream names on the target must be there first, or the load stops halfway (and rolls
  # back): every role the source's public schema grants to or makes a policy for, every extension it keeps
  # in public, and the auth functions its policies call. The supabase/postgres image has them all; plain
  # PostgreSQL needs prepare-plain-pg.sql, the extensions installed, and GoTrue's migrations run.
  local roles exts missing
  roles=$(q_src <<'SQL'
select coalesce(string_agg(distinct pg_catalog.pg_get_userbyid(g), ' '), '') from (
  select (pg_catalog.aclexplode(c.relacl)).grantee g from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relacl is not null
  union select (pg_catalog.aclexplode(a.attacl)).grantee from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
   where c.relnamespace = 'public'::regnamespace and a.attacl is not null
  union select (pg_catalog.aclexplode(p.proacl)).grantee from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proacl is not null
  union select (pg_catalog.aclexplode(n.nspacl)).grantee from pg_catalog.pg_namespace n
   where n.nspname = 'public' and n.nspacl is not null
  union select d.defaclrole from pg_catalog.pg_default_acl d where d.defaclnamespace = 'public'::regnamespace
  union select (pg_catalog.aclexplode(d.defaclacl)).grantee from pg_catalog.pg_default_acl d
   where d.defaclnamespace = 'public'::regnamespace
  union select unnest(pol.polroles) from pg_catalog.pg_policy pol join pg_catalog.pg_class c on c.oid = pol.polrelid
   where c.relnamespace = 'public'::regnamespace
) x where g <> 0 and pg_catalog.pg_get_userbyid(g) <> 'clics_analyst';
SQL
)
  exts=$(echo "select coalesce(string_agg(e.extname, ' ' order by e.extname), '') from pg_catalog.pg_extension e
                 where e.extnamespace = 'public'::regnamespace;" | q_src)
  # auth is restored data-only into GoTrue's tables, and pg_dump writes every column of every table, an
  # empty one too: a column the hosted GoTrue has and the target's GoTrue lacks stops the load. So every
  # source auth column must exist on the target (a target column the source lacks is fine: it takes its
  # default). An older GoTrue on the target is the usual cause.
  local list cols
  list=$(printf "'%s', " "${AUTH_SESSION_TABLES[@]}"); list=${list%, }
  cols=$(q_src <<SQL
select coalesce(string_agg(pg_catalog.quote_literal(c.relname || '.' || a.attname), ', ' order by c.relname, a.attnum), '')
  from pg_catalog.pg_class c
  join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
 where c.relnamespace = 'auth'::regnamespace and c.relkind = 'r'
   and c.relname not in ('schema_migrations', $list)
   and not exists (select 1 from pg_catalog.pg_depend d
                    where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');
SQL
)
  # shellcheck disable=SC2086 # word lists
  missing=$({
    for r in $roles; do echo "select $(lit "role $r") where pg_catalog.to_regrole($(lit "\"$r\"")) is null;"; done
    for e in $exts; do echo "select 'extension $e' where not exists (select 1 from pg_catalog.pg_available_extensions where name = $(lit "$e"));"; done
    for f in 'auth.uid()' 'auth.role()'; do echo "select 'function $f' where pg_catalog.to_regprocedure($(lit "$f")) is null;"; done
    # Not named by the restore, but PostgREST's search path (../docker-compose.auth.yml) is: without it
    # PostgREST loads no schema cache and the backend gets no database at all once it points here.
    echo "select 'schema extensions (PostgREST searches it)' where pg_catalog.to_regnamespace('extensions') is null;"
    [ -z "$cols" ] || echo "select 'auth column ' || v || ' (an older GoTrue on the target?)' from unnest(array[$cols]::text[]) v
      where not exists (select 1 from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
                         where c.relnamespace = 'auth'::regnamespace and c.relname = split_part(v, '.', 1)
                           and a.attname = split_part(v, '.', 2) and a.attnum > 0 and not a.attisdropped);"
  } | q_dst | paste -sd ',' - | sed 's/,/, /g')
  [ -z "$missing" ] || die "the target lacks what the restore or PostgREST needs: $missing (plain PostgreSQL: README.md, Plain PostgreSQL target)"
  (( dver / 10000 >= sver / 10000 )) || die "the target's PostgreSQL ($dver) is older than the source's ($sver)"
  local pgd
  pgd=$("$(tool_path pg_dump)" --version | sed -n 's/.* \([0-9][0-9]*\)\..*/\1/p')
  (( pgd >= sver / 10000 )) || die "pg_dump $pgd is older than the source server ($sver)"
  out=$(echo "select string_agg(t, ' ') from unnest(array[$(printf "'%s'," "${REQUIRED_TABLES[@]}" | sed 's/,$//')]) t
                where pg_catalog.to_regclass(t) is null;
              $(audit_head_sql source)" | q_src)
  [ -z "$(head -1 <<< "$out")" ] || die "the source lacks: $(head -1 <<< "$out")"
  if [ "$(tail -1 <<< "$out")" = audit_head\|not_installed ] && [ "$AUDIT_CHAIN" = required ]; then
    die "the source has no audit_log chain (audit_chain=not_installed): apply it first or set AUDIT_CHAIN=checksum (README.md, Audit chain)"
  fi
  log "preflight ok"
}

# ---- backup and restore drill -----------------------------------------------------------------------------
# The nightly backup is the data host's own restore stream, read in ONE exported snapshot, with that
# snapshot's report carried inside it as `-- clics-report ` comment lines (psql skips them). A drill
# restores the stream into a throwaway data host and checks it against the report it carries.
# Export one snapshot of the source and hold it open (a session left in its transaction) until
# snapshot_close, so every later read of the source (pg_dump --snapshot, q_src) sees the same moment.
SNAP_DIR='' SNAP_PID=''
snapshot_open() {
  SNAP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/db-move-snap.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$SNAP_DIR'" EXIT
  mkfifo "$SNAP_DIR/in"
  src "$(tool_path psql)" -X -q -At -v ON_ERROR_STOP=1 < "$SNAP_DIR/in" > "$SNAP_DIR/out" 2> "$SNAP_DIR/err" &
  SNAP_PID=$!
  exec 4> "$SNAP_DIR/in"
  echo "begin isolation level repeatable read read only; select pg_catalog.pg_export_snapshot();" >&4
  for _ in $(seq 1 300); do [ -s "$SNAP_DIR/out" ] && break; kill -0 "$SNAP_PID" 2>/dev/null || break; sleep 0.1; done
  SNAPSHOT=$(head -1 "$SNAP_DIR/out")
  [[ "$SNAPSHOT" =~ ^[0-9A-Fa-f-]+$ ]] || die "could not export a snapshot from the source: $(cat "$SNAP_DIR/err")"
  log "source snapshot $SNAPSHOT"
}
snapshot_close() {
  echo "commit;" >&4
  exec 4>&-
  wait "$SNAP_PID" || die "the snapshot session failed: $(cat "$SNAP_DIR/err")"
}
backup() {
  [ -p /dev/stdout ] || die "backup writes to a pipe only (into the encryption), never to a file or a terminal"
  SRC_FROM=data-host
  snapshot_open
  report source | sed 's/^/-- clics-report /'
  stream
  snapshot_close
}
drill() {
  [ ! -t 0 ] || die "drill reads a decrypted backup stream on stdin"
  local rep tver
  rep=$(mktemp "${TMPDIR:-/tmp}/db-move-report.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -f '$rep'" RETURN
  tver=$(echo "select current_setting('server_version_num');" | q_dst) || die "cannot read the drill database"
  # A backup restores into its own PostgreSQL major version or a newer one, never an older one (PostgreSQL does
  # not support that). pg_dump names the source's version in a comment before the first row; an older drill
  # database stops the stream there, and the load's transaction ends without its commit, so nothing stays.
  awk -v f="$rep" -v tmaj="$(( tver / 10000 ))" '
    index($0, "-- clics-report ") == 1 { print substr($0, 17) > f }
    !seen && index($0, "-- Dumped from database version ") == 1 {
      seen = 1; smaj = int(substr($0, 33) + 0)
      if (smaj > tmaj) {
        printf "[db-move] ERROR: the backup comes from PostgreSQL %d and this drill database runs %d: restore it into %d or newer\n", smaj, tmaj, smaj > "/dev/stderr"
        exit 3
      }
    }
    { print }' | load
  grep -q '^table|' "$rep" || die "the stream carries no report: is it a backup.sh stream?"
  check "$rep"
}

verify() {
  local rep
  rep=$(mktemp "${TMPDIR:-/tmp}/db-move-report.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -f '$rep'" RETURN
  report source > "$rep"
  check "$rep"
}

cmd=${1:-}
# The password line follows the URL, so only a command that reads the URL can take it from stdin.
if [ "$CLICS_DATA_PASSWORD" = stdin ]; then
  [ "$SRC_FROM" = stdin ] || die "CLICS_DATA_PASSWORD=stdin needs the URL on stdin (SRC_FROM=stdin)"
  case "$cmd ${2:-}" in
    'preflight '*|'move '*|'verify '*|'report source'|'dump '*) ;;
    *) die "CLICS_DATA_PASSWORD=stdin works with preflight, move, verify, report source and dump only" ;;
  esac
fi
case "$cmd" in
  preflight) read_source; preflight ;;
  move)
    read_source
    preflight
    # One source snapshot for the dump and the report: a write to Supabase during the move (a browser's
    # token refresh, say) can then neither split the dump nor make the report differ from what was copied.
    # Needs a session (not a transaction-mode pooler) connection, as every source read here does.
    snapshot_open
    log "streaming: auth (data), then public (schema, data, grants), triggers off, in one transaction"
    stream | load
    log "restored; verifying against the same snapshot"
    verify
    snapshot_close
    ;;
  verify) read_source; verify ;;
  report)
    case "${2:-}" in
      source) read_source; report source ;;
      target) report target ;;
      *) die "usage: move.sh report source|target" ;;
    esac
    ;;
  check) [ -n "${2:-}" ] || die "usage: move.sh check REPORT_FILE"; check "$2" ;;
  dump)
    # A pipe only: a dump redirected into a file would put participant data on a disk in clear.
    [ -p /dev/stdout ] || die "dump writes to a pipe only (encrypt it, or load it), never to a file or a terminal"
    read_source
    stream
    ;;
  load) [ ! -t 0 ] || die "load reads a restore stream on stdin"; load ;;
  backup) backup ;;
  drill) drill ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64 ;;
esac
