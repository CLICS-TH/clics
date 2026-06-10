# PIS-7 Evaluator Prompt — Calibration Versions

Archive of `PIS7_EVALUATOR_PROMPT` (`rimpl/src/lib/prompts.js`) revisions and the ICC each produced
on the fixed soak cohort (`--mode rescore`). Goal: lift AI↔human ICC from 0.66 toward ≥0.75 by
removing the AI's leniency on templated/structured reasoning. (See README caveats — these are
directional, not a passed gate.)

| Version | Prompt sha (first 12) | ICC (95% CI) | d2 Δ | d3 Δ | What changed |
|---------|-----------------------|--------------|------|------|--------------|
| v0 (soak baseline) | _from `--mode baseline`_ | 0.662 (0.40–0.83) | +0.80 | +0.83 | original prompt (2026-06-07) |
| v1 | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |

## Notes per version

### v0 — original (2026-06-07)
Domains/weights only, 0–5 scale with one-word anchors (0 Not observed … 5 Very High). No guidance
distinguishing genuine reasoning depth from templated structure → AI rewards effort/structure.

### v1 — PROPOSED (not yet applied — measure the live baseline first)

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
