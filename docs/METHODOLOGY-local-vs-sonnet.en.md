# Can an on-premise open-weight model replace a frontier cloud model as an automated rubric scorer?

**Methodology and results of the CLICS local-evaluator screening study, 2 – 4 September 2026.**

This document exists so that the Methods and Limitations sections of a paper can be written from it
without re-deriving a number. Every figure it quotes is regenerated from committed data by

```sh
node scripts/probe/report/methodology-figures.mjs          # human-readable
node scripts/probe/report/methodology-figures.mjs --json    # machine-readable
```

reading `scripts/probe/report/*.json`. Where a figure comes from a project document instead, the
section is cited inline. Nothing here is hand-transcribed from a terminal.

**Headline.** The screening gate returned `insufficient` on a pre-reserved held-out split:
ICC(A,1) = **0.436** (95% CI 0.000 – 0.873, n = 8) against a threshold of 0.75 on the *lower* bound.
The substantive finding is *why*: on that split the candidate model's **absolute** disagreement with
the incumbent was the smallest observed in the whole study, and the coefficient fell anyway because
the eight held-out episodes differ from each other by less than the two scorers differ on the same
episode. The binding constraint is the corpus, not the model.

---

## 1. Question and design

**Question.** Can an on-premise open-weight LLM substitute for a frontier cloud model as the
automated scorer of PIS-7, a seven-domain rubric for physician clinical reasoning that gates
continuing-professional-development credit?

**Design.** A paired agreement study. Both models score the same de-identified transcripts under the
same rubric; agreement is summarised as an intraclass correlation on the weighted composite.

**The gate is asymmetric, and this decides how the result may be read.** The governing decision
(D18, `docs/LOCAL-MODEL-ROADMAP.md`, "Settled 2026-08-28") defines *two* gates at one threshold:

| gate | comparison | status |
|---|---|---|
| **Screening** | candidate model vs. **incumbent model** | runnable today; this study |
| **Decisive** | candidate model vs. **human experts** | required before the model is locked; never yet runnable |

Its own stated rationale is the reason the distinction matters:

> Screening can reject a candidate before a single human rater exists; **it can never accept one**,
> because two models can agree closely and be wrong the same way.

So a screening study has a one-sided outcome space by construction. `insufficient` here is a result
inside that space, not a study that failed. Conversely, no screening result — however high — would
have licensed deployment.

**A pre-registration-like control.** The confirmatory split was drawn and frozen *before* any tuning
run (decision D13). It was opened exactly once, and it is now spent. Section 2 gives the mechanism;
Section 7.1 gives the consequence, which is not the one we expected.

**A second asymmetry, stated up front.** No intraclass correlation recorded anywhere in this project
has been measured against real human auditors. The frequently cited 0.811 for the incumbent evaluator
was measured against **three simulated agent-raters with assigned stances**
(`scripts/soak/gen-auditor-wf.js:30-32`), on a cohort that was itself a regeneration after the
original was destroyed. The one figure involving real humans is ICC −0.315 on n = 5. The reference
standard in this study is therefore an *incumbent*, not a ground truth, and Section 7.2 measures how
unreliable it is.

---

## 2. Materials

### 2.1 Corpus

26 transcripts of physician–AI clinical learning episodes ("PLEs"), drawn from the platform's own
records and passed through the production de-identification filter by `scripts/probe/build-fixtures.mjs`.
Each fixture holds only `{ple_id, patient_ref, transcript[]}`, where `transcript` is an ordered list
of `{role, content}` with `role ∈ {physician, assistant}`. `patient_ref` is null in all 26. Episode
length ranges from 8 to 35 turns (median 12).

The fixtures are **not** committed — they contain clinical dialogue, and a de-identification slip
that reaches a git history is unrecoverable. The per-fixture SHA-256 digests are committed, in
`scripts/probe/SPLIT.json`, and are re-verified on every run (`scripts/probe/split.mjs:44-48`), so
the corpus is pinned even though it is not published.

### 2.2 The split

| | | |
|---|---|---|
| method | seeded Fisher–Yates over sorted fixture ids (mulberry32) | `scripts/probe/reserve-split.mjs` |
| seed | 20260901 | recorded in the manifest |
| reserved | 2026-09-02T04:09:06.961Z, at git HEAD `496ad1d` | recorded in the manifest |
| tuning | 18 fixtures | all development, prompt work and rule comparison |
| held-out | 8 fixtures | one confirmatory run, then spent |

`reserve-split.mjs` refuses to overwrite an existing manifest and has no `--force`: the split cannot
be silently redrawn after seeing a result. `model-agreement.mjs --only` can narrow *within* a split
but hard-errors on an id outside the chosen one, so a pre-flight check on a tuning fixture cannot
reach a held-out fixture by accident.

### 2.3 Instrument

