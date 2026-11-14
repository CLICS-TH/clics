#!/usr/bin/env bash
# Ship a git ref of CLICS to vm1 and run it there (Topology B, docs/adr/0002-vm1-topology-b.md).
#
# Usage, from any checkout of this repo on the Mac:
#   VM1_HOST=VM1_TAILNET_NAME deploy/vm1/deploy.sh [--dry-run] [GIT_REF]     (GIT_REF defaults to origin/master)
#   VM1_HOST=VM1_TAILNET_NAME deploy/vm1/deploy.sh [--dry-run] --rollback SHA
#   VM1_HOST=VM1_TAILNET_NAME deploy/vm1/deploy.sh [--dry-run] --attach
#
#   --dry-run          Resolve the ref, build and check the tarball locally, and PRINT every remote
#                      command and script, including the command that starts the activation detached.
#                      Nothing is sent to vm1.
#   --rollback SHA     Re-activate a release already on vm1 (/opt/clics/releases/SHA). No upload.
#   --attach           Follow the most recent activation on vm1, from its first line to its result.
#                      Read-only. Use it whenever a deploy lost its connection.
#
# Environment:
#   VM1_HOST       required. vm1's tailnet host name. Not a secret (ADR 0002 names the node); it is
#                  passed in so that nothing in deploy/vm1/ is tied to one host.
#   VM1_USER       remote user (default root, the access verified on 2026-10-21).
#   TAILSCALE_BIN  Tailscale CLI (default /Applications/Tailscale.app/Contents/MacOS/Tailscale). On macOS
#                  `tailscale ssh` needs the Standalone variant; the App Store variant does not have it.
#
# What it does: git archive of backend/ rimpl/ physician-ui/ audit-dashboard/ deploy/vm1/ at the ref ->
# Tailscale SSH -> preflight -> /opt/clics/releases/<sha> -> activate, started DETACHED on vm1 (a systemd
# transient unit) and followed from here: docker compose -p clics build -> rimpl up -> gate 1 (rimpl
# healthy, INTERNAL_TOKEN matches) -> backend up -> gate 2 (/health/deep says backend, rimpl up, Supabase
# up) -> Portal and dashboard up, each answering on its loopback port only -> /opt/clics/current flips.
# Any failure restores the previous release in that same order: its backend starts again if its rimpl
# accepts INTERNAL_TOKEN (healthy or only degraded), and is left STOPPED if it does not (on a first
# deploy, CLICS is stopped); its Portal and dashboard start again, or this run's are stopped if it had none. A signal on vm1 (systemctl stop, a reboot) is recorded as a failure and
# restores nothing. A dropped connection stops only the following, never the activation.
#
# What it never does: copy an env file (they live in /opt/clics/env, placed by a human), need GitHub
# credentials on vm1 (the code arrives as a tarball), or touch Railway, Vercel or DNS.
set -euo pipefail

TS_BIN="${TAILSCALE_BIN:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
VM1_USER="${VM1_USER:-root}"
BASE=/opt/clics
PROJECT=clics
# Must equal the loopback port in docker-compose.yml (scripts/deploy/vm1.test.mjs checks it).
HOST_PORT=3101

die() { echo "deploy: $*" >&2; exit 1; }
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

DRY_RUN=0
ATTACH=0
ROLLBACK=""
REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --attach) ATTACH=1 ;;
    --rollback)
      [ $# -ge 2 ] || die "--rollback needs a sha"
      ROLLBACK=$2
      shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown flag: $1 (see --help)" ;;
    *)
      [ -z "$REF" ] || die "pass one ref at most"
      REF=$1 ;;
  esac
  shift
done
if [ -n "$ROLLBACK" ] && [ -n "$REF" ]; then die "--rollback takes a sha; do not pass a ref as well"; fi
if [ "$ATTACH" = 1 ] && { [ -n "$ROLLBACK" ] || [ -n "$REF" ]; }; then
  die "--attach follows the latest activation on vm1; pass no ref and no --rollback"
fi
REF=${REF:-origin/master}

# (No apostrophe in this message: bash 3.2 reads one inside "${...:?...}" as an opening quote.)
: "${VM1_HOST:?set VM1_HOST to the tailnet host name of vm1 (see deploy/vm1/README.md, Deploying)}"
case "$VM1_HOST" in *[!A-Za-z0-9._-]*) die "VM1_HOST may hold only letters, digits, '.', '_' and '-'" ;; esac
case "$VM1_USER" in ''|*[!a-z0-9_-]*) die "VM1_USER may hold only lower-case letters, digits, '_' and '-'" ;; esac
TARGET="$VM1_USER@$VM1_HOST"
if [ "$DRY_RUN" != 1 ] && [ ! -x "$TS_BIN" ]; then
  die "Tailscale CLI not found at $TS_BIN (set TAILSCALE_BIN)"
