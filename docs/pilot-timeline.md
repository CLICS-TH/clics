# Pilot Timeline

**Both published milestones have passed without starting, and neither slipped for an engineering
reason.** This file used to carry the schedule below as though it were live; it is kept, marked as
superseded, because four other docs still quote it and a deleted table would leave those quotations
sourceless.

## The superseded schedule

| Month | Milestone | What actually happened |
|-------|-----------|------------------------|
| July 2026 | Calibration Workshop — establish inter-rater ICC ≥ 0.75 | **Did not happen.** G0.5 has not started ([LOCAL-MODEL-ROADMAP.md](LOCAL-MODEL-ROADMAP.md) §G0.5) |
| Aug–Sep 2026 | Pilot Study — 75 physicians × 3 PLEs = 225 PLEs | **Did not start.** The Aug–Sep activity was the internal **sandbox round** — test data, not participant data |

Original targets, for the record: ~50 completers after ~30% dropout, ~120–135 PLEs passing PLE
criteria, ICC ≥ 0.75 gating the start of Tier-2 auditing.

## Why there is no replacement date

**Data collection is defined relative to approval, not to a calendar.** CREC082 puts it at **month
3–4 after CREC approval**, and approval has not happened ([LOCAL-MODEL-ROADMAP.md:19-22](LOCAL-MODEL-ROADMAP.md)).
Until there is an approval date there is nothing to count months from, so any month named here would
be invented.

**Sandbox is not pilot.** The two were conflated once and it is worth stating plainly: the sandbox
round is a test cohort in an isolated council, and its sessions carry `is_test`. See the *Pilot
Study* entry in [domain-concepts.md](domain-concepts.md).

**As of 2026-09-07** production holds 47 PLEs, of which **13** are not test sessions and **5** carry
a human score. Against the published target of 225 participant PLEs the count is **0** — none of
them are participant data, because there are no participants yet.

## The one date on the books, and what it means

**D23 — internal deadline 15 Sep 2026, covering everything through Model Lock.** Self-imposed, and
deliberately not tracked to CREC approval, because the box-side work does not depend on the approval
date and needed a fixed date to move against
([LOCAL-MODEL-ROADMAP.md:137](LOCAL-MODEL-ROADMAP.md)).

[LOCAL-MODEL-CUTOVER.md:177-183](LOCAL-MODEL-CUTOVER.md) already states what it can honestly mean:

> *"queue, limits, consistency layer shipped and measured on the sandbox; screening verdict reported
> with its pairs-needed row"* — **not** *"gate passed"*.

On an 8-pair held-out split the D18 verdict reads `insufficient` unless true agreement is ≈0.95. It
did: **0.436 (0.000–0.873), n=8, `insufficient`**, spent 2026-09-04
([METHODOLOGY-local-vs-sonnet.en.md](METHODOLOGY-local-vs-sonnet.en.md)).

**There is no external or regulatory deadline in September or October 2026.** D25 retired the 15 Sep
fallback: the honest response to a slip is to move the start date, not the model.

## What actually gates the first participant

Not the box, and not engineering. [LOCAL-MODEL-CUTOVER.md:193-198](LOCAL-MODEL-CUTOVER.md):

> The whole of step 7's denominator — recruitment, the anchor set, rater calibration, and whatever is
> suppressing the human range — is independent of the box and is the actual long pole. It can start
> today.

The measured state of that denominator is in
[G0.5-HUMAN-RATER-PREP.th.md §0](G0.5-HUMAN-RATER-PREP.th.md): the current cohort's between-episode
SD is **2.44** against the **4.66** the ICC gate needs, so it cannot adjudicate any scorer no matter
how many raters are added. Cohort selection precedes scheduling.

Any future date on this page must be derived — `required_n / paired PLEs produced per week`, with the
denominator **measured** rather than assumed — and must carry the approval date it counts from.
