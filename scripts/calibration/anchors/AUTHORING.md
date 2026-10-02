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
   reserving, and authoring is the step the split must precede. Held-out is stratified on
   **language × profile** (Thai/English × dissociated/coherent) and, within each cell, over the
   designed composite. Each cell's held-out share is proportional, and every cell of 2 or more keeps
   at least one tuning anchor. Held-out therefore spans the whole range (16–93, against the probe's
   32–62) and mirrors the pool on the two dimensions a D18 result could otherwise lean on.
   **Per-cell counts and composite spans are coordinator-only:** `anchor-split.mjs --report` prints
   them, and it needs `SPLIT-anchors.json`. They are not written in any document an author reads,
   because a cell's tuning span can identify an anchor. The small tuning cells are drawn as the
   complement of a stratified held-out, so they do not span their cell's range. Low-composite rewrite
   learning for English and dissociated anchors still comes from the pilot.
   **Why 60.** The cohort is about 100 so that the held-out test has power. For the two-rater
   ICC(A,1) lower bound to clear 0.75 when the true value is 0.88 (the D18 bar), the earlier power
   work for PR #104 found about 60 pairs gives 80% power, and 26 pairs only a coin flip
   (`pairsNeededTwoRater` = 26 is the coin-flip n). Re-simulated with `iccTwoRater`, no rater bias,
   3000 reps: 45 pairs → 0.76, 50 → 0.79, 55 → 0.84, **60 → 0.87**; with a rater bias of 0.5 SD of the
   error, 60 → 0.61. The first reservation (40 held-out, 61cdcb7) gave 0.71, underpowered by design.
   **60 is a floor, and only with no rater bias.** A systematic bias b, measured in units of the
   error SD, lowers the true ICC(A,1) itself. At the variance that gives 0.88 with no bias, the true
   value is 0.879 at b = 0.1, 0.867 at b = 0.5, 0.816 at b = 1.14, and 0.75 at b ≈ 1.7. Simulated at
   60 pairs, b = 1.14 gives power 0.004. No number of pairs rescues a large bias. Which bias applies
   matters, and the pilot has two very different numbers:
   - **D18 (local vs Claude):** on the pilot, local vs the blind Claude raters had a bias of −0.8
     composite points, about −0.10 error-SD. Small: this is the regime the table above describes.
   - **Known-groups (local vs designed TARGET):** +11.6 composite points, about **1.14** error-SD.
     Large, and fatal for an absolute-agreement ICC, but this is the known-groups measure, not D18.
     Do not carry it into a D18 power claim, or the reverse.
   It was redrawn **before any non-pilot anchor was authored or screened**, in a commit that says so.
   The second redraw added the language × profile cells, because the composite-only draw left 1
   English and 2 dissociated anchors among the 20 new tuning ones. It also happened before any
   non-pilot anchor existed. Seed, size and the held-out rules are unchanged.
   **Fixture bytes are bound at intake, not at first scoring.**
   - A batch is first accepted with `validate.mjs --record-batch N`. That runs the full intake, where
     a budget deviation is an error, and refuses an `extra_review` row unless
     `--confirm-extra-review <id>` names it. On success it appends the batch, with each fixture's
     sha256, to `intake-log.json`.
   - `validate.mjs` (no flags) then writes `manifest.json` and locks into `HELDOUT-LOCK.json` exactly
     the held-out fixtures whose current bytes are in the intake log. Any other held-out fixture
     present is an error and blocks the write.
   - From then on, `validate.mjs` and `anchors.test.mjs` fail if a locked fixture ever changes. A lock
     entry already on master may never change; CI fetches origin/master for that check, and fails
     rather than skips if it cannot read it.
   - A panel rating or an uncommitted run cannot slip a change past this, because the lock does not
     depend on any score existing.
   - Fixing a held-out fixture before it is locked is authoring: fix it and record its batch again.
   - `intake-log.json` is **append-only** against master by the same test pattern: master's entries
     must be a prefix of the branch's, so an entry can be added but never edited or removed. A
     hand-written entry for a fixture that never ran intake would otherwise let the writing run lock
     it, skipping the budget and extra-review gates.
   - The repo has no CODEOWNERS file, so `HELDOUT-LOCK.json` has no owner rule. A PR that changes an
     existing lock entry is a D13 breach by definition, and reviewers should treat it as one.
   **What this means for authoring and screening.** Every anchor, held-out or tuning, is written the
   same way and must pass `validate.mjs` (PII, schema, citations, cue gate) before any scoring. Fixing
   a validator failure before intake is authoring, not tuning. The **blind-panel rewrite rule (§7
   amendment, item 2) applies to TUNING anchors only**, and no held-out anchor is scored at all until
   every one is locked (§9). A held-out anchor is never rewritten on the strength of a panel or AI score, and
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
8. **Cohort batch 1 (2026-10-02).** The panel rated the 5 batch-1 tuning anchors (first write, the
   deciding round) among 2 unchanged pilot decoys (`pilot/batch-1/`, `analyse-b1.mjs`). The 5 held-out
   batch-1 anchors were not rated (§9). anc-027 is at +18 and anc-064 at +21, so each uses its single
   rewrite (§7.4). anc-059 (+7), anc-078 (+9) and anc-090 (+13) stay. All 5 read high (mean +13.5),
   although batch 1 was written under the pilot lesson "write lower". The general lesson went into the
   brief (§7 there) before batch 3 was written, and no batch-1 anchor was rewritten on its strength.
   Decoys: anc-016 93/90 and anc-008 17/17 (sonnet/opus), inside their earlier range.
