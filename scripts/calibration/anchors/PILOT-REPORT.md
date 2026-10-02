# Anchor pilot — strict run, blind diagnosis, rewrites and four panel rounds (2026-10-02)

> **Evidence level: screening-synthetic (AI-authored, AI-scored) — not a decisive gate.**
> The transcripts were written by an AI to designed targets and scored by AIs. Nothing here is human
> agreement, and nothing here says how the evaluator agrees with human auditors on real physicians.
> n = 20 throughout, so every interval is wide; read the intervals, not the point estimates.

## Summary — final pilot state

- **20 active pilot anchors.** anc-015 was excluded under §7.4 (rewritten once, still +22) and
  replaced by **anc-101** at the same target vector and case slot; its text is archived.
- **Rewrites used:** anc-005, 006, 014, 019 (round 1 → 2), anc-012 (round 2 → 3), anc-101 (its own
  single rewrite, round 3 → 4). anc-015's rewrite failed and led to its exclusion.
- **Beyond ±15 on each anchor's deciding round** (the first rating of its current text by a
  two-model panel, AUTHORING.md §7 amendment item 6): **0 of 20**. No rewrite is outstanding. The §7.6
  allowance is 4, so **the pilot proceeds**. The excluded anc-015 is not one of the 20. Counting it
  against the pilot anyway, as a failure, gives 1 of 20, and the verdict is unchanged. Pooled over every round-2–4 rating of the current text, 1 of 20 is beyond
  ±15 (anc-003, +17); that is reported, and the decision stands.
- **Panel verdicts near the line are noise-limited.** On identical text, the same two models moved
  −6 to +6 (Sonnet) and −3 to +10 (Opus) composite points between rounds. That is the same order as
  the 15-point line itself (§ Round 4).
- **Circularity.** The anchors are Claude-authored, and the panel that screened them is Claude
  (Sonnet + Opus). The incumbent production evaluator is also Claude (`claude-sonnet-4-6`). This
  cohort is therefore fitted toward Claude's reading of the rubric. Any Sonnet-arm result on it carries
  that caveat, and a non-Claude panel member remains an open item. Human raters are the decisive gate.
- **The local evaluator** has scored only round 1's texts in this PR. Its re-score of the changed
  anchors is being run separately and is not reported here.

Four blind rounds are reported:
- **Round 1** (§ What was scored … § Per domain) rated the pilot as written in PR #111.
- **Round 2** (§ Round 2) rated all 20 after the rewrites.
- **Round 3** rated anc-101's first write and the rewritten anc-012 among decoys.
- **Round 4** rated anc-101's rewrite among decoys.

**Rater isolation.** In rounds 1 and 2, the raters were general-purpose subagents told to read only
`rubric.txt` and `episodes.txt` from a scratchpad folder outside the repo, and each confirmed it opened
only those two files. They had file tools, so isolation was by instruction, not enforced. Rounds 3 and 4
were run by the coordinator with the same two-file packet layout.

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

`known-groups.mjs` on the same run (per-domain median of the three runs, then composite) gave
local vs target ICC(A,1) 0.685 [0.196, 0.879], Spearman ρ 0.798 [0.539, 0.919], bias +11.25, n 20/20.
**These figures were computed at 2627c9b, before anc-015 was excluded**. They reproduce exactly with
`known-groups.mjs … --pilot --include-excluded`, and a test pins that. The plain command at HEAD
skips the excluded anc-015 (local 72 against a target of 30) and gives ICC(A,1) 0.750 [0.300, 0.908],
ρ 0.798 [0.529, 0.921], bias +9.68, n 19/20. That improvement comes from **dropping the anchor the
evaluator missed most**, not from the evaluator. Quote 0.685 for round 1.

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

## Round 3 — blind panel on the two changed anchors, among decoys

| | |
|---|---|
| Texts | anc-101 (first write, sha `b7dd555b…`) and the rewritten anc-012 (sha `2c0fa94a…`), shuffled F01–F08 among six **unchanged** decoys (anc-002, 004, 009, 011, 018, 020) |
| Panel | one Sonnet and one Opus subagent, same rubric text as rounds 1–2 (`pilot/panel-3/rubric.txt`), no targets or ids; isolation as stated at the top |
| Analysis | `node scripts/calibration/anchors/pilot/panel-3/analyse3.mjs` (n = 8, so no ICC is computed) |

| anchor | target | Sonnet | Opus | panel | Δ |
|---|---|---|---|---|---|
| **anc-012** (rewritten) | 74 | 73 | 73 | 73 | −1 |
| **anc-101** (new) | 30 | 53 | 46 | 50 | **+20** |
| anc-002 | 45 | 54 | 44 | 49 | +4 |
| anc-004 | 62 | 73 | 77 | 75 | +13 |
| anc-009 | 38 | 28 | 20 | 24 | −14 |
| anc-011 | 70 | 77 | 82 | 80 | +10 |
| anc-018 | 58 | 74 | 74 | 74 | +16 |
| anc-020 | 15 | 23 | 17 | 20 | +5 |

