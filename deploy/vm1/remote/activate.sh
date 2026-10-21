# activate: build, start rimpl, gate, start the backend, gate, flip /opt/clics/current (deploy/vm1/deploy.sh).
#
# deploy.sh does not run this over its SSH session: launch.sh starts it DETACHED, as a systemd transient
# unit, so a dropped connection cannot stop it between "rimpl recreated" and "restore". With a RUN id it
# writes everything to runs/<RUN>/log and its exit code to runs/<RUN>/status; without one (the tests) it
# writes to stdout.
#
# The rule every path below keeps, restore() included: the backend is only ever started after rimpl has
# passed gate 1 (health + INTERNAL_TOKEN). Its evaluation drain claims queued PLEs the moment it boots
# (backend/src/services/eval-drain.js:180), and a 401 from rimpl sends each one to manual QA
# (eval-drain.js:99-101) on the shared production database. Nothing here runs a service-less `up`.
if [ -n "$RUN" ]; then
  RUN_DIR=$BASE/runs/$RUN
  exec >>"$RUN_DIR/log" 2>&1
  trap 'rc=$?; echo "$rc" > "$RUN_DIR/status.tmp" && mv -f "$RUN_DIR/status.tmp" "$RUN_DIR/status"' EXIT
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
    OUTCOME="CLICS's backend on vm1 is STOPPED, because $1. It stays stopped until it is started again; deploy.sh starts it only after rimpl passes gate 1"
  else
    OUTCOME="$1, and stopping CLICS's backend FAILED: stop it by hand on vm1 now (docker stop $PROJECT-backend-1), or its evaluation drain may send queued PLEs to manual QA"
  fi
  log "!!! $OUTCOME"
}

# Put back the release /opt/clics/current pointed at when this run began (on a re-activation, this same
# sha), in the order a deploy uses: rimpl, gate 1, and only then the backend. On any failure the backend
# is STOPPED rather than left to drain against a rimpl that may refuse it. restore() never runs `down`.
restore() {
  if [ -z "$PREV" ]; then
    # Nothing was live on this host before this run. `stop`, not `down`: restore() removes nothing.
    if dc stop backend rimpl; then
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
  fi
  if ! dc up -d --no-deps --wait --wait-timeout 180 rimpl; then
    stop_backend "the rimpl of $PREV did not become healthy during the restore"
    return 0
  fi
  if ! gate rimpl; then
    stop_backend "the rimpl of $PREV failed gate 1 (health + INTERNAL_TOKEN) during the restore"
    return 0
  fi
  if dc up -d --no-deps --wait --wait-timeout 180 backend; then
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
fi
log "starting rimpl"
dc up -d --no-deps --wait --wait-timeout 180 rimpl || fail "the rimpl of $SHA did not become healthy"
log "gate 1: rimpl health and INTERNAL_TOKEN, checked BEFORE the backend (and its evaluation drain) starts"
gate rimpl || fail "gate 1 (rimpl health + INTERNAL_TOKEN) failed for $SHA, before its backend was started"
log "starting backend"
dc up -d --no-deps --wait --wait-timeout 180 backend || fail "the backend of $SHA did not become healthy"
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
