#!/bin/bash
# The database move under CME's rules for vm1 (#432): the CLICS operator logs in with no root, no docker
# group and no `docker run`, only sudo for a fixed list of commands. This is the move's entry on
# that list, installed by CME from the reviewed main, root-owned, with move.sh and db-move.conf beside it:
#
#   sudo /usr/local/lib/clics-db-move/run-move.sh preflight
#   sudo /usr/local/lib/clics-db-move/run-move.sh move   | tee ~/db-move-report.txt
#   sudo /usr/local/lib/clics-db-move/run-move.sh verify
#
# It runs move.sh in a throwaway container of the data host's PostgreSQL version on vm1's network (the data
# host's pg_hba admits vm1's tailnet address). It asks for two secrets at this terminal, without echo: the
# Supabase session-pooler URL (typed by the CLICS operator) and the data host superuser's password (typed by
# whoever holds it). Both reach move.sh as two lines on its stdin (CLICS_DATA_PASSWORD=stdin), so no file,
# argv, environment variable or container log on vm1 ever holds either. The container keeps no log at all
# (--log-driver none): Docker would otherwise copy what move.sh prints, a psql error quoting a row
# included, into a log on vm1's disk.
#
# db-move.conf: NAME=value lines, only these names, none a secret:
#   CLICS_PG_IMAGE          the image move.sh runs in: bash, psql and pg_dump of the data host's major or newer
#   CLICS_DATA_HOST         the data host's tailnet name or address
#   CLICS_DATA_PORT, CLICS_DATA_DB, CLICS_DATA_USER, CLICS_DATA_SSLMODE, AUDIT_CHAIN    as move.sh reads them
#   CLICS_DATA_SSLROOTCERT  a file on vm1, the data host's CA certificate, for CLICS_DATA_SSLMODE=verify-full
#
# sudo runs this as root, so whoever can change a file it reads or runs is root too. It refuses to start
# unless this script, move.sh, db-move.conf, the CA certificate and the docker binary, and every directory
# above each of them, are owned by root (or, in the hermetic test, by the user running it) and writable by
# no group and no other user (a root-owned sticky directory such as /tmp aside).
set -euo pipefail
# Nothing from the caller steers what runs as root: the tools come from the system's own directories, and
# docker talks to the local daemon with root's settings, not a host or config the caller named. The caller's
# PATH is kept only to find docker, which trusted() below then checks (sudo's secure_path on vm1).
CALLER_PATH=$PATH
export PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C LANG=C
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH BASH_ENV ENV CDPATH
umask 077
log() { echo "[run-move] $*" >&2; }
die() { echo "[run-move] ERROR: $*" >&2; exit 1; }
usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }

cmd=${1:-}
[ "$#" = 1 ] || usage
case "$cmd" in preflight|move|verify) ;; *) usage ;; esac

