# attach: follow the most recent activation's log, from its first line, to its result (deploy.sh --attach).
# Read-only, so it is safe to run at any time, as often as needed, while the activation runs or after.
[ -L "$BASE/runs/latest" ] || die "no activation has been launched on this host ($BASE/runs/latest is missing)"
run=$(readlink -f "$BASE/runs/latest")
log "following activation $(basename "$run")"
rc=0
follow_run "$run" || rc=$?
exit "$rc"
