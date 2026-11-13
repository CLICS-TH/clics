#!/bin/bash
# Drives the sign-in rehearsal (#427). README.md in this directory says when to run which command.
#
#   rehearsal/run.sh hermetic            synthetic data, mail captured by mailpit: CI and a laptop with docker
#   rehearsal/run.sh vm1-env ENV_DIR     vm1: fresh secrets for the rehearsal stack into a root-only ENV_DIR
#   rehearsal/run.sh vm1-up ENV_DIR      vm1: database, roles, restore from Supabase (URL on stdin), then the stack
#   rehearsal/run.sh vm1-paths ENV_DIR   vm1: replay the sign-in paths against it
#   rehearsal/run.sh down [ENV_DIR]      stop and remove the rehearsal project; the tmpfs database goes with it
#
# Everything runs under the compose project `clics-rehearsal`, never `clics`. The rehearsal backend has no host
# port, so the live backend on 127.0.0.1:3101 is never touched. Prints no secret.
# The single-quoted `sh -c` scripts expand inside the db container, on its own POSTGRES_PASSWORD and stdin.
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=clics-rehearsal
log() { echo "[rehearsal] $*"; }
die() { echo "[rehearsal] ERROR: $*" >&2; exit 1; }
dc() {
  docker compose -p "$PROJECT" -f docker-compose.yml -f docker-compose.auth.yml \
    -f rehearsal/docker-compose.rehearsal.yml "$@"
}

# supabase/postgres creates the API and auth roles without a usable password; the stack logs in as two of
# them. The password goes in on stdin, never on a command line.
set_role_passwords() {
  dc exec -T db sh -c 'for r in authenticator supabase_auth_admin; do
      echo "alter role $r with login password '"'"'$POSTGRES_PASSWORD'"'"';"
    done | psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -X -q'
}

# The db container must not swap (mem_limit = memswap_limit in docker-compose.rehearsal.yml): its tmpfs holds
# the restored copy, and swap is disk. Read from the running container, before any data is loaded, so a kernel
# that does not enforce the limit stops the rehearsal instead of trusting the compose text.
assert_no_swap() {
  local max
  max=$(dc exec -T db cat /sys/fs/cgroup/memory.swap.max) || die "db has no cgroup v2 memory.swap.max: swap cannot be ruled out"
  [ "$max" = 0 ] || die "db may swap (memory.swap.max is '$max'): a restored copy could reach vm1's disk"
  log "db cannot swap (memory.swap.max 0)"
}

up_db() {
  dc up -d --wait --wait-timeout 180 db
  assert_no_swap
  set_role_passwords
}

# The auth services, then the backend on its own (rimpl is not part of a sign-in rehearsal).
up_stack() {
  dc up -d --wait --wait-timeout 180 gotrue
  [ "${1:-}" = schema ] && load_schema
  dc up -d --wait --wait-timeout 180 postgrest supabase-gw
  dc up -d --no-deps --wait --wait-timeout 180 backend
}

# Hermetic only: the repo's schema over GoTrue's auth tables, then PostgREST re-reads it.
load_schema() {
  log "loading db/schema.sql"
  dc exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -X -q < ../../db/schema.sql
}

paths() { # [extra docker run args...]
  dc run --rm --no-deps -T -v "$PWD/rehearsal/auth-paths.mjs:/paths.mjs:ro" \
    -e "API_EXTERNAL_URL=$(sed -n 's/^API_EXTERNAL_URL=//p' "$CLICS_ENV_DIR/gotrue.env")" "$@" backend node /paths.mjs
}

# Hermetic only, after the replay: GoTrue fails one mail send (mailpit is stopped) and refuses one client's
# repeated wrong codes and passwords (failure-probes.mjs), then no auth container's log may name an address. Every replay account is @rehearsal.invalid, so this also covers every request the
# replay made through supabase-gw (R5: json-file logs sit on vm1's disk).
assert_logs_clean() {
  dc stop mailpit >/dev/null 2>&1
  dc run --rm --no-deps -T -v "$PWD/rehearsal/failure-probes.mjs:/failure-probes.mjs:ro" backend node /failure-probes.mjs
  local hits
  hits=$(dc logs --no-log-prefix gotrue postgrest supabase-gw 2>&1 | grep -c 'rehearsal\.invalid' || true)
  [ "$hits" = 0 ] || die "the auth containers logged $hits line(s) naming a synthetic address (R5)"
  log "no auth container log names an address"
}