9. **Cohort batch 3 and the batch-1 rewrites (2026-10-02).** The panel rated batch 3's 3 tuning
   anchors (first write), the rewrites of anc-027 and anc-064, and 2 unchanged pilot decoys
   (`pilot/batch-3/`, `analyse-b3.mjs`). For every non-decoy this was the deciding round of its text.
   - anc-023 (+4) and anc-097 (+2) stay. anc-024 (+21) uses its one rewrite.
   - The anc-064 rewrite reads +2 and stays.
   - The anc-027 rewrite still reads +19, so under §7.4 anc-027 is **excluded and replaced** by anc-102.
     The row is unchanged and was the same dissociated d2 = 1 beside d3 = 5 and d5 = 5. Its text is
     archived at `fixtures/excluded/anc-027.json`, with the sha256 in `design.mjs` REPLACEMENTS.
   - Decoys: anc-018 72/70 and anc-005 49/46, inside their earlier range.
   - **The first exclusion after the split was reserved exposed two bugs, fixed in this PR:**
     - **The batch plan.** It re-drew every batch from the active rows, so the exclusion would have
       reshuffled batches 1 and 3, which were already written. It now plans over the design's original
       slots. A replacement takes its slot's batch and cue budget, and its row does not say what it
       replaces, because only a tuning anchor is ever replaced.
     - **`checkSplit`.** It rejected any split that listed an excluded anchor. That contradicted
       `splitFilter`, which lets a later replacement inherit its predecessor's split, and the split
       is never rewritten (D13). It now rejects only an excluded **held-out** anchor, or a replacement
       listed on the other side from its predecessor. One older test asserted the broad rule and was
       updated to the narrow one, with a comment saying why.
   - Brief: a batch-3 lesson was added (one context factor that decides the plan reads as d3 4–5;
     format steering reads as d7 4–5). Anchor ids were taken out of the brief's lessons, because
     naming them tells authors which anchors are tuning.