- **Panel stability on identical text.** The six decoys moved −6 to +4 (Sonnet, mean |Δ| 3.2) and −3
  to +4 (Opus, mean |Δ| 2.3) against round 2. That is six texts and one re-rating each; it says the
  panel was not wildly unstable this time, not that it is stable in general.
- **anc-012:** its old text was rated 98 / 92 in round 2; the rewrite reads 73 / 73 against a target of
  74. Per domain both raters gave [4,4,4,4,3,4,2] against [4,4,4,4,4,4,1]: d5 one level low, d7 one
  level high, and they cancel in the composite. The rewrite worked on the composite. One rating
  round on one text cannot show it is right on every domain.
- **anc-101:** +20 on its first write. Both raters read it high on the same domains: d1 2 (target 1),
  d2 2 (0), d4 2 (0), d7 4 / 3 (2), and Sonnet's d6 2 (1). d5 was 5 from both, as designed. It
  therefore uses its single §7.4 rewrite (below).
- **anc-018 at +16** (unchanged text; +12 in round 2). Recorded, not acted on: a rule decision uses the
  round in which a text was first rated by a two-model panel (AUTHORING.md §7 amendment item 6). That rule was
  written down **after** seeing this reading, which is why it is stated as a rule and not decided
  case by case.

### anc-101 rewrite (its one allowance)