# What a running rehearsal exposes (R1-R4, ADR 0007): no host port at all, GoTrue's included (its loopback
# port is reset in the rehearsal, see docker-compose.rehearsal.yml), and every auth container non-root with a
# read-only root. Run against the live containers, so it checks docker's own view; the compose text, and
# GoTrue's 127.0.0.1:3102 outside a rehearsal, are scripts/deploy/vm1-auth.test.mjs's.
assert_surface() {
  local svc id bound user
  for svc in gotrue postgrest supabase-gw backend db; do
    id=$(dc ps -q "$svc")
    bound=$(docker inspect -f '{{range $p, $v := .NetworkSettings.Ports}}{{if $v}}{{$p}} {{end}}{{end}}' "$id")
    [ -z "$bound" ] || die "$svc publishes host ports: $bound"
    [ "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$id")" = 0 ] || die "$svc has port bindings"
  done
  for svc in gotrue postgrest supabase-gw; do
    id=$(dc ps -q "$svc")
    user=$(docker inspect -f '{{.Config.User}}' "$id")
    [ "$user" = "$CLICS_UID:$CLICS_GID" ] || die "$svc runs as '$user', not the clics uid"
    [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$id")" = true ] || die "$svc root filesystem is writable"
    [ "$(docker inspect -f '{{.HostConfig.SecurityOpt}}' "$id")" = "[no-new-privileges:true]" ] || die "$svc lacks no-new-privileges"
    [ "$(docker inspect -f '{{.HostConfig.CapDrop}}' "$id")" = "[ALL]" ] || die "$svc keeps capabilities"
  done
  # A write only a read-only root can refuse (postgrest's image has no shell, docker's flag above covers it).
  for svc in gotrue supabase-gw; do
    [ "$(dc exec -T "$svc" id -u)" = "$CLICS_UID" ] || die "$svc is not running as the clics uid"
    dc exec -T "$svc" sh -c 'touch /tmp/probe' || die "$svc cannot write its tmpfs /tmp"
    if dc exec -T "$svc" sh -c 'touch /var/tmp/probe /probe' 2>/dev/null; then die "$svc root filesystem accepts writes"; fi
  done
  log "surface ok: no rehearsal container publishes a host port; gotrue, postgrest and supabase-gw non-root with read-only roots"
}

# auth-role-keys.cjs in the backend's own base image, with no network: vm1's host has no node of its own.
mint_role_keys() {
  docker run --rm -i --network none "$(sed -n 's/^FROM \([^ ]*\).*/\1/p' backend.Dockerfile | head -n 1)" \
    node -e "$(cat auth-role-keys.cjs)" < "$1"
}

# Env files for a throwaway stack: fresh secrets, the role keys minted from them, nothing reused.
hermetic_env() {
  local d=$1 jwt db
  jwt=$(openssl rand -base64 48 | tr -d '\n')
  db=$(openssl rand -hex 24)
  umask 077
  cat > "$d/gotrue.env" <<EOF
GOTRUE_JWT_SECRET=$jwt
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:$db@db:5432/postgres
GOTRUE_SMTP_PASS=unused
GOTRUE_EXTERNAL_GOOGLE_SECRET=rehearsal-not-a-secret
API_EXTERNAL_URL=http://localhost:3102
GOTRUE_JWT_ISSUER=http://localhost:3102/auth/v1
GOTRUE_JWT_EXP=3600
GOTRUE_SITE_URL=http://portal.rehearsal.invalid
GOTRUE_URI_ALLOW_LIST=http://portal.rehearsal.invalid/auth/callback,http://portal.rehearsal.invalid/reset
GOTRUE_SMTP_HOST=mailpit
GOTRUE_SMTP_PORT=1025
GOTRUE_SMTP_USER=rehearsal
GOTRUE_SMTP_ADMIN_EMAIL=noreply@rehearsal.invalid
GOTRUE_SMTP_SENDER_NAME=CLICS
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=rehearsal.apps.googleusercontent.com
GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI=http://localhost:3102/callback
GOTRUE_MAILER_OTP_LENGTH=6
GOTRUE_MAILER_OTP_EXP=3600
EOF
  printf 'PGRST_JWT_SECRET=%s\nPGRST_DB_URI=postgres://authenticator:%s@db:5432/postgres\n' "$jwt" "$db" > "$d/postgrest.env"
  {
    echo "SUPABASE_URL=http://supabase-gw:8080"
    mint_role_keys "$d/gotrue.env"
    echo "INTERNAL_TOKEN=$(openssl rand -hex 24)"
    echo "GUEST_TOKEN_SECRET=$(openssl rand -hex 24)"
    echo "IDENTITY_ENC_KEY=$(openssl rand -hex 32)"
    echo "ALLOWED_ORIGINS=http://portal.rehearsal.invalid"
    echo "SITE_URL=http://portal.rehearsal.invalid"
    echo "LICENSE_VERIFIER_ADAPTER=manual"
    echo "RECONCILE_INTERVAL_MS=0"
    echo "OAUTH_ENABLED=true"
  } > "$d/backend.env"
  : > "$d/rimpl.env"
  echo "REHEARSAL_DB_PASSWORD=$db" > "$d/db.secret"
}

