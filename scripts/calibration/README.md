# ICC Calibration Harness (G1 credit gate)

> ### ⚠️ These numbers are AI-vs-AI, not AI-vs-human — read this before quoting any of them
>
> The three "auditors" in the 2026-06-07 soak cohort were **Claude agents with assigned rater
> stances** (`scripts/soak/gen-auditor-wf.js:30-32` — balanced / strict / lenient), driven through
> the `Workflow` tool by `scripts/soak/README.md` step 5. They were not human physicians.
>
> So every value in `runs/` (**0.377 – 0.811**) and the 0.662 baseline below measures the evaluator
> against *simulated* raters. **No CLICS ICC has ever been measured against real human auditors.**
> Do not cite these as human-validated agreement — not in a paper, not to an IRB, not to a reviewer.
>
> The words `human` / `n_human` survive in the code and JSON output **as key names only**: the
> archived `runs/*.json`, `three-way.js`, and `GET /oversight/icc/three-way` all consume that shape,
> so renaming them would be a breaking change rather than a wording fix. Read them as
> "the counterpart rater arm", whoever that turns out to be.

CME credit is gated on evaluator↔**human**-auditor agreement at **ICC ≥ 0.75** — a threshold nothing
recorded here has yet been tested against. The 2026-06-07 soak measured pooled
evaluator↔*simulated*-auditor **ICC = 0.662** (n≈30 pairs, 95% CI ~0.40–0.83) while inter-rater
ICC = 0.97 — the simulated auditors agree with *each other*; the **PIS-7 AI evaluator is
systematically lenient (+10.3 pts)**, over-crediting templated/structured reasoning (worst on
**d2 Reasoning Depth** and **d3 Contextual Integration**).

`calibrate.js` measures ICC on the fixed soak cohort and reports per-domain divergence so the
`PIS7_EVALUATOR_PROMPT` (`rimpl/src/lib/prompts.js`) can be tuned and re-measured.

## Run

```bash
# baseline — ICC from STORED ai_evaluations (no Claude); must reproduce ≈0.66 (harness sanity check)
cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/calibration/calibrate.js --mode baseline

# rescore — re-score the transcripts via LIVE RIMPL/Claude, then ICC of the new AI scores vs the
#   same stored counterpart-rater scores (simulated, see the banner above)
#   needs RIMPL running:  (cd rimpl && npm start)   with ANTHROPIC_API_KEY in rimpl/.env
cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/calibration/calibrate.js --mode rescore
```

Each run prints ICC + 95% CI + per-domain (AI vs counterpart rater, +Δ = AI inflates) + per-CLE
deltas, and
archives a JSON to `runs/<stamp>-<mode>.json` (incl. the PIS-7 prompt sha, so runs are diffable).

## Iterate

1. `--mode baseline` → confirm ≈0.66.
2. `--mode rescore` on the current prompt → confirm ≈0.66 (± Claude nondeterminism).
3. Edit `PIS7_EVALUATOR_PROMPT` (tighten d2/d3 anchors: structure ≠ depth; score templated/scripted
   reasoning LOW). Record the change + result in `prompt-versions.md`.
4. `--mode rescore` → compare ICC + whether d2/d3 inflation shrank. Repeat.

## ⚠️ Caveats — read before quoting a number

- **Overfitting:** tuning the prompt on the *same* 10 CLEs you measure on inflates the apparent ICC.
  ≥0.75 here is **necessary, not sufficient**.
- **Wide CI:** at n≈30 pairs the 95% CI is ~0.40–0.83 — the point estimate is statistically fragile.
- **Selection effect in the headline number:** the best run (**0.811**) was computed on a *smaller*
  cohort than the runs before it — `n` falls 33 → 30 and `perPle` 11 → 10 between the `05-50-42`
  and `05-56-29` runs. The pair that dropped out was a **failed** evaluation, not a disagreement:
  `05-50-42` records `P-014` as `ai: 0` against `human: 59.3`, with all seven domain values `null`.
  Removing a broken row is defensible; quoting the resulting 0.811 as if it were measured on the
  same cohort as 0.487 is not.
- So a passing run here is a **directional signal**, not a passed gate. Real sign-off needs a larger
  / held-out cohort **scored by human auditors** (the calibration workshop).

---

# Three-way comparison — `three-way.js`

`calibrate.js` above measures ONE relationship: the served Claude evaluator vs whatever scores sit
in `audit_scores` — which to date means the soak's **simulated** auditors, not human ones.
`three-way.js` adds the third rater — the candidate **on-prem** evaluator that now scores every CLE a
second time into `shadow_evaluations` (never served, never shown) — and reports all three pairwise
comparisons **on the same CLEs**, so they can honestly be read against one another.

```bash
cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/calibration/three-way.js
```

Read-only against the DB in `backend/.env` — no inserts, no updates, like `calibrate.js`. Prints
coverage, the three arms, and an acceptance verdict; archives the whole thing to
`runs/<stamp>-three-way.json` in the same shape as `GET /oversight/icc/three-way`, so an offline run
and the dashboard can be diffed directly.

