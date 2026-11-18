# A booth visitor sees a fixed 0–100 rescale of the stored demo score

The kiosk result and the board show a five-step play's demo score through one fixed, strictly increasing map, `display-v1`: raw composite 26 shows as 0, 65 as 100, linear in between, rounded to a whole number and clamped at both ends. `booth_plays` still stores the raw composite and d1–d7 that the path score table gives (ADR 0009), and the auditor reveal, the open dataset, the purge summary and research read only those. The per-domain values and their low/mid/high bands stay on the raw rubric scale. We chose this because the ten admitted NFCME-2026 tables give raw composites of 26–65 only (median 46, p5–p95 35–55, over all 2,430 paths), so on a "/ 100" card most visitors land in the 40s and most of the range is never reached. The owner wants the card to use the whole 0–100 and the raw score kept apart for research, including digital-twin work.

## Considered options

- **Rescale the domains too**: every band would become reachable. But the band lines are written against the rubric's 0 → 3 → 5 anchors and carry a safety review, so a d6 shown "high" over a raw score below the rubric's midpoint would say something false. d6 is also too flat to split into three bands (61% of paths sit at 1.0).
- **A per-case rescale**: each case would span 0–100. But it reorders the board across cases, and the board would no longer rank on a number derived from the stored score alone.
- **A percentile of the pool's paths**: it spreads the middle, but paths are not played uniformly, and the number would read as "better than X% of visitors", which it is not.
- **Rebuilding the tables to spread the raw scores**: that needs paid evaluator runs and tree edits for every case, and still could not promise the range.

## Consequences

- The board order is unchanged: it ranks on the raw composite, and the map never reorders two scores. Two raw scores can show the same number only when both clamp at 0 or at 100.
- The number on the card is not a PIS-7 composite. The card already labels it a demo score, not CME credit, and the auditor reveal shows the raw composite.
- A display number is converted back to raw with raw = 26 + display × 39 / 100, to within rounding. The scale's name and anchors live in `backend/src/booth-cases/display-score.js`.
- Changing an anchor makes a new scale version and needs a PR and a deploy. A case admitted later whose paths fall outside 26–65 clamps until the scale is re-anchored.
- Three-step events show the raw score unchanged.