export_env() { # <env dir>: what the compose files interpolate
  CLICS_ENV_DIR=$1
  CLICS_RELEASE=${CLICS_RELEASE:-rehearsal}
  # The host's clics user where there is one (vm1, R1), else whoever runs this (a laptop, CI sets its own).
  CLICS_UID=${CLICS_UID:-$(id -u clics 2>/dev/null || id -u)}
  CLICS_GID=${CLICS_GID:-$(id -g clics 2>/dev/null || id -g)}
  REHEARSAL_DB_PASSWORD=$(sed -n 's/^REHEARSAL_DB_PASSWORD=//p' "$1/db.secret" 2>/dev/null || echo unused)
  export CLICS_ENV_DIR CLICS_RELEASE CLICS_UID CLICS_GID REHEARSAL_DB_PASSWORD
}

case "${1:-}" in
  hermetic)
    ENV_DIR=$(mktemp -d)
    # KEEP=1 leaves the stack up for a look (`run.sh down` removes it); otherwise it goes when this exits.
    if [ -z "${KEEP:-}" ]; then
      trap 'dc --profile mail down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$ENV_DIR"' EXIT
    else
      log "KEEP=1: env in $ENV_DIR"
    fi
    hermetic_env "$ENV_DIR"
    export_env "$ENV_DIR"
    [ -n "${SKIP_BUILD:-}" ] || dc build backend
    dc --profile mail up -d mailpit
    up_db
    up_stack schema
    assert_surface
    paths -e MAILPIT_URL=http://mailpit:8025
    assert_logs_clean
    ;;
  vm1-env)
    # Fresh secrets for a rehearsal on vm1, as for the hermetic run: nothing is reused from production. The
    # directory must exist, owned by root, mode 700.
    [ -d "${2:-}" ] || die "usage: run.sh vm1-env ENV_DIR (an existing root-only directory)"
    hermetic_env "$2"
    log "env written to $2"
    ;;
  vm1-up)
    [ -n "${2:-}" ] || die "usage: run.sh vm1-up ENV_DIR < supabase-db-url"
    # Read before anything else: every `docker compose exec` below forwards this script's stdin.
    IFS= read -r SRC_URL || die "no database URL on stdin"
    export_env "$2"
    # A failure must not leave a partial copy of production running: unless the step reaches its end, the
    # whole project goes down on exit, whether it failed through set -e or through die.
    UP_OK=
    trap '[ -n "$UP_OK" ] || { log "vm1-up did not finish: removing the rehearsal project"; dc --profile mail down -v --remove-orphans; }' EXIT
    [ -n "${SKIP_BUILD:-}" ] || dc build backend
    dc --profile mail up -d mailpit
    up_db
    # GoTrue first: its own migrations make the auth tables, and auth is restored data-only into them, so a
    # column the hosted GoTrue has and this one lacks fails the restore loudly.
    dc up -d --wait --wait-timeout 180 gotrue
    log "restoring from Supabase: auth (data), then public (schema, data, grants), triggers off; the URL is read from stdin"
    # Tables the restore creates must not pick up the image's default grants to anon and authenticated
    # (db/migration-postgrest-closed.sql does the same on Supabase, ADR 0007). The dump runs inside the db
    # container and streams into its psql, so no copy of it reaches a disk: not vm1's (the database is
    # tmpfs) and not a laptop's.
    printf '%s\n' "$SRC_URL" | dc exec -T db bash -c 'set -euo pipefail; read -r SRC
      # The URL is split into libpq variables, set only on the two source commands, so it is never in
      # any argv (ps). %XX escapes in the user or password are decoded.
      re="^postgres(ql)?://([^:@/]+):([^@]*)@([^:/?]+)(:([0-9]+))?/([^?]+)(\?(.*))?$"
      [[ $SRC =~ $re ]] || { echo "the source is not a postgres://user:password@host[:port]/db URL" >&2; exit 64; }
      dec() { local v=${1//+/ }; printf "%b" "${v//%/\\x}"; }
      SU=$(dec "${BASH_REMATCH[2]}") SP=$(dec "${BASH_REMATCH[3]}") SH=${BASH_REMATCH[4]} SPORT=${BASH_REMATCH[6]:-5432}
      SDB=${BASH_REMATCH[7]} SSL=$(sed -n "s/.*sslmode=\([a-z-]*\).*/\1/p" <<< "${BASH_REMATCH[9]}")
      unset SRC
      src() { PGUSER=$SU PGPASSWORD=$SP PGHOST=$SH PGPORT=$SPORT PGDATABASE=$SDB PGSSLMODE=${SSL:-prefer} "$@"; }
      {
        echo "set session_replication_role = replica;"
        for r in supabase_admin postgres; do for k in tables sequences functions; do
          echo "alter default privileges for role $r in schema public revoke all on $k from anon, authenticated;"
        done; done
        # pg_dump --schema leaves extensions out; the ones the source keeps in public must exist first.
        src psql -AtX -c "select format('"'"'create extension if not exists %I with schema public;'"'"', e.extname)
          from pg_extension e join pg_namespace n on n.oid = e.extnamespace where n.nspname = '"'"'public'"'"'"
        # auth data first: adding public.professionals_id_fkey checks its rows against auth.users, and
        # session_replication_role skips triggers, not that check.
        src pg_dump --no-owner --no-privileges --data-only --schema=auth --exclude-table=auth.schema_migrations
        # The image already has the (empty) public schema, and its default ACLs hang off it: keep it.
        src pg_dump --no-owner --schema=public | sed "/^CREATE SCHEMA public;$/d"
      } | psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -X -q >/dev/null'
    unset SRC_URL
    users=$(dc exec -T db psql -U supabase_admin -d postgres -AtX -c 'select count(*) from auth.users')
    [ "$users" -gt 0 ] || die "the restore left auth.users empty"
    log "restored: $users auth users, $(dc exec -T db psql -U supabase_admin -d postgres -AtX -c 'select count(*) from public.professionals') professionals"
    dc up -d --wait --wait-timeout 180 postgrest supabase-gw
    dc up -d --no-deps --wait --wait-timeout 180 backend
    assert_surface
    UP_OK=1
    log "up: replay with run.sh vm1-paths $2"
    ;;
  vm1-paths)
    [ -n "${2:-}" ] || die "usage: run.sh vm1-paths ENV_DIR"
    export_env "$2"
    extra=()
    for f in old-passwords.tsv hosted-settings.json; do
      [ -f "$2/$f" ] && extra+=(-v "$2/$f:/rehearsal/$f:ro")
    done
    [ -f "$2/old-passwords.tsv" ] && extra+=(-e OLD_PASSWORDS=/rehearsal/old-passwords.tsv)
    [ -f "$2/hosted-settings.json" ] && extra+=(-e HOSTED_SETTINGS=/rehearsal/hosted-settings.json)
    paths -e MAILPIT_URL=http://mailpit:8025 "${extra[@]}"
    ;;
  down)
    if [ -n "${2:-}" ]; then export_env "$2"; else export_env "$(mktemp -d)"; fi
    dc --profile mail down -v --remove-orphans
    ;;
  *) die "usage: run.sh hermetic | vm1-env ENV_DIR | vm1-up ENV_DIR | vm1-paths ENV_DIR | down [ENV_DIR]" ;;
esac
