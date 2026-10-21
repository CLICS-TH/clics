# launch: start activate DETACHED on vm1, then follow its log to its result (deploy/vm1/deploy.sh).
#
# Why detached: activate recreates containers and, on a failure, restores the previous release. If it ran
# inside this SSH session, a dropped connection (the Mac sleeps, the network blips) would kill it between
# the two, and nothing would restore anything. So it runs as a systemd transient unit, outside this
# session and outside tailscaled's own cgroup. deploy.sh staged its script at runs/<RUN>/activate.sh just
# before this step. It writes its output to runs/<RUN>/log and its exit code to runs/<RUN>/status; this
# step only prints that log as it grows. If this step dies, the activation does not: `deploy.sh --attach`
# follows it again.
[ -n "$RUN" ] || die "launch needs a run id"
run=$BASE/runs/$RUN
unit=clics-activate-$RUN
[ -f "$run/activate.sh" ] || die "run $RUN was not staged ($run/activate.sh is missing); nothing was started"
[ ! -e "$run/log" ] || die "run $RUN was launched already; follow it with deploy.sh --attach"
# activate takes this lock itself; checking it here refuses a second deploy before it creates a run.
flock -n "$BASE/.deploy.lock" true || die "another activation holds $BASE/.deploy.lock; follow it with deploy.sh --attach. Nothing was started"
: > "$run/log"
ln -sfn "$RUN" "$BASE/runs/.latest.next" && mv -Tf "$BASE/runs/.latest.next" "$BASE/runs/latest"
# A transient unit starts with systemd's environment, not this session's: PATH and HOME are passed on so
# docker and its compose plugin resolve exactly as they do over SSH.
systemd-run --unit="$unit" --collect --quiet --setenv=PATH="$PATH" --setenv=HOME="${HOME:-/root}" \
  /bin/bash "$run/activate.sh" "$BASE" "$PROJECT" "$PORT" "$SHA" "$MODE" "$RUN" \
  || die "systemd-run could not start $unit; nothing was started"
log "activation $RUN started detached, as systemd unit $unit (log: $run/log)"
log "if this connection drops, the activation carries on; follow it again with deploy.sh --attach"
rc=0
follow_run "$run" || rc=$?
exit "$rc"
