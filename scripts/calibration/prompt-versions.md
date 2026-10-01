# PIS-7 Evaluator Prompt — Calibration Versions

Archive of `PIS7_EVALUATOR_PROMPT` (`rimpl/src/lib/prompts.js`) revisions and the ICC each produced.
Goal: lift AI↔human ICC toward ≥0.75 by removing the AI's leniency on templated/structured reasoning.
(See README caveats — these are directional, not a passed gate.)

**Cohort note (2026-06-10):** the original 2026-06-07 soak cohort (ICC 0.662) was wiped by its own
clean-slate step and had no backups, so the cohort was REGENERATED on the scaletest project via
`scripts/soak/` (11 evaluated PLEs, 3 agent-rater stances, 33 ratings; inter-rater ICC 0.742). All
runs below measure against the regenerated cohort; archived under `runs/`.

| Version | Prompt sha (first 12) | ICC (95% CI, regen cohort) | Mean bias | What changed |
|---------|-----------------------|----------------------------|-----------|--------------|
| v0 (original) | `--mode baseline` 2026-06-10 | **0.377** (0.04–0.64) n=33 | **+16.4** lenient | original prompt (2026-06-07); worst d2 +1.36, d6 +1.24, d1 +1.15 |
| v1 | 4d23a997f403 | **0.700** (0.47–0.84) n=33 | ≈ −8 | calibration rules: structure ≠ depth, quote-evidence threshold for 4–5, template caps, "expect 2–3" — overcorrected the top tier (P-016/17 −12…−16) |
| v2 | a849c6b21b94 | **0.811** (0.64–0.91) n=30 | ≈ ±0 | kept v1's brakes; removed middle-compression ("use the FULL scale", award evidenced 4–5 confidently, linkage phrases count when they engage content) — all domain Δ ≤ \|0.43\| |
| **v3 (CURRENT)** | `59561c292df0` | **never measured** | — | `cd29df5` inserted the CREC082-approved behavioural anchors: an explicit 0–5 scale and per-domain 0/3/5 anchors, 3,357 → 4,639 chars. Correct on its own terms — the committee-approved rubric must win — but it changed the instrument and no calibration run has ever been made against it |

