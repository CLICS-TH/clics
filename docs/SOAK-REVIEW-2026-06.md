# CLICS — 1-Week Soak Review & Superadmin Orders

**Date:** 2026-06-07 · **Environment:** production stack (Railway backend + RIMPL, Supabase, live Claude) · **Reviewer:** Superadmin
**Scope:** full-lifecycle dry run on a clean database before committing the multi-account member system — onboard a cohort, run a simulated week of physician–AI sessions across the competence spectrum, gate + AI-score them, have three auditors blind-score, compute ICC, and decide what to fix.

---

> ## ⚠️ Correction (2026-08-25) — the "auditors" in this review were AI agents, not people
>
> This document was written on 2026-06-07 and repeatedly calls the three raters *expert auditors*
> and their mean *the human consensus*. **They were Claude agents** given assigned rater stances
> (`scripts/soak/gen-auditor-wf.js:30-32` — balanced / strict / lenient) and run through the
> `Workflow` tool as step 5 of `scripts/soak/README.md`. No human physician scored anything here.
>
> **What that changes:**
> - Every ICC below is **AI-vs-AI**. The 0.662 figure is the evaluator against *simulated* raters,
>   not against expert human judgement, and must not be cited as human-validated agreement.
> - The **inter-rater 0.97** is the weakest number in the document, not the strongest. Three agents
>   sharing one model, one rubric and one prompt template will agree with each other almost by
>   construction; that agreement is close to a tautology and is **not** evidence that the rubric is
>   well-defined or that human raters would converge.
> - The direction of the finding still stands on its own terms — the evaluator was measurably
>   lenient against a rubric-anchored counterpart, and the calibration work that followed was
>   worth doing. What is **not** established is the magnitude, or that ≥0.75 against humans is
>   within reach.
>
> The numbers are left exactly as recorded; only the attribution is corrected. See
> `scripts/calibration/README.md` for the same caveat on the harness that produced the later runs.

## 1. Executive summary

A clean-slate cohort of **16 accounts** (1 superadmin, 2 admins, 10 physicians, 3 auditors) was onboarded through the **real** invite/approve flows, then **10 physicians ran 15 sessions** over a simulated week (May 31 – Jun 6). The full pipeline worked end-to-end: CLE screening, PIS-7 AI scoring, LPDP snapshots, auditor blind-scoring, and ICC.

**The headline result:** the three *simulated* auditors agree with **each other** almost perfectly (**inter-rater ICC 0.97** — see the correction above; this is three agents sharing one model and rubric, so it is close to a tautology), but the **AI evaluator agrees with their consensus only at ICC 0.66 — below the pilot's 0.75 gate.** The AI is **systematically lenient (+10.3 composite points)**, over-crediting structured-but-shallow "templated" reasoning that the simulated auditors penalise. **The ICC gate did its job mechanically: the harness computed and surfaced a below-threshold value.** Whether the evaluator is misaligned *with humans* remains unmeasured.

The soak also surfaced **two real reliability bugs** in the evaluation path. One (silent loss of credit-eligible sessions) was **fixed and deployed during this review**; the other (partial-write on a failed evaluation) is fixed in this branch.

---

## 2. Method

| Step | What was done |
|------|---------------|
| **Clean slate** | `db/reset-demo.js` wiped all prior activity + accounts, leaving only the superadmin bootstrap and default role-slot pools. |
| **Onboarding (real flows)** | Superadmin direct-created 2 admins + 3 auditors (the "invite"). 10 physicians self-registered via `POST /auth/request-access` (→ pending). The 2 admins approved all 10 (split 5/5, reviewer-stamped) → pseudonyms **P-001…P-010**. |
| **Cohort design** | Competence spectrum: **2 weak**, **3 average** (1 reflective), **3 good**, **2 top**. Per-physician token budgets graduated by "how well the admin managed them" (10k → 72k). |
| **Sessions** | A deterministic driver logged in as each physician and ran tier-appropriate multi-turn clinical reasoning (5 realistic chief complaints) through the live backend → RIMPL → Claude. Passing physicians ran 2 sessions for a longitudinal (LPDP) trend. |
| **1-week span** | Activity backdated across May 31 – Jun 6; auditor review on Jun 7 ("after the week"). Fully visible to superadmin/admin in the dashboard. |
| **Auditors** | Three **simulated** auditors — Claude agents, not people (`scripts/soak/gen-auditor-wf.js:30-32`) — **blind-scored all 10 evaluated CLEs** on the PIS-7 rubric (no AI score shown), with distinct rater stances (balanced / strict / lenient) intended to surface realistic inter-rater variance. Whether assigned stances actually reproduce human rater variance is itself unvalidated. |

> **Why a deterministic driver, not AI "physician" agents:** the first attempt used autonomous agents to drive the chats. They were unreliable — they lost session state between steps, spawned duplicate sessions, and stalled — producing a broken dataset (1 usable session of 10). Switching to a single-process driver that holds each physician's session id in memory produced a 100% reliable run. *This is a testing-harness lesson, not a product bug.*

---

