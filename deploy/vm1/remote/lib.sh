# shellcheck shell=bash
# SC2317 ("command appears to be unreachable") is disabled file-wide: this library is prepended to every
# step, and each step calls only some of its functions, so the rest always look unreachable to the linter.
# shellcheck disable=SC2317
# Prepended by deploy/vm1/deploy.sh to every remote step. Steps run as `bash -s -- BASE PROJECT PORT SHA
# MODE RUN` inside `{ ... } </dev/null`; activate runs the same text from runs/<RUN>/activate.sh, detached
# (see launch.sh). Not executed on its own. CI lints each step as sent: lib.sh + <step>.sh.
set -euo pipefail
log() { echo "[vm1] $*"; }
die() { echo "[vm1] ERROR: $*" >&2; exit 1; }
# Not every step uses every argument (attach uses none of SHA, MODE, RUN).
# shellcheck disable=SC2034
BASE=$1 PROJECT=$2 PORT=$3 SHA=$4 MODE=$5 RUN=${6:-}
# The front ends' loopback ports (#429): docker-compose.yml publishes them and the host nginx proxies to them
# (scripts/deploy/vm1.test.mjs checks the three agree).
# shellcheck disable=SC2034
PORTAL_PORT=3103 DASHBOARD_PORT=3104

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

