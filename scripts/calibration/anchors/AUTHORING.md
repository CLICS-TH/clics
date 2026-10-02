# Anchor cohort — authoring spec and pre-registered analysis

The anchor cohort is a set of **synthetic** CLE transcripts, each written to express a **designed**
PIS-7 score vector. It exists because the 26 real probe fixtures span too narrow a range (held-out
composites 32–62, between-episode SD 2.44 against the 4.66 G0.5 needed), so no agreement statistic on
them can be decisive for any scorer. Targets come from `design.json` (`design.mjs`, seeded); the
transcripts live in `fixtures/anc-NNN.json`; this file says how a transcript must express its target.

> **Evidence level: screening-synthetic (AI-authored, AI-scored), not a decisive gate.**
> An AI wrote these transcripts to a rubric, and an AI scores them. Agreement between the two shows
> the evaluator can *read* the behaviours the rubric names when they are written plainly. It does not
> show it agrees with human auditors on real physicians. That is the job of the decisive gate: three
> blinded human raters (`scripts/calibration/three-way.js`), and they can score these same anchors
> once imported into the SANDBOX council.
>
> Shared-author bias: if the scorer is the same model family as the author (Claude scoring
> Claude-written anchors), agreement is inflated by shared phrasing priors. Report the scorer's model
> next to every number.

Sources this spec is grounded in, and which win where they differ:
1. CREC082 `PIS7_Rubric_Behavioral_Anchors_V2.0`, as mirrored verbatim in
   `audit-dashboard/lib/pis7-rubric.ts` (`PIS7_SCALE`, per-domain 0→3→5 `anchors`).
2. `rimpl/src/lib/prompts.js` `PIS7_EVALUATOR_PROMPT`: the calibration rules, domain definitions and
   floors the evaluator applies (and `PIS7_LOCAL_ADDENDUM` for the local model).

---

## 1. Hard rules (validate.mjs enforces each one it can)

1. **Synthetic, no PII.** No names of patients, physicians, nurses or relatives (not even invented
   ones: the PII filter will mask them and the scored text would then differ from the fixture). No
   HN/AN, phone, ID number, date of birth, exact admission date, address, province, or named
   hospital. Frame cases generically: `ผู้ป่วยชายในวัย 50 กว่า`, `a woman in her 30s, G2P1`,
   `รพ.ชุมชนขนาด 30 เตียง`, `a district hospital without CT`. Labs and vitals are fine; ages need the
   phrasing below.
   `validate.mjs` runs `rimpl/src/services/pii-filter.js` over every turn: any change is a failure.
   That rule is stricter than privacy needs, on purpose: every scoring path runs the same filter
   (`flattenForPrompt`), so a masked span is text the evaluator never sees, and an anchor whose
   evidence was masked no longer expresses its target.

   The table below was **re-verified entry by entry with `stripPii` on 2026-10-02, after #114**
   (which stopped the filter masking much clinical prose). Re-check it whenever pii-filter.js changes.

   | still masked (do NOT write)                                      | survives (write this instead)                                   |
   |------------------------------------------------------------------|-----------------------------------------------------------------|
   | `อายุ 58`, `58 ปี`, `อายุ 58 ปี`, `อายุ 65–74`, `เด็กอายุ 2 เดือน`, `ทารกอายุ 6 สัปดาห์`, `อายุ 18 เดือน` → `[AGE-n]` | `ในวัย 50 กว่า`, `วัย 70`, `อายุมากกว่า 65`, `อายุตั้งแต่ 75 ขึ้นไป`, `เด็ก 7 ขวบ`, `ผู้สูงอายุ` |
   | `a 58-year-old`, `a 34-year-old woman`, `age 58`, `age 6 weeks` → `[AGE-n]` | `in his 50s`, `a woman in her 30s`, `over 65`, `older than 65`, `6-week-old infant`, `2 months old` |
   | **durations in years**: `เป็นเบาหวานมา 10 ปี`, `อาการ 3 ปี` → `อาการ [AGE-1]`, `1 ปีที่ผ่านมา` | `เป็น DM มานานกว่าสิบปี`, `ไม่ถึงสองสามปี`, `ช่วงสามถึงห้าปี` |
   | **คุณ** + a following clause: `คุณคิดว่าอย่างไร`, `คุณจะทำอย่างไรต่อ`, `ถ้าคุณเป็นแพทย์`, `คุณสมบัติ`, and **ขอบคุณ** + a clause (`ขอบคุณที่ชี้ครับ`, `ขอบคุณสำหรับคำตอบครับ`) → `คุณ[NAME-n]` | drop the pronoun (Thai allows it), or `หมอ`, `ท่าน`; plain `ขอบคุณครับ`, `ขอบคุณมากครับ`, `คุณหมอ`, `คุณภาพ` now survive |
   | `ห้อง lab` → `[WARD-n]`                                          | `lab`, `ส่ง lab`, `ห้องปฏิบัติการ`                                  |

   **Durations in years are masked as ages** (`อาการ 3 ปี` → `อาการ [AGE-1]`). Whether the filter
   should mask ages at all is pending the IRB answer on age; until then, write durations in words.

   **No longer masked after #114** (verified; usable again): `first-line`, `joint line tenderness`,
   `ต่างจังหวัด`, `รพ.สต.`, `รพ.จังหวัด`, `เครือข่ายจังหวัด`, `เชื่อว่า`, `เชื่อมั่น`,
   `ช่วงความเชื่อมั่น`, English `ward` / `toward`, `ชื่อยา X`. `GA 34 wk`, `อายุครรภ์ 34 สัปดาห์`, labs and
   vitals were always safe. When validate reports a new hit, rephrase, and add the pattern to the table.
