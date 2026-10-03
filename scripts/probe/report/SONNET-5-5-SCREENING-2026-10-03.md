# Sonnet 5.5 screening run (2026-10-03)

The user approved a paid run with a hard $1.00 budget. Evidence level: **screening-synthetic**, not a decisive gate.

The anchors are Claude-authored. A Claude evaluator reading them is partly circular: AUTHORING.md §7 item 20 measured the Claude panel at 0.90 against the targets.

- **Model:** `claude-sonnet-5-5`, using the frozen request shape from this branch:
  - evaluate: adaptive thinking, effort high, max_tokens 16000;
  - chat: between_tools, effort low.
- **Prompt:** the shipped base evaluator prompt, `pis7-prompt-59561c29`. The cloud path has no local addendum.
- **Data:** synthetic tuning anchors only. Held-out anchors are refused by the harness, and no real PLE data was used. That is why this used `anchor-cloud-repeat.mjs` and not `repeat-consistency.mjs`, which reads fixtures built from real pilot PLEs.

## Spend: $0.588 of $1.00

| Run | Spend |
|---|---|
| repeat run 1 (`tuning-repeat-sonnet-5-5-anchors-2026-10-03.json`) | $0.235 |
| repeat run 2 (`…-run2.json`) | $0.304 |
| chat smoke (`scripts/quality/report/anthropic-sonnet-5-5-smoke-2026-10-03.json`) | $0.049 |

These figures come from the response `usage` at $2/$10 per MTok. They are an estimate, not the invoice. Before each anchor, the harness enforced the cap at the worst case, assuming full max_tokens output.

## Evaluate: 14 tuning anchors × K = 2 (28 calls)

- **Contract:** 28/28 parsed (Wilson 95% [0.88, 1.00]). 0 invalid JSON, 0 refusals, 0 max_tokens truncations.
  - Output tokens peaked at 1250, well under the 16000 ceiling.
  - Reported thinking tokens peaked at 0. At effort high, adaptive thinking chose not to think on these transcripts.
- **Latency:** p50 8.2 s, max 10.6 s.
- **Cost:** $0.019 per evaluation (max $0.024). The worst case allowed for was about $0.16.
- **Repeatability:**
  - Domain scores matched exactly in 90/98 cases (0.92 [0.85, 0.96]), and no domain differed by 2 or more.
  - Composites were identical on 7/14 anchors (0.50 [0.27, 0.73]). The largest composite range was 5 points (anc-013: 82 / 87).
  - This is ONE repeat pair per anchor. It is not a test–retest ICC over the full cohort.

## Against the same 14 anchors, DeepSeek baseline (free comparison, existing data)

The DeepSeek rows come from `runs/tuning-local-baseline-2026-10-02-*.json` (PR #138): median of 3, `+local-c5ffe572aa81`. Sonnet's composite is the mean of its 2 runs.

| | ICC(A,1) vs target [95% CI] | bias | low-band bias (n = 4) |
|---|---|---|---|
| Sonnet 5.5 | 0.95 [0.85, 0.98] | −0.1 | +5.1 |
| DeepSeek | 0.85 [0.49, 0.95] | +7.8 | +15.8 |

Sonnet 5.5 against DeepSeek: ICC 0.82 [0.44, 0.94].

**Reading, with the limits stated:**
- On these 14 anchors, Sonnet 5.5 sits closer to the targets than DeepSeek and lifts low anchors less.
- The low band is only 4 anchors, and the anchors were written by Claude, so Sonnet's agreement is inflated by circularity.
- The arms also differ in prompt: Sonnet ran without the local addendum, while DeepSeek ran with it.
- This hints that part of DeepSeek's low-end lift is the model's, but it does **not** settle the question PR #138 left open. Human auditors (plan 2.7) are still the deciding evidence.

## Chat smoke: 4 items (2 English, 2 Thai; examiner and natural modes)

- 4/4 answered: none truncated, no reasoning leak, and no language retry needed.
- Latency 8.2–10.0 s per item, far inside the backend's 100 s chat limit.

## What this does and does not change in the PR

- **Confirmed:** the frozen shape holds on these transcripts. There was no truncation, no refusal, no invalid JSON, and latency was low. Real evaluate cost was about 8× below the worst-case estimate.
- **Not settled:** calibration against human auditors, and full-cohort test–retest. Both are still required before scores from 5.5 count as calibrated.
- **Still for the PI:** whether 5.5 should replace 4.6 at all.