10. **Round K (2026-10-02).** The panel rated anc-102 (first write, replacing anc-027) and the
    anc-024 rewrite among 2 unchanged pilot decoys (`pilot/round-k/`).
    - The anc-024 rewrite reads +9 and stays.
    - anc-102 reads +22, so it uses its one rewrite (§7.4).
    - Decoys: anc-020 +1, anc-012 −1.
    - **This row has now missed three times, the same way.** anc-027 first write +18, its rewrite +19,
      anc-102 +22. Each time d2 = 1 was read as 4. Both raters quote the same thing as reasoning: an
      appraisal of the tutor's claim that ends in the decision (the low-score rule "has no source"
      and does not cover this patient, then "Admit").
    - Under this rubric, a patient-specific appraisal (d5 = 5) that context turns into the plan
      (d3 = 5) **is** a justified decision. So `[3,1,5,3,5,4,4]` may not be writable at all.
    - A second reading cannot be ruled out with a Claude-only panel: the panel may itself be the
      scorer that stamps one impression on all seven domains, which is what dissociated anchors exist
      to catch (`profile: dissociated`). If so, the panel rule filters out exactly the dissociated
      anchors that Claude cannot read, and fits the cohort to Claude's halo. Only a non-Claude or
      human rater can tell the two readings apart. It is recorded as an open item next to item 2's.
11. **Stop rule for a row that cannot be written (amendment, 2026-10-02).** This was decided after
    round K and **before anc-102's rewrite was rated**. §7.4 had no stop: a row whose replacement also
    fails would be replaced again from the same row, indefinitely.
    - From now on, when a **replacement** anchor fails its rewrite (the fourth text on one design row
      beyond ±15 on its deciding round), the row is declared **not writable under this rubric and
      panel**. It is excluded and not replaced from the same row.
    - The cohort then stands one anchor short in that row's cell. The deficit is reported with the
      known-groups result and is never filled by an ad-hoc new row.
    - The rule applies to every row, held-out never included (held-out anchors are never rated before
      the lock, §9). anc-102 is the first row it can reach.
    - It changes nothing about the threshold (±15) or the one-rewrite allowance.
    - In code: a `REPLACEMENTS` entry with `replaced_by: null` excludes the row without consuming an
      id. The batch plan drops that slot and moves nothing else.
12. **Round L (2026-10-02).** The anc-102 rewrite reads **+4** and stays, so the item-11 stop rule
    was not reached. Sonnet 68, Opus 76.
    - What changed: every decision now comes before its grounds ("Admitting him." first). The
      appraisal is a separate note that labels each claim's evidence status and concludes nothing.
      Context appears only as constraints on the orders, never as a reason for the decision.
    - d2 still reads 3 against a target of 1, so the dissociation is only partly visible to this panel.
      The item-10 open question (an unworkable row, or the panel's own halo) stays open.
    - Decoys: anc-016 +11 and anc-007 +6, inside their earlier range.
13. **Length targets (2026-10-02).** At n = 40 the length cue reached r = 0.40, 95% CI 0.10–0.63,
    with every author inside their bin. Inside the short bin r was 0.95: authors wrote longer as the
    target rose.
    - Every row now carries an exact `length_chars`, drawn inside its bin and independently of its
      targets. Intake enforces it to ±125.
    - Batches 1 and 3 were accepted before the rule (`LENGTH_TARGET_EXEMPT_BATCHES`). Their rows are
      held to the bin only, because their held-out anchors are locked and their tuning anchors have
      used their rewrites.
    - anc-102 and the anc-024 rewrite went through intake after the rule and met their targets.
14. **Batches 6–7 panel (2026-10-02).** The panel rated the 6 tuning anchors (first write) among 2
    unchanged pilot decoys (`pilot/batch-6-7/`).
    - anc-030 +3, anc-039 −4, anc-051 −4, anc-086 +3 and anc-093 +11 stay.
    - anc-082 is +19 and uses its one rewrite. d2 (target 3) read 5; d3, d4 and d7 read about a
      level high.
    - Mean Δ +4.5, against +13.5 for batch 1 and +9 for batch 3's first writes: the brief lessons are
      landing.
    - Decoys: anc-017 −1. anc-013 +15, inside its earlier range (its composite has read high since
      the pilot).
    - **Finding, not a rule change: the panel lifts a LOW dissociated domain.** On the latest
      rating of every dissociated anchor rated so far, the dissociated domain reads as follows:
      - Targeted **low** beside high ones: read **+1.6 levels** on average, with 10 of 11 lifted by
        1–3 levels. For anc-013, d2 = 1 has been read 3–4 by every rater in every round since the
        pilot.
      - Targeted **high** beside low ones: read about right, −0.4 (n = 5).
    - One domain at 15–20% weight lifted by 1.6 levels moves the composite only about 5 points, so the
      ±15 rule never sees it.
    - A Claude panel cannot tell whether the authors fail to write the absence or the raters read
      the high domains into the low one (item 10). Either way, **the panel does not confirm the
      low side of dissociated anchors.** Per-domain known-groups results for those domains rest on
      the design targets alone until human raters adjudicate them.
    - No domain-level rewrite trigger was added. One chosen after seeing these numbers would be a
      post-hoc rule, and it would fit the cohort further to Claude's reading.
15. **Round N (2026-10-02).** The anc-082 rewrite reads **+18** (first write +19). Under §7.4 it is
    **excluded and replaced** by anc-103, from the same row and slot. Its text is archived at
    `fixtures/excluded/anc-082.json`, with the sha256 in REPLACEMENTS.
    - This is the row's first exclusion, so the item-11 stop rule does not apply. It would apply only
      if anc-103 also fails its rewrite.
    - The rewrite barely moved, in the same domains: d2 3 read 4–5, d4 2 read 3–4, d7 3 read 5.
    - Decoys: anc-018 +13 and anc-003 +9, inside their earlier range.
    - The batch plan changed only by the anc-082 → anc-103 swap.
16. **Round O (2026-10-02).** anc-103's first write (replacing anc-082) reads **+6** and stays.
    - It was written to the brief's newer lessons (a decision with one reason and no ranking for
      d2 = 3; generic follow-ups for d4 = 2; context taken unshaped for d7 = 3).
    - Decoys: anc-014 −4 and anc-010 +7.
    - **No panel rewrite is outstanding for batches 1, 3, 6 and 7.**
