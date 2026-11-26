#!/usr/bin/env bash
# deploy/data-host/setup.sh: set up and check the CLICS data host on cme-dev (ADR 0012, #432). Run as root
# on cme-dev, from the release directory (/opt/clics-data/current/deploy/data-host). README.md is the
# order; every step prints what it did and stops on the first problem.
#
#   setup.sh volume DEVICE          LUKS2 on a whole disk CME gave for it (erases DEVICE), opened and mounted
#   setup.sh volume-file PATH GB    the same on a file of GB gigabytes (when there is no separate disk)
#   setup.sh open DEVICE|PATH       after a reboot: unlock (passphrase prompt) and mount, nothing else
#   setup.sh close                  stop the container, unmount, lock
#   setup.sh start                  start the server (after open)
#   setup.sh reload                 the server re-reads pg_hba.conf and postgresql.conf
#   setup.sh logs [--since 10m]     the server's log (connections and refusals; no row, no statement)
#   setup.sh tls NAME ADDRESS       the server certificate (self-signed, NAME and ADDRESS in its SAN)
#   setup.sh hba VM1_ADDRESS        pg_hba.conf for vm1's tailnet address, and postgresql.conf
#   setup.sh init                   first start: initdb, superuser password set to NULL, prepare-plain-pg.sql
#   setup.sh psql                   psql as the superuser, through the container's socket (\password ROLE)
#   setup.sh lock                   the superuser's password back to NULL (after the move window)
#   setup.sh check                  the post-check: prints one line per fact, exits 1 if any is wrong
#
# The LUKS passphrase is typed at cryptsetup's own prompt, never on a command line or in a file. Paths can
# be moved for a local test only: CLICS_DATA_ROOT (default /srv/clics-data), CLICS_DATA_ENV (default
# /opt/clics-data/env/data.env).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=${CLICS_DATA_ROOT:-/srv/clics-data}
ENV_FILE=${CLICS_DATA_ENV:-/opt/clics-data/env/data.env}
MAPPER=clics-data
PROJECT=clics-data
SERVICE=clics-mentor-postgres
PG_UID=999

die() { echo "setup.sh: $*" >&2; exit 1; }
say() { echo "== $*"; }

compose() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE (CLICS_DATA_BIND=...)"
  CLICS_DATA_ROOT=$ROOT docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$HERE/docker-compose.yml" "$@"
}
psql_su() {  # the superuser through the socket inside the container: peer auth, no password anywhere.
  # Without -f -, give it </dev/null: `compose exec -T` forwards stdin and would eat a piped script.
  compose exec -T -u postgres "$SERVICE" psql -X -v ON_ERROR_STOP=1 -d clics_mentor "$@"
}

make_dirs() {
  install -d -o "$PG_UID" -g "$PG_UID" -m 700 "$ROOT/pg" "$ROOT/pg/bootstrap" &&
    install -d -o root -g "$PG_UID" -m 750 "$ROOT/conf"
}

# Every step returns on failure by itself (set -e does not hold inside a function called from `||`), so
# make_dirs never runs unless the encrypted volume is mounted.
luks_format_mount() {  # $1: a block device (a disk, or a loop device over the volume file)
  local dev=$1
  say "LUKS2 on $dev: cryptsetup asks for YES, then the passphrase twice to format and once to open"
  cryptsetup luksFormat --type luks2 --verify-passphrase "$dev" || return 1
  cryptsetup open "$dev" "$MAPPER" || return 1
  mkfs.ext4 -q -L clics-data "/dev/mapper/$MAPPER" || return 1
  install -d -m 755 "$ROOT" || return 1
  mount "/dev/mapper/$MAPPER" "$ROOT" || return 1
  make_dirs || return 1
  say "mounted $ROOT on /dev/mapper/$MAPPER"
}
undo_format() {  # after a failed luks_format_mount: unmount and lock what it opened; $1: a loop to detach
  ! findmnt -rn "$ROOT" >/dev/null || umount "$ROOT" || true
  ! cryptsetup status "$MAPPER" >/dev/null 2>&1 || cryptsetup close "$MAPPER" || true
  [ -z "${1:-}" ] || losetup -d "$1" || true
}

cmd_volume() {
  local dev=${1:?usage: setup.sh volume DEVICE}
  [ -b "$dev" ] || die "$dev is not a block device"
  ! findmnt -rn -S "$dev" >/dev/null || die "$dev is mounted"
  echo "This ERASES everything on $dev. Type the device path again to go on:"
  read -r again; [ "$again" = "$dev" ] || die "not confirmed"
  luks_format_mount "$dev" || { undo_format; die "setting up $dev failed: nothing is mounted"; }
}

