# activate: build, start rimpl, gate, start the backend, gate, flip /opt/clics/current (deploy/vm1/deploy.sh).
#
# deploy.sh does not run this over its SSH session: launch.sh starts it DETACHED, as a systemd transient
# unit, so a dropped connection cannot stop it between "rimpl recreated" and "restore". With a RUN id it
# writes everything to runs/<RUN>/log and its exit code to runs/<RUN>/status; without one (the tests) it
# writes to stdout.
#
# The rule every path below keeps, restore() included: the backend is only ever started after rimpl has
# accepted the backend's INTERNAL_TOKEN in gate 1. Its evaluation drain claims queued PLEs the moment it
# boots (backend/src/services/eval-drain.js:180), and a 401 from rimpl sends each one to manual QA
# (eval-drain.js:99-101) on the shared production database. A deploy also needs rimpl HEALTHY (gate 1
# exit 0) before `current` can move. restore() also accepts exit 2 (token accepted, a dependency of
# rimpl's down): that puts back what was already live. Nothing here runs a service-less `up`.
#
# Success is explicit. ACTIVATED=1 is the success path's last statement, and finish(), the EXIT trap,
# records any other ending as a failure, even one whose last command returned 0. A signal (systemctl
# stop, a host shutting down) ends the run with 128+N, and the log and runs/<RUN>/status both say
# "interrupted by signal". It does NOT run restore(): systemd kills whatever outlives the stop timeout,
# so a restore would be cut off part-way, and after a reboot docker restarts what was running. Nothing
# started a backend before gate 1, so what is left running is what the log reached. Its last line says
# where `current` points.
ACTIVATED=0
SIGNALLED=""
RESTORING=0
STOPPED_BACKEND=0   # 1 while this run has CLICS's backend stopped (a token change, or a failed restore)
if [ -n "$RUN" ]; then
  RUN_DIR=$BASE/runs/$RUN
  exec >>"$RUN_DIR/log" 2>&1
fi
finish() { # <exit code>: the EXIT trap. The only place this run's result is decided and recorded.
  local rc=$1 cur what
  if [ "$rc" = 0 ] && [ "$ACTIVATED" != 1 ]; then
    rc=1
    echo "[vm1] ERROR: activation ended before its last step without reporting an error. Recorded as a failure" >&2
  fi
  if [ -n "$SIGNALLED" ]; then
    cur=$(readlink "$BASE/current" 2>/dev/null || echo "nothing (there is no current)")
    if [ "$ACTIVATED" = 1 ]; then
      echo "[vm1] ERROR: activation ${RUN:-} was interrupted by signal $SIGNALLED after its last step. $BASE/current -> $cur. Recorded as a failure: confirm with docker ps" >&2
    else
      if [ "$STOPPED_BACKEND" = 1 ]; then
        echo "[vm1] !!! this run had STOPPED CLICS's backend and had not started it again. It stays stopped until deploy.sh --rollback brings it back through gate 1" >&2
      fi
      if [ "$RESTORING" = 1 ]; then what="the restore it had started was cut short"; else what="restore() was NOT attempted"; fi
      echo "[vm1] ERROR: activation ${RUN:-} was interrupted by signal $SIGNALLED (systemctl stop, or the host shutting down) and did not finish; $what. $BASE/current -> $cur. No backend was started before rimpl accepted its INTERNAL_TOKEN, so what runs now is what the lines above reached: docker ps --filter label=com.docker.compose.project=$PROJECT, then deploy.sh --rollback with the sha current names" >&2
    fi
  fi
  if [ -n "$RUN" ]; then
    { echo "$rc"; if [ -n "$SIGNALLED" ]; then echo "interrupted by signal $SIGNALLED"; fi; } > "$RUN_DIR/status.tmp" \
      && mv -f "$RUN_DIR/status.tmp" "$RUN_DIR/status"
  fi
  exit "$rc"
}
trap 'finish "$?"' EXIT
# Without these, bash runs the EXIT trap on SIGTERM with $? from the last command, usually a log line: 0.
# A trapped signal waits for the running command to end (systemd signals the whole unit, docker included).
trap 'SIGNALLED=TERM; exit 143' TERM
trap 'SIGNALLED=HUP; exit 129' HUP
trap 'SIGNALLED=INT; exit 130' INT
if [ -n "$RUN" ]; then
  log "activation $RUN: $MODE $SHA, started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
