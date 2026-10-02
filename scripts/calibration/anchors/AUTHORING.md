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
   hospital. Frame cases generically: `ผู้ป่วยชายอายุ 58 ปี`, `a 34-year-old woman, G2P1`,
   `รพ.ชุมชนขนาด 30 เตียง`, `a district hospital without CT`. Ages, labs and vitals are fine.
   `validate.mjs` runs `rimpl/src/services/pii-filter.js` over every turn: any change is a failure.
   That rule is stricter than privacy needs, on purpose: every scoring path runs the same filter
   (`flattenForPrompt`), so a masked span is text the evaluator never sees, and an anchor whose
   evidence was masked no longer expresses its target. The filter over-masks two things that are
   everywhere in clinical Thai, so write around them:

   | masked by production (do NOT write)                       | survives (write this instead)                         |
   |-----------------------------------------------------------|-------------------------------------------------------|
   | `อายุ 58`, `58 ปี`, `อายุ 58 ปี`, `เด็กอายุ 2 เดือน` → `[AGE-n]` | `ในวัย 50 กว่า`, `วัย 70`, `อายุมากกว่า 65`, `เด็ก 7 ขวบ`, `ผู้สูงอายุ` |
   | `a 58-year-old`, `age 58`, `age 6 weeks`                  | `in his 50s`, `over 65`, `older than 65`, `6-week-old infant`, `2 months old` |
   | `คุณ…` anywhere — `คุณคิดว่า`, `คุณหมอ`, `ขอบคุณครับ`, `ขอบพระคุณ` → `คุณ[NAME-n]` (swallows the rest of the clause) | drop the pronoun (Thai allows it), or `หมอ`, `ท่าน`; thanks as `thanks ครับ`, `ได้ความรู้มากครับ` |

   Other over-masks found while writing the pilot: `line <word>` reads as a LINE id
   (`first-line drug therapy`, `joint line tenderness` → `[LINE-n]`); write `first choice`, `ยาตัวแรก`,
   `tenderness along the joint`. `ต่างจังหวัด` and `รพ.สต.` are masked as addresses (`[ADDR-n]`);
   write `บ้านอยู่ไกล`, `สถานีอนามัยใกล้บ้าน`. `เชื่อว่า`, `เชื่อมั่น`, `ช่วงความเชื่อมั่น` become
   `[NAME-n]` (write `คิดว่า`, `95% CI`). English `ward …`, `toward …` and `ห้อง lab` become
   `[WARD-n]` (write `on the medical floor`, `lab`). `รพ.จังหวัด`, `เครือข่ายจังหวัด` → `[ADDR-n]`
   (write `รพ.แม่ข่าย`, `เครือข่ายส่งต่อ`). `คุณภาพ`, `คุณสมบัติ` hit the `คุณ` rule; `ชื่อยา X` masks X
   as a name (and the shared registry then masks X in every later turn); `อายุ 65–74` and
   `1 ปีที่ผ่านมา` hit AGE (`อายุตั้งแต่ 75 ขึ้นไป` is safe). When validate reports a hit, rephrase, and record any new
   pattern here.

   Durations in years (`เป็นเบาหวานมา 10 ปี`) can trip the age pattern too — run validate and
   rephrase (`เป็น DM มานานกว่าสิบปี`). `GA 34 wk`, `อายุครรภ์ 34 สัปดาห์`, labs and vitals are safe.
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
   publisher and year of without looking it up.
6. **Clinically correct tutor content.** The tutor is the anti-sycophantic mentor of the real prompts:
   it corrects a physician's error with evidence, it does not invent facts. Physician turns may
   contain errors — that is how low reasoning levels are expressed — but the tutor must not endorse
   them.

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
5. `node scripts/calibration/anchors/validate.mjs` — must pass. It also rewrites `manifest.json`.

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
   from the design. Rewriting toward the AI's score is circular, so a rewrite must be justified from §5
   (the behaviour was genuinely missing or ambiguous), never from the AI's number.
5. **Held-out discipline.** Before the full cohort is scored, a held-out split is reserved
   (`SPLIT-anchors.json`, seeded, same method as `scripts/probe/reserve-split.mjs`). Held-out anchors
   are **never** rewritten on the strength of an AI score; their flags are reported as results.
   **The 20 pilot anchors are tuning-only**: they are scored, read and possibly rewritten before any
   split exists, so none may ever be held out. `anchor-split.mjs` `checkSplit` rejects a split that
   holds one out, `heldOutEligible` excludes them, and `anchors.test.mjs` checks the committed
   `SPLIT-anchors.json` as soon as it exists. Once it exists, `known-groups.mjs` requires
   `--split tuning|heldout`.
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
of either.*

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
   behaviour was expressed at the wrong level — never from any evaluator's number.
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

## 8. Pipeline and commands

| step | command | network |
|------|---------|---------|
| design matrix | `node scripts/calibration/anchors/design.mjs` (`--check` to verify + print coverage) | none |
| validate + manifest | `node scripts/calibration/anchors/validate.mjs` (`--check` to verify without writing) | none |
| tests (CI) | `npm run test:calibration` | none |
| what would be sent | `node scripts/calibration/anchors/score-local.mjs --pilot --dry-run` | none |
| score (local box) | `LOCAL_AI_BASE_URL=… LOCAL_AI_MODEL=… LOCAL_AI_API_KEY=… node scripts/calibration/anchors/score-local.mjs --pilot --repeats 3 --concurrency 2 --out scripts/calibration/anchors/runs/pilot-local-<date>.json` | local box only |
| re-check a past run | `node scripts/calibration/anchors/revalidate.mjs scripts/calibration/anchors/runs/pilot-local-<date>.json` (writes `….revalidated.json`; needs rimpl deps) | none |
| analyse | `node scripts/calibration/anchors/known-groups.mjs scripts/calibration/anchors/runs/pilot-local-<date>.json --pilot [--split tuning\|heldout] --out …-known-groups.json` | none |

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