## 3. Cohort & traceability

All 16 accounts persist and are visible to superadmin (`/admin/users`) and admins. Demo password for the soak cohort: `SoakPass#2026` (throwaway). Pseudonyms are the only physician identifier in any audit/export context.

| Role | Accounts |
|------|----------|
| Superadmin | `superadmin@clics.th` |
| Admin (2) | `soakadmin1/2@example.com` (approved the cohort) |
| Physician (10) | `soakdoc01…10@example.com` → **P-001 … P-010** |
| Auditor (3) | `soakaud1/2/3@example.com` (Auditor 1/2/3) |

---

## 4. Results

### 4.1 CLE screening funnel (15 sessions)

| Outcome | Count | Who |
|---------|-------|-----|
| `cle_fail_t1` (structural: <15 min / <4 turns) | **2** | P-001, P-002 (weak — short, vague, no reflection) |
| `cle_flag_t2` (content: failed C4–C6) | **3** | P-003, P-004 (average, no learning summary); P-010 #2 (truncated by a transient RIMPL error before its summary) |
| `evaluated` (passed gate + AI-scored) | **10** | P-005, P-006 ×2, P-007 ×2, P-008 ×2, P-009 ×2, P-010 ×1 |

The gate behaved exactly as specified: weak sessions auto-rejected on structure; average non-reflective sessions flagged for manual QA on content (C6 "explicit learning summary" is the discriminator); only reflective, sufficiently-deep sessions reached scoring.

### 4.2 Per-physician outcomes

| Pseudo | Tier | Sessions | CLE result(s) | AI composite(s) |
|--------|------|----------|---------------|-----------------|
| P-001 | weak | 1 | fail_t1 | — |
| P-002 | weak | 1 | fail_t1 | — |
| P-003 | average | 1 | flag_t2 | — |
| P-004 | average | 1 | flag_t2 | — |
| P-005 | average (reflective) | 1 | evaluated | **56** |
| P-006 | good | 2 | evaluated ×2 | 86, 71 |
| P-007 | good | 2 | evaluated ×2 | 87, 86 |
| P-008 | good | 2 | evaluated ×2 | 69, 88 |
| P-009 | top | 2 | evaluated ×2 | 94, 94 |
| P-010 | top | 2 | 1 evaluated, 1 flag_t2 | 94 |

AI composite range **56 → 94** — a clean monotonic spread by tier, confirming the evaluator discriminates competence.

### 4.3 LPDP trajectories (composite over the week)

P-005 `56` · P-006 `86 → 71` · P-007 `87 → 86` · P-008 `69 → 88` · P-009 `94 → 94` · P-010 `94`.
The per-physician charts render correctly (the second session lands later in the week). *Data note: P-007 has one spurious `composite=0` snapshot in the DB from the partial-write bug in §5 F3 — excluded above; the code fix prevents recurrence.*

### 4.4 Simulated-auditor blind-scoring & ICC — **the key result (AI-vs-AI)**

Three simulated auditors (Claude agents) independently scored all 10 evaluated CLEs (30 ratings).

| Metric | ICC (95% CI) | Verdict |
|--------|-------------|---------|
| **Inter-rater** (simulated auditors vs each other) | **0.97** (0.94–0.99) | Near-perfect, but expected: same model, same rubric, same prompt. Not evidence of a well-defined rubric. |
| **AI ↔ Auditor 1 / 2 / 3** | 0.67 / 0.66 / 0.72 | Each below target |
| **Pooled AI ↔ simulated rater** (n=30) | **0.662** (0.40–0.83) | **Below the 0.75 pilot gate** — but against agents, so not the gate's real test |

Auditor mean composites: 73.0 / 70.5 / 73.1 — the "strict" auditor is detectably tougher, as designed, but all three track together.

**Where the evaluator and the simulated raters diverge** (AI minus mean rater score, evaluated set):

- The AI is **systematically lenient: mean +10.3 points.**
- The gap is **largest in the mid-tier "good" sessions** — e.g. P-007 #1: AI **86** vs rater **55** (Δ31); P-006 #1: AI **71** vs rater **54** (Δ17). The simulated auditors penalised *templated / scripted* reasoning (and one **verbatim-repeated physician turn**) that the AI rewarded.
- By domain, the AI over-scores **d2 Reasoning Depth (+0.8)**, **d3 Contextual Integration (+0.83)**, **d1 Clinical-Question (+0.73)** and **d6 Reflective Synthesis (+0.73)**. It is only slightly *harsher* than the simulated raters on **d5 Critical Appraisal (−0.23)**.
- At the **top tier the AI and the simulated auditors agree** (P-009: AI 94 vs rater 97, Δ−3) — divergence is concentrated in the middle of the range.

**Interpretation:** the AI evaluator inflates structure/effort and under-weights genuine reasoning depth and critical appraisal. This is precisely the calibration target the July workshop exists to close.

---