exec 9>"$BASE/.deploy.lock"
flock -n 9 || die "another deploy is running on this host"
# Preflight ran these already; the env files may have been edited since.
check_internal_token
check_reconcile
check_current_release
cd "$BASE/releases/$SHA/deploy/vm1" || die "release $SHA is not unpacked on this host"
CLICS_RELEASE=$SHA
CLICS_ENV_DIR=$BASE/env
CLICS_UID=$(id -u clics)
CLICS_GID=$(id -g clics)
export CLICS_RELEASE CLICS_ENV_DIR CLICS_UID CLICS_GID
dc() { docker compose -p "$PROJECT" -f docker-compose.yml "$@"; }
# The gates run in a one-off backend container: same image, env file and network as the backend. Both
# dc and gate use the current directory, so after restore() cds they act on the restored release.
gate() { dc run --rm --no-deps -T -v "$PWD/health-gate.cjs:/gate.cjs:ro" backend node /gate.cjs "$1"; }
# Gate 1, keeping its output (printed as well). On exit 2 its DEGRADED line names rimpl's checks that are
# down, after "; down: " (health-gate.cjs gateRimpl), and down_checks quotes them.
GATE_OUT=""
gate_rimpl() {
  local rc=0
  GATE_OUT=$(gate rimpl 2>&1) || rc=$?
  if [ -n "$GATE_OUT" ]; then printf '%s\n' "$GATE_OUT"; fi
  return "$rc"
}
down_checks() {
  local d
  d=$(printf '%s\n' "$GATE_OUT" | sed -n 's/^.*rimpl is DEGRADED.*; down: //p' | tail -n 1)
  echo "${d:-see the gate lines above}"
}
start_backend() { dc up -d --no-deps --wait --wait-timeout 180 backend && STOPPED_BACKEND=0; }
PREV=""
if [ -L "$BASE/current" ]; then PREV=$(basename "$(readlink -f "$BASE/current")"); fi

# A running backend keeps the INTERNAL_TOKEN it was created with, whatever backend.env says now. If
# rimpl.env holds a different line (a rotation: both files edited), recreating rimpl would leave that
# backend draining against a rimpl that answers it 401. Compared by sha256, so no value is printed; a
# quoting difference also reads as different, which only costs a stop the gated start then undoes.
running_backend_token_differs() {
  local id
  for id in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=backend); do
    if [ "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" | grep -E '^INTERNAL_TOKEN=' | sha256sum)" \
         != "$(token_line_sha "$BASE/env/rimpl.env")" ]; then
      return 0
    fi
  done
  return 1
}

OUTCOME=""   # what restore() achieved; fail() puts it on the last line, so that line is true
stop_backend() { # <reason>: stop CLICS's backend, so its drain claims nothing, and say so loudly
  if dc stop backend; then
    STOPPED_BACKEND=1
    OUTCOME="CLICS's backend on vm1 is STOPPED, because $1. It stays stopped until it is started again; deploy.sh starts it only after rimpl accepts its INTERNAL_TOKEN in gate 1"
  else
    OUTCOME="$1, and stopping CLICS's backend FAILED: stop it by hand on vm1 now (docker stop $PROJECT-backend-1), or its evaluation drain may send queued PLEs to manual QA"
  fi
  log "!!! $OUTCOME"
}

# Put back the release /opt/clics/current pointed at when this run began (on a re-activation, this same
# sha), in the order a deploy uses: rimpl, gate 1, and only then the backend. Gate 1 exit 2 (the token
# accepted, rimpl degraded) still starts the backend: that is how the release ran before this run, and
# a dependency outage is no reason to take the whole API down. Any other failure STOPS the backend
# rather than leave it to drain against a rimpl that may refuse it. restore() never runs `down`.
restore() {
  RESTORING=1
  if [ -z "$PREV" ]; then
    # Nothing was live on this host before this run. `stop`, not `down`: restore() removes nothing.
    if dc stop backend rimpl; then
      STOPPED_BACKEND=1
      OUTCOME="no release was live on this host before this run, and CLICS's containers are stopped here now (production is unaffected while it is on Railway)"
    else
      OUTCOME="no release was live on this host before this run, and stopping CLICS's containers FAILED: stop them by hand (docker stop $PROJECT-backend-1 $PROJECT-rimpl-1)"
    fi
    log "$OUTCOME"
    return 0
  fi
  local dir=$BASE/releases/$PREV/deploy/vm1
  if [ ! -f "$dir/docker-compose.yml" ] || ! cd "$dir"; then
    stop_backend "$PREV, the release that was live, is not on this host any more and cannot be restored"
    return 0
  fi
  CLICS_RELEASE=$PREV
  log "restoring $PREV, the release that was live: rimpl, then gate 1, then the backend"
  if running_backend_token_differs; then
    log "the running backend holds a different INTERNAL_TOKEN from rimpl.env: stopping it before rimpl is recreated"
    if ! dc stop backend; then
      OUTCOME="restoring $PREV was NOT attempted: the running backend holds a different INTERNAL_TOKEN from rimpl.env and could not be stopped. Stop it by hand now (docker stop $PROJECT-backend-1)"
      log "!!! $OUTCOME"
      return 0
    fi
    STOPPED_BACKEND=1
  fi
  if ! dc up -d --no-deps --wait --wait-timeout 180 rimpl; then
    stop_backend "the rimpl of $PREV did not become healthy during the restore"
    return 0
  fi
  local g=0
  gate_rimpl || g=$?
  # restore() runs PREV's health-gate.cjs. A gate older than this kit's may return 2 without asking the
  # token, so 2 counts as "token proven" only if the gate also printed that rimpl accepted it.
  if [ "$g" = 2 ] && ! printf '%s\n' "$GATE_OUT" | grep -q 'INTERNAL_TOKEN matches'; then
    log "gate 1 exited 2 but did not report the token as accepted (an older gate?): treating it as unproven"
    g=1
  fi
  if [ "$g" = 2 ]; then
    # The token is proven, so the drain cannot be 401'd: a degraded rimpl answers /evaluate with 500 or
    # 503, which the drain retries (backend/src/services/rimpl-client.js:70) up to EVAL_MAX_ATTEMPTS
    # (20, about 4 h) before flagging each PLE `exhausted`. Stopping the backend here would turn, say, an
    # exhausted Anthropic balance into a full API outage at once; leaving it gives hours to fix it.
    if start_backend; then
      OUTCOME="$PREV restored; rimpl degraded: $(down_checks). Its rimpl accepted the backend's INTERNAL_TOKEN, so its backend runs again, as it did before this run. Once that dependency is back: deploy.sh --rollback $PREV"
    else
      OUTCOME="the rimpl of $PREV accepted INTERNAL_TOKEN but is degraded ($(down_checks)), and its backend did not report healthy within 180 s during the restore. Check docker logs $PROJECT-backend-1, then deploy.sh --rollback $PREV"
    fi
    log "$OUTCOME"
    return 0
  fi
  if [ "$g" != 0 ]; then
    stop_backend "the rimpl of $PREV failed gate 1 (exit $g: INTERNAL_TOKEN not proven) during the restore"
    return 0
  fi
  if start_backend; then
    OUTCOME="$PREV, the release that was live before this run, is running: its rimpl passed gate 1, then its backend reported healthy"
  else
    OUTCOME="the rimpl of $PREV passed gate 1, but its backend did not report healthy within 180 s during the restore. Check docker logs $PROJECT-backend-1, then deploy.sh --rollback $PREV"
  fi
  log "$OUTCOME"
}
fail() { restore; die "$1. $OUTCOME"; }