It is **usable today**, before any shadow data exists: `db/migration-shadow-evaluations.sql` is
deliberately unapplied, so the shadow arms report `unavailable` and the claude-vs-auditor arm still
runs on the CLEs that already carry both an AI and a human score. A missing table is a known state,
not a failure. Running it now means November is a re-run, not a build.

Flags: `--include-test`, `--provider <name>`, `--model <version>` (pick the candidate explicitly),
`--margin <0.10>` (see *Power* below), `--top <25|all>` (per-CLE rows printed; the JSON always has
all of them).

## The three arms

| Arm | What it answers | Acceptance evidence? |
|-----|-----------------|----------------------|
| **claude-vs-auditor** | How well the *currently served* evaluator agrees with expert humans. This is the G1 credit gate, and the first human-measured ICC either model will ever have. | **Yes** |
| **local-vs-auditor** | How well the *candidate* evaluator agrees with expert humans. This is the acceptance test for moving the evaluator on-prem. | **Yes** |
| **claude-vs-local** | How similar the two models are to each other. A cheap early signal (it can be read long before enough audits accumulate) and a correlated-error check. | **No** |

Each arm reports overall ICC(2,1) + 95% CI + n + interpretation, the same per domain d1–d7, the
**mean bias** (which rater is systematically more lenient, and by how much), and per-CLE composite
deltas sorted by |delta| with anything beyond 2 SD flagged.

Bias is not decoration. ICC can look respectable while one rater sits a whole band above the other —
the v0 evaluator ran **+16.4 composite lenient** — and a lenient evaluator hands out credit that was
not earned. Agreement and bias have to be read together.

## The auditors are the reference standard. Claude is not.

The only thing that makes any of this a measurement is the blinded expert human score. Claude is a
comparator, not ground truth.

So **claude-vs-local can never pass anything.** Two models agreeing proves they are *similar* —
possibly similarly wrong, which is exactly what you would expect from two systems reading the same
prompt against the same rubric. A high claude-vs-local ICC alongside a poor local-vs-auditor ICC
means the candidate faithfully reproduces Claude's errors. That arm earns its place for two other
reasons: it is readable early, and a *low* value tells you something is wrong before the human data
is in.

## Acceptance criteria — moving the evaluator on-prem

All three must hold. The harness prints PASS / FAIL / PENDING for each.

1. **Contract compliance ≥ 95%** — the candidate must actually produce a valid PIS-7 score set.
   Rows in `shadow_evaluations` with a non-null `error` carry no scores; they are **excluded from
   every ICC and counted here**. "The candidate could not hold the scoring contract 8% of the time"
   is a disqualifying result on its own, and averaging it away would hide the one number a model swap
   turns on. The harness reports this over the whole shadow corpus, not just the audited subset —
   contract compliance is a property of the model, not of whichever CLEs got picked for audit.
2. **local-vs-auditor ICC ≥ 0.75** — the same G1 threshold the served evaluator is held to. A
   candidate that cannot clear the credit gate cannot serve credit-bearing scores.
3. **Local not materially below Claude on the same cohort** — the two human-anchored arms are
   computed on the identical set of CLEs, so their difference is meaningful. Default margin: local
   may sit at most **0.10 ICC** below Claude.

## Power — pre-register the margin

At the pilot's expected **n ≈ 135** CLEs, a gap of about **0.10 ICC is detectable; 0.80 vs 0.78 is
not.** That difference is inside the noise, and the two CIs will overlap heavily.

Which means the margin must be **pre-registered before anyone sees the numbers**. Chosen afterwards,
it is chosen to fit the result — a margin that just happens to admit the candidate is not a decision,
it is a rationalization. Write the value down (and pass it as `--margin`) while the answer is still
unknown.

Related: the arms are computed on CLEs scored by all three raters, so adding shadow data *shrinks*
the comparison cohort. The harness prints each arm's own maximal n as well, clearly marked as not
cross-comparable, so nothing is dropped silently.

## ⚠️ Caveats — read before quoting a number

The caveats above apply here in full, and one more:

- **Overfitting still applies.** If the candidate's prompt was tuned against these same CLEs, its
  local-vs-auditor ICC is optimistic for exactly the reason `calibrate.js`'s is.
- **Wide CIs.** At the n available today the 95% CI spans most of the usable range. A point estimate
  clearing 0.75 with a CI from 0.2 to 1.0 has not established anything.
- **Not comparable to `calibrate.js`'s 0.662.** `calibrate.js` *pools* one pair per auditor (a
  3-auditor CLE contributes 3 pairs reusing one AI value). `three-way.js` averages a CLE's auditors
  to one human value first, as ICC(2,1) requires and as `GET /oversight/icc` does. Same estimator
  (`backend/src/services/icc.js`), different pairing — the two numbers are not interchangeable.
- **Blinding.** Shadow scores exist only behind the service role and the
  `analyst`/`ethics`/`superadmin` gate. A second AI score reaching an auditor would anchor them and
  destroy the very ICC this measures. Output from this harness must never be shown to an auditor.

So a passing run here is a **directional signal, not a passed gate** — same standing as everything
else in this directory.