## 5. Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| **F1** | **High** | **Silent loss of credit-eligible sessions.** The `/end` PIS-7 evaluation is fire-and-forget with no retry; a transient RIMPL 5xx left **3 of 9** passed sessions stuck at `cle_pass` with no score, invisible to auditors. | **Fixed + deployed** (retry-with-backoff + admin `reevaluate` endpoint; the 3 were recovered). |
| **F2** | **High** | **AI evaluator is mis-calibrated vs the rubric-anchored counterpart** — systematically lenient (+10.3), AI↔rater **ICC 0.66 < 0.75 gate**, while inter-rater is 0.97. Measured against agents, not experts. | **Order #1** below (calibration). |
| **F3** | **Medium** | **Partial-write on a failed evaluation.** `persistEvaluation` doesn't check its insert errors, so a bad result can leave a `composite=0` LPDP snapshot + missing `ai_evaluation` while the CLE is marked `evaluated` (seen once, on P-007). | **Fixed in this branch** (ordered + error-checked persistence). |
| **F4** | **Medium** | **Tier-2 classifier false-negative.** The C4–C6 LLM classifier flagged one genuinely strong top-tier session (P-009), which manual QA then approved. The auto-gate has a non-zero false-negative rate on strong transcripts. | **Order #4** (manual-QA path works; monitor false-negative rate). |
| **F5** | **Medium** | **The "10k tokens/physician" budget is incompatible with earning credit.** A credit-eligible session needs ≥4 turns ≈ 16k+ tokens (good/top ran 24–68k). Every non-weak physician crossed 10k by **turn 3–4** — before the 4-turn + learning-summary requirements. | **Order #3** (reconcile budget policy with the gate). |
| **F6** | **Low** | **No server-side budget enforcement.** Budgets were simulated client-side; the platform has no per-physician token allowance or admin control over it. | **Order #5** (roadmap). |
| **F7** | **Process** | The autonomous-agent test harness is unreliable for stateful multi-step flows; the deterministic driver should be the standard soak tool. | Captured as the reusable `/tmp/soak-*.js` toolchain. |

---

## 6. Superadmin's orders — "make it better"

Prioritised, mapped to the pilot timeline (July = calibration workshop, target ICC ≥ 0.75).

1. **(P1, before July) Recalibrate the PIS-7 AI evaluator — and obtain a first ICC against real human auditors, which does not yet exist.** Correct the **+10 leniency**, especially on d2/d3 and the over-reward of templated structure. Concretely: tighten the `PIS7_EVALUATOR_PROMPT` anchors (define what 4 vs 5 means with depth/originality, not structure), add a few human-scored exemplars, and re-measure ICC on this same 10-CLE set as the regression gate — noting that until human raters score it, that regression gate is AI-vs-AI. **Owner: clinical lead + RIMPL.**
2. **(P1, done) Make evaluation durable.** ✅ Retry + `reevaluate` shipped (F1). Next: a small **reconcile job** that periodically re-evaluates any `cle_pass`-without-`ai_evaluation`, so no session is ever silently stranded even if all retries fail.
3. **(P1) Decide the token-budget policy.** Either (a) raise the per-physician allowance to a workable floor (~24k for a 4–6-turn session), or (b) make the AI responses leaner, or (c) lower the C2 turn threshold. The current "10k" cannot coexist with the credit gate. **Owner: product + clinical.**
4. **(P2) Monitor the tier-2 classifier's false-negative rate** and keep the admin manual-QA approve path as the safety valve (it correctly rescued P-009).
5. **(P2) Build enforced, admin-managed per-physician token budgets** (the "depend on their management" lever) — a real column + middleware check + dashboard control. **Roadmap.**
6. **(P2) Backend route tests** for the gate transitions and the new `reevaluate`/`approve` paths (this branch adds the eval-retry test; extend to supertest route coverage per ROADMAP P1).

---

## 7. Fixed during this review (in this branch)

- **`services/cle-evaluation.js`** — `evaluateWithRetry` (3× backoff) wraps the RIMPL evaluation; **+ ordered, error-checked persistence** so a failed insert can no longer leave partial state (F1, F3). Unit-tested (`tests/eval-retry.test.js`).
- **`routes/admin.js`** — `POST /admin/cles/:id/reevaluate`: recovers a passed-but-unscored CLE; refuses (409) to touch an already-evaluated one, so it can never override a score (F1).
- *(deployed to the production backend during the review; the 3 stranded sessions were recovered through this path.)*

---

## 8. Reproduce

Clean + onboard + drive + audit + report is fully scripted (kept under `/tmp/soak-*.js` this run; promote to `scripts/soak/` if we want it in-repo):
`reset-demo.js` → `soak-onboard.js` → `soak-drive.js` → `soak-fetch-transcripts.js` → auditor workflow → `soak-audit-post.js` → `soak-backdate.js` → `soak-report-data.js`.

**Bottom line:** the platform's lifecycle works end-to-end and the ICC machinery correctly computed and surfaced a below-threshold value. What it caught was misalignment against a *simulated* counterpart; alignment with **expert human judgement is still entirely unmeasured**, and obtaining that measurement — not closing F2 — is the real gate on calling the prototype pilot-grade.