if [ "$MODE" = deploy ] || ! docker image inspect "clics-backend:$SHA" "clics-rimpl:$SHA" >/dev/null 2>&1; then
  log "building clics-backend:$SHA and clics-rimpl:$SHA"
  dc build --pull || die "build failed; nothing was restarted"
fi

if running_backend_token_differs; then
  log "INTERNAL_TOKEN is changing (the running backend holds a different one from rimpl.env): stopping the backend before rimpl is recreated"
  dc stop backend || die "could not stop the running backend; nothing was restarted"
  STOPPED_BACKEND=1
fi
log "starting rimpl"
dc up -d --no-deps --wait --wait-timeout 180 rimpl || fail "the rimpl of $SHA did not become healthy"
log "gate 1: rimpl health and INTERNAL_TOKEN, checked BEFORE the backend (and its evaluation drain) starts"
g=0
gate_rimpl || g=$?
if [ "$g" = 2 ]; then
  # Strict on purpose, unlike restore(): an activation never makes a degraded rimpl current, even with its
  # token proven. restore() then decides what runs.
  fail "gate 1 failed for $SHA: its rimpl accepted INTERNAL_TOKEN but is DEGRADED (down: $(down_checks)), and an activation never makes a degraded rimpl current, so this one stopped before starting its backend"
elif [ "$g" != 0 ]; then
  fail "gate 1 (rimpl health + INTERNAL_TOKEN) failed for $SHA, before its backend was started"
fi
log "starting backend"
start_backend || fail "the backend of $SHA did not become healthy"
curl -fsS --max-time 10 "http://127.0.0.1:$PORT/health" >/dev/null || fail "the backend is not answering on 127.0.0.1:$PORT"
# grep -c reads all of its input, so no SIGPIPE can turn a match into a pass under pipefail.
beyond=$(ss -Hltn "sport = :$PORT" | grep -vc "127.0.0.1:$PORT" || true)
if [ "${beyond:-0}" -gt 0 ]; then fail "port $PORT is listening beyond loopback"; fi
log "gate 2: backend /health/deep"
gate backend || fail "gate 2 (backend /health/deep) failed for $SHA"

ln -sfn "releases/$SHA" "$BASE/.current.next" && mv -Tf "$BASE/.current.next" "$BASE/current"
if [ -n "$PREV" ] && [ "$PREV" != "$SHA" ]; then
  ln -sfn "releases/$PREV" "$BASE/.previous.next" && mv -Tf "$BASE/.previous.next" "$BASE/previous"
fi
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $MODE $SHA prev=${PREV:-none}" >> "$BASE/deploys.log"
log "active: $SHA ($MODE); $BASE/current -> releases/$SHA"
ACTIVATED=1   # the last statement: finish() records success only after this
