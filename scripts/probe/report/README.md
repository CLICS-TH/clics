# Probe run reports — the local-vs-Sonnet experimental record

Every `*.json` here is the raw output of one probe run against the on-premise model, written by
`--out`. Together they are the underlying data for `docs/METHODOLOGY-local-vs-sonnet.en.md`, the
model-axis rows in `scripts/calibration/prompt-versions.md`, and §8 of `docs/GATE0-DGX-RESULTS.md`.

**They are committed on purpose.** They were gitignored until 2026-09-04, which left the entire
record one `git clean` away from gone and no figure in the write-up reproducible. They hold numbers
and fixture ids only — seven integers per arm, latencies, token counts, error stamps — and were
checked to contain no string longer than 60 characters: no rationale text, no transcript, no
`patient_ref`. The `fixtures/` they were computed from stay ignored, because those *do* hold
transcripts. The `.log` siblings stay ignored too; they carry nothing the JSON does not.

Regenerate every published figure from these files with:

```sh
node scripts/probe/report/methodology-figures.mjs          # table
node scripts/probe/report/methodology-figures.mjs --json    # machine-readable
```

## The runs, in order

| # | file | when | tool | configuration | outcome |
|---|---|---|---|---|---|
| 1 | `ctx-2026-09-02.json` | 09-02 13:06 | `context-limit.mjs` | synthetic, 8k→96k, both shapes | no input ceiling found; sentinel recalled at 66,029 served tokens |
| 2 | `tuning-agreement-v0.json` | 09-02 16:55 | `model-agreement.mjs` | tuning · adaptive · **no addendum** | n=16 · weighted ICC 0.578 · bias −2.50 · JSON 100% |
| 3 | `tuning-repeat-v0.json` | 09-02 22:32 | `repeat-consistency.mjs` | tuning · 18×5 · local arm | 10/18 measurable (box degraded) · repeatability Σ\|Δ\| median 6 |
| 4 | `noise-2026-09-03-noaddendum.json` | 09-03 17:32 | `repeat-consistency.mjs` | tuning · 18×5 · **addendum off** | 11/18 measurable · median 5 · 8 fixtures lost to transport |
| 5 | `noise-2026-09-03-addendum.json` | 09-03 23:26 | `repeat-consistency.mjs` | tuning · 18×5 · **addendum on** | **18/18** measurable · median **1** · 14/18 at or under the bar of 2 |
| 6 | `tuning-agreement-addendum.json` | 09-04 10:11 | `model-agreement.mjs` | tuning · adaptive · addendum `cae23b1a5f37` | n=14 · 0.735 · bias +0.79 · JSON 34/36 |
| 7 | `tuning-agreement-median3.json` | 09-04 11:50 | `model-agreement.mjs` | tuning · **stamped `median3`, ran `adaptive`** | n=15 · 0.762 · bias +0.00 · JSON 34/36 |
| 8 | `tuning-agreement-c5ffe-adaptive.json` | 09-04 16:48 | `model-agreement.mjs` | tuning · adaptive · addendum `c5ffe572aa81` | n=**18/18** · 0.611 · JSON 37/37 |
| 9 | `tuning-agreement-c5ffe-adaptive-rep2.json` | 09-04 18:40 | `model-agreement.mjs` | identical to #8, 90 min later | n=12 (6 lost) · **0.795** |
| — | *(no file)* | 09-04 19:25 | `model-agreement.mjs` | identical to #8, first run with retry | **aborted at PLE-012**: HTTP 400 `credit balance is too low` |
| 10 | `heldout-c5ffe-adaptive.json` | 09-04 21:52 | `model-agreement.mjs` | **heldout** · adaptive · `arm_attempts 4` | n=**8/8**, zero losses · **0.436 (0.000–0.873)** · JSON 16/16 · `insufficient` |

> **Note, 2026-10-02 (PR #105).** The biases in rows 2, 6 and 7 are on the unweighted d1–d7 sum (0–35) that
> `model-agreement.mjs` printed until that date, while every ICC in this table is on the weighted
> composite. On the weighted composite they read **−7.875, +1.64 and −0.73**. That is
> `bias_weighted` in `methodology-figures.mjs --json`, and the scale `model-agreement.mjs` and
> `e2-compare.mjs` print on now. Row 10's interval is the Fisher-z one `icc.js` used until the same
> date; the F-based interval it uses now is 0.000–0.855.

## Four things to know before quoting any of these

1. **#7 did not run what it says.** `model-agreement.mjs` hardcoded `mode: 'adaptive'` from `a79f4d3`
   until `8d36492` while faithfully stamping the `--consistency` flag into the report. #6 and #7 are
   therefore the *same configuration*, and their 0.735 → 0.762 gap is two draws from one config at
   n=14/15 — the best available estimate of sampling noise, not a treatment effect. **`median3` has
   never actually run.** Verify a lever from the call counts, never from the flag.
2. **#9 is survivorship-inflated.** Same configuration as #8, ninety minutes apart, 0.611 → 0.795 —
   because six fixtures dropped out and the lost ones are the harder ones (Σ\|Δ\| 5.2 against 3.6 for
   survivors). Longer transcripts both time out more and are the ones the models disagree about, so
   the metric improves as the infrastructure degrades. Fixed by retry in `9ea5636`; **every figure
   recorded before that commit carries the bias.**
3. **#2–#7 used a prompt that no longer ships.** The local addendum moved
   `+local-cae23b1a5f37` → `+local-c5ffe572aa81` on 2026-09-04 (`5340d13`). Runs #8 onward are the
   only ones describing the current prompt.
4. **Only #10 is a gate result.** By the rule in `prompt-versions.md`, a row counts only when
   `split = heldout`. Everything else is tuning-split and is recorded for the history.

## Two Σ|Δ| that are not the same quantity

- **repeatability** Σ|Δ| — one model re-scoring one fixture, summed over d1–d7 of (max − min) across
  repeats. From `repeat-consistency.mjs` (#3, #4, #5). This is the noise floor.
- **agreement** Σ|Δ| — local vs cloud on one fixture, summed over d1–d7 of |local − cloud|. From
  `model-agreement.mjs`.

They were recorded under one column heading in `prompt-versions.md` and read as one number. They are
not comparable, and the whole point of measuring both is that the first bounds what the second can
mean.
