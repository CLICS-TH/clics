<!--
  Auditor manual — English.

  Section ids MUST match auditor.th.md exactly and in the same order, or the build fails.
  [[labels]] stay IDENTICAL to the Thai file: they quote what is on screen, and the product renders
  its controls bilingually, so an English reader still looks for the Thai/English pair on the button.
-->

## role | What an expert auditor does

> You are the expert who scores physicians' Professional Learning Episodes against the **PIS-7** rubric, **without seeing the score the AI gave first** — so that we can establish whether the AI scores as accurately and as fairly as an expert does.

The sequence is: a physician works through an episode with the AI → the AI scores it against PIS-7 → an administrator assigns the episode to you → **you score it blind** → on submission the AI's score is revealed and the agreement (ICC) between you and the AI is calculated.

### Principles that hold throughout

- **Score before you see the AI's score.** The AI's score is revealed only after you submit. Seeing the AI score first biases the comparison and makes the resulting ICC uninterpretable.
- **You never audit your own episode.** The system enforces this; you are only ever assigned other physicians' episodes.
- **Confidentiality.** No screenshots, no downloads, no forwarding of transcripts or scores.
- **Score the evidence in this episode, not the physician.** You are assessing what appears in this one conversation.

::: note The calibration target
The target for agreement (ICC) between AI and expert auditors is ≥ 0.75 — and that figure only means anything if auditors use enough of the scale to separate a strong episode from a weak one.
:::

## sign-in-consent | Signing in, and consent

### Signing in

1. Open the physician portal — it is the **single front door** for every role. Enter [[อีเมล / Email]] and [[รหัสผ่าน / Password]], then press [[เข้าสู่ระบบ / Login]]
2. You are taken to the auditor dashboard automatically, where you will see your home page and a summary of your work
3. Press [[~ คิวประเมิน / Queue]] in the top bar to see the episodes assigned to you

::: tip Works on a phone as well as a computer
Sign in through the same portal and the system takes you to the auditor dashboard automatically. There is no second web address to remember.
:::

### Auditor consent

The [[ความยินยอมผู้เชี่ยวชาญประเมิน / Expert Auditor Consent]] panel asks you to confirm three things:

- You will keep transcripts, scores and research data confidential — no recording, downloading or sharing
- You understand the rubric and its behavioural anchors, and will score to the same calibrated standard
- You have no conflict of interest with this participant, and will report one immediately if it arises

Then press [[ยินยอมและส่งคะแนน / Consent & submit]] — the system records your consent and submits your score together, in one action.

::: warn This panel appears on your first "submit", not when you open the page
You can score all seven domains without ever having seen it, and only then be asked to consent. Your work is not lost, but it is worth knowing it is coming. Consent is recorded once per account.
:::

## queue | Your scoring queue

The queue lists the episodes assigned to you. Each row shows the date, the number of exchanges, and a status of [[~ รอประเมิน]] or [[ให้คะแนนแล้ว]] (these two badges are in Thai only) — click a row to open it. It also opens from the keyboard.

![The auditor scoring queue](img/auditor-queue.png "The scoring queue — the episodes assigned to you, and the status of each")

The search box at the top filters the queue as you type.

::: note You see only what is assigned to you
You will only see episodes an administrator has assigned to you, and only ones the AI has already scored. If you open a row and it reports that the episode cannot be found, the assignment has been changed — contact an administrator.
:::

## scoring | Blind PIS-7 scoring

The scoring page has two sides: the **transcript** to read, and the **PIS-7 scoring** panel — [[แตะระดับ 0–5 ของแต่ละหมวด]]

### How to score

1. Read the whole transcript first
2. Tap a level from 0 to 5 in each domain. Each level carries a description of the behaviour it stands for — use that as the shared standard, not your impression
3. Record your reasoning in the notes, especially for a 0, 1, 4 or 5 — the form prompts you at those levels
4. If you wish, record the [[ความชัดเจนของ anchor / Anchor clarity]] for each domain: clear, moderate, or ambiguous
5. Tick all five confirmations, then press [[ส่งคะแนน / Submit score]]

- Nothing defaults to 0 — a domain you have not touched is shown as not yet scored
- The [[คะแนนรวม / Total]] updates live as you tap each domain

### The submit button is locked twice over

The button tells you what is missing: [[~ ให้คะแนนให้ครบทุกหมวด / Score all 7 domains]] while domains remain unscored, then [[~ ยืนยันให้ครบทุกข้อ / Confirm every item above]] while confirmations remain unticked, and only then [[ส่งคะแนน / Submit score]].

The five confirmations — which are about **this assessment**, not the one-time consent above — are:

- [[ให้คะแนน D1–D7 ครบ / Scored all seven domains]]
- [[บันทึกความเห็นที่จำเป็นแล้ว / Recorded the comments the form expects]]
- [[ให้คะแนนโดยอิสระ และไม่ได้เห็นคะแนน AI / Scored independently, without seeing the AI score]]
- [[ไม่พบข้อมูลระบุตัวบุคคล หรือแจ้งแล้ว / Found no identifying information, or reported it]]
- [[เข้าใจว่าน้ำหนักแต่ละหมวดยังเป็นค่าชั่วคราว / Understand the domain weights are provisional]]