fi

# ---- remote steps ---------------------------------------------------------------------------------
# Each step is remote/lib.sh + remote/<step>.sh (beside this file), wrapped in `{ ... } </dev/null`: bash
# reads the whole group before running any of it, and no command inside (`docker compose run` attaches
# stdin) can swallow the rest of the script. Steps are sent on stdin to `bash -s -- <args>`, except
# activate, which is staged as a file on vm1 and started detached (remote/launch.sh). The scripts come
# from THIS checkout, so a rollback runs today's host logic against the older release.
HERE=$(cd "$(dirname "$0")" && pwd)
step_body() { printf '{\n%s\n} </dev/null\n' "$(cat "$HERE/remote/lib.sh" "$HERE/remote/$1.sh")"; }

run_step() { # <step>: run (or print) lib.sh + remote/<step>.sh on vm1; returns ssh's exit code
  local body
  body=$(step_body "$1")
  if [ "$DRY_RUN" = 1 ]; then
    printf '\n----- [dry-run] %s -----\n$ %s ssh %s bash -s -- %s %s %s %s %s %s <<'"'"'REMOTE'"'"'\n%s\nREMOTE\n' \
      "$1" "$TS_BIN" "$TARGET" "$BASE" "$PROJECT" "$HOST_PORT" "$SHA" "$MODE" "$RUN" "$body"
    return 0
  fi
  echo "deploy: $1" >&2
  printf '%s\n' "$body" | "$TS_BIN" ssh "$TARGET" bash -s -- "$BASE" "$PROJECT" "$HOST_PORT" "$SHA" "$MODE" "$RUN"
}

# ---- --attach: follow the latest activation, change nothing ---------------------------------------
if [ "$ATTACH" = 1 ]; then
  MODE=attach SHA=- RUN=-
  echo "deploy: following the latest activation on $TARGET"
  rc=0
  run_step attach || rc=$?
  if [ "$DRY_RUN" = 1 ]; then echo; echo "deploy: dry run; nothing was sent to $VM1_HOST"; exit 0; fi
  [ "$rc" = 0 ] || die "the latest activation on $VM1_HOST did not succeed, or could not be followed (exit $rc, output above)"
  echo "deploy: the latest activation on $VM1_HOST succeeded"
  exit 0
fi

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel) || die "run this from a checkout of the CLICS repo"

# ---- resolve what is being deployed --------------------------------------------------------------
if [ -n "$ROLLBACK" ]; then
  MODE=rollback
  SHA=$(git -C "$REPO" rev-parse --verify --quiet "${ROLLBACK}^{commit}" || true)
  if [ -z "$SHA" ]; then
    # Not in this checkout: accept a full sha as written in /opt/clics/deploys.log.
    case "$ROLLBACK" in *[!0-9a-f]*) die "--rollback $ROLLBACK is not a commit in this checkout" ;; esac
    [ "${#ROLLBACK}" -eq 40 ] || die "--rollback $ROLLBACK is not a commit here; pass the full 40-character sha"
    SHA=$ROLLBACK
  fi
else
  MODE=deploy
  SHA=$(git -C "$REPO" rev-parse --verify --quiet "${REF}^{commit}") || die "cannot resolve '$REF' (run 'git fetch origin' first?)"
  git -C "$REPO" cat-file -e "${SHA}:deploy/vm1/docker-compose.yml" 2>/dev/null \
    || die "$REF ($SHA) has no deploy/vm1/docker-compose.yml: it predates the vm1 setup"
fi
# One id per activation: names its directory on vm1 (/opt/clics/runs/<RUN>) and its systemd unit.
RUN="$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}-$MODE"
SUBJECT=$(git -C "$REPO" log -1 --format=%s "$SHA" 2>/dev/null || echo '(commit not in this checkout)')
echo "deploy: $MODE $SHA -> $TARGET:$BASE/releases/$SHA (run $RUN)"
echo "deploy: $SUBJECT"
if [ "$MODE" = deploy ] && [ "$REF" = origin/master ]; then
  echo "deploy: origin/master as this checkout last fetched it; run 'git fetch origin' first for the remote tip"
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/clics-vm1.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

# ---- the release tarball (deploy only) ------------------------------------------------------------
TARBALL="$TMP/release-$SHA.tgz"
if [ "$MODE" = deploy ]; then
  git -C "$REPO" archive --format=tar "$SHA" -- backend rimpl physician-ui audit-dashboard deploy/vm1 | gzip -n > "$TARBALL"
  # git archive ships tracked files only, and no env file is tracked. Refuse anyway if one ever is.
  # The listing goes to a file first: `tar | grep -q` under pipefail can lose a match to SIGPIPE.
  tar -tzf "$TARBALL" > "$TMP/listing"
  if grep -E '(^|/)(\.env|[^/]*\.env|\.env\.[^/]*)$' "$TMP/listing" | grep -vE '\.env\.example$' > "$TMP/envfiles"; then
    die "refusing to ship env files: $(tr '\n' ' ' < "$TMP/envfiles")"
  fi
  echo "deploy: tarball $(wc -l < "$TMP/listing" | tr -d ' ') entries, $(wc -c < "$TARBALL" | tr -d ' ') bytes, no env files"
fi

# The upload and the stage read data on stdin, so their scripts travel as the command string instead.
# Releases are immutable: a sha already on the host is not unpacked again.
UPLOAD_CMD="set -eu; umask 022; d='$BASE/releases/$SHA'; t='$BASE/releases/.incoming-$SHA'; \
if [ -f \"\$d/deploy/vm1/docker-compose.yml\" ]; then cat >/dev/null; echo '[vm1] release $SHA is already on the host'; exit 0; fi; \
rm -rf \"\$t\" \"\$d\"; mkdir -p \"\$t\"; tar -xzf - --no-same-owner -C \"\$t\"; chmod -R go-w \"\$t\"; mv -T \"\$t\" \"\$d\"; \
echo '[vm1] release $SHA unpacked'"
# The activate script (lib.sh + activate.sh from this checkout) becomes runs/<RUN>/activate.sh, root-only.
STAGE_CMD="set -eu; umask 077; mkdir -p '$BASE/runs'; r='$BASE/runs/$RUN'; mkdir \"\$r\"; \
cat > \"\$r/activate.sh.part\"; mv \"\$r/activate.sh.part\" \"\$r/activate.sh\"; echo '[vm1] staged activation $RUN'"
# What launch.sh runs on vm1, shown resolved by --dry-run (launch.sh is the copy that executes).
DETACHED_CMD="systemd-run --unit=clics-activate-$RUN --collect --quiet --setenv=PATH=\"\$PATH\" --setenv=HOME=\"\${HOME:-/root}\" \
/bin/bash $BASE/runs/$RUN/activate.sh $BASE $PROJECT $HOST_PORT $SHA $MODE $RUN"

run_upload() {
  if [ "$DRY_RUN" = 1 ]; then
    # "$UPLOAD_CMD" below is printed literally, as the name of the command shown under it.
    # shellcheck disable=SC2016
    printf '\n----- [dry-run] upload -----\n$ %s ssh %s "$UPLOAD_CMD" < %s\nUPLOAD_CMD (one remote shell command):\n%s\n' \
      "$TS_BIN" "$TARGET" "release-$SHA.tgz" "$UPLOAD_CMD"
    return 0
  fi
  echo "deploy: upload" >&2
  "$TS_BIN" ssh "$TARGET" "$UPLOAD_CMD" < "$TARBALL" || die "upload to $VM1_HOST failed; nothing was restarted"
}

run_stage() {
  if [ "$DRY_RUN" = 1 ]; then
    # shellcheck disable=SC2016
    printf '\n----- [dry-run] stage -----\n$ %s ssh %s "$STAGE_CMD" <<'"'"'REMOTE'"'"'\n%s\nREMOTE\nSTAGE_CMD (one remote shell command):\n%s\n' \
      "$TS_BIN" "$TARGET" "$(step_body activate)" "$STAGE_CMD"
    return 0
  fi
  echo "deploy: stage" >&2
  step_body activate | "$TS_BIN" ssh "$TARGET" "$STAGE_CMD" || die "staging the activation on $VM1_HOST failed; nothing was restarted"
}

run_launch() {
  local rc=0
  run_step launch || rc=$?
  if [ "$DRY_RUN" = 1 ]; then
    printf '\n----- [dry-run] detached activation -----\nlaunch starts the staged script on vm1, detached from the SSH session, as:\n  %s\n' "$DETACHED_CMD"
    return 0
  fi
  case "$rc" in
    0) ;;
    255) die "ssh exited 255: the connection to $VM1_HOST was lost (unless the activation itself exited 255; the lines above show which). An activation that had started ('started detached' above) carries on by itself. Follow it to its result: VM1_HOST=$VM1_HOST $0 --attach" ;;
    *) die "the activation did not succeed on $VM1_HOST (exit $rc); its last lines above say what is running there now. Its full log: VM1_HOST=$VM1_HOST $0 --attach" ;;
  esac
}

run_step preflight || die "preflight failed on $VM1_HOST (output above); nothing was changed"
if [ "$MODE" = deploy ]; then run_upload; fi
run_stage
run_launch

if [ "$DRY_RUN" = 1 ]; then
  echo
  echo "deploy: dry run; nothing was sent to $VM1_HOST"
else
  echo "deploy: done. Public check (once DNS, cert and nginx are in place): curl -s https://clics.ccme.or.th/health/deep"
fi
