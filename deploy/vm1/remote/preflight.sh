# preflight: read-only checks on vm1 before anything is uploaded or restarted (deploy/vm1/deploy.sh).
# Nothing here prints an env value: names are tested with grep -q, INTERNAL_TOKEN lines by sha256.
[ "$(uname -m)" = x86_64 ] || die "host is $(uname -m); rimpl/Dockerfile downloads amd64 Tailscale binaries"
command -v docker >/dev/null || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "the docker compose v2 plugin is not installed"
log "$(docker --version) / $(docker compose version)"
# systemd-run + systemctl: activate runs detached, as a transient unit (launch.sh).
for c in curl ss flock sha256sum systemd-run systemctl; do command -v "$c" >/dev/null || die "$c is not installed"; done
id -u clics >/dev/null 2>&1 || die "user clics does not exist (one-time setup in deploy/vm1/README.md)"
for f in backend.env rimpl.env; do
  p="$BASE/env/$f"
  [ -f "$p" ] || die "$p is missing: a human creates it from deploy/vm1/$f.example"
  [ "$(stat -c %a "$p")" = 600 ] || die "$p must be mode 600 (it is $(stat -c %a "$p"))"
  [ "$(stat -c %U "$p")" = clics ] || die "$p must be owned by clics (it is $(stat -c %U "$p"))"
done
for n in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY INTERNAL_TOKEN GUEST_TOKEN_SECRET \
         IDENTITY_ENC_KEY ALLOWED_ORIGINS SITE_URL LICENSE_VERIFIER_ADAPTER; do
  grep -qE "^$n=.+" "$BASE/env/backend.env" || die "backend.env: $n has no value"
done
for n in INTERNAL_TOKEN ANTHROPIC_API_KEY SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  grep -qE "^$n=.+" "$BASE/env/rimpl.env" || die "rimpl.env: $n has no value"
done
check_internal_token
for n in TS_AUTHKEY LOCAL_AI_HTTP_PROXY LOCAL_TUTOR_AI_HTTP_PROXY; do
  if grep -qE "^$n=.+" "$BASE/env/rimpl.env"; then die "rimpl.env sets $n, which is Railway-only (see rimpl.env.example)"; fi
done
for n in RIMPL_URL PORT NODE_ENV; do
  if grep -qE "^$n=" "$BASE/env/backend.env"; then log "WARNING: backend.env sets $n; docker-compose.yml overrides it"; fi
done
check_reconcile
check_model_block
check_auth_env
# The loopback port is free, or held by CLICS's own backend.
if [ -n "$(ss -Hltn "sport = :$PORT")" ]; then
  [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=backend)" ] \
    || die "port $PORT is in use by something that is not CLICS"
fi
# The compose project name is ours: every container labelled with it must come from $BASE/releases.
dirs=$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.project.working_dir"}}' | sort -u)
while IFS= read -r wd; do
  [ -n "$wd" ] || continue
  case "$wd" in "$BASE/releases/"*) ;; *) die "a compose project named $PROJECT already runs from $wd" ;; esac
done <<< "$dirs"
check_current_release
if [ "$MODE" = rollback ]; then
  [ -f "$BASE/releases/$SHA/deploy/vm1/docker-compose.yml" ] || die "release $SHA is not on this host (ls $BASE/releases)"
fi
log "preflight ok"
