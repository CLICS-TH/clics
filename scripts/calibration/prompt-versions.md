# PIS-7 Evaluator Prompt — Calibration Versions

Archive of `PIS7_EVALUATOR_PROMPT` (`rimpl/src/lib/prompts.js`) revisions and the ICC each produced
on the fixed soak cohort (`--mode rescore`). Goal: lift AI↔human ICC from 0.66 toward ≥0.75 by
removing the AI's leniency on templated/structured reasoning. (See README caveats — these are
directional, not a passed gate.)

| Version | Prompt sha (first 12) | ICC (95% CI) | d2 Δ | d3 Δ | What changed |
|---------|-----------------------|--------------|------|------|--------------|
| v0 (soak baseline) | _from `--mode baseline`_ | 0.662 (0.40–0.83) | +0.80 | +0.83 | original prompt (2026-06-07) |
| v1 | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |

## Notes per version

### v0 — original (2026-06-07)
Domains/weights only, 0–5 scale with one-word anchors (0 Not observed … 5 Very High). No guidance
distinguishing genuine reasoning depth from templated structure → AI rewards effort/structure.

### v1 — _tbd_