Arrows give the INTENDED level; the rewrite has not been rated. Justified from §5, domain by domain,
against the round-3 notes ("generic hopping questions",
"excellent three-way evidence appraisal", "generic reflection"):
- **d1 2 → 1.** The opening asked "what do you generally do" for this case, which is §5's level-2 form
  (relevant but generic). It now asks a textbook lookup that fits any patient ("ยาละลายลิ่มเลือดกับหัวกระแทก
  มีอะไรต้องรู้บ้าง").
- **d2 2 → 0.** The closing appraisal argued *why* each claim failed (trial population, which bleeding
  the cited guideline covers). That is the physician's own reasoning. It now only labels each claim's
  evidence status (RCT / expert opinion / small retrospective cohorts / no source).
- **d4 2 → lower.** The closing turn is now a note to self that asks nothing; the two middle turns are
  bare topic hops. Appraising the tutor's earlier answers still picks them up, so d4 = 0 alongside d5 = 5
  remains the hardest combination in the cohort.
- **d7 3–4 → 2.** The remark that none of the three claims carried a citation was the physician
  checking the tool's sourcing (§5 d7 4: verifies a key output). It is gone, and the prompts are
  shorter and less specific.
- **d6 2 → 1.** The reflection named the topic; it is now generic ("ได้ความรู้เยอะมาก ขอบคุณครับ").
- Unchanged: the three planted tutor claims (same turns, no citation on the false line, corrected in
  turn 7; `planted-claims.json` still matches), d5's separation of established / weak / unknown /
  overreach, and the case itself. Neutral history and a few labs were added to the first turn (listed,
  never used, as d3 = 2 requires) to keep length from tracking level (cue gate: length vs composite r 0.44, CI reaches inside ±0.1).

## Round 4 — anc-101's rewrite, among decoys

| | |
|---|---|
| Texts | anc-101 after its single rewrite (sha `35631435…`), shuffled G01–G06 among five **unchanged** decoys (anc-003, 008, 013, 016, 017) |
| Panel | Sonnet + Opus, same rubric text (`pilot/panel-4/rubric.txt`), no targets or ids |
| Analysis | `node scripts/calibration/anchors/pilot/panel-4/analyse4.mjs`: this table, the drift on identical text, and the pooled pilot table. n = 6, so no ICC is computed. |

| anchor | target | Sonnet | Opus | panel | Δ | round 2 (S/O) |
|---|---|---|---|---|---|---|
| **anc-101** (rewritten) | 30 | 44 | 44 | 44 | **+14** | — |
| anc-003 | 42 | 65 | 59 | 62 | +20 | 62/50 |
| anc-008 | 26 | 23 | 17 | 20 | −6 | 17/17 |
| anc-013 | 78 | 96 | 96 | 96 | +18 | 90/86 |
| anc-016 | 81 | 93 | 96 | 95 | +14 | 90/87 |
| anc-017 | 22 | 32 | 24 | 28 | +6 | 26/27 |

- **anc-101 is within the line (+14), so it stays.** It was +20 on its first write.
  - Per domain: Sonnet [2,1,2,1,5,1,4], Opus [2,1,1,2,5,2,3], against a target of [1,0,2,0,5,1,2].
  - d5 is read as designed by both raters.
  - **Residual: d7 still reads 1–2 levels high** (4 and 3 against 2). d1, d2 and d4 each read one
    level high from at least one rater.
  - It passed by one point, inside a panel whose drift on identical text is up to 10 points. It is
    not shown to express its target. It is under the line on the round the rule uses.
- **Decoys drifted more this round.**
  - Opus: anc-003 50 → 59, anc-013 86 → 96. Sonnet: anc-003 62 → 65, anc-013 90 → 96.
  - Every round-4 decoy moved up on average: +5 for each rater, against about 0 in round 3.
  - So this round's panel read higher than round 2's on the same texts. anc-101 was decided in this
    same round, so the shift works against it, not for it.
  - anc-003 (+20) and anc-013 (+18) are beyond ±15 on this re-rating. Under item 6 they are not
    triggers: their deciding round is round 2 (+14, +10).

### Drift and pooling (what the single-round verdicts can and cannot say)

Across rounds 3–4, eleven decoys were re-rated on identical text against their round-2 rating:
- **Sonnet:** −6 to +6 composite points (mean |Δ| 3.9).
- **Opus:** −3 to +10 (mean |Δ| 4.1).

That is the same order as the ±15 line. A single round's verdict on an anchor within about 10 points
of the line is noise-limited. It can say that an anchor read beyond the line that day, not that the
anchor over- or under-expresses its target.

Pooled over every round-2–4 rating of each anchor's current text (`analyse4.mjs`), beside the
deciding-round Δ. This changes no decision:

| anchor | target | deciding Δ (round) | pooled Δ | ratings pooled |
|---|---|---|---|---|
| anc-020 | 15 | +3 (r2) | +4 | r2, r3 |
| anc-017 | 22 | +5 (r2) | +5 | r2, r4 |
| anc-008 | 26 | −9 (r2) | −8 | r2, r4 |
| anc-101 | 30 | +14 (r4) | +14 | r4 |
| anc-005 | 34 | +12 (r2) | +12 | r2 |
| anc-009 | 38 | −11 (r2) | −13 | r2, r3 |
| anc-003 | 42 | +14 (r2) | **+17** | r2, r4 |
| anc-002 | 45 | +7 (r2) | +6 | r2, r3 |
| anc-006 | 50 | +2 (r2) | +2 | r2 |
| anc-019 | 54 | +10 (r2) | +10 | r2 |
| anc-018 | 58 | +12 (r2) | +14 | r2, r3 |
| anc-004 | 62 | +13 (r2) | +13 | r2, r3 |
| anc-014 | 66 | +5 (r2) | +5 | r2 |
| anc-011 | 70 | +14 (r2) | +12 | r2, r3 |
| anc-012 | 74 | −1 (r3) | −1 | r3 |
| anc-013 | 78 | +10 (r2) | +14 | r2, r4 |
| anc-016 | 81 | +8 (r2) | +11 | r2, r4 |
| anc-001 | 86 | +14 (r2) | +14 | r2 |
| anc-010 | 90 | +9 (r2) | +9 | r2 |
| anc-007 | 94 | +6 (r2) | +6 | r2 |

- **Beyond ±15:** 0 of 20 on the deciding round; 1 of 20 pooled (anc-003).
- **The panel reads above target almost everywhere:** 17 of 20 pooled Δs are positive. The three
  negatives are anc-012 (−1), anc-008 (−8) and anc-009 (−13).
- **Eight anchors sit at +12 to +17 pooled** (anc-001, 003, 004, 005, 011, 013, 018, 101). That is a band the drift above can carry across the line
  in either direction. They are the anchors the full cohort's panel will most likely re-flag.
- anc-014's only change since round 2 is a tutor-turn citation year; the raters score the physician,
  so its round-2 rating is treated as current.

## Status

| item | status |
|---|---|
| anc-015 excluded, replaced by anc-101 | done (§7.4) |
| anc-012's single rewrite | done; −1 on its deciding round (round 3) |
| anc-101's single rewrite | done; +14 on its deciding round (round 4); residual d7 high |
| outstanding panel rewrites | **none** |
| local evaluator re-score of the changed anchors (and anc-101's rewrite) | run separately by the coordinator; not in this PR |
| anc-014 tutor citation (NICE, 2010 → 2011) | done; tutor text only, new sha |

Re-running `known-groups.mjs --pilot` on the round-1 run at HEAD drops anc-015 (excluded) and counts
anc-101 as never scored (it did not exist then). So the **headline ICC, its CI and the bias move**
(0.685 → 0.750, bias +11.25 → +9.68, n 20 → 19), and the §7.6 line moves with them. Add
`--include-excluded` to reproduce round 1 exactly. The round-1 figures in this report are the record.
Planted tutor claims (deliberately wrong statements for the physician to appraise) are listed in
`planted-claims.json`. anc-101's three carry no citation on the false line (AUTHORING.md §5).
