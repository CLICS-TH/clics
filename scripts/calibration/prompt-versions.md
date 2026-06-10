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
| **v2 (CURRENT)** | a849c6b21b94 | **0.811** (0.64–0.91) n=30 | ≈ ±0 | kept v1's brakes; removed middle-compression ("use the FULL scale", award evidenced 4–5 confidently, linkage phrases count when they engage content) — all domain Δ ≤ \|0.43\| |

⚠️ v2's first measurement read 0.487 — poisoned by ONE malformed eval (AI=0, missing domains). The
harness now validates each eval (retry once, drop on second failure). The clean re-run (n=30; one
PLE dropped — the 46k-token transcript truncates the evaluator's 1000-token output) gave 0.811.
Follow-up: raise `maxTokens` in `rimpl/src/routes/evaluate.js` for very long transcripts.

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