PIS-7 — seven domains, each scored 0–5 against behavioural anchors approved by the ethics committee
(CREC082 attachment *PIS7_Rubric_Behavioral_Anchors_V2.0*).

| key | domain | weight |
|---|---|---|
| d1 | Clinical Question Intelligence · ปัญญาในการตั้งคำถามคลินิก | 0.15 |
| d2 | Reasoning Depth · ความลึกของการให้เหตุผล | **0.20** |
| d3 | Contextual Integration · การบูรณาการบริบท | 0.15 |
| d4 | Iterative Inquiry · การสืบค้นแบบต่อยอด | 0.15 |
| d5 | Critical Appraisal · การประเมินอย่างมีวิจารณญาณ | 0.15 |
| d6 | Reflective Synthesis · การสังเคราะห์เชิงสะท้อนคิด | 0.10 |
| d7 | AI Literacy & Prompt Skill · ความรู้เท่าทัน AI และทักษะการพรอมต์ | 0.10 |

Composite = Σ(domain × weight) × 20, range 20–100 (`rimpl/src/lib/pis7.js:32`). Weights are a single
source of truth at `rimpl/src/lib/versions.js:9`, mirrored in the audit front-end and hashed into a
rubric version (`pis7-weights-08b0cb1a`), which did not change during the study.

> **Two composites appear in the record and they are not the same number.** The probe logs print the
> *unweighted* d1–d7 sum (range 0–35); the verdict tool uses the *weighted* 0–100 composite. This is
> why the same two runs are reported as 0.726/0.765 in one place and 0.735/0.762 in another. Every
> figure in this document is on the **weighted** composite unless it says otherwise.
>
> *Note, 2026-10-01:* the probes now print the weighted composite too, through production's
> `compositeOf` and `icc.js` (`scripts/probe/agreement-stats.mjs`). `e2-compare.mjs` now reads
> 0.735/0.762 off those two reports; 0.726/0.765 survive only in the logs written before that date.

### 2.4 Models

| | candidate | incumbent |
|---|---|---|
| identifier | `deepseek-v4-flash-dspark` | `claude-sonnet-4-6` |
| serving | vLLM `0.21.1rc1.dev339+g1967a5627bc3-tp2`, reached through an Open WebUI gateway on a shared on-premise host | vendor API |
| temperature | 0 | 0 |
| max tokens | 4096 | 4096 |

The candidate is a **custom build name**; the underlying base release, weight checksum and
quantization are not discoverable through the gateway, and the host is administered by a third party
who can change models on it. This is recorded as an open item for the Model Lock record
(`docs/GATE0-DGX-RESULTS.md` §5.2, §5.3) and is a limitation of the study, not a detail: a model
version that cannot be pinned cannot be certified.

### 2.5 Prompts

The scoring prompt is identical for both arms except for an addendum appended only to the candidate's.

| | chars | provenance |
|---|---|---|
| base evaluator prompt (both arms) | 4,639 | `pis7-prompt-59561c29`, byte-identical in every run |
| candidate addendum, first version | +1,601 (6,240 total) | `+local-cae23b1a5f37` |
| candidate addendum, second version | +2,266 (6,905 total) | `+local-c5ffe572aa81` |

Prompt provenance is stamped into every report by `promptVersionFor()`
(`rimpl/src/lib/versions.js:30`), and `screening-verdict.mjs` refuses to present a run's figures
without saying which prompt produced them.

> **The base prompt has not been calibrated since it last changed.** Hashing `PIS7_EVALUATOR_PROMPT`
> at every commit that touched it yields three versions: `35f265977a8c` (1,312 chars) →
> `a849c6b21b94` (3,357 chars, the version that measured 0.811) → `59561c292df0` (4,639 chars,
> current). The last transition is the CREC082 conformance commit, which inserted the committee's
> approved 0–5 scale and per-domain anchors. That change was correct — an AI and a human scoring
> against two different rubrics produce an ICC that measures the gap between the rubrics — but no
> calibration run has followed it. The incumbent's agreement with any rater, on the prompt it
> actually runs, is unmeasured.

---

## 3. Interventions

Two levers were available and both were tested against the tuning split.

**3.1 Self-consistency rule** (`rimpl/src/services/consistency.js`). Three modes:

| mode | behaviour |
|---|---|
| `off` | one scored call |
| `adaptive` | two calls; if no domain differs by more than 1 the first is returned, otherwise a third call and the per-domain median |
| `median3` | always three calls, per-domain median, no short-circuit |

The disagreement threshold is `maxDomainDelta: 1` with `maxSumDelta` disabled by default
(`consistency.js:44`). A JSON re-ask budget of 2 is shared across the whole run.

