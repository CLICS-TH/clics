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
#   pgpass           the data host's password for CLICS_DATA_USER, in pgpass format (mode 600)
#   recipient.asc    the PUBLIC key the dump is encrypted to. Its private half is held by the key holder,
#                    on neither vm1 nor the backup host. A file holding a private key is refused.
#
# The dump never exists in clear outside a pipe: move.sh backup (in a throwaway supabase/postgres
# container, the image the data host runs) streams into gpg, and gpg writes the only file.
set -euo pipefail
export LC_ALL=C LANG=C
HERE="$(cd "$(dirname "$0")" && pwd)"
CONF=${CLICS_BACKUP_CONF:-/opt/clics/backup}
IMAGE=${CLICS_PG_IMAGE:-supabase/postgres:17.6.1.136}
log() { echo "[db-backup] $(date -u +%FT%TZ) $*" >&2; }
die() { echo "[db-backup] ERROR: $*" >&2; exit 1; }

OUT=${1:-}
[ -n "$OUT" ] && [ -d "$OUT" ] || die "usage: backup.sh OUT_DIR (an existing directory)"
for f in backup.env pgpass recipient.asc; do [ -f "$CONF/$f" ] || die "missing $CONF/$f"; done
for f in backup.env pgpass; do
  [ "$(stat -c '%a %U' "$CONF/$f")" = "600 root" ] || die "$CONF/$f must be mode 600, owned by root"
done
grep -q 'PRIVATE KEY' "$CONF/recipient.asc" && die "$CONF/recipient.asc holds a private key: only the public key may be on this host"
command -v gpg >/dev/null || die "gpg is not installed"

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

stamp=$(date -u +%Y%m%dT%H%M%SZ)
part="$OUT/.clics-$stamp.sql.gpg.partial"
final="$OUT/clics-$stamp.sql.gpg"
trap 'rm -f "$part"' EXIT
log "dumping the data host into $final"
# --network host: the data host is reached over vm1's tailnet address, the one its pg_hba admits.
docker run --rm -i --network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    --memory 1g --pids-limit 256 \
    -v "$HERE/move.sh:/db-move/move.sh:ro" -v "$CONF/pgpass:/run/pgpass:ro" -e PGPASSFILE=/run/pgpass \
    "${envs[@]}" --entrypoint bash "$IMAGE" /db-move/move.sh backup < /dev/null |
  gpg --batch --no-tty --quiet --trust-model always --recipient-file "$CONF/recipient.asc" --encrypt --output - > "$part"
[ -s "$part" ] || die "the encrypted dump is empty"
mv "$part" "$final"
trap - EXIT
log "done: $final ($(stat -c %s "$final") bytes)"
