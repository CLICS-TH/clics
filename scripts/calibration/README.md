# ICC Calibration Harness (G1 credit gate)

CME credit is gated on AI↔human agreement at **ICC ≥ 0.75**. The 2026-06-07 soak measured pooled
AI↔human **ICC = 0.662** (n≈30 pairs, 95% CI ~0.40–0.83) while inter-rater ICC = 0.97 — the human
auditors agree; the **PIS-7 AI evaluator is systematically lenient (+10.3 pts)**, over-crediting
templated/structured reasoning (worst on **d2 Reasoning Depth** and **d3 Contextual Integration**).

`calibrate.js` measures ICC on the fixed soak cohort and reports per-domain divergence so the
`PIS7_EVALUATOR_PROMPT` (`rimpl/src/lib/prompts.js`) can be tuned and re-measured.

## Run

```bash
# baseline — ICC from STORED ai_evaluations (no Claude); must reproduce ≈0.66 (harness sanity check)
cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/calibration/calibrate.js --mode baseline

# rescore — re-score the transcripts via LIVE RIMPL/Claude, then ICC of the new AI scores vs humans
#   needs RIMPL running:  (cd rimpl && npm start)   with ANTHROPIC_API_KEY in rimpl/.env
cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/calibration/calibrate.js --mode rescore
```

Each run prints ICC + 95% CI + per-domain (AI vs human, +Δ = AI inflates) + per-CLE deltas, and
archives a JSON to `runs/<stamp>-<mode>.json` (incl. the PIS-7 prompt sha, so runs are diffable).

## Iterate

1. `--mode baseline` → confirm ≈0.66.
2. `--mode rescore` on the current prompt → confirm ≈0.66 (± Claude nondeterminism).
3. Edit `PIS7_EVALUATOR_PROMPT` (tighten d2/d3 anchors: structure ≠ depth; score templated/scripted
   reasoning LOW). Record the change + result in `prompt-versions.md`.
4. `--mode rescore` → compare ICC + whether d2/d3 inflation shrank. Repeat.

## ⚠️ Caveats — read before quoting a number

- **Overfitting:** tuning the prompt on the *same* 10 CLEs you measure on inflates the apparent ICC.
  ≥0.75 here is **necessary, not sufficient**.
- **Wide CI:** at n≈30 pairs the 95% CI is ~0.40–0.83 — the point estimate is statistically fragile.
- So a passing run here is a **directional signal**, not a passed gate. Real sign-off needs a larger
  / held-out cohort (the July calibration workshop).
