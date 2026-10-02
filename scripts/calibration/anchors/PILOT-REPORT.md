# Anchor pilot — strict run, blind diagnosis, rewrites and round-2 panel (2026-10-02)

> **Evidence level: screening-synthetic (AI-authored, AI-scored) — not a decisive gate.**
> The transcripts were written by an AI to designed targets and scored by AIs. Nothing here is human
> agreement, and nothing here says how the evaluator agrees with human auditors on real physicians.
> n = 20 throughout, so every interval is wide; read the intervals, not the point estimates.

Two blind rounds are reported. **Round 1** (§ What was scored … § Per domain) rated the pilot as
written in PR #111. **Round 2** (§ Round 2) rated it after the rewrites in this PR. The local
evaluator has scored round 1's texts only; its re-score of the changed anchors is pending.
Applying §7.4 to round 2 as written (§ Verdict), **anc-015 is excluded and replaced by anc-101**, and
**anc-012 is rewritten**; both are ready for the blind panel and the local re-score (§ Pending).

**Rater isolation (both rounds).** The raters were general-purpose subagents told to read only
`rubric.txt` and `episodes.txt` from a scratchpad folder outside the repo, and each confirmed it opened
only those two files. They had file tools, so isolation was by instruction, not enforced.

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
  under test (AUTHORING.md §7 amendment). It is dated as made before any rewrite, but it landed in
  the same commit as the rewrites (6827719), so that ordering is self-attested, not provable from git.
  The local flag rate stays a reported outcome.
- The 5 anchors above were rewritten to express their targets — d4 and d2 in particular — and four
  high anchors (anc-007, anc-010, anc-013, anc-016) had rubric phrases replaced with behaviourally
  equivalent wording. With nine pilot files changed, the pilot freeze lapsed; the surface-cue gate
  passed on its own over all 20 (largest remaining at 2627c9b: length vs composite r = 0.43, rubric
  echo vs d7 r = 0.41, list lines vs composite r = −0.40; each CI reaches inside ±0.1). After this
  round's exclusion and rewrite (anc-101 in, anc-015 out, anc-012 rewritten) it still passes: length
  vs composite 0.42, rubric echo vs d7 0.37, list lines vs composite −0.40.
- The figures in the sections above describe the pilot **before** the rewrites. Round 2 below is the
  blind panel on the rewritten pilot; the local evaluator's re-score of the nine changed anchors is
  pending.

## Round 2 — blind panel on the rewritten pilot

| | |
|---|---|
| Texts | all 20 pilot anchors after this PR's rewrites (5 rewritten, 4 reworded, 11 unchanged) |
| Panel | one Sonnet and one Opus subagent (isolation: see the top of this report), new shuffle E01–E20, same rubric text as round 1 (`pilot/panel-2/rubric.txt`), no targets or ids. `pilot/panel-2/KEY-do-not-share.json` maps labels back and was withheld while they scored. |
| Analysis | `node scripts/calibration/anchors/pilot/panel-2/analyse2.mjs` |

**Caveats that govern every round-2 number:**
- **Sonnet and Opus are different models but both are Claude.** They agree at composite ICC(A,1)
  0.968 [0.837, 0.990] (per domain 0.89–0.98). They are not independent of each other, and this is not
  a two-rater human panel. Their agreement with each other is not evidence about the anchors.
- **Round 1 used two Sonnets; round 2 used Sonnet + Opus.** A round-to-round change in the panel mean
  mixes the rewrite's effect with the change of panel. The like-for-like comparison is Sonnet-only
  (below). Even that has a noise floor: re-rating the **11 unchanged** anchors, Sonnet moved by a mean
  of +1.5 composite points, SD 6.3, range −10 to +12 (anc-012 +12, anc-017 −10, anc-002 +10). A
  before/after change smaller than about ±12 on one anchor is within what the same model does to the
  same text.
- **The panel still scores above target on average (+8.2).** Either the authoring overshoots
  systematically or the rubric reads generously; n = 20 cannot separate the two.

### Composite agreement (weighted composite, 0–100)

| comparison | ICC(A,1) [95% CI] | bias (first − second) |
|---|---|---|
| Sonnet vs Opus | 0.968 [0.837, 0.990] | +4.5 |
| Sonnet vs target | 0.875 [0.172, 0.966] | +10.4 |
| Opus vs target | 0.923 [0.737, 0.973] | +5.9 |
| panel mean vs target | 0.907 [0.453, 0.973] | +8.2 |

The intervals against the target still reach down to 0.17 (Sonnet) and 0.45 (panel mean). Round 1
and round 2 used different raters and different texts, so the two rounds' ICCs are not a before/after
pair.