cmd_volume_file() {
  local file=${1:?usage: setup.sh volume-file PATH GB} gb=${2:?usage: setup.sh volume-file PATH GB} loop
  [[ $gb =~ ^[0-9]+$ ]] || die "GB must be a whole number"
  [ ! -e "$file" ] || die "$file exists already"
  # The directory must exist already: `install -d -m` would also change the mode of an existing one
  # (/var/lib to 700, on a host other services share).
  [ -d "$(dirname "$file")" ] || die "$(dirname "$file") does not exist"
  fallocate -l "${gb}G" "$file"; chmod 600 "$file"
  loop=$(losetup --find --show "$file")
  luks_format_mount "$loop" ||
    { undo_format "$loop"; die "setting up $file failed: nothing is mounted; delete $file before trying again"; }
}

cmd_open() {
  local src=${1:?usage: setup.sh open DEVICE|PATH} loop=''
  ! findmnt -rn "$ROOT" >/dev/null || die "$ROOT is mounted already"
  if [ -f "$src" ]; then loop=$(losetup --find --show "$src"); src=$loop; fi
  cryptsetup open "$src" "$MAPPER" || { undo_format "$loop"; die "not unlocked (a wrong passphrase?)"; }
  mount "/dev/mapper/$MAPPER" "$ROOT" || { undo_format "$loop"; die "unlocked, but $ROOT did not mount"; }
  say "mounted $ROOT; start the server with: setup.sh start"
}

# Whatever state it finds (running, mounted, open, or only part of that), it ends locked.
cmd_close() {
  [ ! -f "$ENV_FILE" ] || compose down
  ! findmnt -rn "$ROOT" >/dev/null || umount "$ROOT"
  if cryptsetup status "$MAPPER" >/dev/null 2>&1; then
    local back; back=$(cryptsetup status "$MAPPER" | awk '$1 == "device:" {print $2}')
    cryptsetup close "$MAPPER"
    case "$back" in /dev/loop*) losetup -d "$back" ;; esac
  fi
  say "closed: $ROOT unmounted, $MAPPER locked"
}