# Owner uid and mode bits of a path: GNU stat on vm1, BSD stat on a Mac (the hermetic test).
own_mode() { stat -c '%u %a' "$1" 2>/dev/null || stat -f '%u %p' "$1" 2>/dev/null; }
trusted() { # trusted <absolute path, no symlink in it>: the path and every directory above it
  local p=$1 u m
  while :; do
    read -r u m <<< "$(own_mode "$p")" || true
    [ -n "${m:-}" ] || die "cannot read the owner of $p"
    [ "$u" = 0 ] || [ "$u" = "$EUID" ] || die "$p is owned by uid $u: everything this script trusts must be root's"
    if (( 8#$m & 8#022 )) && ! { [ -d "$p" ] && [ "$u" = 0 ] && (( 8#$m & 8#1000 )); }; then
      die "$p can be changed by its group or by other users"
    fi
    [ "$p" != / ] || return 0
    p=$(dirname "$p")
  done
}
real_file() { # real_file <path> -> the absolute path, with every directory resolved; a symlinked file is refused
  [ -f "$1" ] || die "$1 is not a file"
  [ ! -L "$1" ] || die "$1 is a symlink"
  echo "$(cd -P "$(dirname "$1")" && pwd)/$(basename "$1")"
}

SELF=$(real_file "$0")
HERE=$(dirname "$SELF")
MOVE=$(real_file "$HERE/move.sh")
[ -f "$HERE/db-move.conf" ] || die "no $HERE/db-move.conf (CME writes it: README.md, Under CME's rules)"
CONF=$(real_file "$HERE/db-move.conf")
DOCKER=$(PATH=$CALLER_PATH command -v docker) || die "docker is not installed"
case "$DOCKER" in /*) ;; *) die "docker was found at $DOCKER, not an absolute path" ;; esac
# The directory PATH found it in (sudo's secure_path), then the file a symlink there points to.
trusted "$(cd -P "$(dirname "$DOCKER")" && pwd)"
DOCKER=$(real_file "$(readlink -f "$DOCKER" 2>/dev/null || echo "$DOCKER")")
for f in "$SELF" "$MOVE" "$CONF" "$DOCKER"; do trusted "$f"; done

# The settings: only the names move.sh reads, so the file cannot smuggle anything else into the container.
envs=() image='' ca='' user=supabase_admin n=0 line=''
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  case "$line" in
    ''|'#'*) continue ;;
    CLICS_PG_IMAGE=?*) image=${line#*=} ;;
    CLICS_DATA_SSLROOTCERT=?*) ca=${line#*=} ;;
    CLICS_DATA_HOST=?*|CLICS_DATA_PORT=?*|CLICS_DATA_DB=?*|CLICS_DATA_USER=?*|CLICS_DATA_SSLMODE=?*|AUDIT_CHAIN=?*)
      [[ "${line#*=}" =~ ^[A-Za-z0-9._:-]+$ ]] || die "db-move.conf line $n: the value has a character it may not"
      envs+=(-e "$line")
      case "$line" in CLICS_DATA_USER=*) user=${line#*=} ;; esac ;;
    # The line is not printed: it might be a secret written where it does not belong.
    *) die "db-move.conf line $n: not one of the names it may set (README.md, Under CME's rules)" ;;
  esac
done < "$CONF"
printf '%s\n' ${envs[@]+"${envs[@]}"} | grep -q '^CLICS_DATA_HOST=' || die "db-move.conf has no CLICS_DATA_HOST"
[ -n "$image" ] || die "db-move.conf has no CLICS_PG_IMAGE"
[[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || die "CLICS_PG_IMAGE is not an image reference"
mounts=(-v "$MOVE:/db-move/move.sh:ro")
if [ -n "$ca" ]; then
  [[ "$ca" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "CLICS_DATA_SSLROOTCERT must be an absolute path"
  ca=$(real_file "$ca")
  trusted "$ca"
  mounts+=(-v "$ca:/run/data-ca.crt:ro")
  envs+=(-e CLICS_DATA_SSLROOTCERT=/run/data-ca.crt)
fi

sum12() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -c1-12; }
log "kit: run-move.sh $(sum12 "$SELF"), move.sh $(sum12 "$MOVE"); image $image; data host user $user"

# Typed, never piped: a secret that arrives on a pipe was in a file or another program first.
[ -t 0 ] || die "the two secrets are typed at this terminal: stdin must be a terminal, not a file or a pipe"
url='' pw=''
IFS= read -r -s -p "[run-move] Supabase session-pooler URL (typed by the CLICS operator; not shown): " url || true
echo >&2
case "$url" in postgres://*|postgresql://*) ;; *) die "that is not a postgres:// URL" ;; esac
IFS= read -r -s -p "[run-move] Password of $user on the data host (typed by its holder; not shown): " pw || true
echo >&2
[ -n "$pw" ] || die "no password typed"

# printf is a shell builtin: the two lines go down the pipe without ever being an argv.
status=0
printf '%s\n%s\n' "$url" "$pw" | "$DOCKER" run --rm -i --log-driver none --network host --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
  "${mounts[@]}" "${envs[@]}" -e CLICS_DATA_PASSWORD=stdin \
  --entrypoint bash "$image" /db-move/move.sh "$cmd" || status=$?
unset url pw
[ "$status" = 0 ] || die "move.sh $cmd exited $status"
