<!--
  Physician manual — English.

  Section ids MUST match physician.th.md exactly and in the same order; the build fails otherwise,
  because the language toggle keys on them and a reordered translation lands the reader in the wrong
  place.

  [[labels]] stay IDENTICAL to the Thai file. They are quotations of what is on screen, and the
  product renders every control bilingually — so an English reader looking for the button still sees
  "จบและส่ง / End" on it. Translating the quotation would break the one thing it is for.
-->

## what-is-clics | What CLICS is — and what you get from it

> CLICS lets you practise clinical reasoning by talking through a case with an AI assistant. It then assesses the quality of that reasoning against a standard rubric, **PIS-7** (seven domains), The pilot is testing whether this can replace collecting CME/CPD credit by attending lectures.

Each conversation is a **Continuous Learning Episode (CLE)**. You bring a hypothetical case — never a real, identifiable patient — and work through it with the AI: forming questions, testing hypotheses, and drawing conclusions.

::: note What you get
A PIS-7 score (0–100) for each episode · a chart of your progress · a learning band (not yet CME credit at this stage) · and compensation for each completed episode during the pilot.
:::

::: warn The most important rule: de-identified cases only
Never type a name, an ID number, an HN, or anything else that could identify a patient. The system records the de-identified case content and your reasoning, for assessment.
:::

### The whole thing, in eight steps

1. Sign in and give consent
2. Verify your professional identity
3. Start a new CLE
4. Talk it through with the AI
5. End and submit
6. Record your reflection
7. Read your PIS-7 result
8. Track your progress and receive compensation

Each step is covered in detail below, quoting the actual button text you will see.

## first-login | Signing in for the first time

Open the physician portal. You will land on the sign-in page, which is the **single front door** for the whole system — administrators and expert auditors sign in here too.

![The CLICS sign-in page](img/login.png "The real sign-in screen of the physician portal")

### How to sign in

1. **Email and password** — fill in [[อีเมล / Email]] and [[รหัสผ่าน / Password]], then press [[เข้าสู่ระบบ / Login]]. The eye icon shows what you have typed.
2. **A Google account** — press [[เข้าสู่ระบบด้วย Google / Sign in with Google]].
3. **Forgotten password** — press [[~ ลืมรหัสผ่าน? / Forgot password?]], enter your email, and a reset link will be sent to you.
4. **An invitation** — if an administrator sent you an invite link, open it, set your name and a password, then confirm the 6-digit code emailed to you.

![The consent panel shown on your first visit](img/consent.png "The consent panel — all four boxes must be ticked before you can begin")

::: note There is no email sign-up
There are exactly two ways in: sign yourself up with a Google account, or use an invite link from an administrator. If you have neither, contact the project team.
:::

### Registering your professional details (first Google sign-up only)

1. Choose your [[สภาวิชาชีพ / Professional council]]
2. Medical Council only: choose your [[ระดับการฝึกอบรมสูงสุด / Highest medical training level]] — extern, intern, resident, fellow, or staff
3. Choose your [[ความเชี่ยวชาญ / Specialty]] (the field is searchable)
4. Press [[ดำเนินการต่อ / Continue]] — you will be taken straight to your home page

### Giving consent

The first time you sign in, a panel appears headed **"ก่อนเริ่ม มีสามเรื่องที่อยากให้มั่นใจ"** (three things to be clear on before you start). Read it and tick all four boxes before you can begin:

- Participation is voluntary and you may withdraw at any time
- You will not enter anything that identifies a patient
- You understand the scores are research data and are not used for licensing decisions
- You agree that AI and expert auditors may assess de-identified versions of your episodes

The accept button only becomes active once all four are ticked. This panel cannot be skipped — without consent the system will not let you start an episode.

::: note Why this is here
For transparency: during the pilot, scores are **research data** used to calibrate the instrument. They do not yet count as formal credit.
:::

## identity | Verifying your professional identity

The research protocol requires your identity to be verified before your first episode, using your national ID together with your medical licence number. Press [[~ ยืนยันตัวตน / Identity]] in the top bar.

1. Enter your [[เลขประจำตัวประชาชน / National ID (13 digits)]] — the number is checked for validity as you type
2. Enter your [[เลขที่ใบอนุญาตประกอบวิชาชีพเวชกรรม / Medical licence number]]
3. Press [[ส่งเพื่อตรวจสอบ / Submit for review]]

![The identity verification page](img/identity.png "The identity page — your national ID and your licence number")

Your status will then be one of three: **pending review**, **verified**, or **rejected** with a reason. If it is rejected, correct what the reason names and submit again.

::: note This is encrypted and never sent to the AI
Your national ID is encrypted, stored separately from the research data, never sent to AI, and never displayed again — administrators see only the last four digits.
:::