17. **Batches 2–5 panel (2026-10-02).** The panel rated the 4 tuning anchors (first write) among 2
    unchanged pilot decoys (`pilot/batch-2-5/`).
    - All four stay: anc-035 +6, anc-042 +1, anc-092 +2, anc-099 −12. Mean Δ −1.0.
    - anc-099 is the cohort's first clear undershoot. It is a single anchor inside ±15, so no lesson
      was added.
    - **Drift on identical text is now as large as the decision line.** The decoys anc-019 and
      anc-006 read +24 and +16, against +9.5 and +2 in round 2 on the same bytes. The panel mean
      moved +14.5 and +13.5, and one rater moved 44 → 64.
      - Earlier rounds put this drift at up to ±10 (item 7).
      - A single-round verdict within about ±15 of the line is not distinguishable from noise for
        this panel.
      - One untested explanation is a packet-contrast effect: this packet's other anchors were
        mostly low-target. Decoys are rated beside different company each round.
      - Re-ratings stay stability checks and never trigger a rewrite (item 6). The deciding-round
        rule is unchanged.
      - The noise is reported so that the cohort's panel numbers are not read more precisely than
        they are.
18. **Batches 4–8 panel (2026-10-02).** The cohort is complete: 100 fixtures, and the held-out lock
    covers 60 of 60. The panel rated the last 2 tuning anchors (first write) among 2 unchanged pilot
    decoys (`pilot/batch-4-8/`).
    - anc-057 reads +13 and stays.
    - anc-052 reads +16.0 (Sonnet 96, Opus 100) and uses its one rewrite. It is near the line that
      item 17 says this panel cannot resolve, but the rule is applied as written.
    - Decoys: anc-016 +14, anc-020 +3.
19. **Round S (2026-10-02).** The anc-052 rewrite reads **+11.5** and stays. Decoys: anc-007 +6,
    anc-008 −10.
    - **The tuning screen is complete.** 40 tuning anchors were each screened by the two-model panel
      on their current text, and none is outstanding.
    - Exclusions: anc-015 (pilot), anc-027 and anc-082, replaced by anc-101, anc-102 and anc-103.
      The item-11 stop rule was never reached.
    - Held-out: 60 of 60 locked and not yet rated by anyone.
20. **Held-out scored, once (2026-10-02).** The user said go. Scoring used the current evaluator
    prompt, with no d4 change. Every rating used the locked bytes (sha256 verified against
    HELDOUT-LOCK.json). The evidence is screening-synthetic, not a decisive gate.
    - **Blind panel** (`pilot/heldout/`): Sonnet and Opus, 6 shuffled packets of 10, no ids, no
      targets.
      - Panel mean vs target: ICC(A,1) **0.902 [0.654, 0.959]**, Spearman 0.94, bias +7.1. 13 of 60
        are beyond ±15.
      - Sonnet vs Opus: 0.961.
      - Low dissociated domains were lifted in **14 of 14** cases (mean +2.0 levels); high ones read
        correctly (−0.5). This confirms item 14 on held-out data.
    - **Local evaluator** (DeepSeek `deepseek-v4-flash-dspark`, `pis7-prompt-59561c29+local-c5ffe572aa81`,
      temperature 0, K = 3; `runs/heldout-local-2026-10-02-*.json`):
      - The first invocation stopped at the 2-hour tool limit after 120 of 180 evaluations (runs 1–2;
        the report is written after every run, so none was lost).
      - Run 3 was scored by a second invocation and merged, relabelled run 3. Model, prompt,
        rubric, decoding and contract were checked identical. 180 of 180 scored, 0 errors.
    - **Pre-registered known-groups result** (`runs/heldout-local-2026-10-02-known-groups.json`):
      - DeepSeek vs target: ICC(A,1) **0.587 [0.122, 0.796]**, below target. Spearman 0.787,
        bias **+13.3**.
      - 27 of 60 are beyond ±15 (45%).
      - Per domain, Spearman runs from 0.49 (d7) to 0.88 (d6).
      - Under §7.5 these are results only. The §7.6 "EXCEEDED" line in the tool output concerns a
        tuning rewrite round and does not apply: held-out anchors are never rewritten.
    - **Compressed scale.** DeepSeek's composites span 29–91 (SD 16.1), against target 16–93 (SD 23.5)
      and panel 17–100 (SD 27.3).
      - It over-scores low anchors: +25.4 on targets below 40, +14.2 on 40–69.
      - It is about right on high anchors: −2.4 on 70 and above.
      - Many composites sit at 75–80 (all 4s).
    - **DeepSeek vs the Claude panel** (screening D18 analogue, held-out):
      - ICC(A,1) **0.708 [0.533, 0.821]** with the mean of 3; 0.744 [0.601, 0.840] with run 1 alone.
        Bias +6.3.
      - The lower bound is below 0.75, so this does not pass a D18-style screen.
    - **Test–retest** (DeepSeek run 1 vs run 2): ICC(A,1) 0.907 [0.824, 0.948]. Median composite
      range across the 3 runs is 3, maximum 20. The evaluator is consistent with itself; the
      shortfall is calibration (compression and low-end lift), not noise.
    - **Reading.** The anchors read roughly as designed to Claude (0.90), which is circular: Claude
      wrote them. The local evaluator ranks anchors reasonably (ρ 0.79) but compresses the scale.
      As a scorer it does not yet match either reference. The held-out set is now spent for this
      prompt: a re-calibrated prompt (for example a d4/low-end fix) needs fresh anchors or human
      raters to be judged.

21. **Plan 2.6 pre-registration: local low-end fix, tuning only (written 2026-10-02, before the
    tuning split was scored by DeepSeek as a whole).** Not fully blind: the 20 pilot anchors were
    scored with the shipping addendum in `runs/pilot-local-strict-2026-10-02.json`, and several were
    rewritten since. The rules below were not tuned on that run. Item 20 showed compression, not noise: DeepSeek
    over-scores low anchors by about +25 and is about right at the top. This loop changes only
    `PIS7_LOCAL_ADDENDUM` (`rimpl/src/lib/prompts.js`). The cloud prompt and the rubric mirror stay as
    they are.
    - **Data.** The 40 tuning anchors only (10 below a target of 40, 15 at 40–69, 15 at 70 and
      above). K = 3, temperature 0, scored with `score-local.mjs --split tuning`. Held-out is never
      scored again in this loop.
    - **Baseline.** The shipping addendum (`+local-c5ffe572aa81`) on tuning, scored first.
    - **Variants.** At most **3** addendum variants, each scored once on the same 40 anchors. A
      variant must be justified from the rubric (§5), never by naming an anchor or a score.
    - **Adoption rule.** A variant may replace the baseline only if **all** of these hold against
      the baseline run:
      1. low band (target below 40): |mean bias| falls by **at least 10** points;
      2. composite ICC(A,1) vs target: the point estimate is higher;
      3. high band (target 70 and above): |mean bias| is **7 or less**;
      4. composite Spearman: drops by **no more than 0.05**;
      5. test–retest (run 1 vs run 2) ICC(A,1) is **0.85 or more**, and no run fails to parse.
    - If more than one variant passes, the highest ICC(A,1) wins. If none passes, the baseline stays
      and the result is reported as a null.
    - **What a pass means.** The variant is selected on the same 40 anchors it is measured on, so its
      tuning numbers are optimistic. They are screening-synthetic and **are not validation**. A
      selected prompt is judged only by the SANDBOX human auditors (plan 2.7) or by fresh anchors.
      Nothing ships to production on this loop alone.

## 8. Pipeline and commands