**3.2 Candidate prompt addendum.** A block appended only to the candidate's prompt, targeting the
three weaknesses the first measurement found: a −2.2 composite compression (on the unweighted 0–35
sum — note, 2026-10-01: that run's report was not archived, so it has no weighted figure), weak d1,
and a level shift. Its second version re-punctuated its worked examples to single quotes for a
reason given in Section 7.6.

**One of these two levers never actually ran** — see Section 7.5. That is itself a result.

---

## 4. Outcomes

**Primary.** The lower bound of the 95% confidence interval on ICC(A,1) for the weighted composite,
against a threshold of 0.75. The *lower* bound, not the point estimate, so that a wide interval
cannot pass by luck (decision D19: `insufficient` is a first-class verdict, distinct from `fail`).

**Secondary.**

| outcome | definition |
|---|---|
| per-domain ICC(A,1) | the same estimator on each of d1–d7 |
| agreement Σ\|Δ\| | per fixture, Σ over d1–d7 of \|candidate − incumbent\| — disagreement **between** the models |
| repeatability Σ\|Δ\| | per fixture, Σ over d1–d7 of (max − min) across repeated scorings by **one** model — the noise floor |
| parseability | valid PIS-7 JSON as a fraction of local model **calls**, threshold ≥ 98% |
| bias | mean(candidate) − mean(incumbent) on the composite |
| Bland–Altman limits | mean difference ± 1.96 SD |

> The two Σ|Δ| statistics answer different questions and were, until this study was written up,
> recorded under one column heading. Repeatability bounds what agreement can possibly mean: a model
> that disagrees with itself by 6 points cannot be shown to agree with anything to within 2.

---

## 5. Statistical methods

**Intraclass correlation.** ICC(A,1) — two-way random effects, absolute agreement, single measure
(equivalently ICC(2,1) in the Shrout–Fleiss scheme). The estimator is the platform's production
implementation, `iccTwoRater` at `backend/src/services/icc.js:20-72`, used unmodified so that a
figure quoted in a paper is the same figure the platform's own credit gate computes. Absolute
agreement, not consistency, is the correct model here: a candidate scorer that ranks episodes
identically but sits two points lower is not a substitute.

**Confidence interval.** The figures in this report were computed with Fisher-z, se = 1/√(n − 3),
back-transformed and clamped to [0, 1] — the interval `icc.js` used at the time. From 2026-10-01
`icc.js` uses the exact F-based McGraw & Wong (1996) interval instead (the one R's `irr` and
pingouin use); a re-run of this analysis will report different bounds for the same point estimates,
and must say which interval it used. At n = 8 either interval is wide by construction, and the study
was designed knowing that — see the power calculation below. The estimator refuses to return a verdict below
n = 4 (`icc.js:281-308`).

**Verdict rule.** `pass` if the lower bound clears the threshold; `fail` if the upper bound is below
it; **`insufficient`** if the interval spans it. The third state is the point of the design: it
separates "we measured disagreement" from "we could not measure".

**Power.** `screening-verdict.mjs:138-143` inverts the interval — for a hypothesised true ICC it
finds by linear search the smallest n whose lower bound clears the threshold:

| if the true ICC were | pairs needed |
|---|---|
| 0.95 | 9 |
| 0.92 | 14 |
| 0.90 | 19 |
| 0.88 | 27 |
| 0.85 | 51 |
| 0.82 | 117 |
| 0.80 | 247 |

> **Correction, 2026-10-01 — this table was built on a Fisher-z interval that `icc.js` no longer
> uses.** `icc.js` now uses the exact F-based McGraw & Wong interval (the one R's `irr` and
> pingouin use). The two differ by only 1–2 pairs here (F-based: 0.95→7, 0.92→12, 0.90→17,
> 0.88→26, 0.85→50, 0.82→116, 0.80→245). The larger correction is what the table *means*. Each
> row is the n at which an interval centred on the true value just clears 0.75, which is roughly a
> **coin-flip chance of `pass`**, not power. Simulated 80% power (no rater bias, 600 reps): 0.95 →
> ~14, 0.92 → ~26, **0.90 → ~36, 0.88 → ~60**, 0.85 → ~110. Any rater bias raises these. Plan
> cohorts on the 80% figures.

This ladder is the study's a-priori power calculation and it was published before the confirmatory
run. With 26 fixtures in existence, only a true agreement of about 0.9 or better was ever
demonstrable. That was stated and accepted in advance rather than discovered afterwards.

**Rates.** Wilson intervals for proportions; Fisher's exact test for before/after comparisons of
parse-failure counts. Every rate in this document is also given as counts, because at these
denominators a percentage conceals how little evidence it rests on.

**Variance decomposition.** For each paired run, the mean squares underlying the ICC are reported as
two standard deviations on the composite scale:

- `sdBetween` = √(max(0, (MS_between − MS_error) / k)) — how far the **episodes** stand apart;
- `sdError` = √(MS_error) — how far the two **scorers** stand apart on the same episode.

Their ratio is diagnostic. Because an ICC is a variance ratio, a ratio below 1 caps the achievable
coefficient below 0.5 however well the candidate performs. `methodology-figures.mjs` self-checks
that these components re-derive the production ICC to three decimal places.

**Permutation test.** To ask whether the held-out arm is unusually narrow rather than merely small,
all C(26, 8) = 1,562,275 subsets were enumerated exactly and the fraction with a standard deviation
at or below the observed one reported. This is exact and needs no seed; a 20,000-draw seeded Monte
Carlo is also computed and agrees, purely as a check on the enumeration.

**No correction for multiplicity, and no per-domain inference.** Seven domain-level ICCs are reported
for description only. At these sample sizes they are not findings — Section 7.7 shows one of them
reading 0.055, 0.663 and 0.294 across three runs of the same configuration.

---

## 6. Results

### 6.1 All runs

Twelve runs, 2 – 4 September 2026, local time (UTC+07). One workload at a time: the host is shared
and concurrent probe runs degraded it once, so overlapping runs would not be comparable.

| # | when | tool | configuration | outcome |
|---|---|---|---|---|
| 1 | 09-02 13:06 | `context-limit` | synthetic 8k → 96k | no input ceiling found; a sentinel was still recalled at 66,029 served tokens |
| 2 | 09-02 16:55 | `model-agreement` | tuning · adaptive · **no addendum** | 16/18 paired · **0.578** (0.116–0.835) · bias −7.87 · Σ\|Δ\|agr 4 · JSON 18/18 |
| 3 | 09-02 22:32 | `repeat-consistency` | tuning · 18 × 5 · candidate arm | **10/18** measurable · Σ\|Δ\|rep median **6**, max 10 · 3/10 at the bar |
| 4 | 09-03 17:32 | `repeat-consistency` | tuning · 18 × 5 · **addendum off** | 11/18 measurable · median **5**, max 12 · 4/11 at the bar |
| 5 | 09-03 23:26 | `repeat-consistency` | tuning · 18 × 5 · **addendum on** | **18/18** measurable · median **1**, max 7 · **14/18** at the bar |
| 6 | 09-04 10:11 | `model-agreement` | tuning · adaptive · addendum `cae23b1a5f37` | 14/18 paired · **0.735** (0.335–0.910) · bias +1.64 · Σ\|Δ\|agr 2 · JSON 17/18 † |
| 7 | 09-04 11:50 | `model-agreement` | tuning · **stamped `median3`, ran `adaptive`** | 15/18 paired · **0.762** (0.410–0.917) · bias −0.73 · Σ\|Δ\|agr 2 · JSON 17/18 † |
| 8 | 09-04 16:48 | `model-agreement` | tuning · adaptive · addendum `c5ffe572aa81` | **18/18** paired · **0.611** (0.202–0.839) · bias −1.56 · Σ\|Δ\|agr 3.5 · JSON 37/37 |
| 9 | 09-04 18:40 | `model-agreement` | identical to #8, 112 minutes later | 12/18 paired · **0.795** (0.407–0.940) · bias +0.17 · Σ\|Δ\|agr 3 · JSON 30/30 |
| 10 | 09-04 19:25 | `model-agreement` | identical to #8, first run with retry | **aborted** — HTTP 400, cloud API credit exhausted, at fixture 8 of 18 |
| 11 | 09-04 ~21:45 | `canary.sh` | one real evaluation on a spent tuning fixture | passed in 96.3 s — the precondition for opening the split |
| 12 | **09-04 21:52** | `model-agreement` | **held-out** · adaptive · 4 attempts per arm | **8/8** paired, zero losses · **0.436** (0.000–0.873) · bias −2.50 · Σ\|Δ\|agr 2 · JSON 16/16 |

† counted per fixture rather than per call — these two reports predate per-call accounting, so the
figure is a floor, not a rate.

Bias and Bland–Altman limits are on the weighted 0–100 composite. Candidate latency was 156–193 s per
fixture at the median against 20–25 s for the incumbent, throughout.

### 6.2 The confirmatory run

```
split heldout · reserved 2026-09-02T04:09:06Z · git_head 496ad1d · seed 20260901
candidate deepseek-v4-flash-dspark   incumbent claude-sonnet-4-6
prompt pis7-prompt-59561c29+local-c5ffe572aa81 · consistency adaptive · 4 attempts per arm
n = 8 · 8/8 paired · zero losses · 16 candidate calls · 0 re-asks · JSON 16/16 = 100%

ICC(A,1) weighted composite   0.436  (95% CI 0.000 – 0.873)     threshold 0.75, lower bound
per-domain   d1 0.13 · d2 0.26 · d3 0.52 · d4 0.00 · d5 0.53 · d6 −0.17 · d7 0.63
bias −2.50 · Bland–Altman −21.96 … 16.96 · agreement Σ|Δ| median 2
verdict: INSUFFICIENT — the interval spans 0.75
pairs needed at the observed 0.436: none — the point estimate is not above the threshold
```

### 6.3 Why the coefficient fell: the denominator

| run | n | cloud SD | sdBetween | sdError | **ratio** | ICC |
|---|---|---|---|---|---|---|
| **held-out** | 8 | **11.11** | 5.98 | **7.02** | **0.85** | 0.436 |
| tuning #8 | 18 | 17.22 | 11.94 | 9.73 | 1.23 | 0.611 |
| tuning #9 | 12 | 18.36 | 14.56 | 7.72 | 1.89 | 0.795 |
| tuning #6 | 14 | 16.45 | 13.00 | 8.01 | 1.62 | 0.735 |
| tuning #7 | 15 | 17.93 | 14.33 | 8.26 | 1.73 | 0.762 |
| tuning #2 | 16 | 16.72 | 11.38 | 8.23 | 1.38 | 0.578 |

On the held-out split `sdError` is **7.02**, the lowest of any run in the study (tuning: 7.72–9.73);
the agreement Σ|Δ| median is 2, the joint lowest; and no call failed to parse. By every measure of
*absolute* agreement, the confirmatory run is the candidate's best performance. The coefficient is
its worst because held-out is the only arm whose ratio falls below 1 — the eight episodes differ from
each other by less than the two scorers differ on the same episode.

### 6.4 Why the denominator collapsed: the draw

Pooling the incumbent's composite for each of the 26 fixtures across all six agreement runs (the
incumbent's prompt was byte-identical throughout, so the runs are poolable):

| arm | n | mean | SD | range |
|---|---|---|---|---|
| held-out | 8 | **43.50** | **11.11** | 32.0 – 62.0 |
| tuning | 18 | 58.40 | 17.28 | 33.8 – 88.8 |

The held-out arm is both lower and narrower, and contains no high-scoring episode at all. Enumerating
every one of the C(26, 8) = 1,562,275 possible subsets, **6.47%** (101,028) have a standard deviation
at or below the observed 11.11. The draw was unlucky but not extraordinary — and, critically, it was
made and frozen before any tuning, so this is the pre-registration control behaving exactly as
intended while producing an uninformative sample. That is a real hazard of small pre-registered
splits and, as far as we can tell, an under-discussed one.

---

## 7. Threats to validity

Ordered by how much each one constrains the conclusion. Several were discovered by finding a wrong
number already published, and are recorded here in that form because the failure mode is the
transferable part.

### 7.1 Range restriction in the confirmatory split

Established in 6.3 and 6.4. Its consequence for interpretation is that **the study cannot
distinguish "the candidate disagrees more on held-out" from "the held-out episodes discriminate
less"**, and the auxiliary measures point at the second. The 95% interval, 0.000 – 0.873, excludes
neither good nor poor agreement.

This is the same failure mode already measured on the human raters this platform's gate ultimately
depends on: at the human-agreement baseline, ICC was **−0.315** on n = 5, with between-episode SD
2.44 against error SD 2.69. Five episodes scored 74–80 by humans and 71–91 by the AI do not differ
from each other enough for any rater to be shown to agree about them. **Restriction of range is the
recurring finding of this programme, and it is a property of the corpus, not of any model.**

### 7.2 The reference standard is itself unreliable, and this is rarely measured

An agreement study inherits the reliability of its reference. Ours was measured, and it is poor.
Re-scoring one episode (PLE-045) at temperature 0:

| | composites across repeats | range | schema failures |
|---|---|---|---|
| candidate | 16, 16, 16, 16, 17 | **1** | 0 of 5 |
| **incumbent** | 12, 16, 21, 13 | **11** | 2 of 6 |

On that episode the frontier cloud model was the *less* reproducible of the two, on a 0–35 scale
where the whole between-model gap was about 4. Across the corpus, roughly **59%** of the candidate's
run-to-run variance is a common-mode per-run level shift rather than per-domain noise, and the two
models' failure sets are largely disjoint.

This is n = 1 episode for the incumbent and must not be over-read. But it is enough to establish that
the reference standard has non-trivial measurement error, which places a ceiling on any achievable
agreement coefficient. Most LLM-as-judge comparisons we are aware of report agreement with a frontier
model without ever measuring that model against itself. **Where the reference is another model,
its test–retest reliability should be reported alongside the agreement statistic**, or the agreement
statistic has no interpretable scale.

### 7.3 No agreement figure in this project has ever involved a human rater

The evaluator's frequently cited ICC of 0.811 was measured against three *simulated* agent-raters
with assigned stances, on a cohort regenerated after the original was destroyed by its own cleanup
step. The prompt that produced 0.811 has not shipped since the ethics-conformance commit replaced it
(Section 2.5). Consequently this study compares a candidate against an incumbent whose own agreement
with human experts is unknown, using a prompt whose agreement with anything is unmeasured. The
decisive gate — candidate versus humans — remains the programme's real go/no-go and is unaffected by
anything reported here.

### 7.4 Survivorship bias: the metric improves as the infrastructure degrades

When a run loses fixtures to transport failures, the losses are not random. Longer transcripts take
longer to score, so they are both the ones a flaky host drops **and** the ones the two models
disagree about. Across every run that lost anything, the lost fixtures' mean agreement Σ|Δ| exceeded
the survivors':

| run | lost | lost mean Σ\|Δ\| | survivor mean | difference |
|---|---|---|---|---|
| #6 addendum | 4 | 4.19 | 3.07 | +1.12 |
| #9 c5ffe rep2 | 6 | 4.64 | 3.25 | +1.39 |
| #7 median3 | 3 | 5.44 | 3.33 | +2.11 |
| #2 v0 | 2 | 4.50 | 4.13 | +0.38 |

Four of four in the same direction, with a mechanism that predicts the direction in advance. The
cleanest demonstration is runs #8 and #9: identical model, prompt, rule and host, 112 minutes apart,
**0.611 with all 18 fixtures against 0.795 with 12**. The run that lost a third of its sample scored
0.18 higher.

Mitigated from commit `9ea5636` onward by retrying transport failures (up to 4 attempts, 20 s
doubling backoff) and by distinguishing a transport failure from a model failure at the call site.
**Every figure recorded before that commit carries the bias.** The confirmatory run lost nothing.

Generalisation: an evaluation harness that silently drops hard cases reports a better model than it
has. Losses must be retried, and the loss rate must be published beside the metric.

### 7.5 A lever that was configured, recorded, and never ran

Run #7 is stamped `consistency: "median3"` in its report. It ran `adaptive`. The probe passed the
flag through to the report while the call site had the mode hardcoded, so every row shows two calls
where a real `median3` requires three. The two "different" configurations #6 and #7 are the same
configuration, and the 0.735 → 0.762 difference between them is a re-run difference at n = 14/15, not
a treatment effect. **`median3` has still never been measured.**

The transferable rule: **verify from the execution evidence, not from the configuration**. Call
counts, token counts and latencies all recorded the truth here; only the flag lied. A stamped
configuration is a record of intent.

### 7.6 Parseability: an accounting rule that was got wrong four times in one day

The ≥98% JSON-validity bar produced four different answers about the same runs before settling:
95.4% (charging transport failures and cloud-side failures to the candidate), then "100%" (excluding
`Pis7ScoreError`, which is precisely the contract breach the bar exists to catch — this switched the
gate off, turning a run with 5 of 18 failing rows into a clean pass), then 94.4%, per call.

The root ambiguity is real and worth naming: the HTTP client never throws, so a timeout returns an
empty body, the empty string parses to `{}`, the schema fails, and a dead host is indistinguishable
from a garbage reply at the point where the error is classified. It is solvable only at the call
site, where the transport status is still visible. Two rules resulted, now unit-tested
(`scripts/probe/parseability.mjs`, 13 cases): **only a transport failure leaves the denominator**,
and **count calls, not fixtures**.

Separately, the bar itself cannot be adjudicated at this scale. The apparent addendum-induced
regression, 97.4% → 94.4%, is 1 bad parse in 38 against 2 in 36: Fisher exact **p = 0.61**, and
p = 1.00 after re-classifying one as a timeout on deterministic token-count evidence. Every interval
straddles 98%, including the baseline's. Clearing 98% with 95% confidence requires **189 consecutive
clean calls**. The real mechanism was found and fixed on its merits anyway: the addendum's symmetric
evidence rule raised the rate at which the model quotes transcript text inside a JSON string from
about 3% of domain scores to about 55%, and the addendum's own worked examples used the very
double-quote character that breaks the parser. Re-punctuating them to single quotes changed the
prompt hash, which invalidated the measurements taken with the previous one.

**A measurement error that flatters the model is not symmetric with one that libels it.** The second
is caught by the next run; the first ships.

### 7.7 Per-domain coefficients at this n are not findings

Across three runs of the same configuration, d1 read **0.055 → 0.663 → 0.294**. A narrative built on
run 2 ("the addendum rescued d1 at d6's expense") is contradicted by run 3, where d6 recovers to
0.745 and d1 collapses. Seven domain ICCs at n ≈ 15, uncorrected, will always yield an apparent
pattern.

The one signal stable across all runs is **d4, Iterative Inquiry**, lowest every time
(0.425 / 0.552 / 0.530), and of a kind calibration cannot fix: the two models' *means* on d4 agree to
within 0.07 while their per-episode ranking does not. If prompt work resumes, that is where the
headroom is. Even this is offered as a hypothesis for a properly powered study, not a result.

### 7.8 Run-to-run variance at a fixed configuration

Two draws from one configuration ninety-odd minutes apart returned 0.611 and 0.795 (Section 7.4), and
another pair returned 0.735 and 0.762 (Section 7.5). At n ≈ 15 the sampling noise on this statistic
is of the same order as every effect the study set out to detect. Two draws from one configuration
are the best available estimate of that noise and should be reported as such rather than as a
treatment contrast.

### 7.9 Uncontrolled, shared hardware

The candidate ran on a host administered by a third party, serving several unrelated models to other
users, reached over a VPN through a gateway rather than directly. Identical work took **57 s and
956 s two hours apart**; at one point a 30-token prompt answered in 1 second while the smallest
tuning transcript exceeded 10 minutes. No timeout or concurrency setting protects against a
neighbour's job. Two probe runs sharing the host once degraded it for hours, after which the rule
became one workload at a time.

This affects latency figures directly and the agreement figures indirectly through 7.4. It is also
why the model version could not be pinned (Section 2.4): a machine where another person can change
the weights cannot support a Model Lock record.

### 7.10 Optimism from tuning to confirmation, confounded with 7.1

The tuning-split estimates on the final prompt were 0.611 and 0.795; the confirmatory estimate was
0.436. Part of that drop is the ordinary optimism of estimates taken on data used for development —
which is exactly what a held-out split exists to expose, and it worked. But it cannot be cleanly
separated from the range restriction of 7.1, because the same eight episodes carry both effects. A
larger corpus, split so that both arms span the scale, would separate them; this one cannot.

### 7.11 The path that was measured was not the path that would serve

Every figure in this report was produced by `scripts/probe/*`, a harness that calls the model
directly. It shares the *instrument* with the production service — the same rubric weights, the same
assembled prompt, the same self-consistency module, all imported from `rimpl/src/lib` and
`rimpl/src/services` — but not the *transport*: the provider adapter, the bounded queue, the
de-identification filter and the provenance builder that a served score actually passes through were
never exercised against the box while any of these numbers were taken. A study can measure an
instrument perfectly and still not have measured the system that will use it.

This was closed only partially, and only after the analysis was complete (2026-09-05,
`docs/GATE0-DGX-RESULTS.md` §8.10). One tuning fixture was scored end to end through the production
service against the same endpoint: it returned in 135 s under the same prompt label
(`pis7-prompt-59561c29+local-c5ffe572aa81`), and its composite re-derived exactly — Σ(score × weight)
= 3.00, × 20 = 60.0. So the two paths assemble the same instrument, which is the part that matters for
these figures. What remains untested at scale is everything the harness does not have: queueing
behaviour under concurrent load, retry accounting, and the de-identification filter on real traffic.

**It also found a defect the harness could not have.** Provenance recorded `engine`, `quantization`
and `runtime` as null on every served score, while the endpoint returned
`system_fingerprint: vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2-48c629c0` on every call — two of the
three fields CREC082 §10.2 requires, arriving in plain sight and being discarded. No unit test could
have caught it, because the mocks never carried the field; no probe could have, because the probes
never ran that code. **A methodology that validates only its measurement harness will report clean
figures from a system that cannot record what its own protocol requires.**

---

## 8. Conclusions, and what a future study would need

### 8.1 What this study establishes

1. **The screening gate returns `insufficient`.** ICC(A,1) = 0.436 (0.000 – 0.873) on the reserved
   held-out split; the interval spans the 0.75 threshold. At that point estimate no attainable number
   of additional pairs would clear a lower bound of 0.75.
2. **No further run on this corpus can change that**, and the reason is measurable rather than
   speculative: the confirmatory arm's between-episode variance is smaller than its scorer-error
   variance.
3. **The candidate's absolute agreement was good and its output contract was clean** — error SD 7.02,
   agreement Σ|Δ| median 2, 16 of 16 calls valid JSON, zero losses — which is *not* the same as
   passing, and must not be reported as if it were.
4. Operationally: the incumbent remains the scorer of record for credit-bearing evaluation. The
   candidate is deployed only for non-credit-bearing purposes, where no agreement gate applies.

### 8.2 What it does not establish

- Not that the candidate model disagrees with the incumbent.
- Not that the candidate model is fit to score. A screening gate cannot accept, by design; and n = 8
  supports no acceptance claim in any case.
- Nothing about agreement with human experts, which is the question that actually gates credit.

### 8.3 What a future study needs

1. **Episodes chosen to span the scale.** This is the binding constraint. A corpus whose composites
   cluster cannot certify any scorer, and adding scorers or runs does not help. Sampling should be
   stratified over the composite range — which requires scoring a larger pool first, then selecting.
2. **A reference standard with published test–retest reliability.** If the reference is a model, run
   it against itself and report that number beside the agreement statistic. If it is human, report
   inter-rater reliability on the same episodes.
3. **The power calculation before the data.** The pairs-needed ladder in Section 5 is cheap to
   compute and would have told us, on day one, that 26 fixtures could only ever demonstrate agreement
   at about 0.9 or above.
4. **A harness that retries and reports its losses.** See 7.4.
5. **A pinned model.** Base release, weight checksum, engine version and quantization, on hardware
   under change control. None of these were obtainable here.
6. **Larger held-out arms than intuition suggests**, or a split stratified on the outcome. An 8-case
   confirmatory sample drawn at random from 26 had a 6.47% chance of being at least as uninformative
   as the one we drew; that is not a remote risk.

---

## 9. Reproducibility

### 9.1 Data and code

| artefact | location | committed |
|---|---|---|
| run reports (10 JSON) | `scripts/probe/report/*.json` | yes |
| held-out verdict | `scripts/probe/report/heldout-c5ffe-adaptive.verdict.json` | yes |
| split manifest + per-fixture SHA-256 | `scripts/probe/SPLIT.json` | yes |
| figure regeneration | `scripts/probe/report/methodology-figures.mjs` | yes |
| transcripts | `scripts/probe/fixtures/*.json` | **no** — clinical dialogue |

The reports contain scores and identifiers only: across all ten files there are 60 distinct string
values in total — timestamps, a git SHA, pseudonymous `PLE-NNN` ids, mode and model names, prompt
hashes and probe labels. No rationale text, no transcript, no patient reference.

### 9.2 Commands

```sh
# 2  baseline agreement, no addendum
node scripts/probe/model-agreement.mjs --split tuning --consistency adaptive \
     --out scripts/probe/report/tuning-agreement-v0.json
# 3-5  noise floor, addendum off then on
node scripts/probe/repeat-consistency.mjs --arm local --split tuning --fixtures 18 --repeats 5 \
     --addendum off --out scripts/probe/report/noise-2026-09-03-noaddendum.json
# 6-9  agreement with each addendum version
node scripts/probe/model-agreement.mjs --split tuning --consistency adaptive \
     --out scripts/probe/report/tuning-agreement-c5ffe-adaptive.json
# 11   pre-flight before opening the split
sh scripts/probe/canary.sh
# 12   the confirmatory run — ONCE
node scripts/probe/model-agreement.mjs --split heldout --consistency adaptive \
     --attempts 4 --retry-base-ms 20000 \
     --out scripts/probe/report/heldout-c5ffe-adaptive.json
```

The verdict tool imports the platform's production ICC implementation and therefore runs from
`backend/`:

```sh
cd backend && node ../scripts/probe/screening-verdict.mjs \
  --agreement ../scripts/probe/report/heldout-c5ffe-adaptive.json --json
```

Exit codes: 0 pass, 1 fail, 3 insufficient, 2 misconfigured. Tuning-split reports require
`--allow-tuning` and are labelled "not a gate result" in the output.

### 9.3 Provenance checks that run automatically

- Every fixture's SHA-256 is re-verified against the split manifest on every run.
- Every report records the exact prompt version of both arms; the verdict tool compares the recorded
  version against the working tree and warns when a report describes a prompt that no longer exists.
- The figure script self-checks that its variance components re-derive the production ICC to three
  decimals, and cross-checks its exact permutation enumeration against a seeded Monte Carlo.

---

## 10. Notes on scope and wording

Three statements that appear in adjacent project material must **not** be carried into a paper:

1. **Provider randomisation is not implemented.** The architecture describes per-session allocation
   of the AI provider; `docs/constraints.md:4` marks it *"Planned — not yet implemented; runs
   Claude-only."* No sentence about randomised provider assignment can be written as as-built.
2. **"PII never leaves Thailand" is false.** The application database is hosted in `ap-northeast-1`.
   The defensible claim is narrower and still worth making: on-premise inference removes the
   cloud-inference hop, so de-identification becomes defence-in-depth rather than the sole barrier.
3. **Terminology.** *PLE* (Professional Learning Episode) throughout. The **Pilot Study**
   (75 physicians × 3 episodes) **has not started**; the August–September 2026 activity was a sandbox
   round whose sessions are flagged as tests and count toward nothing.

**Ethics.** All transcripts were de-identified by the production filter before any model saw them,
under protocol CREC082. No participant data appears in this document or in any committed artefact.

**Status.** This document reports a screening result. It is not a validation of either model as a
scorer of physician clinical reasoning, and no credit decision rests on it.