Per domain, panel mean vs target (ICC(A,1) point estimates): d1 0.83, d2 0.76, d3 0.82, d4 0.77,
d5 0.93, d6 0.98, d7 0.84. Rubric echo vs the d5 target is r = 0.36 [95% CI −0.10, 0.69] on the
round-2 texts, against 0.64 [0.28, 0.84] on round 1's (Fisher z, n = 20). The intervals overlap, so
these data do not show that the rewording removed the echo; they show only that it no longer has to
be there. Echo vs d7 is still r = 0.41 [−0.04, 0.72]. The d5 figure may still owe something to
wording.

### Rewrite outcomes (Δ = composite − target)

| anchor | round 1 panel (2× Sonnet) | round 2 panel (Sonnet + Opus) | Sonnet only, before → after |
|---|---|---|---|
| anc-006 | +36 | +2 | +36 → +10 |
| anc-019 | +27 | +10 | +27 → +15 |
| anc-014 | +24 | +5 | +24 → +9 |
| anc-005 | +17 | +12 | +17 → +17 |
| anc-015 | +28 | **+22** | +28 → +24 |
| *reworded only* | | | |
| anc-007 | +6 | +6 | +6 → +6 |
| anc-010 | +6 | +9 | +6 → +7 |
| anc-013 | +15 | +10 | +15 → +12 |
| anc-016 | +8 | +8 | +8 → +9 |

Read against the Sonnet noise floor (±12 on unchanged texts):
- anc-006 (−26) and anc-014 (−15) moved further than the same model moves on its own.
- anc-019 (−12) is at the edge.
- anc-005 did not move on Sonnet (+17 → +17). Its panel-mean change from +17 to +12 comes from adding
  Opus, not from the rewrite.
- anc-015 is still over the line.
- The four reworded anchors stayed within noise, as wording-only edits should.

### Verdict under the amended rule (AUTHORING.md §7 amendment)

Beyond ±15 of target, by rater (`analyse2.mjs` prints this):

| rater | over the line | anchors |
|---|---|---|
| panel mean (the rule) | **2 / 20** | anc-015 (+22), anc-012 (+21) |
| Opus alone | 2 / 20 | anc-015, anc-012 |
| Sonnet alone | **4 / 20** | anc-003, anc-015, anc-005, anc-012 |

- On the panel mean, 2 of 20 — 10% [Wilson 3–30%] — within the §7.6 allowance of 4. **Sonnet alone
  puts 4 over, exactly at the allowance**: one more Sonnet-read anchor over the line and the pilot
  would fail on Sonnet's reading. The verdict depends on averaging in Opus.
- Round 1's single-model panel had anc-012 at +12; Sonnet alone moved +12 on its identical text, so
  its crossing is at least partly rater variation. That does not change what the rule requires.
- **§7.4 applied as written** (the earlier draft of this verdict kept both anchors as they were; that
  relaxed a pre-registered rule after the numbers were known, and is withdrawn):
  - **anc-015 — excluded and replaced.** It had used its one rewrite and is still over (+22). It is
    replaced by **anc-101**: same target vector [1,0,2,0,5,1,2] (composite 30), same case slot
    (Emergency Medicine, minor head injury on anticoagulation), same language, tutor mode, turn count
    and reflection placement (`design.mjs` `REPLACEMENTS`). The excluded text is kept, byte for byte, at
    `fixtures/excluded/anc-015.json` (sha256 `2eddee89…088e`, recorded in `design.json`); its round-1
    and round-2 ratings stay in this report. anc-015 is never scored, counted or held out again.
  - **anc-012 — rewritten.** It had had no rewrite, so it is due its one. Justified from §5, not from
    any number: its physician turns expressed level 5 for d1–d5 (a converging question sequence,
    explicit separation of prognostic from therapeutic evidence, the "guideline assumes resources we
    lack" layer) and ownership statements that read as d7 3–4. The rewrite is written to keep d1–d6
    at clear-and-systematic (4) and to make d7 unmistakably low: the physician hands the aspirin decision
    to the tool, asks for hold numbers to paste into an order, then overrides the tutor's "check these
    first" and copies the whole note into the chart unread.

## Pending (for the coordinator — not run here)

| anchor | what changed | needs |
|---|---|---|
| **anc-101** | new anchor replacing anc-015; first draft | blind panel + local evaluator |
| **anc-012** | its one rewrite | blind panel + local evaluator; if still beyond ±15 → excluded and replaced like anc-015 |
| anc-014 | tutor turns only: `(NICE, 2010)` → `(NICE, 2011)`; physician text untouched | new sha256, so a local re-score scores new bytes; the evaluator ignores tutor turns |

Until those scores exist, the pilot verdict above is about the round-2 texts, not the current cohort.
Re-running `known-groups.mjs --pilot` on the round-1 run now lists anc-015 as excluded and anc-101
as never scored (it did not exist then), so its §7.6 line no longer reproduces round 1's; the round-1
figures in this report are the record.
Planted tutor claims (deliberately wrong statements for the physician to appraise) are listed in
`planted-claims.json`; anc-101's three carry no citation on the false line (AUTHORING.md §5).