cmd_tls() {
  local name=${1:?usage: setup.sh tls NAME ADDRESS} addr=${2:?usage: setup.sh tls NAME ADDRESS}
  [ -d "$ROOT/conf" ] || die "$ROOT/conf missing: open the volume first"
  local key="$ROOT/conf/server.key" crt="$ROOT/conf/server.crt"
  [ ! -e "$key" ] || die "$key exists: delete it first to make a new one"
  ( umask 077
    openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 -subj "/CN=$name" \
      -addext "subjectAltName=DNS:$name,IP:$addr" -addext "basicConstraints=critical,CA:TRUE" \
      -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign" \
      -keyout "$key" -out "$crt" 2>/dev/null )
  chown "$PG_UID:$PG_UID" "$key"; chmod 600 "$key"
  chown root:"$PG_UID" "$crt"; chmod 644 "$crt"
  say "certificate for $name / $addr, valid 825 days. vm1 trusts exactly this certificate:"
  openssl x509 -in "$crt" -noout -fingerprint -sha256 -enddate
  echo "Copy $crt (not the key) to vm1 as /etc/clics/data-ca.crt and /opt/clics/backup/data-ca.crt:"
  echo "the move and the nightly backup check the server against it (sslmode=verify-full)."
}

cmd_hba() {
  local vm1=${1:?usage: setup.sh hba VM1_ADDRESS}
  [[ $vm1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "VM1_ADDRESS must be one IPv4 address"
  [ -d "$ROOT/conf" ] || die "$ROOT/conf missing: open the volume first"
  sed "s#VM1/32#$vm1/32#g" "$HERE/pg_hba.conf.template" > "$ROOT/conf/pg_hba.conf"
  ! grep -qE '^[^#]*VM1' "$ROOT/conf/pg_hba.conf" || die "pg_hba.conf still names VM1"
  install -m 644 "$HERE/postgresql.conf" "$ROOT/conf/postgresql.conf"
  chown root:"$PG_UID" "$ROOT/conf/pg_hba.conf" "$ROOT/conf/postgresql.conf"
  chmod 640 "$ROOT/conf/pg_hba.conf"
  say "pg_hba.conf allows $vm1 only; a running server reads it after: setup.sh reload"
}

cmd_init() {
  for f in postgresql.conf pg_hba.conf server.crt server.key; do
    [ -f "$ROOT/conf/$f" ] || die "missing $ROOT/conf/$f (setup.sh tls, setup.sh hba)"
  done
  [ ! -e "$ROOT/pg/18" ] || die "$ROOT/pg/18 exists: the cluster is initialised already"
  local boot="$ROOT/pg/bootstrap/superuser"
  ( umask 077; openssl rand -base64 33 | tr -d '\n' > "$boot" )
  chown "$PG_UID:$PG_UID" "$boot"; chmod 400 "$boot"
  compose up -d --wait
  psql_su -c "alter role postgres password null" >/dev/null </dev/null
  : > "$boot"   # the image reads the file on every start, so it stays, empty
  say "initialised; the superuser has no password (only peer, inside the container)"
  psql_su -f - < "$HERE/../vm1/db-move/prepare-plain-pg.sql"
  say "prepare-plain-pg.sql applied. Now, at psql's prompt (README.md), set authenticator's and"
  say "supabase_auth_admin's passwords: setup.sh psql, then \\password authenticator, \\password supabase_auth_admin"
}

cmd_check() {
  local bad=0
  ok()   { echo "ok    $*"; }
  fail() { echo "FAIL  $*"; bad=1; }
  is()   { if [ "$1" = "$2" ]; then ok "$3"; else fail "$4"; fi; }  # is GOT WANT OK_TEXT FAIL_TEXT
  local src; src=$(findmnt -rn -o SOURCE "$ROOT" || true)
  if [ "$src" = "/dev/mapper/$MAPPER" ] && cryptsetup status "$MAPPER" 2>/dev/null | grep -q 'type: *LUKS2'; then
    ok "$ROOT is on LUKS2 ($MAPPER)"
  else fail "$ROOT is not mounted from a LUKS2 mapping (source: ${src:-none})"; fi
  local bind; bind=$(sed -n 's/^CLICS_DATA_BIND=//p' "$ENV_FILE" | tail -1)
  local listen; listen=$(ss -Hltn 'sport = :5432' | awk '{print $4}' | sort -u | tr '\n' ' ')
  if [ -n "$bind" ] && [ "$listen" = "$bind:5432 " ]; then ok "port 5432 listens on $bind only"
  else fail "port 5432 listens on: ${listen:-nothing} (want $bind:5432 only)"; fi
  local q
  q=$(psql_su -At -c "select current_setting('server_version_num'), current_setting('ssl'),
        (select default_version from pg_available_extensions where name = 'vector'),
        (select rolpassword is null from pg_authid where rolname = 'postgres'),
        (select string_agg(datname, ',' order by datname) from pg_database where not datistemplate),
        (select count(*) from pg_hba_file_rules where error is not null),
        (select string_agg(distinct type, ',') from pg_hba_file_rules where type like 'host%' and auth_method <> 'reject')" \
  </dev/null) || { fail "the server does not answer"; return 1; }
  IFS='|' read -r ver ssl vec nopw dbs hbaerr hosttypes <<< "$q"
  is "$ver" 180007 "PostgreSQL 18.7" "PostgreSQL server_version_num $ver (want 180007, 18.7)"
  is "$ssl" on "ssl on" "ssl $ssl"
  is "$vec" 0.8.7 "pgvector $vec available" "pgvector ${vec:-missing} (want 0.8.7)"
  is "$nopw" t "superuser has no password" "the superuser has a password (setup.sh lock, after the window)"
  is "$dbs" clics_mentor,postgres "databases: $dbs" "databases: $dbs (want clics_mentor,postgres)"
  is "$hbaerr" 0 "pg_hba.conf parses" "pg_hba.conf has $hbaerr bad line(s)"
  is "$hosttypes" hostssl "every accepting network line is hostssl" "accepting network lines: $hosttypes"
  local who; who=$(compose exec -T "$SERVICE" id -u </dev/null)
  is "$who" "$PG_UID" "the server runs as uid $PG_UID" "the server runs as uid $who"
  return $bad
}

case "${1:-}" in
  volume) shift; cmd_volume "$@" ;;
  volume-file) shift; cmd_volume_file "$@" ;;
  open) shift; cmd_open "$@" ;;
  close) cmd_close ;;
  tls) shift; cmd_tls "$@" ;;
  hba) shift; cmd_hba "$@" ;;
  init) cmd_init ;;
  start) compose up -d --wait ;;
  reload) [ "$(psql_su -Atc "select pg_reload_conf()" </dev/null)" = t ] &&
            say "the server re-read pg_hba.conf and postgresql.conf (setup.sh check: does pg_hba.conf parse)" ;;
  logs) shift; compose logs "$@" "$SERVICE" ;;
  psql) compose exec -u postgres "$SERVICE" psql -X -d clics_mentor ;;
  lock) psql_su -c "alter role postgres password null" >/dev/null </dev/null && say "the superuser has no password" ;;
  check) cmd_check ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac
