# shellcheck shell=bash
# Prepended by deploy/vm1/deploy.sh to every remote step. Steps run as `bash -s -- BASE PROJECT PORT SHA
# MODE RUN` inside `{ ... } </dev/null`; activate runs the same text from runs/<RUN>/activate.sh, detached
# (see launch.sh). Not executed on its own. CI lints each step as sent: lib.sh + <step>.sh.
set -euo pipefail
log() { echo "[vm1] $*"; }
die() { echo "[vm1] ERROR: $*" >&2; exit 1; }
# Not every step uses every argument (attach uses none of SHA, MODE, RUN).
# shellcheck disable=SC2034
BASE=$1 PROJECT=$2 PORT=$3 SHA=$4 MODE=$5 RUN=${6:-}

# ---- env checks: run by preflight, and again by activate before it changes anything -----------------
# Nothing here prints an env value or puts one on a command line.

# sha256 of a file's `INTERNAL_TOKEN=` line. The value only ever travels down a pipe into sha256sum.
token_line_sha() { grep -E '^INTERNAL_TOKEN=' "$1" | sha256sum; }

# Both files carry exactly one INTERNAL_TOKEN line, and the two lines are byte-identical. A mismatch turns
# the backend's evaluation drain into a manual-QA queue: rimpl answers 401, which the backend classes as
# deterministic (backend/src/services/rimpl-client.js:70), so every PLE it claims is flagged.
check_internal_token() {
  local f n
  for f in backend.env rimpl.env; do
    n=$(grep -cE '^[[:space:]]*(export[[:space:]]+)?INTERNAL_TOKEN[[:space:]]*=' "$BASE/env/$f" || true)
    [ "$n" = 1 ] || die "$f assigns INTERNAL_TOKEN $n times; it must have exactly one INTERNAL_TOKEN= line. Nothing was changed."
    grep -qE '^INTERNAL_TOKEN=.+' "$BASE/env/$f" \
      || die "$f: write it as INTERNAL_TOKEN=value, at the start of its line, with a value. Nothing was changed."
  done
  [ "$(token_line_sha "$BASE/env/backend.env")" = "$(token_line_sha "$BASE/env/rimpl.env")" ] \
    || die "INTERNAL_TOKEN differs between backend.env and rimpl.env (the two lines were compared by sha256: same value, same quoting, no trailing space or CR). Nothing was changed."
}

# The reconcile sweep is not safe on two backends at once (ADR 0002, Parallel run), and the backend reads
# RECONCILE_INTERVAL_MS as `value || 6h`, then parseInt: a blank value or a missing line both mean every
# 6 h, and "5m" means 5 ms. Only an explicit 0 is off. Anything else needs CLICS_CUTOVER_DONE=1, which a
# human adds once Railway's backend is stopped (deploy/vm1/README.md, cutover step 5).
check_reconcile() {
  local f=$BASE/env/backend.env n
  n=$(grep -cE '^[[:space:]]*(export[[:space:]]+)?RECONCILE_INTERVAL_MS[[:space:]]*=' "$f" || true)
  [ "$n" -le 1 ] || die "backend.env assigns RECONCILE_INTERVAL_MS $n times; keep one line. Nothing was changed."
  if [ "$n" = 1 ]; then
    grep -qE '^RECONCILE_INTERVAL_MS=[0-9]+$' "$f" \
      || die "backend.env: RECONCILE_INTERVAL_MS must be unquoted digits (0 while Railway's backend runs). A blank value is not 0: the backend reads it as the 6-hour default. Nothing was changed."
  fi
  if grep -qE '^RECONCILE_INTERVAL_MS=0+$' "$f"; then
    log "reconcile sweep OFF on vm1 (RECONCILE_INTERVAL_MS=0)"
  elif grep -qE '^CLICS_CUTOVER_DONE=1$' "$f"; then
    log "reconcile sweep ON on vm1 (CLICS_CUTOVER_DONE=1: Railway's backend is stopped)"
  else
    die "backend.env turns vm1's reconcile sweep ON (RECONCILE_INTERVAL_MS is non-zero, or missing, which means every 6 h). While Railway's backend runs, set RECONCILE_INTERVAL_MS=0. Once it is stopped, add CLICS_CUTOVER_DONE=1 (README, cutover step 5). Nothing was changed."
  fi
}

# /opt/clics/current, when it exists, must point at a release that is on this host: a failed activation
# restores that release from its directory. Pruning keeps `current` and `previous` (README, Operating it).
check_current_release() {
  if [ -L "$BASE/current" ] || [ -e "$BASE/current" ]; then
    [ -f "$BASE/current/deploy/vm1/docker-compose.yml" ] \
      || die "$BASE/current points at '$(readlink "$BASE/current" || true)', which is not a release on this host, so a failed activation could not restore it. Nothing was changed. Point current at a release under $BASE/releases first."
  fi
}

# ---- following a detached activation (launch.sh, attach.sh) ------------------------------------------
# Prints a run's log from the start, as it grows, and returns the run's exit code once runs/<RUN>/status
# exists. Read-only: following twice, or losing the follower halfway, does nothing to the activation.
FOLLOW_PRINTED=0
follow_print() { # <log>: print what was appended since the last call
  local size
  size=$(($(wc -c < "$1")))
  if [ "$size" -gt "$FOLLOW_PRINTED" ]; then
    tail -c +"$((FOLLOW_PRINTED + 1))" "$1" | head -c "$((size - FOLLOW_PRINTED))" || true
    FOLLOW_PRINTED=$size
  fi
}
follow_run() { # <run dir>
  local run=$1 name unit finished rc
  name=$(basename "$run")
  unit=clics-activate-$name
  [ -f "$run/log" ] || die "$run has no log: that activation was never launched"
  FOLLOW_PRINTED=0
  while :; do
    # activate writes status after its last log line, so once status exists the log is complete.
    finished=0
    if [ -f "$run/status" ]; then finished=1; fi
    follow_print "$run/log"
    if [ "$finished" = 1 ]; then break; fi
    if ! systemctl is-active --quiet "$unit"; then
      sleep 1
      if [ -f "$run/status" ]; then continue; fi
      follow_print "$run/log"
      die "activation $name is no longer running and wrote no status (was it killed?). Everything it logged is above ($run/log). See what is running: docker ps --filter label=com.docker.compose.project=$PROJECT"
    fi
    sleep 1
  done
  rc=$(head -n 1 "$run/status")
  case "$rc" in ''|*[!0-9]*) die "$run/status does not hold an exit code" ;; esac
  if [ "$rc" = 0 ]; then
    log "activation $name succeeded"
  else
    log "activation $name FAILED (exit $rc); the lines above say what is running on vm1 now"
  fi
  return "$rc"
}
