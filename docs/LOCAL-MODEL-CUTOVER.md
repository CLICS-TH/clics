# Cutover critical path — how to compute the slip the day access lands

Companion to [`LOCAL-MODEL-ROADMAP.md`](LOCAL-MODEL-ROADMAP.md), which holds the phases and the 26
decisions of record. This one answers a narrower question: **given an access date, what is the
earliest possible first-participant date, and which step is actually the long pole?**

D23 set an internal deadline of 15 Sep 2026. As of 2026-08-28 the box is still unreachable, so that
date can no longer be asserted — it has to be derived. This is the derivation.

Run `npm run local-model:status` for the live position at any moment.

---

## The chain

Each step's earliest start is its predecessor's finish. Only the **owner** column tells you whether a
step can be compressed by working harder; the ones owned by other people cannot.

| # | Step | Owner | Duration | Notes |
|---|---|---|---|---|
| 1 | **G0 — tailnet access to `cme-dev`, inference port** | Aj. Chanvit | unknown | Everything waits here. Not the UI port — see the roadmap's G0 |
| 2 | **G0 — box inventory + `sha256sum` of the weights** | Aj. Chanvit | ~½ day | The checksum is not readable over an inference API; someone with filesystem access must run it |
| 3 | **`OLLAMA_CONTEXT_LENGTH` raised** | Aj. Chanvit | ~½ day | A 9,144-token evaluation already returned `400 … exceeds 4096`. `options.num_ctx` is proven inert; the fix is server-side |
| 4 | **P0 — Gate 0 probe** (`scripts/probe/`) | us | ½ day | JSON contract ≥ 95%, Thai signed off by a clinician. **Fail here and the programme stops** |
| 5 | **P2 — rimpl relocation / bridge** | us | 1–2 days | D3. If rimpl cannot be hosted on a tailnet node, this becomes a Tailscale sidecar and D7 needs revisiting |
| 6 | **P3 — migrate a non-`evaluate` purpose** | us | ½ day | The readiness gate refuses an unfit box, so this is fast or it is a real finding |
| 7 | **P4 — accumulate the paired shadow corpus** | **time + raters** | **see below** | ← the long pole |
| 8 | **P4 — decisive verdict clears 0.75** | statistics | — | Falls out of 7. Not compressible by effort |
| 9 | **P5 — Model Lock + amend the Lock Record** | us | ½ day | Needs the step-2 checksum. Must disclose the shadow evaluator (D11) |
| 10 | **First participant** | — | — | |

Steps 4–6 and 9 total **≈ 3 working days**. The box-side work in 1–3 is short once it starts. So
**the schedule is not made of engineering** — it is made of step 1 (someone else's calendar) and step
7 (paired scores accumulating).

---

## Step 7 is the whole problem, and it is arithmetic

The decisive gate is `candidate-vs-human ICC ≥ 0.75`, decided by the **lower bound** of the
confidence interval, not the point estimate (D19). `backend/src/services/icc.js` builds that interval
with Fisher-z and `se = 1/√(n−3)`. Inverting it gives the number of paired CLEs required — and it is
brutally sensitive to how good the agreement actually is:

| If true agreement is… | paired CLEs needed for the lower bound to clear 0.75 |
|---|---|
| 0.95 | **9** |
| 0.92 | 14 |
| 0.90 | **19** |
| 0.88 | 27 |
| 0.85 | **51** |
| 0.82 | 117 |
| 0.80 | **247** |

Each figure verified against the implementation, not just the algebra: at *n* the lower bound clears
0.75 and at *n−1* it does not.

Read the bottom row carefully. **At a true agreement of 0.80, the gate needs more paired CLEs than
the entire study contains** (225). The gate is not "get to 0.80" — a model that agrees at 0.80 can
never pass it at pilot scale. The candidate has to be *comfortably* above the threshold, or no amount
of waiting will help.

A paired CLE needs three things: a completed episode, an incumbent score, **and a human auditor
score**. The third is the scarce one — which is why D26 puts expert invitations first, and why the
roster of 3 against a target of 20–25 is the longest lead time in the programme.

---

## Computing the slip

```
first participant  ≥  access_date
                    + 1 day    (box inventory + context length, steps 2–3)
                    + 3 days   (probe, relocation, purpose migration, steps 4–6)
                    + T7       (paired corpus accumulates to the required n)
                    + 1 day    (Model Lock, step 9)
```

`T7` is the only unknown, and it is not an engineering estimate — it is
`required_n / (paired CLEs produced per week)`, where the denominator is governed by rater
availability. **Measure the denominator before promising a date.** With one rater and no recruitment
it is currently well under one per week.

Worked: if access lands on 5 Sep and the candidate turns out to agree at 0.90 (19 pairs needed) with
raters producing 5 paired CLEs per week, `T7 ≈ 4 weeks` and the earliest first participant is around
**8 Oct** — not 15 Sep. If agreement is 0.85, `T7 ≈ 10 weeks` and it is December.

D25 retired the fallback deliberately: the honest response to a slip is to move the start date, not
the model.

---

## Measured position, 2026-08-28

`npm run local-model:status`, all figures from production:

| Gate | State | Reading |
|---|---|---|
| G0 access | **BLOCKED** | `LOCAL_AI_BASE_URL` unset; `cme-dev` (100.68.210.69) unreachable |
| G0 probe | waiting | cannot run until the box answers |
| **G0.5 human baseline** | **waiting — but see below** | incumbent vs human **−0.315** on **n=5** |
| P3 a purpose is local | waiting | every purpose on `anthropic` / `openai` — nothing to shadow against |
| P4 shadow corpus | waiting | table applied 2026-08-28, 0 rows |
| P4 decisive verdict | waiting | no estimate — no candidate |
| P5 model lock | waiting | not locked |

### The −0.315 deserves its own paragraph

This is **G0.5, the programme go/no-go gate** (D14), and it has nothing to do with the local model.
The five non-test CLEs carrying both an AI evaluation and a human score:

| CLE | human | AI | Δ |
|---|---|---|---|
| CLE-002 | 75.0 | 71.0 | −4.0 |
| CLE-005 | 75.0 | 91.0 | +16.0 |
| CLE-006 | 74.0 | 91.0 | +17.0 |
| CLE-011 | 80.0 | 73.0 | −7.0 |
| CLE-012 | 77.5 | 76.0 | −1.5 |

The verdict is correctly `insufficient`, not `fail` — at n=5 the interval spans almost everything and
the estimate is worth very little. But the estimate that exists points the wrong way, and the reason
is visible in the table: **the humans barely discriminate.** Their scores span 74–80; the AI's span
71–91. ICC asks whether two raters rank the same subjects the same way, and with six points of human
range there is almost nothing to rank. A restriction-of-range problem produces a negative ICC readily,
and no amount of model tuning fixes it.

Two consequences worth stating before more effort is spent downstream:

1. **The anchor set matters more than the model.** If raters cannot separate a weak episode from a
   strong one, no evaluator can agree with them. D24's synthetic anchor PLE set — deliberately
   spanning the range — is on the critical path for exactly this reason.
2. **Do not read this as "Claude disagrees with our experts".** n=5, one auditor on three of them,
   and every episode scored in a six-point band. It is a signal that the *measurement* is not yet
   able to measure, which is a different and more urgent problem.

The four `is_test` CLEs excluded from the gate lean the other way (AI scores 11–27 points *below* the
human), which is a second, separate divergence and also unexplained.

---

## Blocked-on-access does not mean blocked

The whole of step 7's denominator — recruitment, the anchor set, rater calibration, and whatever is
suppressing the human range above — is independent of the box and is the actual long pole. It can
start today.