⚠️ v2's first measurement read 0.487 — poisoned by ONE malformed eval (AI=0, missing domains). The
harness now validates each eval (retry once, drop on second failure). The clean re-run (n=30; one
PLE dropped — the 46k-token transcript truncates the evaluator's 1000-token output) gave 0.811.
(Follow-up done 2026-06-10: `maxTokens` raised to 2000 in `rimpl/src/routes/evaluate.js`.)

> ### ⚠️ 2026-09-04 — the 0.811 does not describe the prompt that ships
>
> The evaluator prompt has had exactly three versions, verified by hashing
> `PIS7_EVALUATOR_PROMPT` at every commit that touched `rimpl/src/lib/prompts.js`:
>
> | commit | sha | chars | |
> |---|---|---|---|
> | `a1e7cc3` | `35f265977a8c` | 1,312 | original scaffold |
> | `ef65ee7` | `a849c6b21b94` | 3,357 | v2 — **the prompt that measured 0.811** |
> | `cd29df5` | `59561c292df0` | 4,639 | v3 — CREC082 behavioural anchors; **shipping since, never calibrated** |
>
> `cd29df5` ("bring the platform into conformance with the CREC082 protocol") added the approved 0–5
> scale and the per-domain 0/3/5 anchors. That is the right change — an AI and a human scoring against
> two different rubrics produce an ICC that measures the gap between the rubrics, as the code comment
> introduced by that very commit says. But it replaced the instrument, and **the calibration did not
> follow it.** Every citation of 0.811 as the incumbent evaluator's agreement describes a prompt that
> has not run since.
>
> Three consequences, all still open:
> - **`docs/GATE0-DGX-RESULTS.md` §5.2 names `pis7-prompt-a849c6b2`** as the CREC082 §10.2 Model Lock
>   "evaluator prompt version ✅". That value is two revisions stale and no code produces it — the
>   ✅ is wrong. (`pis7-weights-08b0cb1a` in the same table is still correct.)
> - The whole local-model screening programme below ran against **v3** (`59561c29`), so it compares a
>   candidate to an incumbent whose own agreement with any rater is unmeasured.
> - It compounds, rather than causes, the deeper problem: the 0.811 was against **three simulated
>   Claude agent-raters**, not humans (`scripts/soak/gen-auditor-wf.js:30-32`). No ICC in this
>   project has ever been measured against a real human auditor.
>
> Do not re-run the v2 calibration to "restore" the number. The cohort it used was itself a
> regeneration after the original was wiped, and the raters were synthetic. The gap this exposes is
> closed by Gate 0.5 (real human auditors), not by re-measuring against agents.

## Notes per version

### v0 — original (2026-06-07)
Domains/weights only, 0–5 scale with one-word anchors (0 Not observed … 5 Very High). No guidance
distinguishing genuine reasoning depth from templated structure → AI rewards effort/structure.

### v1 — measured 0.700 (superseded by v2)

Targets the measured divergence (AI lenient on d2 +0.8 / d3 +0.83 / d1 +0.73 / d6 +0.73; slightly
harsh on d5 −0.23). Apply by replacing the body of `PIS7_EVALUATOR_PROMPT` in
`rimpl/src/lib/prompts.js` AFTER the current-prompt rescore is recorded, then re-run `--mode rescore`.

```
You are PIS-7 Evaluator. Assess the PHYSICIAN'S reasoning behaviour (NOT the AI's responses) across 7 domains. Ignore AI turns.

CALIBRATION RULES (apply BEFORE scoring):
- Structure is NOT depth. Headings, lists, or textbook-style completeness earn NOTHING by themselves.
  Score the ORIGINAL reasoning visible in the physician's own words: hypothesis generation, weighing,
  revision in response to new information.
- Penalize templated/scripted behaviour: generic questions that fit any case, restated AI content,
  boilerplate summaries. A verbatim-repeated or near-duplicate physician turn caps d2 and d4 at 2.
- Evidence threshold: a score of 4–5 in ANY domain requires quoting (in the rationale) a specific
  physician utterance that could NOT have been written without engaging this particular case.
  If you cannot quote one, the score is at most 3.
- Most real sessions are mixed: expect 2–3 in most domains. 4–5 is the exception, not the default.
- Do NOT penalize genuine critical appraisal for bluntness (d5): challenging or testing the AI's
  answer counts even when brief.

DOMAINS AND WEIGHTS:
1. Clinical Question Intelligence (15%) — questions are case-specific and expose real decision points;
   generic "what's the differential?" questions score ≤2.
2. Reasoning Depth (20%) — the physician COMMITS to ranked hypotheses with justification, weighs
   risk-benefit, updates when contradicted. A list of diagnoses without ranking/justification is ≤2.
3. Contextual Integration (15%) — THIS patient's age/comorbidities/setting visibly change the
   reasoning. Mentioning context without it altering any decision is ≤2.
4. Iterative Inquiry (15%) — each turn builds on the AI's previous answer (probes, narrows, tests);
   restarting or topic-hopping is ≤2.
5. Critical Appraisal (15%) — questioning AI output, requesting evidence, noting uncertainty or
   disagreement. Accepting everything unexamined is ≤1.
6. Reflective Synthesis (10%) — an explicit, case-grounded takeaway in the physician's own words;
   a generic "very useful, I learned a lot" is ≤1.
7. AI Literacy & Prompt Skill (10%) — precise prompts, verification of outputs, clinical ownership
   of the final plan.

SCALE: 0=Not observed, 1=Very Low, 2=Low, 3=Moderate, 4=High, 5=Very High

Return ONLY valid JSON — no explanation outside the JSON:
{
  "d1": <0-5>, "d2": <0-5>, "d3": <0-5>, "d4": <0-5>,
  "d5": <0-5>, "d6": <0-5>, "d7": <0-5>,
  "rationale": {
    "d1": "<2-3 sentence justification citing specific transcript evidence>",
    ...
  }
}
```

Design notes: the quote-to-score-4+ rule is the main leniency brake (it forces evidence, the exact
thing auditors demanded); the verbatim-turn cap encodes the soak's concrete failure case; the d5
carve-out protects the one domain where the AI is already slightly harsh.

## Model axis (local-model screening, D18)

One row per gate run of `scripts/probe/screening-verdict.mjs` (which prints the row ready to paste).
The prompt column carries the version AND the sha of the exact text sent (base + any local addendum),
because the local addendum changes the prompt without changing the rubric levels. `split` must read
`heldout` for a row to count as a gate result; tuning-split rows are allowed here only for the record
and are marked "not a gate result" by the tool.

**Two Σ|Δ| columns, because they are two different quantities that shared one heading until
2026-09-04 and were read as one number.** `Σ|Δ| agr` = median over fixtures of Σ over d1–d7 of
|local − cloud| — disagreement BETWEEN the two models. `Σ|Δ| rep` = median over fixtures of Σ over
d1–d7 of (max − min) across repeats of the LOCAL model on one fixture — the model disagreeing with
ITSELF, i.e. the noise floor, and it is what bounds how small `Σ|Δ| agr` could ever get. The verdict
tool prints `n/m` in the second column unless `--repeat` is passed; a number there comes from the
matching `repeat-consistency` run and is stated as such. JSON % = valid PIS-7 JSON over every local
CALL in the run (not per fixture).

| model (local vs cloud) | prompt version · sha | split (n pairs) | consistency | ICC(A,1) composite (95% CI) | Σ\|Δ\| agr | Σ\|Δ\| rep | JSON % | verdict |
|---|---|---|---|---|---|---|---|---|
| deepseek-v4-flash-dspark vs claude-sonnet-4-6 | pis7-prompt-59561c29 | tuning (n=16) | adaptive | 0.578 (0.116–0.835) | 4 | 6 † | 100.0% (18/18) | insufficient |
| deepseek-v4-flash-dspark vs claude-sonnet-4-6 | pis7-prompt-59561c29+local-cae23b1a5f37 | tuning (n=14) | adaptive | 0.735 (0.335–0.910) | 2 | 1 ‡ | 94.4% (17/18) § | insufficient |
| deepseek-v4-flash-dspark vs claude-sonnet-4-6 | pis7-prompt-59561c29+local-cae23b1a5f37 | tuning (n=15) | adaptive (stamped `median3`)* | 0.762 (0.410–0.917) | 2 | 1 ‡ | 94.4% (17/18) § | insufficient |
| deepseek-v4-flash-dspark vs claude-sonnet-4-6 | pis7-prompt-59561c29+local-c5ffe572aa81 | tuning (n=18) | adaptive | 0.611 (0.202–0.839) | 3.5 | n/m | 100.0% (37/37) | insufficient |
| deepseek-v4-flash-dspark vs claude-sonnet-4-6 | pis7-prompt-59561c29+local-c5ffe572aa81 | tuning (n=12) | adaptive | 0.795 (0.407–0.940) | 3 | n/m | 100.0% (30/30) | insufficient ¶ |
| **deepseek-v4-flash-dspark vs claude-sonnet-4-6** | **pis7-prompt-59561c29+local-c5ffe572aa81** | **heldout (n=8)** | **adaptive** | **0.436 (0.000–0.873)** | **2** | n/m | **100.0% (16/16)** | **insufficient** |

† from `tuning-repeat-v0.json`, and it is a median over **10 of 18** fixtures — the box degraded
mid-run, so it does not describe all 18.  ‡ from `noise-2026-09-03-addendum.json` (18/18 measurable).
§ counted per FIXTURE in these two reports, which predate per-call accounting: read as a floor, not
a rate.  ¶ same configuration as the row above it, ninety minutes later — see the survivorship note.

> **Note, 2026-10-01 — every interval in this table is a Fisher-z interval.** That is what `icc.js`
> computed when each row was recorded. From 2026-10-01 `icc.js` uses the exact F-based McGraw & Wong
> interval, which gives, top to bottom on the same reports: 0.107–0.833 · 0.354–0.907 · 0.421–0.914 ·
> 0.211–0.835 · 0.422–0.937 · **0.000–0.855** (`methodology-figures.mjs --json`). Every verdict is still
> `insufficient`. The point estimates do not change, and all six are on the weighted composite. The
> pairs-needed figures under "Still `insufficient`" below rest on the same retired interval; F-based,
> they are 4,898 at 0.762, 17 at 0.90 and 12 at 0.92.

**v0 baseline, 2026-09-02.** The first row is the local model against the incumbent on the 18-fixture
tuning split, with adaptive self-consistency ON. Read it with the earlier single-call measurement
(ICC 0.594, 26 fixtures): **self-consistency did not move agreement** — 0.578 weighted / 0.591
unweighted against 0.594. The gap is systematic rather than noisy: composite bias −2.50 (local
harsher), Bland–Altman −10.27…5.27, and per-domain ICC 0.06 on d1, 0.42 on d4, 0.55 on d2 while
d5/d6/d7 sit at 0.68/0.72/0.59 with no bias. Two cloud replies were unparseable (malformed JSON in a
rationale); the local arm parsed 18/18. `screening-verdict.mjs` reports `insufficient`, and at a point
estimate of 0.578 **no number of pairs would clear a 0.75 lower bound** — more data cannot rescue a
model that ranks the episodes differently. That is what the addendum below is aimed at.

**Addendum + median3, 2026-09-04.** Rows 2 and 3 add the local prompt addendum
(`PIS7_LOCAL_ADDENDUM`, sha `local-cae23b1a5f37`), which row 1 predates. Together they move three
things at once: composite ICC 0.578 → 0.735 → **0.762**, bias −2.50 → +0.79 → **+0.00**, and the
repeatability floor from Σ|Δ| median 6 to **1** — the last of which is what §8.3 called the real
blocker, and it is now clear.

> **Note, 2026-10-01 — the biases and the Bland–Altman band in the two paragraphs above are on the
> unweighted d1–d7 sum (0–35), not on the weighted composite of the ICCs beside them.** They were read
> off `model-agreement.mjs`, which printed its bias and band on that sum until 2026-10-01. It prints on
> the weighted composite now, as `e2-compare.mjs` does, and `methodology-figures.mjs --json` reports
> both (`bias_weighted`, `bias_unweighted_sum`). On the weighted composite the three runs read
> **−7.875 → +1.64 → −0.73**, and v0's band is **−30.70…14.95**. Read as points on the 0–100 credit
> scale, "−2.50" understates v0's harshness about threefold, and row 3's bias is not zero. The 0.594
> the v0 paragraph compares against is an unweighted-sum figure too (GATE0 §7.2), so its like-for-like
> partner is 0.591. The per-domain ICCs are unaffected. The figures above stay as recorded.

**Still `insufficient`.** At 0.762 the interval is 0.410–0.917 and the tool computes **4,899 pairs**
needed to lift the lower bound past 0.75 — not reachable. The point estimate has to rise (0.90 → 19
pairs, 0.92 → 14).

\* **Rows 2 and 3 are the same configuration.** `model-agreement.mjs` hardcoded `mode: 'adaptive'`
from `a79f4d3` until 2026-09-04 while faithfully stamping the `--consistency` flag into the report, so
the run labelled `median3` ran adaptive. The logs match call-for-call (15 rows `calls 2`, 2 rows
`calls 2+1 re-ask`; a real median3 shows `calls 3` on every row). **`median3` is unmeasured**, and the
0.735 → 0.762 gap is what two draws from one configuration look like at n=14/15.

**JSON% was reported three ways in one day; 94.4% is the honest one.** 95.4% counted transport and
cloud-arm failures against the model; a "100%" correction then excluded `Pis7ScoreError` — which
`pis7.js` throws for invalid JSON and invalid scores after the re-ask budget is spent, i.e. the exact
failure this bar exists to catch — and counted one adaptive row as one call when it is 2–3 plus
re-asks. Counted per call, excluding only transport: **94.4% (34/36), down from 97.4% before the
addendum**, and below the 98% bar. GATE0 §8.6 carries the full retraction.

**Do not read the per-domain ICCs in these runs as findings.** d1 reads 0.055 → 0.663 → 0.294 across
the three, which at n=14–15 is within what chance alone produces. The one stable signal is **d4
(Iterative Inquiry), lowest in all three** (0.425 / 0.552 / 0.530) and of the hardest kind: the two
models' means agree (Δ −0.07) while their per-case ranking does not, so calibration cannot fix it.
That is where prompt work should go next.

### 2026-09-04 — the addendum is edited, so rows 2 and 3 no longer describe the shipped prompt

`PIS7_LOCAL_ADDENDUM` gained a JSON-string-integrity rule and its three worked examples were
re-punctuated from double to single quotes. The text changed, so the derived sha changed:

    pis7-prompt-59561c29+local-cae23b1a5f37   ->   pis7-prompt-59561c29+local-c5ffe572aa81

**Every number in rows 2 and 3 belongs to `cae23b1a5f37`** — ICC 0.735 / 0.762, bias +0.79 / +0.00
(unweighted sum; +1.64 / −0.73 weighted — see the 2026-10-01 note above), Σ|Δ| median 1, JSON
94.4%, and the per-domain table. They stay in this file as the record of that prompt; none of them
is a claim about the prompt now in `prompts.js`. Re-measuring means a fresh
`model-agreement.mjs` run on the tuning split (the held-out split must stay unopened) — ICC, bias
and Σ|Δ| as well as JSON%, because a punctuation change to worked examples inside a scoring prompt
is not guaranteed to be score-neutral even though it was not intended to move scores.

**Why the addendum was edited: the mechanism, and what the 3-point drop actually is.** The rule that
lifted ICC is the symmetric evidence rule, and it multiplied how often the model must put verbatim
transcript text inside a rationale — which is a JSON string. Counted over the local scores in these
reports, the "you must quote" requirement fires on **3.2%** of domain scores under the base prompt
alone (only 4–5 triggers it; 4 of 126 scores were 4–5) and on **~55%** under the addendum (every
score that is not exactly 3). A straight double quote inside a rationale closes the string early,
`lib/parse.js` throws, and the reply is re-asked. The addendum's own examples demonstrated exactly
that character; they no longer do, and the output block now names the rule. Nothing about the
evidence requirement was relaxed to buy this.

**But the drop it was aimed at is not a measurable drop.** Re-scored per call: 97.4% (37/38) before
vs 94.4% (68/72) after is **1 failure against 4**, Fisher exact two-sided **p = 0.66**. And one of
those four is not a contract failure at all. In `tuning-agreement-addendum.json`, PLE-001's re-ask
has the transport fingerprint: per-call input tokens are deterministic (8 fixtures confirm the
addendum adds exactly 384), PLE-001's is 5,756, and the row's `extra_input_tokens` is 5,756 for
**two** extra calls — one call billed nothing. Its `localMs` is 353,629 ≈ 180,000 (`PROBE_TIMEOUT_MS`)
+ 2 × 87s. The runs predate the `transport` stamp, so `scoreWithConsistency` saw `{ text: '' }` and
counted a timeout as a re-ask, exactly as `scripts/probe/parseability.mjs` warns. Excluding it:
95.8% (68/71), 3 failures against 1, **p = 1.00**. The other three re-asks billed full input on every
extra call and are genuine contract failures.

**The 98% bar cannot be adjudicated at this sample size, in either direction.** The baseline's own
97.4% is already under the bar and its 95% CI is 86.5–99.5%. A 95% lower bound at 98% needs **189
consecutive clean calls** (~4 h serial on the box at the observed ~78 s/call); at n=71 a run that
scores a true 98% still reports a lower bound of 92.4%. Until the denominator grows, JSON% moves in
this table are descriptive, not gate evidence — and a run that comes back at 94% after this edit is
not evidence the edit failed.
