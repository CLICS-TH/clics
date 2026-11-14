#!/usr/bin/env bash
# Decides which CI jobs a pull request runs (.github/workflows/ci.yml, the fast-checks job's first step).
# CI and the local proof run this same file, so what the proof shows is what CI does.
# Usage: ci-select.sh <event> < changed-paths   (one repo-relative path per line)
# Prints "<job>=true|false" per job, ready for "$GITHUB_OUTPUT".
# Any event other than pull_request (the push to master) selects every job, so a rule that is
# too narrow is caught right after merge, in the open, never by a silent skip.
#
# Each rule lists every path the job's steps and the scripts they call read, cross-layer reads
# included (a test that opens another layer's source as text counts). When a test starts reading a
# new path outside its job's rule, add the path here in the same PR. Runs on bash 3.2 (macOS).
set -euo pipefail
event=${1:?usage: ci-select.sh <event> < changed-paths}

# One "job  extended-regex" per line (whitespace-separated; no regex may contain a space).
# job "ALL": a change here selects every job (workflows, this script, the root manifest + lockfile).
RULES='
ALL               ^(\.github/|package\.json$|package-lock\.json$)
backend           ^(backend/|rimpl/src/|rimpl/tests/helpers/|db/|scripts/booth/sandbox|scripts/booth/open-dataset-step-keys\.json$|scripts/booth/path-table-sample\.js$|scripts/booth/(spend-ledger|build-path-tables|path-table|path-fit)\.mjs$|scripts/booth/sample-replies/|scripts/booth/path-table-runs/|scripts/.*\.(js|mjs|cjs|ts)$|audit-dashboard/(app|components|lib)/|physician-ui/public/js/)
license_verifier  ^license-verifier/
rimpl             ^(rimpl/|backend/src/booth-cases/|backend/src/services/(booth-dialogue|ple-gate|rimpl-client)\.js$|backend/src/lib/pii-spans\.js$)
dashboard         ^(audit-dashboard/|physician-ui/public/|backend/src/|db/|rimpl/src/lib/)
physician_ui      ^physician-ui/public/js/
probe             ^(scripts/probe/|rimpl/src/|backend/src/services/)
quality           ^(scripts/quality/|scripts/probe/|rimpl/src/|physician-ui/public/js/ple-chat\.js$)
vm1               ^(deploy/|scripts/deploy/|scripts/dev/|scripts/lib/|scripts/readability/|scripts/responsive/nav-width-audit\.mjs$|physician-ui/|audit-dashboard/|backend/|rimpl/|db/schema\.sql$)
vm1_guards        (\.md$|^scripts/|^physician-ui/public/js/config\.js$|^(physician-ui|audit-dashboard)/vercel\.json$)
manifest          ^(scripts/manifest/|rimpl/src/)
pg                ^(scripts/db/|db/)
calibration       ^(scripts/calibration/|scripts/probe/(lib|agreement-stats)\.mjs$|rimpl/src/|backend/src/(services|lib)/)
manuals           ^(scripts/manuals/|docs/manuals/|physician-ui/public/|audit-dashboard/|rimpl/src/|backend/src/lib/pii-spans\.js$)
portal_browser    ^(scripts/auth/|physician-ui/public/|audit-dashboard/)
responsive        ^(scripts/(responsive|chat)/|scripts/lib/api-origin\.cjs$|physician-ui/public/)
booth_kiosk       ^(scripts/booth/|physician-ui/public/(booth|css/(booth|fonts\.css$)|js/(booth-|ui\.js$|icons\.js$|config\.js$|vendor/)|fonts/|img/booth|favicon\.svg$)|backend/src/booth-cases/|backend/tests/fixtures/booth-|backend/src/services/booth-dialogue\.js$)
booth_scripts     ^(scripts/booth/|rimpl/src/lib/booth-cache(\.js|-calibration\.json)$|backend/src/services/(ple-gate|booth-dialogue)\.js$|backend/src/booth-cases/|backend/src/lib/schemas\.js$|backend/tests/fixtures/booth-|physician-ui/public/booth-sw\.js$|rimpl/src/services/pii-(filter|names\.th|clinical-words\.th)\.js$|rimpl/src/lib/provider-policy\.js$|backend/src/lib/(pricing|pii-spans)\.js$|scripts/manuals/lib/pii-gate\.mjs$)
'

jobs=$(printf '%s\n' "$RULES" | awk 'NF == 2 && $1 != "ALL" { print $1 }')
changed=$(cat)

all=false
if [ "$event" != pull_request ]; then
  all=true
else
  all_re=$(printf '%s\n' "$RULES" | awk '$1 == "ALL" { print $2 }')
  if [ -n "$all_re" ] && printf '%s\n' "$changed" | grep -Eq "$all_re"; then all=true; fi
fi

for job in $jobs; do
  on=$all
  if [ "$on" = false ]; then
    re=$(printf '%s\n' "$RULES" | awk -v j="$job" '$1 == j { print $2 }')
    if [ -n "$changed" ] && printf '%s\n' "$changed" | grep -Eq "$re"; then on=true; fi
  fi
  echo "$job=$on"
done