# Local-only mode (ADR 0012, #428): CLICS_LOCAL_ONLY, read as rimpl/src/lib/provider-policy.js reads it
# (trimmed, lower-cased; unset, blank, 0, false, off or no is off; anything else is on). rimpl is the process
# that refuses commercial calls, so the mode is on only when rimpl.env has it on. The backend lists and
# switches providers as if on when either file has it on (it reads rimpl's through GET /health/mode), so
# on in backend.env alone would hide the commercial providers while rimpl still calls them: refused. More
# than one line in either file is refused too. Prints on/off only.
check_local_only() {
  local f mode rimpl backend
  for f in rimpl backend; do
    mode=$(awk '
      /^[[:space:]]*(export[[:space:]]+)?CLICS_LOCAL_ONLY[[:space:]]*=/ {
        n++; v = $0; sub(/^[^=]*=/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); v = tolower(v)
      }
      END {
        if (n > 1) { print "many"; exit }
        print (n == 0 || v == "" || v == "0" || v == "false" || v == "off" || v == "no") ? "off" : "on"
      }' "$BASE/env/$f.env")
    [ "$mode" != many ] || die "$f.env assigns CLICS_LOCAL_ONLY more than once; keep one line. Nothing was changed."
    if [ "$f" = rimpl ]; then rimpl=$mode; else backend=$mode; fi
  done
  if [ "$backend" = on ] && [ "$rimpl" = off ]; then
    die "backend.env turns local-only mode on (CLICS_LOCAL_ONLY) but rimpl.env does not: rimpl is the process that refuses commercial AI, so set it in rimpl.env too. Nothing was changed."
  fi
  log "local-only mode $rimpl (CLICS_LOCAL_ONLY: rimpl.env $rimpl, backend.env $backend)"
}

# The on-prem model block in rimpl.env is DECLARED and never ROUTED (#424), and its two instances are two
# model artifacts (CCME R3). Refused: any provider-selecting name (AI_PROVIDER, AI_PROVIDER_<PURPOSE>,
# EMBED_PROVIDER, SHADOW_EVAL_PROVIDER, CHAT_FAILOVER_PROVIDER) set to `local` or `local-tutor`, read as
# rimpl/src/services/ai.js reads it (trimmed, lower-cased); a second line for any of the four
# BASE_URL/MODEL names; any of those names holding # or $ (compose would read a comment or a
# variable there, not the value checked); and an evaluator and tutor whose base URL and model are equal, compared the way
# rimpl's endpointKey() compares them (scheme and host case, a default port and trailing slashes do
# not make another box). awk compares in-process and prints names only, never a value.
check_model_block() {
  local f=$BASE/env/rimpl.env msg
  msg=$(awk -v q="'" '
    function val(s) {
      sub(/^[^=]*=/, "", s); sub(/\r$/, "", s); gsub(/^[ \t]+|[ \t]+$/, "", s)
      if (s ~ /^".*"$/ || s ~ ("^" q ".*" q "$")) s = substr(s, 2, length(s) - 2)
      gsub(/^[ \t]+|[ \t]+$/, "", s); return s
    }
    function endpoint(u,   scheme, rest, host, path, i) {
      if (!match(u, /^[A-Za-z][A-Za-z0-9+.-]*:\/\//)) { sub(/\/+$/, "", u); return tolower(u) }
      scheme = tolower(substr(u, 1, RLENGTH - 3)); rest = substr(u, RLENGTH + 1)
      i = index(rest, "/"); host = tolower(i ? substr(rest, 1, i - 1) : rest); path = i ? substr(rest, i) : ""
      if (scheme == "https") sub(/:443$/, "", host); if (scheme == "http") sub(/:80$/, "", host)
      sub(/\/+$/, "", path); return scheme "://" host path
    }
    {
      line = $0; sub(/^[ \t]*(export[ \t]+)?/, "", line)
      if (!match(line, /^[A-Z][A-Z0-9_]*[ \t]*=/)) next
      name = substr(line, 1, RLENGTH); sub(/[ \t]*=$/, "", name)
      watched = name ~ /^(AI_PROVIDER(_[A-Z0-9_]+)?|EMBED_PROVIDER|SHADOW_EVAL_PROVIDER|CHAT_FAILOVER_PROVIDER|LOCAL_(TUTOR_)?AI_(BASE_URL|MODEL))$/
      if (watched && val(line) ~ /[#$]/) { print "rimpl.env: " name " holds # or $, which docker compose reads as a comment or a variable, so this check cannot see the value rimpl gets. Write the plain value. Nothing was changed."; failed = 1; exit 1 }
      if (name ~ /^(AI_PROVIDER(_[A-Z0-9_]+)?|EMBED_PROVIDER|SHADOW_EVAL_PROVIDER|CHAT_FAILOVER_PROVIDER)$/) {
        p = tolower(val(line))
        if (p == "local" || p == "local-tutor") { print "rimpl.env routes to the on-prem model: " name " names " p ". This deploy declares the model block and routes nothing to it (#424). Delete the line. Nothing was changed."; failed = 1; exit 1 }
      }
      if (name ~ /^LOCAL_(TUTOR_)?AI_(BASE_URL|MODEL)$/) {
        if (++seen[name] > 1) { print "rimpl.env assigns " name " more than once; keep one line. Nothing was changed."; failed = 1; exit 1 }
        v[name] = val(line)
      }
    }
    END {
      if (failed) exit 1
      if (v["LOCAL_AI_BASE_URL"] != "" && v["LOCAL_AI_MODEL"] != "" &&
          endpoint(v["LOCAL_AI_BASE_URL"]) == endpoint(v["LOCAL_TUTOR_AI_BASE_URL"]) &&
          v["LOCAL_AI_MODEL"] == v["LOCAL_TUTOR_AI_MODEL"]) {
        print "rimpl.env: the evaluator (LOCAL_AI_BASE_URL + LOCAL_AI_MODEL) and the tutor (LOCAL_TUTOR_AI_BASE_URL + LOCAL_TUTOR_AI_MODEL) resolve to the same base URL and model. CCME R3 requires two model artifacts. Nothing was changed."; exit 1
      }
      for (e = 0; e < 2; e++) {
        pre = e ? "LOCAL_TUTOR_AI" : "LOCAL_AI"; who = e ? "tutor" : "evaluator"
        if (v[pre "_BASE_URL"] != "" && v[pre "_MODEL"] != "") print "on-prem " who " declared (" pre "_BASE_URL, " pre "_MODEL), routed to nothing"
        else print "WARNING: on-prem " who " not declared: " pre "_BASE_URL or " pre "_MODEL has no value"
      }
    }' "$f") || die "$msg"
  while IFS= read -r l; do log "$l"; done <<< "$msg"
}

# Self-hosted sign-in (#427, docker-compose.auth.yml). Its secrets live only in gotrue.env and postgrest.env
# (R6), so: a GoTrue or PostgREST name in backend.env or rimpl.env, or one service's name in the other's file,
# is refused wherever it appears. With neither file present, sign-in is not configured on this host and
# nothing else is checked. With either present (or `required`, from the rehearsal), both must be there at
# mode 600 owned by clics, every required name must have a value, the JWT secret must be at least 32
# characters, and GoTrue's and PostgREST's JWT secrets must be byte-identical (compared by sha256).
AUTH_GOTRUE_REQUIRED="GOTRUE_JWT_SECRET GOTRUE_DB_DATABASE_URL GOTRUE_SMTP_PASS GOTRUE_EXTERNAL_GOOGLE_SECRET API_EXTERNAL_URL GOTRUE_JWT_EXP GOTRUE_SITE_URL GOTRUE_URI_ALLOW_LIST GOTRUE_SMTP_HOST GOTRUE_SMTP_PORT GOTRUE_SMTP_USER GOTRUE_SMTP_ADMIN_EMAIL GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI"
AUTH_POSTGREST_REQUIRED="PGRST_JWT_SECRET PGRST_DB_URI"
auth_value_sha() { grep -E "^$2=" "$1" | sed "s/^$2=//" | sha256sum; }
check_auth_env() {
  local f n g=$BASE/env/gotrue.env p=$BASE/env/postgrest.env
  for f in backend.env rimpl.env; do
    n=$(grep -oE '^[[:space:]]*(export[[:space:]]+)?(GOTRUE_[A-Z0-9_]*|PGRST_[A-Z0-9_]*|API_EXTERNAL_URL)[[:space:]]*=' "$BASE/env/$f" | head -n 1 | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/[[:space:]]*=$//' || true)
    [ -z "$n" ] || die "$f sets $n, a self-hosted sign-in name: it belongs in gotrue.env or postgrest.env only (R6). Delete it from $f. Nothing was changed."
  done
  if [ ! -e "$g" ] && [ ! -e "$p" ]; then
    log "self-hosted sign-in not configured on this host (no gotrue.env or postgrest.env); this deploy starts the backend and rimpl only"
    return 0
  fi
  for f in "$g" "$p"; do
    [ -f "$f" ] || die "$f is missing: gotrue.env and postgrest.env go together, created by a human from deploy/vm1/$(basename "$f").example. Nothing was changed."
    [ "$(stat -c %a "$f")" = 600 ] || die "$f must be mode 600 (it is $(stat -c %a "$f")). Nothing was changed."
    [ "$(stat -c %U "$f")" = clics ] || die "$f must be owned by clics (it is $(stat -c %U "$f")). Nothing was changed."
  done
  if grep -qE '^[[:space:]]*(export[[:space:]]+)?PGRST_' "$g"; then die "gotrue.env sets a PGRST_ name: it belongs in postgrest.env. Nothing was changed."; fi
  if grep -qE '^[[:space:]]*(export[[:space:]]+)?(GOTRUE_|API_EXTERNAL_URL)' "$p"; then die "postgrest.env sets a GoTrue name: it belongs in gotrue.env. Nothing was changed."; fi
  for n in $AUTH_GOTRUE_REQUIRED; do grep -qE "^$n=.+" "$g" || die "gotrue.env: $n has no value. Nothing was changed."; done
  for n in $AUTH_POSTGREST_REQUIRED; do grep -qE "^$n=.+" "$p" || die "postgrest.env: $n has no value. Nothing was changed."; done
  for n in GOTRUE_JWT_SECRET:"$g" PGRST_JWT_SECRET:"$p"; do
    [ "$(grep -cE "^[[:space:]]*(export[[:space:]]+)?${n%%:*}[[:space:]]*=" "${n#*:}")" = 1 ] \
      || die "$(basename "${n#*:}") must assign ${n%%:*} exactly once, as ${n%%:*}=value at the start of its line. Nothing was changed."
  done
  # Base64 characters only, unquoted: compose strips quotes and interpolates $ (and # starts a comment),
  # while auth-role-keys.cjs reads the file raw, so anything else would mint keys GoTrue then rejects.
  for n in GOTRUE_JWT_SECRET:"$g" PGRST_JWT_SECRET:"$p"; do
    grep -qE "^${n%%:*}=[A-Za-z0-9+/=_-]+\$" "${n#*:}" \
      || die "write GOTRUE_JWT_SECRET and PGRST_JWT_SECRET unquoted, in base64 characters only (openssl rand -base64 48). Nothing was changed."
  done
  [ "$(grep -E '^GOTRUE_JWT_SECRET=' "$g" | sed 's/^GOTRUE_JWT_SECRET=//' | tr -d '\n' | wc -c)" -ge 32 ] \
    || die "gotrue.env: GOTRUE_JWT_SECRET is shorter than 32 characters; generate it with openssl rand -base64 48. Nothing was changed."
  [ "$(auth_value_sha "$g" GOTRUE_JWT_SECRET)" = "$(auth_value_sha "$p" PGRST_JWT_SECRET)" ] \
    || die "GOTRUE_JWT_SECRET (gotrue.env) and PGRST_JWT_SECRET (postgrest.env) differ (compared by sha256: same value, same quoting, no trailing space or CR). Nothing was changed."
  log "self-hosted sign-in env ok (gotrue.env, postgrest.env)"
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
# exists. status holds the exit code; a second line says why when a signal interrupted the run (only
# activate's ACTIVATED=1 path records 0). Read-only: following twice, or losing the follower halfway,
# does nothing to the activation.
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
  local run=$1 name unit finished rc why
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
  why=$(sed -n 2p "$run/status")
  case "$rc" in ''|*[!0-9]*) die "$run/status does not hold an exit code" ;; esac
  if [ "$rc" = 0 ]; then
    log "activation $name succeeded"
  else
    log "activation $name FAILED (exit $rc${why:+, $why}); the lines above say what is running on vm1 now"
  fi
  return "$rc"
}
