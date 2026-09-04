#!/bin/sh
# Canary before spending the held-out split.
#
# The box answers a 6k-token prompt in 6s and still fails a real PIS-7 evaluation fifteen minutes
# later: the constraint is decode, not input size, and it comes and goes. A held-out run costs a
# sample that cannot be replaced, so prove the box can do the REAL workload first — on a tuning
# fixture, which is already spent.
#
# Usage:  sh scripts/probe/canary.sh            (needs LOCAL_AI_* + ANTHROPIC_API_KEY in env)
# Exit 0 = box did a full evaluation; anything else = do not start the held-out run.
set -e
cd "$(dirname "$0")/../.."
OUT=$(mktemp); LOG=$(mktemp)
node scripts/probe/model-agreement.mjs --split tuning --consistency off \
  --attempts 1 --only ple-001 --out "$OUT" > "$LOG" 2>&1 || true
if grep -q '✔' "$LOG"; then
  grep -E '✔' "$LOG"
  echo "CANARY OK — box completed a real evaluation; the held-out run may start."
  exit 0
fi
grep -E '✘|retry' "$LOG" | head -3
echo "CANARY FAILED — do NOT spend the held-out split. Wait and retry."
exit 1
