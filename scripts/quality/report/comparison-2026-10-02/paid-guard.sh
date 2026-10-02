#!/bin/bash
# Runs the paid Anthropic arm in batches of 5 items; stops before the next batch once spend >= STOP_USD.
W=/private/tmp/claude-501/-Users-napat-Desktop-CLICS/f5f8f0cc-06c9-4d40-970e-21f4ea3c67b7/scratchpad/wt-paid
LABEL=anthropic-sonnet-2026-10-02
REPORT=$W/scripts/quality/report/$LABEL.json
STOP_USD=1.70
cd $W
set -a; . /Users/napat/Desktop/CLICS/rimpl/.env; set +a
unset LOCAL_AI_BASE_URL LOCAL_AI_API_KEY LOCAL_AI_MODEL
cost() { python3 - "$REPORT" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print("0 0 0 0"); sys.exit()
i=o=n=0
for it in d['items']:
  for k in ('first','retry'):
    c=it.get(k)
    if c: i+=c.get('prompt_tokens') or 0; o+=c.get('completion_tokens') or 0
  n+=1 if it.get('final') and it['final'].get('ok') else 0
print(f"{i*3/1e6+o*15/1e6:.4f} {i} {o} {n}")
PY
}
for LIM in $(seq 5 5 80); do
  read USD IN OUT DONE <<<"$(cost)"
  echo "[guard] before limit=$LIM: spent \$$USD (in $IN / out $OUT tokens), answered $DONE"
  if python3 -c "import sys; sys.exit(0 if float('$USD')>=$STOP_USD else 1)"; then echo "[guard] STOP: spend reached \$$USD >= \$$STOP_USD"; break; fi
  RESUME=""; [ -f "$REPORT" ] && RESUME="--resume"
  PROBE_TIMEOUT_MS=180000 node scripts/quality/tutor-audit.mjs --arm anthropic --allow-paid --concurrency 2 --limit $LIM --label $LABEL $RESUME 2>&1 | grep -E "✔|✖|error|Error|refus" 
done
read USD IN OUT DONE <<<"$(cost)"
echo "[guard] FINAL: spent \$$USD (in $IN / out $OUT tokens), answered $DONE/80"
