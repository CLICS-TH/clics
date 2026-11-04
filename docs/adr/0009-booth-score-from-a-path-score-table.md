# A booth play's demo score is read from a path score table, not scored live

A booth play's demo score is a lookup on (case version, tier path) in the case's path score table, which lives in the case file with its provenance (evaluator model id, prompt sha, decoding, samples per path, run id, date). The table is built before admission by the locked PIS-7 evaluator, called unchanged through rimpl on the API, over sample transcripts walked along each path; the AI replies inside those samples may be written in a Claude Code session, but the scoring never is. A 3-step case measures all 27 paths, 3 samples each, median per domain. A 5-step case scores a balanced 27-path sample, 3 samples each, and fills all 243 paths from a median regression of each domain on step × tier, domains kept to one decimal. We chose this because the owner requires one case played with the same answers to score the same every time (#360), and one live evaluator call cannot: the evaluator moves at temperature 0, and on one tier path the AI reply text and the question variant and same-tier options offered also change the transcript (sandbox σ_path 4.91, one play moved 21 points, #344). It also removes the ~17–20 s score wait and the per-play score spend. This replaces spec #244 story 39 ("the evaluator called unchanged" on every play); the evaluator and its lock are untouched.

## Considered options

- **Live cache per (case version, tier path)**: the first play's single noisy call sets everyone's score, the first play still waits, and typed text cannot be part of the key.
- **Median of N live calls**: narrows the spread but never removes it, at N times the spend and the slowest call's wait.
- **A tier-path base plus a smaller live AI part**: the live part still moves, so it fails "the same every time".
- **Scoring in a Claude Code session**: no API spend, but a different model with no temperature control and the session's own system prompt around the rubric, so the demo score would stop being the PIS-7 evaluator's.

## Consequences

- The AI reply, and which same-tier option a visitor tapped, no longer move the score. A typed answer scores as the tier it is sorted into, and the sort memo keeps identical text on one tier.
- Changing a score means a new case version, a PR and a deploy. A play started on the old version just before a deploy ends unavailable.
- A 5-step table is modelled, not measured path by path: it cannot see an interaction such as a recovery after a weak start. A step whose "weaker" effect beats "best" is reported as a likely tier mislabel.
- Each play's d1–d7 are a function of its path, which the open booth dataset states.
