# Anchor pilot — first strict run and blind diagnosis (2026-10-02)

> **Evidence level: screening-synthetic (AI-authored, AI-scored) — not a decisive gate.**
> The transcripts were written by an AI to designed targets and scored by AIs. Nothing here is human
> agreement, and nothing here says how the evaluator agrees with human auditors on real physicians.
> n = 20 throughout, so every interval is wide; read the intervals, not the point estimates.

## What was scored

| | |
|---|---|
| Anchors | the 20 pilot anchors `anc-001`…`anc-020` as committed in PR #111 (`design.json` `pilot: true`) |
| Local evaluator | `deepseek-v4-flash-dspark` (served model, all 60 rows), prompt `pis7-prompt-59561c29+local-c5ffe572aa81`, rubric `pis7-weights-08b0cb1a` |
| Local run | `runs/pilot-local-strict-2026-10-02.json`: K = 3 per anchor, temperature 0, production's strict contract (`scoreWithConsistency` → `scoreFromText`, `.strict()`), consistency off; **60/60 runs validly scored**; every raw reply saved. The box's address was redacted from the file before commit. |
| Blind raters | two Sonnet subagents, scoring the same packet (`pilot/blind/rubric.txt` = the PIS-7 evaluator rubric, `pilot/blind/episodes.txt` = the 20 transcripts) under shuffled labels B01–B20, with no targets or ids. `pilot/blind/KEY-do-not-share.json` maps labels back; it was withheld from the raters while they scored. Ratings: `pilot/blind/rater-a.json`, `rater-b.json`. |
| Analysis | `node scripts/calibration/anchors/pilot/blind/analyse.mjs` — ICC(A,1) with the McGraw–Wong F-based 95% CI (backend `icc.js`); the local score per anchor is the mean of its three runs' composites. |

**The two blind raters are effectively one rater.** Same model, same rubric, same packet: their
composites agree at ICC(A,1) 0.995 [0.987, 0.998]. They are not two independent judgements, and
nothing below treats their agreement with each other as evidence.

## Composite agreement (weighted composite, 0–100)

| comparison | ICC(A,1) [95% CI] | bias (first − second) |
|---|---|---|
| local vs target | 0.676 [0.175, 0.876] | +11.6 |
| blind A vs target | 0.816 [0.085, 0.948] | +12.7 |
| blind B vs target | 0.806 [0.179, 0.940] | +12.2 |
| mean(A,B) vs target | 0.812 [0.128, 0.945] | +12.4 |
| A vs B | 0.995 [0.987, 0.998] | +0.5 |
| local vs mean(A,B) | 0.880 [0.722, 0.951] | −0.8 |

`known-groups.mjs` on the same run (per-domain median of the three runs, then composite) gives
local vs target ICC(A,1) 0.685 [0.196, 0.879], Spearman ρ 0.798 [0.539, 0.919], bias +11.25.

Every lower bound against the target is at or below 0.2. These data are consistent with anything from
poor to good agreement with the designed targets, for both the local evaluator and the blind rater.

## Where the misses come from

- **Pre-registered flag (§7.2, local evaluator):** 7 of 20 anchors over |local − target| > 15 — 35%
  [Wilson 18–57%]: anc-017, anc-015, anc-005, anc-003, anc-006, anc-019, anc-004. The §7.6 proceed
  rule is therefore *exceeded* on this first pass.
- On those 7 anchors: mean target **42**, local **70**, blind A **62**, blind B **63**. Most of the gap
  is in the transcripts — they express more than their targets — and the local evaluator adds roughly
  7 more points on top. That is an authoring problem first.
- **Blind mean beyond ±15 of target:** 5 of 20 — 25% [Wilson 11–47%]: anc-015 (+28), anc-006 (+36),
  anc-019 (+27), anc-014 (+24), anc-005 (+17). Under the AUTHORING.md §7 amendment of the same day,
  these are the anchors rewritten.
- **Scale shape:** the local evaluator scores above the blind rater at the low end and below it at the
  top. Its highest composite on the pilot is about 84, where the blind rater gives anc-001 and
  anc-007 100. The local scale looks compressed. (A description of 20 points, not a tested claim.)

## Per domain

ICC(A,1) point estimates; at n = 20 each carries an interval roughly as wide as the composite's.

| domain | local vs target | local vs blind | blind vs target |
|---|---|---|---|
| d1 | 0.58 | 0.83 | 0.76 |
| d2 | **0.24** | 0.72 | 0.68 |
| d3 | 0.63 | 0.83 | 0.77 |
| d4 | **0.23** | 0.79 | **0.58** |
| d5 | 0.66 ⚠ | 0.84 | 0.79 ⚠ |
| d6 | 0.91 | 0.91 | 0.96 |
| d7 | 0.52 | 0.80 | 0.82 |

- d2 and d4 are where the local evaluator misses the target most, but it agrees with the blind rater
  there (0.72, 0.79). So those misses are mostly the transcripts not expressing the designed level,
  not the evaluator misreading them.
- d4 is also the blind rater's weakest domain against the target (0.58). It is the hardest domain to
  author: an anchor that critiques the tutor, or works through one patient's problems in order, reads
  as follow-up even when it was written as topic-hopping.
- ⚠ **d5 is inflated by rubric echo.** On these pilot texts, the count of rubric-descriptor phrases in
  physician turns (the d5 level-5 triad ข้อเท็จจริง / ไม่แน่นอน / ข้อจำกัด and similar) correlates
  r = 0.64 with the d5 target (`cues.mjs`). A scorer can recover d5 from the wording without judging
  the appraisal, so the d5 figures above overstate how well appraisal itself is read.

## What happened next (this PR)

- The rewrite rule moved from the local evaluator's flag to a blind panel independent of the evaluator
  under test (AUTHORING.md §7 amendment, dated, made before any rewrite). The local flag rate stays a
  reported outcome.
- The 5 anchors above were rewritten to express their targets — d4 and d2 in particular — and four
  high anchors (anc-007, anc-010, anc-013, anc-016) had rubric phrases replaced with behaviourally
  equivalent wording. With nine pilot files changed, the pilot freeze lapsed; the surface-cue gate now
  passes on its own over all 20 (largest remaining: length vs composite r = 0.43, rubric echo vs d7
  r = 0.41, list lines vs composite r = −0.40; each CI reaches inside ±0.1).
- **None of the figures above describes the rewritten pilot.** Re-scoring by a two-model blind panel
  and by the local evaluator is pending.
