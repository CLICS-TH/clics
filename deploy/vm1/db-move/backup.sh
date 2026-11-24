#!/bin/bash
# The nightly encrypted backup of the data host (#432, ADR 0012). Runs on vm1 as root, from cron; README.md
# in this directory, "Nightly backup", says how to set it up and how to run the restore drill.
#
#   backup.sh OUT_DIR
#
# OUT_DIR is where the CME backup job picks the file up (a mount of the backup host, or a directory its
# job copies). One file per run, clics-<UTC stamp>.sql.gpg, written under a .partial name and renamed only
# once gpg has finished, so a half-written dump never looks like a backup.
#
# /opt/clics/backup/ (root, mode 700) holds:
#   backup.env       CLICS_DATA_HOST and, if they differ from move.sh's defaults, CLICS_DATA_PORT,
#                    CLICS_DATA_DB, CLICS_DATA_USER, CLICS_DATA_SSLMODE (NAME=value lines, mode 600)
#   pgpass           the data host's password for CLICS_DATA_USER (clics_backup), in pgpass format (mode 600)
#   data-ca.crt      optional: the data host's certificate, for CLICS_DATA_SSLMODE=verify-full
#   recipients.d/    one PUBLIC key per key holder, NAME.asc; the dump is encrypted to every one of them,
#                    so any one holder can decrypt it. (A single recipient.asc in /opt/clics/backup/ is
#                    still read, as one more key.) Their private halves are held by the key holders, on
#                    neither vm1 nor the backup host. A file holding a private key, or anything but one
#                    public key, is refused.
#   image            optional: one line, the PostgreSQL image to run pg_dump in. Its major version must be
#                    the data host's or newer (pg_dump refuses a newer server). CLICS_PG_IMAGE overrides it.
#
# The dump never exists in clear outside a pipe: move.sh backup (in a throwaway container of the data
# host's PostgreSQL version) streams into gpg, and gpg writes the only file.
set -euo pipefail
export LC_ALL=C LANG=C
HERE="$(cd "$(dirname "$0")" && pwd)"
CONF=${CLICS_BACKUP_CONF:-/opt/clics/backup}
IMAGE=${CLICS_PG_IMAGE:-}
[ -n "$IMAGE" ] || { [ ! -f "$CONF/image" ] || IMAGE=$(head -1 "$CONF/image"); }
IMAGE=${IMAGE:-supabase/postgres:17.6.1.136}
log() { echo "[db-backup] $(date -u +%FT%TZ) $*" >&2; }
die() { echo "[db-backup] ERROR: $*" >&2; exit 1; }

OUT=${1:-}
[ -n "$OUT" ] && [ -d "$OUT" ] || die "usage: backup.sh OUT_DIR (an existing directory)"
for f in backup.env pgpass; do [ -f "$CONF/$f" ] || die "missing $CONF/$f"; done
for f in backup.env pgpass; do
  [ "$(stat -c '%a %U' "$CONF/$f")" = "600 root" ] || die "$CONF/$f must be mode 600, owned by root"
done
[[ "$IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || die "the image name '$IMAGE' is not an image reference"
command -v gpg >/dev/null || die "gpg is not installed"

# The recipients. Each file is read by gpg itself (not by a pattern match): it must hold exactly one public
# key and no secret key, armored or binary. --show-keys reads the file without importing it anywhere.
keys=()
for f in "$CONF/recipient.asc" "$CONF"/recipients.d/*.asc; do
  [ -f "$f" ] || continue
  listing=$(gpg --batch --no-tty --with-colons --show-keys "$f" 2>/dev/null) || die "$f is not an OpenPGP key gpg can read"
  if grep -qE '^(sec|ssb):' <<< "$listing"; then die "$f holds a private key: only public keys may be on this host"; fi
  [ "$(grep -c '^pub:' <<< "$listing")" = 1 ] || die "$f must hold exactly one public key"
  # Field 12 of the pub record: the key's usable capabilities; E = it can encrypt.
  awk -F: '$1 == "pub" && $12 ~ /E/ { ok = 1 } END { exit !ok }' <<< "$listing" ||
    die "$f has no usable encryption key (expired, revoked or sign-only)"
  keys+=(--recipient-file "$f")
done
[ "${#keys[@]}" -gt 0 ] || die "no recipient key: put each key holder's public key in $CONF/recipients.d/NAME.asc"
log "encrypting to $(( ${#keys[@]} / 2 )) key holder(s)"

# Only the names move.sh reads, so backup.env cannot smuggle anything else into the container.
envs=()
while IFS= read -r line; do
  case "$line" in
    CLICS_DATA_HOST=?*|CLICS_DATA_PORT=?*|CLICS_DATA_DB=?*|CLICS_DATA_USER=?*|CLICS_DATA_SSLMODE=?*) envs+=(-e "$line") ;;
    ''|'#'*) ;;
    *) die "backup.env: unexpected line (only CLICS_DATA_* names)" ;;
  esac
done < "$CONF/backup.env"
printf '%s\n' "${envs[@]}" | grep -q '^CLICS_DATA_HOST=' || die "backup.env has no CLICS_DATA_HOST"
# The data host's certificate, when there is one: verify-full then checks the server is the data host.
ca=()
[ ! -f "$CONF/data-ca.crt" ] || ca=(-v "$CONF/data-ca.crt:/run/data-ca.crt:ro" -e CLICS_DATA_SSLROOTCERT=/run/data-ca.crt)

stamp=$(date -u +%Y%m%dT%H%M%SZ)
part="$OUT/.clics-$stamp.sql.gpg.partial"
final="$OUT/clics-$stamp.sql.gpg"
trap 'rm -f "$part"' EXIT
log "dumping the data host into $final"
# --network host: the data host is reached over vm1's tailnet address, the one its pg_hba admits.
docker run --rm -i --network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    --memory 1g --pids-limit 256 \
    -v "$HERE/move.sh:/db-move/move.sh:ro" -v "$CONF/pgpass:/run/pgpass:ro" -e PGPASSFILE=/run/pgpass \
    "${envs[@]}" ${ca[@]+"${ca[@]}"} --entrypoint bash "$IMAGE" /db-move/move.sh backup < /dev/null |
  gpg --batch --no-tty --quiet --trust-model always "${keys[@]}" --encrypt --output - > "$part"
[ -s "$part" ] || die "the encrypted dump is empty"
mv "$part" "$final"
trap - EXIT
log "done: $final ($(stat -c %s "$final") bytes)"