::: warn If you cannot start an episode, check this page first
When identity verification is switched on, you cannot start a new episode until your status is verified. If pressing start produces an error message you cannot make sense of, come back and check your status here.
:::

## dashboard | Your home page

After signing in you land on your **home page**, which gathers everything in one place. The top menu holds [[~ หน้าหลัก / Home]] · [[~ ความก้าวหน้า / Progress]] · [[~ ยืนยันตัวตน / Identity]] · [[~ การรับเงิน / Payments]] · [[~ ออกจากระบบ / Logout]]

![A physician's home page](img/dashboard.png "The home page — your episodes, your folders, and the button that starts a new one")

- **AI allowance bar** — how much of your AI budget remains, as a percentage. Each participant has their own budget, for fairness.
- **Statistics** — press [[~ แสดงสถิติ / Show stats]] to see your total episodes, how many passed, and your latest score. Your choice is remembered.
- **Folders** — group your episodes into categories, rename them, and move episodes between them.
- **Your episodes** — all of them, with status (in progress / passed / failed / under review).
- **Link a Google account** — if your account is not yet linked to Google, a button offers to link it, which makes signing in easier next time.

::: warn Three things the screen does not warn you about in advance
The system does not flag these in advance, and each of them is easy to mistake for a fault.
:::

- **The study caps you at three episodes** — you find out when you try to start a fourth
- **When your AI budget runs out** you cannot start a new episode or send a message — but you can always **finish an episode already open**
- **The conversation timer only runs while the window is in front of you** — switch away for a while and it stops. That is not a fault

## run-a-cle | Working through one CLE

### Starting a new episode

1. Press [[+ เริ่ม Continuous Learning Episode ใหม่]] on your home page
2. Choose a [[~ โฟลเดอร์ / Folder]] (or leave it uncategorised)
3. Enter the [[อาการสำคัญ / Chief Complaint]] — for example "a patient presenting with chest pain". **Use a hypothetical case; never a patient's name.**
4. Press [[เริ่มการสนทนา / Start Session]] and the conversation opens

::: warn Privacy warning
The chief-complaint field and every message in the conversation must describe a case that cannot be traced to a patient.
:::

### Talking with the AI assistant

You reason through the case with the AI — asking questions, testing ideas, and responding to what it asks back. The bar at the top shows which episode this is, the elapsed time, and the number of exchanges.

![The message box in a conversation](img/guest-composer.png "The composer — captured from the real trial mode")

- **Sources** — every AI reply carries at least one citation; press it to search further
- **A question for you** — the AI will sometimes ask you something back, to push your reasoning
- **Sending a message** — type and press Enter (Shift+Enter for a new line)
- **Pausing** — press [[~ พักไว้ / Pause]] to save and return later
- **Progress** — the time, exchange and depth gauges show how close you are to the thresholds

::: tip What a good conversation looks like
Ask questions specific to the case · rank your hypotheses and say why · follow up rather than starting over · challenge the AI's answers · and close with what you have learned, in your own words.
:::

### Ending and submitting

When you are ready, press [[จบและส่ง / End]] at the top right. A summary of your engagement appears: elapsed time, number of exchanges, and length of the conversation.

Those three figures are **recorded, not a pass mark** — a short but substantial episode passes, and a long one without reasoning does not.

What decides the outcome is four qualities of the conversation, assessed at submission: **a meaningful clinical question · developing reasoning · integration of context and evidence · reflective synthesis**.

::: warn Once submitted, you cannot continue
Submitting closes the episode and sends it straight to assessment. You cannot come back, edit it, or carry on the conversation. If you are not ready, press [[~ ยังไม่จบ / Keep going]] or [[~ พักไว้ / Pause]] instead.
:::

### Recording your reflection

After submitting, you are taken to the reflection page. Take five to ten minutes over three questions: what you learned, what you are still unsure about, and how you will check or apply it.

Press [[บันทึกและส่ง / Save & submit]] or [[~ ข้ามขั้นตอนนี้ / Skip]]

::: warn "Skip" is a final submission, not a postponement
Skipping closes the episode and sends it to assessment immediately. **You cannot return and fill it in later.**

Answering is voluntary and does not affect your rights, but what you write is the evidence for the Reflective Synthesis domain (10%) — skip it and that domain has nothing to assess.
:::

::: tip Five minutes here is worth it
Short answers are enough, and the system uses what you write directly as the evidence for Reflective Synthesis.
:::

## your-result | Your result, and credit

After submission the system takes a moment, then shows your **PIS-7 result**: a total out of 100, a radar chart across the seven domains, per-domain scores with the reasoning behind them, and an expandable copy of the full conversation.

::: warn In this round, scores appear after expert review
For impartiality, your score may **not appear immediately**. The result page will show [[อยู่ระหว่างการตรวจประเมิน / Under expert review]] and will open up once **any one** auditor has submitted their score for that episode. How long depends on the auditors' queue; there is no fixed time, and there is nothing further for you to do.
:::

::: note The page stops checking after about three minutes
It refreshes itself for roughly three minutes and then stops. **If you have left it open longer than that and nothing has changed, reload the page** — it is not stuck. While a score is held, that episode also stays off your progress chart and out of "latest score" on your home page.
:::

If an episode does not meet the entry criteria it will show [[~ ไม่ผ่าน CLE / Failed]] or [[~ รอตรวจสอบ / Under Review]], together with the results of all six screening criteria.

::: note About CPD credit
During the pilot the result page shows a **band** rather than a number of credits, alongside a note that it does not yet count towards CME. That is not an error — this phase is about calibrating the instrument.
:::

## pis7 | The PIS-7 rubric, in plain terms

Your score comes from seven domains. Each is scored 0–5 and weighted into a total out of 100. The heaviest is Reasoning Depth.

| Domain | What it means | Weight |
|---|---|---|
| Clinical Question Intelligence | Questions that are specific to the case and name a real decision point | 15% |
| Reasoning Depth | Hypotheses ranked with reasons, risks and benefits weighed, position revised against contrary evidence | 20% |
| Contextual Integration | Age, comorbidity and the patient's circumstances genuinely change the decision | 15% |
| Iterative Inquiry | Each exchange builds on the last, probing more deeply and testing hypotheses | 15% |
| Critical Appraisal | Challenging the AI's answers, asking for evidence, naming what is uncertain | 15% |
| Reflective Synthesis | A usable lesson, drawn in your own words | 10% |
| AI Literacy & Prompt Skill | Clear prompts, answers checked, and the final plan owned by you as the clinician | 10% |

The levels are: 0 absent · 1 minimal · 2 limited · 3 moderate · 4 strong · 5 outstanding.

::: tip How to score better
Say how the patient's age or comorbidity changes your decision · never accept an AI answer unchecked · and close with a lesson you would actually apply, in your own words. For a 4 or a 5 in any domain, an auditor has to be able to quote a specific line from your conversation.
:::

## progress-payment | Progress and compensation

### Tracking your progress

Press [[~ ความก้าวหน้า / Progress]] to see your PIS-7 scores over time, with your latest score and the change against the one before (▲/▼).

![The progress chart](img/progress.png "The progress page — your PIS-7 score over time")

An episode still awaiting expert review does not yet appear on the chart.

### Receiving compensation

Press [[~ การรับเงิน / Payments]] to enter your bank details. You are compensated per completed episode during the pilot.

1. Enter the [[ชื่อบัญชี / Account name]]
2. Enter the [[ธนาคาร / Bank]]
3. Enter either an [[เลขที่บัญชี / Account number]] **or** a [[พร้อมเพย์ / PromptPay]] — at least one of the two
4. Press [[บันทึก / Save]]

::: note Your payment details are encrypted
They are encrypted and held inside the system only. They are never sent to AI, and project administrators see them only partially masked.
:::

## faq | Common questions · privacy · contact

### Why does it say I have reached my AI limit

Each participant has an AI budget, for fairness. If you have used yours, contact an administrator to have it reset or raised. In the meantime you can still finish an episode that is already open.

### How long does an episode have to be

There is no minimum length. Time and exchange count are recorded but decide nothing — a short episode with clear reasoning passes. What decides it is four qualities: a meaningful clinical question, developing reasoning, integration of context and evidence, and reflective synthesis.

### My score has said "under expert review" for a long time

Usually it is simply still in an auditor's queue, and waiting is the right thing to do.

There is one other case. If an auditor believes your conversation may contain something that could identify a person, they report it instead of scoring it. That episode is then **held for review** and will have no score until the review concludes. The system does not tell you this has happened.

**So if several days pass with no score, please contact the project team.**

### The timer in the conversation is not moving

Time is counted only while the window is actually in front of you, and it pauses if you are idle for more than ninety seconds. That is intended behaviour, not a fault.

### What is the acceptability questionnaire

Once you have completed at least one episode, your home page will invite you to answer a short, one-time questionnaire — about ten minutes — on how acceptable you found the system, the time it took, and how your data was handled.

Press [[ส่งแบบสอบถาม / Submit]] when you are done, or [[~ ไม่ตอบแบบสอบถาม / Decline]] at any point. It is entirely voluntary: skip any item, or decline altogether, with no effect on your rights.

### Privacy and security

- **Identifying patient information is never sent to the cloud AI** — only de-identified case content is sent
- **Scores are research data** — during the pilot they are not used for licensing or any appraisal
- **You may withdraw at any time** — participation is voluntary
- **Your conversations may be read by expert auditors** — de-identified, so their scores can be compared with the AI's

### Contact

If you run into a problem or need help, please contact the CLICS pilot team.