::: warn The evidence rule for a 4 or a 5
To award a 4 or a 5 in any domain you must be able to quote a specific, case-grounded line from the physician's side of the conversation. If you cannot quote one, the score is at most 3. **Once submitted, it cannot be changed.**
:::

::: tip Use the width of the scale
If every episode receives roughly the same score, the ICC will be low no matter how carefully everyone scored — because the statistic asks whether two raters *rank* episodes the same way, and if the episodes barely differ there is nothing to rank. Use the full 0–5 range as the level descriptions actually define it.
:::

## privacy-report | If you find something that could identify a person — stop

If while reading you find anything that might identify a patient or anyone else — a name, an ID number, an HN, a hospital named alongside a date — **do not score it.** Report it instead.

1. Press [[พบข้อมูลที่อาจระบุตัวบุคคล — หยุดและแจ้งผู้วิจัย / Report a suspected identifier instead of scoring]] beneath the scoring panel
2. Fill in [[ระบุตำแหน่งและลักษณะของข้อมูล / Where in the transcript, and what kind]] — for example "turn 3 names a hospital and a date"
3. Press [[ส่งรายงาน / Send report]], or [[~ ยกเลิก / Cancel]] to go back to scoring as normal

::: warn Reporting replaces scoring; it does not accompany it
The episode is quarantined for review and leaves your queue, and **no score is recorded** — anything you had already entered is discarded. That is intended: an episode that may contain identifying information must not be used until the review concludes.
:::

::: note Do not hesitate to report
A mistaken report costs little — a privacy reviewer reads it and decides, and if there is no problem the episode returns to the queue. Failing to report something that should have been reported costs a great deal more.
:::

### What this does to the physician

Your report removes the episode from **every** auditor's queue, not just yours, and no score will be recorded by anyone.

In a round configured to release scores only after expert review, the physician who wrote it sees their result page stay at "under expert review" **indefinitely**, and the system does not tell them why.

::: warn Tell an administrator as well
Because the physician receives no notification, sending the report on its own leaves them waiting without knowing what for. Please also notify the project team, so that someone follows the review through and speaks to the physician.
:::

## after-submit | After you submit

The moment you submit, the **AI's score is revealed**, along with a radar chart, [[เทียบกับ AI รายหมวด PIS-7 / PIS-7 by domain — vs AI]], and a plain summary of where you scored above or below it.

If other auditors have scored this episode you also get [[เทียบกับค่าเฉลี่ยผู้ประเมินคนอื่น / vs Other auditors]] (or, when there is exactly one other, [[เทียบกับผู้ประเมินอีกคน / vs the other auditor]]). That average **excludes your own score**.

### Discussing the result with the AI

Below the reveal there is a conversation box. You can ask things like "why did the AI score Critical Appraisal higher than I did?" — it is a tool for calibrating your understanding, not an appeal. A submitted score cannot be changed.

::: note Auditors have their own AI budget
This conversation draws on a separate auditor budget and does not consume any physician's allowance. If you use it up, a message will tell you to contact an administrator.
:::

### Your auditor home page

Your home page summarises your work: how many are waiting, how many you have scored, how many are assigned, and **your ICC** — with a radar chart comparing your average scores against the AI's across every episode you have scored.

## rubric-faq | The PIS-7 rubric for auditors · common questions

Use this to score consistently — it is the same rubric the AI uses. The levels are: 0 absent · 1 minimal · 2 limited · 3 moderate · 4 strong · 5 outstanding.

| Domain (weight) | High quality looks like | What keeps the score low |
|---|---|---|
| Clinical Question Intelligence (15%) | Questions specific to the case, naming a real decision point | Broad questions such as "what is the differential" ≤2 |
| Reasoning Depth (20%) | Hypotheses ranked with reasons, risks and benefits weighed, position revised against contrary evidence | Merely listing diagnoses, unranked and unreasoned ≤2 |
| Contextual Integration (15%) | Age, comorbidity and context genuinely change the reasoning | Context mentioned but the decision unchanged ≤2 |
| Iterative Inquiry (15%) | Each exchange builds, deepens and tests | Starting over, or jumping between topics ≤2 |
| Critical Appraisal (15%) | Challenging the AI, asking for evidence, naming uncertainty | Accepting everything unchecked ≤1 |
| Reflective Synthesis (10%) | A usable lesson in the physician's own words | A vague closing such as "very useful" ≤1 |
| AI Literacy & Prompt Skill (10%) | Clear prompts, answers checked, final plan owned | Vague prompts, answers copied without judgement |

### I have submitted a score and want to change it

You cannot. Once submitted, the score becomes part of the research record and cannot be changed. If you believe you made a significant error, contact the project team — do not try to compensate by scoring another episode the other way.

### An episode has disappeared from my queue

Either you submitted a score for it, or it has been quarantined for privacy review — by you or by another auditor. If you think that is wrong, contact an administrator.

### Do I have to read the whole transcript

Yes — read all of it. Several domains, Iterative Inquiry and Reflective Synthesis in particular, can only be judged across the whole conversation, not from any single exchange.

### Contact

If you run into a problem or need help, please contact the CLICS pilot team.