2. **Blind.** Nothing in a fixture may hint at its target: no `d1`…`d7`, `PIS`, `rubric`, `domain`,
   `composite`, `anchor`, `synthetic`, level talk, or the domain names ("reasoning depth", "critical
   appraisal", "reflective synthesis"…). Clinical scores (HEART, CURB-65, Alvarado, CHA2DS2-VASc…) are
   normal clinical content and are fine.
3. **Format** — exactly the probe-fixture shape (`scripts/probe/build-fixtures.mjs`):
   ```json
   { "ple_id": "anc-007", "patient_ref": null,
     "transcript": [ {"role": "physician", "content": "…"}, {"role": "assistant", "content": "…"}, … ] }
   ```
   Turns alternate `physician` / `assistant`, starting with `physician` and ending with `assistant`.
   The number of `physician` turns equals the design's `physician_turns` (4–8, so 8–16 chat turns).
   An optional final `{"role": "reflection", …}` turn comes after the last assistant turn — see §4.
4. **Language.** `language: "th"` anchors: physician turns in Thai the way Thai doctors actually
   write — Thai sentences carrying English drug names, lab names and abbreviations (`pt`, `Dx`, `DDx`,
   `r/o`, `f/u`, `CXR`, `Cr`, `eGFR`, `on` ยา…). Tutor turns answer in Thai with the same English
   terms. `language: "en"`: everything in English. Thai share is checked per anchor.
5. **Citations are real or absent.** Every tutor turn carries at least one `(Source, Year)` citation
   (the tutor prompts require it), and every citation must match `citations.mjs`. Do not invent a
   reference, a trial name, a statistic attributed to a paper, or a guideline year. If you are not
   sure, cite a broader source you are sure of, or add to `citations.mjs` only what you can name the
   publisher and year of without looking it up. A citation vouches only for the sentence it sits on:
   never put one on a deliberately wrong statement (§5 d5, *planted claims*).
6. **Clinically correct tutor content.** The tutor is the anti-sycophantic mentor of the real prompts:
   it corrects a physician's error with evidence, it does not invent facts. Physician turns may
   contain errors — that is how low reasoning levels are expressed — but the tutor must not endorse
   them. The **one exception** is a *planted claim* for the physician to appraise (§5 d5); it is
   allowed only under the conditions listed there, and every one is recorded in `planted-claims.json`.

## 2. Who carries the signal

The evaluator scores the **physician's** behaviour and is told to ignore AI turns. So every level is
expressed in **physician turns** (and the reflection). Tutor turns are realistic, competent and
roughly constant in quality across the whole cohort — a good tutor reply must not lift a low anchor,
and a weak tutor reply must not be the reason a high anchor looks high.

Tutor turns follow the design's `tutor_mode`, written in the style of
`RIMPL_SYSTEM_PROMPT_NATURAL` / `RIMPL_SYSTEM_PROMPT_EXAMINER`:
- warm, collegial, concise (roughly 80–250 words; never over ~400), short bullet points;
- at least one `(Source, Year)` citation per reply;
- `natural`: answers the question asked and stops — **no** `❓` line;
- `examiner`: ends with exactly one Socratic question on its own last line starting with `❓`.
  The physician may ignore that question (low d4) or take it up (higher d4).

## 3. Independence, length and the traps the evaluator is told about

- **Each domain on its own evidence.** A vector like `[4,4,5,0,3,3,2]` means the physician asks sharp
  questions and reasons well but never follows up on anything the tutor said (d4 = 0: every turn
  restarts). Write exactly that. Dissociated anchors (`profile: "dissociated"`) exist to catch a scorer
  that stamps one global impression on all seven domains; they are worth the most, so write the
  off-profile domain unmistakably.
- **Length must not encode level.** `physician_turns` was assigned independently of the target, and
  physician length is one of the gated surface cues below (the pilot's first draft came in at
  r = 0.45–0.60 — authors write more for higher targets). A low anchor can be long-winded (verbose,
  generic, templated); a high anchor can be terse (a brief question that names this patient's exact
  decision is d1 ≥ 3).
- **Structure is not depth.** Headings, numbered lists and textbook completeness in a physician turn
  earn nothing. A templated "please give DDx, investigation, management, prognosis" prompt is a 1–2
  behaviour — but see the next point: lists must not appear *only* in low anchors.
- **No surface cue may track the level** (`cues.mjs`, run by validate.mjs). A scorer must have to read
  the reasoning to recover the target; if a shallow feature carries it, an AI-vs-target ICC measures
  the feature. Across the cohort, these are correlated with the target composite and the relevant
  domain targets (15 gated pairs, `CUE_RELEVANT`). **A gated pair fails when its 95% CI shows a cue
  beyond ±0.1** — CI lower > 0.1 or upper < −0.1 — at every n. With no true cue the whole check
  false-fails about 17% at n = 30, 10% at n = 50 and 4% at n = 100 (seeded simulation in
  `anchors.test.mjs`, which fails if that rate exceeds 20% or jumps between n = 49 and 50).
  *Amendment, 2026-10-02 (final review of PR #111), made before any non-pilot fixture existed:* this
  replaced "|r| > 0.4 below n = 50; from n = 50 fail unless the CI excludes ±0.4", which was an
  equivalence test above n = 50 and, with no cue at all, false-failed 99% at n = 50 and 27% at
  n = 100 (60% at n = 21, 7% at n = 49) — a cliff at 50 and CI red on noise. The separate
  "|r| > 0.4" physician-length gate was folded into this rule at the same time. The cues are:
  - physician-turn **length**;
  - **acknowledgements** per turn (`ok`, `โอเค`, `ok ครับ`, `noted`, `รับทราบ` …) — the pilot had low
    anchors saying "ok ครับ" and high anchors never saying it (r = −0.71);
  - **numerals** per turn — the pilot's high anchors quoted eGFR, doses and thresholds, its low ones
    rarely did (r = +0.58);
  - **bullet / numbered-list lines** — the pilot used lists only for templated low anchors (r = −0.53);
  - **rubric echo** — the rubric's own descriptor words in physician text (`cues.mjs` `RUBRIC_ECHO`),
    e.g. the d5 level-5 triad ข้อเท็จจริง / ไม่แน่นอน / ข้อจำกัด (pilot r = +0.64 with d5).

  So, for every anchor you write:
  - **Express each level through behaviour, never by reciting rubric wording.** A d5 = 5 physician
    challenges a specific claim and says *why* it does not hold for this patient; they do not announce
    "the fact is … the uncertainty is … the limitation is …". A d7 = 5 physician cross-checks a dose
    against the formulary; they do not say "I own this decision" as a formula. A d6 = 5 reflection
    names what they will do on Monday, not "what changed / next learning".
  - **Vary acknowledgements, numerals and formatting independently of level.** Brisk high-level
    physicians type "ok" too; low-level ones paste labs full of numbers. Some high anchors use a
    numbered list to structure a sharp question; some low anchors are unformatted prose.
  - **Distribute surface features across levels on purpose.** Before writing a batch, decide for each
    anchor (independently of its target) whether it is terse or verbose, ack-heavy or not, numeric or
    not, listy or not — and then write the level inside that shape.
  - validate.mjs prints the full cue matrix and the per-fixture rubric-echo hits; read both before
    submitting a batch.
  - **The pilot freeze** *(lapsed 2026-10-02: nine pilot anchors were edited after the blind
    diagnosis, see the §7 amendment, and the cohort now passes the gate without it)*. The 20 pilot anchors predate this check and fail 6 gated pairs under it
    (acks vs composite r = −0.71 and vs d5 −0.63; numerals vs composite +0.58 and vs d3 +0.52; list
    lines vs composite −0.53; rubric echo vs d5 +0.64). While they are being scored these are reported
    as known, not counted (`cues.mjs` `PILOT_FREEZE`). The freeze is keyed to the 20 pilot files'
    sha256s and caps each pair at its recorded r: rewrite any pilot anchor, add any new fixture, or let
    a frozen pair get stronger, and every gated pair counts again. So the next batch must be written to
    counterbalance these cues, or the pilot rewritten, before validate.mjs passes.
  - **Acks need light counterbalancing as the cohort grows.** Simulated at final review of PR #111:
    the pilot unchanged plus 80 anchors with NO cue failed the check 18% of the time, mostly on
    acks:composite and acks:d5 — the pilot's acknowledgement pattern is strong enough to show through
    80 neutral anchors. So in the next batches give some high-target physicians a casual "ok ครับ" /
    "noted" and keep some low-target ones ack-free, rather than relying on dilution.
  - **Reporting the pilot.** Wherever pilot known-groups results are written up, label the d5 result
    **inflated by rubric echo**: on the pilot, the count of rubric-descriptor phrases correlates
    r = 0.64 with the d5 target, so a scorer can recover d5 from the wording without judging the
    appraisal. `known-groups.mjs --pilot` prints this caveat under the d5 row.
- **Near-duplicate physician turns cap d2 and d4 at 2** (evaluator rule). Use this only for anchors
  whose d2 and d4 are both ≤ 2.
- **Evidence for 4–5 is a quotable, case-bound physician sentence** — something that could not have
  been written without engaging this particular case. Every 4 or 5 in the target needs at least one
  such sentence for that domain. A 0, 1 or 2 needs a visible absence: the turn where the behaviour
  should have appeared and did not.
- **Linkage phrases count only when they engage content.** "From what you said about X…" is d4
  evidence when X is the tutor's specific point; an empty "ok, next question" is not.

## 4. Reflection (d6) — match the production format exactly

`backend/src/services/reflection.js` `asTranscriptTurn` appends the post-session reflection as a
turn with role `reflection`, which `rimpl/src/lib/transcript.js` renders as `[REFLECTION]:`. Its
content is up to three blocks, separated by a blank line, each a heading line then the text; an empty
field is omitted entirely:

```
เรียนรู้อะไร / What I learned:
<text>

ความไม่แน่นอน / What remains uncertain:
<text>

จะตรวจสอบ/นำไปใช้อย่างไร / How I will verify or apply it:
<text>
```

The headings are bilingual in production regardless of the physician's language — keep them verbatim.
The design's `reflection` field says where d6 evidence lives:
- `none` (always when d6 = 0): no reflection turn, and no summary or takeaway anywhere in the chat.
- `reflection_turn`: a `reflection` turn as above. For d6 = 1 it is generic ("ได้ความรู้เยอะมาก
  ขอบคุณครับ" in the first block only); depth grows with level per §5.
- `in_chat`: no reflection turn; the evidence is the physician's own summary in their last chat turn.

## 5. Per-domain levels (what the PHYSICIAN does)

The CREC general scale applies to every domain: **0** no evidence / not assessable · **1** very
little, scattered, or with significant errors · **2** some elements, shallow and unsystematic ·
**3** moderate, reasonably structured · **4** clear and systematic, links reasoning and limits ·
**5** deep and sustained, notably critical and synthesising. The CREC per-domain 0 → 3 → 5 anchor is
quoted first in each block; levels 1, 2 and 4 interpolate it using the evaluator's floors.

### d1 Clinical Question Intelligence — *0 no assessable question → 3 clear, relevant question → 5 deep and specific; leads somewhere*
- **0** No clinical question at all: the physician pastes facts and says `ช่วยด้วย`, `ต่อ`, `ok`, or
  only asks the tool to produce something ("write me a summary").
- **1** Vague textbook lookups that would fit any patient (`โรคนี้รักษายังไง`), or a question built on
  a significant error.
- **2** Relevant to the topic but generic: "what's the differential for chest pain?", `ควรส่งตรวจ
  อะไรบ้าง` — no decision point named.
- **3** A clear question tied to this case's decision: `pt รายนี้ควร admit ไหม`.
- **4** Names the decision AND what it hinges on: `CURB-65 = 1 แต่อยู่คนเดียว บ้านไกล 40 กม. — admit
  เพื่อ social reason หรือ treat OPD แล้วนัด f/u 48 ชม.?`
- **5** A sequence of such questions that converges: each one targets the crux revealed by the last,
  re-framed as understanding grows, and the last one is a question the physician could not have asked
  at the start.

### d2 Reasoning Depth — *0 no reasoning → 3 reasonable reasoning → 5 deep; links mechanism, evidence and limits*
- **0** No reasoning of their own: only asks, or only accepts.
- **1** A bare conclusion with no justification, or reasoning with a significant error left uncorrected.
- **2** Lists possibilities without ranking or justification (`อาจเป็น A, B, C`).
- **3** Commits to a leading hypothesis with some justification.
- **4** Ranked hypotheses with explicit reasons, weighs risk–benefit, and **updates** when the tutor or
  new data contradicts them (says what changed and why).
- **5** Explicit probabilistic reasoning with committed thresholds (pre-test probability, treat/test
  threshold), links mechanism + evidence + its limits, revises visibly.

### d3 Contextual Integration — *0 no use of context → 3 partial integration → 5 thorough, and aware of the limits*
- **0** No patient or setting context; the question is abstract.
- **1** Context barely mentioned, or an obvious contraindication in the case is ignored.
- **2** Context listed (age, comorbidities) but changes no decision.
- **3** At least one patient factor visibly changes a decision.
- **4** Several factors — comorbidity, drugs, renal function, setting (district hospital, no CT,
  referral distance), patient preference or cost — systematically shape the plan.
- **5** As 4, plus awareness of limits: the trial population excluded patients like this, the
  guideline assumes resources this setting lacks, and what the physician will do about that gap.

### d4 Iterative Inquiry — *0 no follow-up → 3 relevant follow-up → 5 strategically adapts the questions*
- **0** No follow-up: every physician turn starts a new, unrelated question; nothing the tutor said is
  ever picked up.
- **1** Mostly topic-hopping; one weak follow-up.
- **2** Generic follow-ups (`อธิบายเพิ่มหน่อย`, "tell me more"), or a near-duplicate repeat of an
  earlier question.
- **3** Follow-ups that build on the previous answer.
- **4** Each turn engages a specific point of the previous answer: probes it, narrows it, tests an
  assumption in it.
- **5** Strategic: the physician changes the line of inquiry because of what was learned, tests an
  edge case or counterfactual ("ถ้า troponin ครั้งที่ 2 ขึ้นเล็กน้อยล่ะ"), and converges.

### d5 Critical Appraisal — *0 no critique of the AI → 3 reasonable appraisal of limits → 5 separates fact, uncertainty and limitation well*
- **0** Accepts everything; may even ask the tool to confirm the physician's own plan and stop there.
- **1** Token doubt with no substance (`แน่ใจนะ?`), or accepts a claim that should have been checked.
- **2** Occasionally asks for a source or notes uncertainty, superficially.
- **3** Asks for the evidence behind a claim, notes a limitation, or catches a minor overreach.
- **4** Challenges specific claims systematically: does the cited study apply to this patient, is the
  recommendation strength being overstated, points out a concrete error.
- **5** Explicitly separates what is established, what is uncertain and what is a limitation of the
  evidence or of the tool, and weighs evidence quality. (For d5 ≥ 4 the tutor must give the physician
  something real to appraise — a generalisation, a recommendation whose population differs from the
  patient — and the anti-sycophantic tutor then concedes or defends with evidence.)

**Planted claims — how this squares with §1.5 and §1.6.** Something to appraise is best a TRUE
statement stated without its limits (a trial result whose population differs from the patient). When
an anchor needs a statement that is actually wrong, it is a *planted claim*, and all of these hold:
1. it is an over-generalisation or a population mismatch (`ทุกราย`, "for everyone", a trial result
   carried to a group it excluded) — never an invented fact, number, trial or reference;
2. **no citation on its line.** A real citation may sit on a neighbouring true sentence, never on the
   false one: putting `(ADA, 2024)` after "HbA1c < 7% for everyone" attributes an error to a real
   guideline, which §1.5 forbids;
3. a later tutor turn in the same transcript corrects it with evidence (the physician catches it, or
   the tutor concedes), so no anchor ends with an uncorrected error;
4. it is recorded in `planted-claims.json` or the anchor's sidecar `planted/anc-NNN.json` (fixture, turn, verbatim text, kind, the turn that corrects
   it). `validate.mjs` checks each entry against the fixture bytes and fails on a false claim with a
   citation on its line. An inaccuracy found in a tutor turn AFTER the text was panel-rated is not
   edited (that would change rated bytes); it is recorded there as kind `unplanted` instead (anc-101
   turn 5: PCC is dosed by weight, not by agent and timing).

Tutor turns in anchors are **authored text, not tutor output**. Any audit of the tutor's own quality
(Phase 3, the Thai tutor audit) must exclude the anchor fixtures entirely, and `planted-claims.json`
says which turns would be actively misleading if it did not. One legacy entry (anc-019 turn 5,
"HbA1c < 7% for everyone (ADA, 2024)") predates rule 2 and is marked `legacy`; it was not edited
because any edit changes bytes that were already scored.

### d6 Reflective Synthesis — *0 no reflection → 3 reasonable summary/reflection → 5 deep synthesis; names the next learning or action*
- **0** No reflection and no summary anywhere (design `reflection: none`).
- **1** Generic: "very useful, I learned a lot".
- **2** A summary that restates the tutor's content, not grounded in the case or the physician's own view.
- **3** A reasonable, case-grounded summary in the physician's own words.
- **4** What changed in their thinking, what remains uncertain, and how they will apply it.
- **5** As 4, deep and specific: names what changed in their approach and why, the residual
  uncertainty, and a concrete next learning or action (verify X against Y, audit Z, teach the ward
  team W).

### d7 AI Literacy & Prompt Skill — *0 inappropriate use of AI → 3 reasonable prompting and steering → 5 critical use, aware of the limits*
- **0** Inappropriate use: hands the decision to the tool (`ตัดสินใจให้เลยว่าจะให้ยาอะไร เดี๋ยว copy
  ไปใส่ order`), asks it for things it cannot know (this patient's result), no clinical ownership.
- **1** Vague prompts with no context; copies the output forward; no verification.
- **2** Some context given, but imprecise prompts; accepts whatever format and scope comes back.
- **3** Reasonable prompting: gives the relevant context, steers the answer (focus, shorten, compare),
  keeps the decision.
- **4** Precise prompts with constraints (setting, what is already known, what is wanted), asks the
  tool to show its reasoning or sources, verifies a key output, states ownership of the final plan.
- **5** Critical use aware of the limits: names what the tool cannot know or may get wrong, cross-checks
  against a guideline or formulary, deliberately uses it as a sparring partner ("argue against my
  plan"), and owns the decision explicitly.

d5 vs d7: d5 is appraisal of the **content** (claims, evidence); d7 is how the physician **uses the
tool** (framing, steering, verification, ownership). A physician can challenge every claim (d5 high)
and still end by asking the tool to just write the order to copy (d7 low).

## 6. Author checklist (per anchor)

1. Read the anchor's row in `design.json`: targets, language, specialty, case, tutor_mode,
   physician_turns, reflection, profile/dissociated_domains.
2. For each domain, decide which physician turn(s) carry its evidence (or its visible absence).
3. Write the dialogue; tutor turns in the right mode, with allowlisted citations.
4. Re-read as a rater: for every target of 4–5, can you quote the sentence? For every 0–2, can you
   point at the absence? Would a scorer give a different number to any domain? Fix the transcript,
   never the target.
5. Any tutor statement written wrong or unqualified on purpose: follow the planted-claim rules (§5)
   and add it to `planted-claims.json`.
6. `node scripts/calibration/anchors/validate.mjs` — must pass. It also rewrites `manifest.json`.

Never change `design.json` to fit a transcript. If a target vector cannot be written naturally,
say so in the PR and leave the anchor unwritten.

## 7. PRE-REGISTERED analysis — fixed before any anchor is scored

These rules are written down before the first scoring run so the threshold that flags an anchor
cannot be chosen after seeing which anchors it would flag. `known-groups.mjs` reads its threshold from
the line below, and `anchors.test.mjs` fails if the two ever differ.

**PRE-REGISTERED THRESHOLD: 15 composite points**

1. **Scoring.** Each anchor is scored K = 3 times by the evaluator under test (production settings:
   temperature 0, max_tokens 4096, the provider's `pis7PromptFor` prompt, consistency `off` so each run
   is one call). The anchor's AI score is the per-domain **median** of its runs; the composite is
   `compositeOf` of that median vector. Each report records model, `prompt_version`, `rubric_version`.
2. **Anchor flag.** An anchor **does not express its target** when
   `|AI composite − target composite| > 15`. Per domain, `|median − target| ≥ 2` is reported as a
   domain flag (diagnostic only; it does not flag the anchor by itself).
3. **Cohort statistics.** ICC(A,1) of AI composite vs target composite with the F-based 95% CI
   (`backend/src/services/icc.js` `iccTwoRater`); Spearman ρ per domain and for the composite; mean
   bias (AI − target) per domain and for the composite; n and the number of anchors excluded for
   missing scores; test–retest composite spread across the K runs.
4. **What a flag means.** A flagged anchor is first a question about the *anchor*, not the scorer. On
   the pilot (all 20 are tuning material) a flagged anchor may be rewritten **once**, re-validated
   (new sha256 in `manifest.json`) and re-scored; if it is flagged again it is excluded and replaced
   from the design. *Mechanics (added 2026-10-02):* `design.mjs` `REPLACEMENTS` records each exclusion;
   the excluded row stays in `design.json` marked `excluded` (date, reason, archive path, sha256), its
   last fixture moves to `fixtures/excluded/` byte for byte, and a NEW id after the cohort (anc-101,
   anc-102, …) copies its target vector, case slot and every other design attribute. The replacement
   is a fresh anchor with the normal single-rewrite allowance. Excluded anchors are never scored,
   counted or held out (`score-local`, `known-groups`, `anchor-split` skip them). Rewriting toward the AI's score is circular, so a rewrite must be justified from §5
   (the behaviour was genuinely missing or ambiguous), never from the AI's number.
5. **Held-out discipline.** Before the full cohort is scored, a held-out split is reserved
   (`SPLIT-anchors.json`, seeded, same method as `scripts/probe/reserve-split.mjs`). Held-out anchors
   are **never** rewritten on the strength of an AI score; their flags are reported as results.
   **The 20 pilot anchors are tuning-only**: they are scored, read and possibly rewritten before any
   split exists, so none may ever be held out. `anchor-split.mjs` `checkSplit` rejects a split that
   holds one out, `heldOutEligible` excludes them, and `anchors.test.mjs` checks the committed
   `SPLIT-anchors.json` as soon as it exists. Once it exists, `known-groups.mjs` requires
   `--split tuning|heldout` (`--pilot` implies `tuning`, since the pilot is tuning-only).
   *Reserved 2026-10-02, before any non-pilot anchor was authored or screened* (D13):
   `anchor-split.mjs --reserve --seed 20261005 --held-out 60`. **60 held-out, 40 tuning** (the 20
   pilot anchors plus 20 new). The split is reserved **by design id**, not by fixture: the probe's
   `reserve-split.mjs` hashes fixture files, which here would mean writing the anchors before
   reserving, and authoring is the step the split must precede. Held-out is stratified over the
   designed composite, so it spans the whole range (16–93), unlike the probe's held-out (32–62).
   **Why 60.** The cohort is about 100 so that the held-out test has power. For the two-rater
   ICC(A,1) lower bound to clear 0.75 when the true value is 0.88 (the D18 bar), the earlier power
   work for PR #104 found about 60 pairs gives 80% power, and 26 pairs only a coin flip
   (`pairsNeededTwoRater` = 26 is the coin-flip n). Re-simulated with `iccTwoRater`, no rater bias,
   3000 reps: 45 pairs → 0.76, 50 → 0.79, 55 → 0.84, **60 → 0.87**; with a rater bias of 0.5 SD of the
   error, 60 → 0.61. The first reservation (40 held-out, 61cdcb7) gave 0.71, underpowered by design.
   It was redrawn **before any non-pilot anchor was authored or screened**, in a commit that says so.
   Fixture bytes are bound at first scoring: `anchors.test.mjs` fails if a held-out fixture that any
   run in `runs/` scored no longer has the bytes that run scored.
   **What this means for authoring and screening.** Every anchor, held-out or tuning, is written the
   same way and must pass `validate.mjs` (PII, schema, citations, cue gate) before any scoring. Fixing
   a validator failure before the first score is authoring, not tuning. From the first AI score or
   blind-panel rating on, the **blind-panel rewrite rule (§7 amendment, item 2) applies to TUNING
   anchors only**. A held-out anchor is never rewritten on the strength of a panel or AI score, and
   never excluded or replaced under §7.4. Its panel and evaluator flags are reported as results. The
   batch plan and the author brief never tell an author which split an anchor is in.
6. **Proceeding.** The pilot is acceptable for scaling to the full cohort if no more than 4 of 20
   anchors (20%) **do not express their target** after the single rewrite round. Otherwise this spec
   is revised first. An anchor that never received a valid score (every run failed production's
   contract, or never returned) counts as not expressing its target: an anchor the evaluator cannot
   score is not one it reads correctly, and dropping it would flatter the rule. `known-groups.mjs`
   prints this verdict (`within` / `exceeded`).
   *Amendment, 2026-10-02 (review of PR #111):* the "never validly scored counts against" clause was
   added while the first pilot run was in progress and before its results were analysed. It can only
   make the rule stricter.
7. **Labelling.** Every output carries `evidence level: screening-synthetic (AI-authored, AI-scored) —
   not a decisive gate`. No result here is described as human agreement, and no "improved/declined"
   claim is made without its interval.

### Amendment, 2026-10-02 — who decides that an anchor must be rewritten

*Made after the first strict pilot run (`runs/pilot-local-strict-2026-10-02.json`) and its blind
diagnosis (`pilot/blind/`, `PILOT-REPORT.md`), and **before any anchor was rewritten** on the strength
of either.* **That ordering is self-attested, not provable from git:** this amendment and the five
rewrites landed in the same commit (6827719), so the history cannot show which was written first.

**This deviates from the pre-registered rule above.** §7.2 and §7.4 let the evaluator under test — the
local model — decide which anchors are flagged and rewritten. That is circular: rewriting an anchor
until the evaluator under test agrees with its target calibrates the cohort *to that evaluator*, and
the known-groups statistic then measures how well the cohort was fitted to it rather than how well it
reads behaviour. The pilot showed why it matters in practice: of the 7 locally flagged anchors (mean
target 42, local 70), blind raters put most of the gap in the transcripts (blind mean about 63), so
the local flag mixed an authoring problem with the evaluator's own offset.

The rule from now on:

1. **The rewrite decision is made by a blind rater panel that is independent of the evaluator under
   test.** The panel is **two different models** (for example a Sonnet and an Opus subagent), each
   scoring every anchor blind: shuffled labels, no targets, no ids, the `PIS7_EVALUATOR_PROMPT` rubric
   text and the transcripts only (the `pilot/blind/` packet is the template). Two copies of the same
   model are one rater, not two — the pilot's two Sonnet raters agreed at composite ICC 0.995.
2. **An anchor is rewritten when |mean blind composite − target composite| > 15** (the same 15 points
   as the pre-registered threshold, now applied to the panel). A rewrite is justified from §5 — the
   behaviour was expressed at the wrong level — never from any evaluator's number. §7.4 is unchanged
   by this amendment: one rewrite per anchor; an anchor still beyond the line after it is excluded
   and replaced from the design.
   **Scope: TUNING anchors only.** Held-out anchors get no panel-driven rewrite, exactly as they get
   no evaluator-driven one (§7.5); their panel flags, like their evaluator flags, are reported as
   results.
   **The panel is not independent of Claude.** The panel is Claude-family (Sonnet + Opus), the anchors
   are Claude-authored, and the incumbent production evaluator is `claude-sonnet-4-6`. A
   panel-screened cohort is therefore fitted toward Claude's reading of the rubric, and any result
   for a Sonnet arm carries that caveat. Whenever Sonnet is the scorer under test, a non-Claude panel
   member is preferred. This is an **open item**: no non-Claude panel member has been run.
3. **The local evaluator's flag rate is kept as a reported outcome, never as the acceptance criterion.**
   §7.2's flag, §7.6's proceed rule and the known-groups statistics are still computed and reported
   for every scored run.
4. On the pilot, the only blind ratings were the two Sonnet raters — one rater in effect, so this
   first selection fell short of item 1; the two-model panel applies from the re-score on. Their mean
   puts **5 anchors** over the line: anc-015 (+28), anc-006 (+36),
   anc-019 (+27), anc-014 (+24), anc-005 (+17). These five were rewritten. Four further pilot anchors
   (anc-007, anc-010, anc-013, anc-016) received **wording-only** edits that replace rubric phrases
   (the d5 triad, "argue against", "AI ไม่รู้") with behaviourally equivalent wording; their behaviour
   and targets are unchanged. Without those edits the surface-cue gate cannot pass once the pilot
   freeze lapses (rubric echo was concentrated in high anchors that no rewrite of the five could
   offset). All nine need re-scoring by the panel and the local evaluator before any pilot figure is
   recomputed.
5. **Round 2 outcome (same day), and §7.4 applied as written.** A Sonnet + Opus panel rated all 20
   pilot anchors after the rewrites. Two are beyond ±15: anc-015 (+22) and anc-012 (+21).
   - **anc-015** had used its one rewrite, so under §7.4 it is **excluded and replaced**: a new anchor,
     **anc-101**, at the same target vector and case slot (`design.mjs` `REPLACEMENTS`). The excluded
     text is archived byte for byte at `fixtures/excluded/anc-015.json`, sha256 recorded in
     `design.json`. anc-101 is a fresh anchor with the normal single-rewrite allowance.
   - **anc-012** had had no rewrite, so under item 2 it is due its one: **rewritten**. If the panel
     puts it beyond ±15 again, it is excluded and replaced the same way.
   - Both go to the blind panel and the local evaluator before any pilot figure is recomputed.

   An earlier draft of this item (2627c9b) kept both anchors without applying §7.4. That relaxed the
   pre-registered rule after the panel's numbers were known; it is withdrawn. Sonnet and Opus are both
   Claude and agree at composite ICC 0.968, so even this panel is not two independent raters (see the
   Claude-family caveat under item 2). Human raters remain the decisive gate.
6. **Round 3 (same day).** The panel rated anc-101 (first write) and the rewritten anc-012 among six
   unchanged decoys. anc-012 lands at −1 and stays. anc-101 is at +20, so it uses its single rewrite
   (§7.4); if the panel puts that rewrite beyond ±15, anc-101 is excluded and replaced like anc-015.
   **Which round counts for a text:** a rule decision uses the round in which that text was *first*
   rated by a two-model panel (Sonnet + Opus; round 1's two Sonnets were one rater, item 1). A later re-rating of identical text (a decoy) is a stability check, recorded but
   never a rewrite trigger. This was decided after round 3 showed decoy anc-018 at +16 (+12 in round
   2, text unchanged); it is written down here so it cannot be chosen again case by case.
7. **Round 4 (same day).** anc-101's rewrite reads +14, so it stays. Its d7 still reads 1–2 levels
   high. No panel rewrite is outstanding: 0 of 20 active pilot anchors are beyond ±15 on their deciding
   round, so the pilot proceeds under §7.6. The excluded anc-015 is not one of the 20; counting it as a
   failure gives 1 of 20, and the verdict is unchanged. Re-ratings of identical text drifted up to 10 composite
   points between rounds, so verdicts near the line are noise-limited. `PILOT-REPORT.md` reports the
   pooled Δ beside the deciding one, and that changes no decision.

## 8. Pipeline and commands

| step | command | network |
|------|---------|---------|
| design matrix | `node scripts/calibration/anchors/design.mjs` (`--check` to verify + print coverage) | none |
| validate + manifest | `node scripts/calibration/anchors/validate.mjs` (`--check` to verify without writing) | none |
| tests (CI) | `npm run test:calibration` | none |
| held-out split (once, done) | `node scripts/calibration/anchors/anchor-split.mjs --reserve --seed 20261005 --held-out 60` (refuses to overwrite) | none |
| batch plan | `node scripts/calibration/anchors/batch-plan.mjs` (`--check` to verify; prints the simulated cue-gate failure rate) | none |
| author brief | `node scripts/calibration/anchors/author-brief.mjs` (`--check` to verify it matches AUTHORING / validate / cues / citations) | none |
| batch intake | `node scripts/calibration/anchors/validate.mjs --batch N` or `--only anc-021,anc-034` (writes nothing; exit 1 = return to authors) | none |
| what would be sent | `node scripts/calibration/anchors/score-local.mjs --pilot --dry-run` | none |
| score (local box) | `LOCAL_AI_BASE_URL=… LOCAL_AI_MODEL=… LOCAL_AI_API_KEY=… node scripts/calibration/anchors/score-local.mjs --pilot --repeats 3 --concurrency 2 --out scripts/calibration/anchors/runs/pilot-local-<date>.json` | local box only |
| re-check a past run | `node scripts/calibration/anchors/revalidate.mjs scripts/calibration/anchors/runs/pilot-local-<date>.json` (writes `….revalidated.json`; needs rimpl deps) | none |
| analyse | `node scripts/calibration/anchors/known-groups.mjs scripts/calibration/anchors/runs/pilot-local-<date>.json --pilot [--split tuning\|heldout] --out …-known-groups.json` (add `--include-excluded` only to reproduce a run made before a §7.4 exclusion) | none |

`score-local.mjs` is local-only by construction: it never reads `ANTHROPIC_API_KEY`. It verifies
every fixture's sha256 against `manifest.json` before sending, scores with production's decoding
(temperature 0, max_tokens 4096) and `pis7PromptFor('local')`, and **scores through production's own
contract** — `scoreWithConsistency` → `scoreFromText`, `DomainScoresSchema` `.strict()`, with
`jsonRetries: 0` in off mode exactly as `evaluate.js` — so a reply production would answer 502 to is
unscored here too. Every raw reply is saved in the report (`rows[].replies`), so `revalidate.mjs` can
replay a past run through a newer contract offline. Runs made before 2026-10-02 (PR #111 review) hold no
replies and were parsed by a laxer extractor; revalidate reports their rows as `not_revalidatable`.
Each row records the model that actually **served** it; `known-groups.mjs` reports those, not the
requested model. The report stamps `prompt_version` and `rubric_version`. A cloud arm, when budget is approved, is
`scripts/probe/model-agreement.mjs`-style and belongs in a separate, explicitly approved run.

## 9. Scaling to the full cohort (prepared 2026-10-02)

The 80 non-pilot anchors are written by authoring agents, one anchor each, from `AUTHOR-BRIEF.md` and
one row of `batches.json`. Nobody writing an anchor calls an AI or sees the split. The order, fixed now:

1. **Split first.** `SPLIT-anchors.json` was reserved before any non-pilot anchor existed (§7.5).
2. **Plan.** `batch-plan.mjs` cuts the 80 rows into 8 batches of 10. Every batch spans the designed
   range and holds 2 English rows. Each row is assigned a **cue budget** — total physician length,
   number of acknowledgement tokens, numeral density, list lines, and zero rubric-descriptor words —
   balanced along the composite order, so no budget tracks the target by construction. The pilot
   showed that asking authors to "vary" these is not enough. Simulated: with every author inside
   their budget, the 100-anchor cue gate fails in 0% of draws. With authors who drift +5 physician
   characters per composite point (the pilot's habit), it fails 97%. Budgets are therefore checked at
   intake.
3. **Write.** One author per row writes `fixtures/anc-NNN.json` and, only if it planted or left
   unqualified a tutor claim, `planted/anc-NNN.json` (sidecars, so parallel authors never edit one
   shared file). `validate.mjs` reads `planted-claims.json` and every sidecar.
4. **Intake.** `validate.mjs --batch N` checks, for that batch only:
   - every per-fixture rule;
   - the cue budgets — a deviation is an error here and a warning in the full run;
   - the planted-claim entries;
   - the batch's contribution to the cohort cue gate, with the fixtures that push a pair most.

   It writes nothing. Exit 1 means the batch goes back to its authors.
5. **Record.** Once a batch passes intake, `validate.mjs` (no flags) writes `manifest.json`.
6. **Screen.** The blind panel and the local evaluator score the batch.
   - **Tuning anchors** follow the §7 amendment (one panel-driven rewrite, then exclude and replace).
   - **Held-out anchors are never rewritten after a score**, and a test enforces it once a run in
     `runs/` has scored them.

What had to change in the tooling for 100 fixtures:
- `known-groups.mjs` refused `--pilot` once the split existed. `--pilot` now implies `--split tuning`.
- `score-local.mjs` takes `--split`.
- A §7.4 replacement inherits its excluded anchor's split.
- With the pilot freeze lapsed, every pilot pair counts. The budgets above are what keeps the cohort
  inside the gate.