| step | command | network |
|------|---------|---------|
| design matrix | `node scripts/calibration/anchors/design.mjs` (`--check` to verify + print coverage) | none |
| validate + manifest | `node scripts/calibration/anchors/validate.mjs` (`--check` to verify without writing) | none |
| tests (CI) | `npm run test:calibration` | none |
| held-out split (once, done) | `node scripts/calibration/anchors/anchor-split.mjs --reserve --seed 20261005 --held-out 60` (refuses to overwrite) | none |
| batch plan | `node scripts/calibration/anchors/batch-plan.mjs` (`--check` to verify; prints the simulated cue-gate failure rate) | none |
| author brief | `node scripts/calibration/anchors/author-brief.mjs` (`--check` to verify it matches AUTHORING / validate / cues / citations) | none |
| batch intake | `node scripts/calibration/anchors/validate.mjs --batch N` or `--only anc-0NN,anc-0MM` (writes nothing; exit 1 = return to authors) | none |
| accept a batch | `node scripts/calibration/anchors/validate.mjs --record-batch N [--confirm-extra-review anc-0NN]`, then `validate.mjs` (no flags) to write the manifest and lock its held-out fixtures | none |
| coordinator report | `node scripts/calibration/anchors/anchor-split.mjs --report` (per-cell counts, run order, extra-review rows, lock progress; needs the split) | none |
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
   characters per composite point (the pilot's habit), it fails 96%
   (`batch-plan.mjs --drift 5` reproduces both). Budgets are therefore checked at intake. Rows with
   d4 ≤ 1 and d5 ≥ 4 are flagged `extra_review` (a design property, the same for every split). They
   are written last in their batch and read by the coordinator before intake.
   Every tutor turn is written to the **pinned** tutor prompts (`tutor-prompt-pin.json`, natural
   `chat-prompt-d63340e1`, examiner `chat-prompt-c6efcfc6`, taken from master before authoring). The
   pin holds even if production's tutor prompt changes mid-cohort (e.g. PR #123): a tutor-style change
   between batches would be a new surface cue.
3. **Write.** One author per row writes `fixtures/anc-NNN.json` and, only if it planted or left
   unqualified a tutor claim, `planted/anc-NNN.json` (sidecars, so parallel authors never edit one
   shared file). `validate.mjs` reads `planted-claims.json` and every sidecar.
4. **Intake.** `validate.mjs --batch N` checks, for that batch only:
   - every per-fixture rule;
   - the cue budgets — a deviation is an error here and a warning in the full run;
   - the planted-claim entries;
   - the batch's contribution to the cohort cue gate, with the fixtures that push a pair most.

   It writes nothing. Exit 1 means the batch goes back to its authors.
5. **Record and lock.** Once a batch passes intake, the coordinator runs
   `validate.mjs --record-batch N` after reading its extra-review rows, adding
   `--confirm-extra-review <id>` for each. That repeats the intake and logs the accepted bytes in
   `intake-log.json`. Then `validate.mjs` with no flags writes `manifest.json` and locks the batch's
   held-out fixtures (`HELDOUT-LOCK.json`, §7.5). A held-out fixture that never passed intake cannot
   be locked, and blocks the write.
6. **Order.** Batches run in descending order of how many **tuning** anchors they hold, so tuning
   feedback arrives early. The order is coordinator-only: `anchor-split.mjs --report` prints it, along
   with the extra-review rows.
7. **Screen TUNING anchors only, by the blind panel only.** Until every held-out anchor is authored and
   locked, the only scores that exist are blind-panel ratings of tuning anchors.
   - **No rater scores a held-out anchor before all 60 are locked:** not the blind panel, not the local
     evaluator, not Claude in any role. Nobody reads such a score either. `score-local.mjs` refuses
     any held-out id until the lock is complete, and then accepts only the locked bytes.
     `known-groups.mjs` refuses a scores file that holds a held-out id before then.
     `scripts/probe/json-contract.mjs --fixtures <dir>` refuses anchor fixtures (matched by ple_id or
     file name) the same way. `anchor-split.mjs --check-scorable <ids>` is the gate for anything built
     by hand. There is no panel-packet builder in the repo, so whoever builds a panel packet must run
     that check on its ids first. Packets are committed under `pilot/<name>/`. While the lock is
     incomplete, a test scans every committed JSON, TXT, MD and CSV file under the anchors folder,
     apart from the design-level records, and fails on any held-out id.
   - **Lessons come ONLY from blind-panel ratings of tuning anchors.** Not from the local evaluator:
     it is the evaluator under test, and learning from it calibrates the cohort to it. Not from
     anything held-out.
   - After a batch's tuning anchors are screened, any **general** lesson (a level authors keep
     overshooting, a cue authors keep missing) goes into `AUTHORING.md` / `AUTHOR-BRIEF.md` as
     authoring guidance before the next batch is written. A lesson is **never** applied as a rewrite of
     a particular anchor outside §7.4, and held-out anchors already written are not touched. Every
     brief change is a commit, so it is on record which batches were written under which brief.
   - Tuning anchors then follow the §7 amendment (one panel-driven rewrite, then exclude and replace).
8. **Score held-out, once.** When the lock covers all 60, held-out anchors are scored — panel and
   evaluator — on their locked bytes. Their flags are results, never rewrite triggers.

**Author isolation.** Authors work in a plain export of the repository, never a git clone. The export
leaves out `SPLIT-anchors.json`, `HELDOUT-LOCK.json` and git history, because the history contains
the split and the commit messages that record it. Everything an author needs — `AUTHOR-BRIEF.md`,
their row of `batches.json`, the scripts, `fixtures/` for the examples — is split-blind; a test checks
the brief and the plan. In a checkout without the split, `validate.mjs --only` simply skips the lock.

What had to change in the tooling for 100 fixtures:
- `known-groups.mjs` refused `--pilot` once the split existed. `--pilot` now implies `--split tuning`.
- `score-local.mjs` takes `--split`, and refuses held-out ids until the lock is complete.
- Held-out bytes are locked at intake (`HELDOUT-LOCK.json`), not at first scoring.
- Parallel authors write planted-claim sidecars instead of one shared file.
- A §7.4 replacement inherits its excluded anchor's split.
- With the pilot freeze lapsed, every pilot pair counts. The budgets above are what keeps the cohort
  inside the gate.
