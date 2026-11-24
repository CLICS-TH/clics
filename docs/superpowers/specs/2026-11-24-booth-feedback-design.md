# Booth feedback survey: design

Status: design approved in conversation with the owner, 2026-11-24. Visual reference: `design/booth-feedback-mockup-v2.html` (untracked; open it in a browser, every control works and nothing is sent).

Build from `origin/master`: the Booth Mode admin page, the plays export and ADR 0014 arrived in PR #525 and are missing from older branches.

## Intent

After a visitor finishes a Booth Mode play at the National Forum on CME, the owner wants them to answer a short survey. The goal is **to improve CLICS**. The survey is not research on the visitor and is not scored. It asks how the play felt: whether it was easy, whether the case felt real, and whether the score felt fair. It also asks what the experience felt *like*: an exam, a real diagnosis, a ward round, a game.

Because the survey is for improving the product, the owner agreed that it is **anonymous and separate from the play record**. No answer can be traced back to a player tag, a play, or a person.

## Goals

- Every visitor who reaches the score screen can open the survey on their own phone in one step.
- Answering takes about one minute and works by touch: face pickers, chips, and draggable sliders with a face that reacts as it moves.
- The answers live inside CLICS: our own table, read on the Booth Mode admin page and exported from there.
- The survey's look matches the booth: CLICS's own drawn faces and line icons, the booth tokens, Thai first.

## Non-goals

- Linking a survey answer to a play, a tag, a score, or a time of play.
- Any change to scoring, the leaderboard, the play record (`booth_plays`), or the internal export of plays (ADR 0014).
- A general survey builder. The questions are fixed in code, and a new question set is a new form version.
- Using the survey on the pilot side (physicians and PLEs).

## Anti-goals

These would make the feature a failure even if it worked:

- A second QR sitting on the score screen next to "Keep your result", where visitors scan the wrong one.
- A free-text comment stored with a name or a patient detail in it.
- Stored data that lets someone match a survey answer to a play. The owner's digital-twin export must not become a way to put a name to a survey answer.
- A slider whose untouched starting value is counted as an answer, which would skew the data toward the middle.
- System emoji, which look different on iPhone, Android and the kiosk, and which screen readers read out by name.

## Constraints

- **Data boundary (CLAUDE.md rule 1):** free text goes through rimpl's PII filter before the backend stores it, the same rule a play's typed answer follows (ADR 0010). rimpl already has `POST /deidentify` (no AI call, fails closed; `rimpl/src/routes/deidentify.js`). The backend reaches it through `rimplDeidentify` (`backend/src/services/rimpl-client.js`).
- **Booth sits outside the pilot data model (ADR 0004):** no professionals, PLE rows, or councils. The feedback table belongs to the booth, keyed by event code.
- **Rehearsal and the forum share one event code:** rehearsal answers land in the same event as forum answers. `scripts/booth/purge-event.mjs` must clear feedback with the event, and the admin page should make rehearsal answers easy to recognise (by date).
- **Kiosk idle policy (`booth-idle.js`):** the scored screen resets 45 s after the last touch, or 180 s after it appeared. Scanning a QR involves no touch on the kiosk, so 45 s is the window a visitor has to scan once the pop-up is open.
- **Readability:** Thai body text at least 15.36 px, WCAG AA contrast, and checks at 320–430 px on the phone and at 1080×1920 and 2160×3840 on the kiosk.
- **Migrations:** only the owner applies a migration to prod. The table must exist before the backend that writes to it is deployed.
- **Deploys:** prod deploys need the owner's approval each time. Before the vm1 cutover, the Portal deploys to Vercel only through the pre-#429 overlay recipe (memory: clics-deployment).
- **Public repo:** nothing secret goes in the form or its config.

## Approaches considered

**Where the survey is offered** (the owner picked the second):

1. **Reuse the existing "Keep your result" QR** and add a survey button to the phone result page. No new QR and no clutter. But visitors who don't scan never see the survey.
2. **A "Give feedback" button on the score screen that opens a pop-up with the survey QR** (picked). At rest the screen shows one QR, so nobody scans the wrong one, and every visitor sees the button. It follows the pattern of the existing leaderboard pop-up.
3. **A QR on the final screen after Done**, next to the Workshop QR. The score screen doesn't change, but visitors are already walking away, and that screen already has a QR.

**Where the form and its answers live** (the owner picked the second):

1. **Google Forms:** no backend work and the questions can change without a deploy. But the answers sit outside CLICS, and the form can't be styled to match the booth.
2. **Built into CLICS** (picked): our own page, endpoint, table and admin view. The data stays in our system and the form matches the booth's design. This means more work, a migration, and a deploy for any change to the questions.

## Design

### 1. Kiosk: button and pop-up

- On the scored screen (`physician-ui/public/js/booth-play.js`, `scored`), add a primary button **"ให้ความเห็น / Give feedback"** with the `message` line icon in `.result-side`, below "Keep your result" and the answers button.
- Tapping it opens a modal overlay. It follows the leaderboard overlay's pattern (`booth-board.js`: `role="dialog"`, `aria-modal`, focus moved into it and returned on close, a Close button, and a tap on the backdrop closes it). The overlay contains:
  - the title **"ช่วยเราปรับปรุง CLICS"** with **"Help us improve CLICS"** under it;
  - the survey QR, drawn on the kiosk with the vendored encoder (`qrSvg`), so nothing leaves the kiosk;
  - two tags: clock icon **"1 นาที"** and lock icon **"ไม่ระบุตัวตน"**;
  - the caption **"สแกนด้วยกล้องมือถือ · Scan with your phone camera"**.
- The survey QR's modules are drawn in the accent colour, unlike the black "Keep your result" QR, so the two never look alike. Check that a phone camera still reads the accent-on-white QR at kiosk size. If it doesn't, use black modules inside an accent frame.
- **QR link:** `/booth-feedback.html#c=<CASE_ID>&l=<LOOK>`. The kiosk does not know the event code, and the backend takes the open event anyway. It never carries the tag or the play id. The fragment form keeps the values out of server access logs, as the result link does.
- **Copy** goes in `booth-copy.js`.
- **Switch:** the button shows only when `window.CLICS_BOOTH_FEEDBACK === true` in `js/config.js`, modelled on `CLICS_BOOTH_LANDING_QR`. The Portal can then ship before the table and backend are live.
- **Idle:** opening and closing the overlay are touches, which restart the 45 s linger. A reset reloads the page, which removes the overlay.

### 2. Phone result page

The phone result page (`booth-result.js`) gets a card next to the Workshop card: **"ช่วยประเมิน CLICS (1 นาที)"**, linking to the same form.

The link carries the case id and look, like the kiosk's QR, and the backend takes the open event. The same `CLICS_BOOTH_FEEDBACK` switch hides the card.

### 3. The form page

New files: `physician-ui/public/booth-feedback.html`, `js/booth-feedback.js`, `css/booth-feedback.css`, and `js/booth-faces.js` (the drawn faces).

- It is a static page with no sign-in, served by the Portal. It loads only same-origin files and fonts, under the same CSP stance as `booth-result.html`.
- **Layout:** one scrolling column, max 560 px, laid out as in mockup v2:
  - a header with "ตอบแล้ว n จาก 7 ข้อ · ไม่ระบุตัวตน" and a progress bar;
  - one card per question;
  - a privacy note;
  - the submit button;
  - a thank-you screen.
- **Language:** Thai is the main line and English the secondary line on every question. The `l=` look from the fragment may choose the emphasis, the same way the result page does; that is the builder's call.
- **Submit** is enabled once the seven required questions are answered. The comment is optional.
- **Closed booth:** on load the page asks `GET /booth/feedback` (`{ open }`). It does not use `/booth/status`: that call counts toward the kiosk's per-IP general budget, and the visitors' phones share the forum Wi-Fi's IP with the kiosk. When the booth is not open, it shows only "บูทปิดรับแบบประเมินแล้ว ขอบคุณที่ร่วมเล่น" with no questions. A `closed` reply on submit shows the same message; the answers are not kept.
- **After a successful submit,** the page shows the thank-you screen and stores a flag in `sessionStorage`, so a reload doesn't invite a second answer. This is a soft guard, not a security control.

**The questions** (form version `fb-1`):

| id | Question (TH / EN) | Input | Stored value |
|---|---|---|---|
| `role` | คุณคือ / You are | single chip: แพทย์, แพทย์ประจำบ้าน, นักศึกษาแพทย์, อื่น ๆ | `physician` \| `resident` \| `student` \| `other` |
| `mood` | ระหว่างเล่น คุณรู้สึกอย่างไร / How did you feel while playing? | pick one of five drawn faces: เครียด, งง, เฉย ๆ, สนุก, ตื่นเต้น | `stressed` \| `confused` \| `neutral` \| `enjoyed` \| `excited` |
| `felt_like` | เล่นแล้วรู้สึกเหมือน… / It felt like… (pick any) | multi chip with line icons: ทำข้อสอบ (clipboard), วินิจฉัยคนไข้จริง (stethoscope), ราวด์วอร์ดกับอาจารย์ (people), เล่นเกม (gamepad), อ่านตำรา (book), อย่างอื่น (speech bubble) | non-empty array of `exam` \| `real_patient` \| `ward_round` \| `game` \| `textbook` \| `other` |
| `easy` | เล่นง่าย เข้าใจได้ทันที / Easy to play | face slider 1–5, ends ยากมาก / ง่ายมาก | integer 1–5 |
| `real` | เคสสมจริง เหมือนเจอในงานจริง / The case felt real | face slider 1–5, ends ไม่เลย / มาก | integer 1–5 |
| `fair` | คะแนนและคำอธิบายสมเหตุสมผล / The score and feedback were fair | face slider 1–5, ends ไม่เลย / มาก | integer 1–5 |
| `use` | อยากใช้ CLICS เก็บหน่วยกิต CME แทนการนั่งฟังบรรยาย / I'd use CLICS for CME credit instead of lectures | face slider 0–10, ends 0 ไม่เลย / 10 แน่นอน | integer 0–10 |
| `comment` | อยากบอกอะไรเราเพิ่มไหม (ไม่บังคับ) / Anything else? (optional) | textarea, at most 1000 characters | de-identified text or null |

The 1–5 sliders show these labels under them: น้อยมาก, น้อย, ปานกลาง, มาก, มากที่สุด.

**Interactions** (mockup v2 is the reference):

- **Faces are our own drawings:**
  - line art on a 48-unit grid with `stroke="currentColor"` and round caps;
  - grey (`--edge`) at rest;
  - when picked: accent stroke, a light accent fill, scaled to 1.2.
  - Each face is `aria-hidden`; its button's accessible name is the Thai and English word. Chips are toggle buttons with `aria-pressed`.
- **Line icons** come from the portal's lucide set (ISC; `js/icons.js`), with `clipboard-check`, `stethoscope`, `users`, `gamepad-2`, `book-open`, `lock` and `trophy` added in the same format.
- **Sliders** are native `<input type="range">`, so they are keyboard- and screen-reader-operable:
  - Each has an `aria-valuetext` such as "มาก, 4 of 5".
  - A face above the thumb changes with the value. The mouth bends from a sad frown with raised inner brows at the low end, through a straight mouth, to a smile with cheeks and happy eyes at the high end.
  - **Unanswered state:** the thumb, face and track are grey, and "ลากเพื่อตอบ" shows until the first touch or keypress. An untouched slider sends nothing and blocks submit.
- **Motion:** only transform, colour and opacity. Everything is still under `prefers-reduced-motion`.

### 4. API

`POST /booth/feedback` goes on the existing public booth router (`backend/src/routes/booth.js`) and is handled in a new `services/booth-feedback.js`.

- **Body** (zod, strict, so unknown keys are refused):
  ```
  { form: 'fb-1', case_id?: string,
    answers: { role, mood, felt_like: string[1..6], easy: 1..5, real: 1..5, fair: 1..5, use: 0..10 },
    comment?: string (≤ 1000) }
  ```
  The schema has no field for a tag, play id, score or time, so none can be sent.
- **Event:** feedback is taken **only while the booth is open** (owner, 2026-11-24), for the open event, which the backend resolves itself. Once the booth closes, the reply is `closed` and nothing is stored, so a visitor who answers after closing time loses that answer.
- **case_id:** kept only when it names a case in that event's pool; otherwise it is stored as null rather than refused, so a stale QR still saves the answers.
- **Rate limit:** `/feedback` is left out of the router's general per-IP budget (as `/draw` is), so phones on the kiosk's Wi-Fi never use up the kiosk's budget. It gets a separate feedback limit per IP, set generously (about 30 a minute): many phones on the forum Wi-Fi share one public IP, so a tight limit would refuse real visitors. Storage is small and the soft one-answer-per-page guard covers honest repeats, so the limit only has to stop a script. A 429 keeps the answers on the page and shows "ลองอีกครั้ง". *(Designer's call; exact number is the builder's.)*
- **Comment:** trimmed, and an empty comment becomes null. A non-empty comment goes to rimpl `/deidentify` as a single message. Only the masked text is stored. The masking is the same filter a play's typed answer gets. It is known to miss some shapes (#449, #451), so every read screens the comment again (section 6), the same two-layer rule plays follow under ADR 0010 and 0014. *(Designer's call.)*
- **Fail closed:** if de-identification fails, the request answers 503 with `reason: 'comment_unavailable'` and stores nothing. The page keeps every answer and offers two buttons: "ลองอีกครั้ง" (try again) and "ส่งโดยไม่มีความเห็น" (send without the comment).
- **Reply:** `201 {}`. It echoes nothing back.
- **Logs:** never log the comment, raw or masked.

### 5. Storage

The new migration `db/migration-booth-feedback.sql` creates `public.booth_feedback`:

| column | type | note |
|---|---|---|
| `id` | uuid pk default gen_random_uuid() | |
| `event_code` | text not null | |
| `case_id` | text null | |
| `form` | text not null | `fb-1` |
| `submitted_on` | date not null default (now() at time zone 'Asia/Bangkok')::date | **date only**: no timestamp column at all, so an answer can't be matched to a play by time |
| `answers` | jsonb not null | as validated |
| `comment` | text null | de-identified |

- **Access:** RLS on with no policy, so only the service role can read or write, the same deny-all stance as `booth_plays`.
- **Index:** on `(event_code, submitted_on)`.
- **Clock:** `id` must not be a time-ordered uuid (gen_random_uuid is v4, fine). The backend must not log the request with its time on purpose (no `console.log` of a submit).
- **Scope of "anonymous" (owner, 2026-11-24):** what CLICS stores and shows (the table, the admin page, the export) holds nothing that matches an answer to a play (ADR 0015: no timestamp, no tag, no play id; rows are sorted by content, never in database order). Server access logs (the vm1 proxy, the backend's request logs) and the in-memory rate-limit store keep recording request times as they do for every booth request today. They are readable only by whoever runs the server and are never joined to the feedback data. The ADR states this limit; no log redaction is built.
- **Purge:** `scripts/booth/purge-event.mjs` also deletes the event's `booth_feedback` rows, then counts what is left for that event and fails if any remain, as it does for `booth_plays`. Nothing is added to the per-event stats in `migration-booth-purge.sql`.

### 6. Admin view (audit-dashboard)

On the Booth Mode page (`audit-dashboard/app/admin/booth/page.tsx`), add a **"Feedback"** section next to the leaderboard and the export. It is backed by a new superadmin read `GET /admin/booth/feedback` (and `/admin/booth/feedback.json` for the file), next to `GET /booth/export.json` in `backend/src/routes/superadmin.js`.

The section shows, for the current event:

- the number of answers, split by date, so rehearsal days stand apart;
- a filter by case;
- **roles:** counts;
- **mood:** a count per face, drawn with the same faces (a port of `booth-faces.js` to TSX, or shared SVG strings);
- **felt like:** a count per choice, as a horizontal bar per choice;
- **easy, real, fair:** a distribution bar per value, with the mean and n;
- **use:** the 0–10 distribution, with the mean;
- **comments:** a list, newest date first, each with its date and case. Comments go through the same second screen the plays export uses: `flaggedForAuditor(content)` in `backend/src/services/booth-dialogue.js`, which returns true for a long digit run, a Thai digit, or a span under the open dataset's rules. A flagged comment shows as `withheld: "flagged"`, never its text, and `counts` says how many were withheld.
- An **export button** that downloads `booth-feedback-<EVENT>.json`, holding the rows as stored (comments screened the same way) and a `counts` block, and writes an audit-log row `booth.feedback_export` through `logEventStrict`, as the plays export does. A failed audit write sends nothing, the same rule as `booth.export`.

Charts take their colours from `lib/chart-colors.ts`. Superadmin only, like the rest of the page.

### 7. ADR

Add the next free ADR, expected to be 0015: "Booth visitors can leave anonymous feedback, kept apart from their play". It records:

- why the survey is anonymous;
- no tag, no play id, no timestamp (date only);
- a comment is de-identified in rimpl before storage and screened again on read;
- the event purge covers it;
- the scope of "anonymous": the stored and shown data, not the server's access logs;
- the case id is kept because it tells which case felt unreal. On a quiet rehearsal day, case plus date could narrow an answer to one or two plays. The ADR accepts this, since the answers are about the product and stay internal.

### 8. Rollout order

1. The owner applies `migration-booth-feedback.sql`.
2. Backend deploy (route, service, admin read, purge script).
3. Dashboard deploy (pre-cutover recipe).
4. Portal deploy, with `CLICS_BOOTH_FEEDBACK` still `false`.
5. Smoke test without spending: submit one test answer through the form against a non-prod backend, or against prod with a test event if the owner allows. The booth never needs an AI call for this, since `/deidentify` makes none. Then delete it with the purge tool, or leave it marked by its date.
6. Flip `CLICS_BOOTH_FEEDBACK` to `true` and deploy the Portal.

## Tests the builder must add

- **Backend:**
  - schema refusals (unknown keys, out-of-range values, an empty `felt_like`, a tag-shaped field);
  - unknown event refused, unknown case stored as null;
  - rate limit;
  - de-identify called only for a non-empty comment, and its failure stores nothing;
  - the stored row has no time;
  - the admin read and export are superadmin only, the export writes its audit row, and a failed audit write sends nothing;
  - purge removes feedback.
- **rimpl:** none needed (no rimpl change). Run `cd rimpl && npm test` anyway if `/deidentify` is touched.
- **Portal:**
  - the form's required-answer gate, the untouched-slider state, keyboard use of sliders and chips, and the 503 retry and send-without-comment paths;
  - the responsive smoke at 320–430 px;
  - the kiosk overlay's open, close, focus and idle-reset behaviour at both kiosk sizes;
  - the switch off, which hides the button and the result-page card.
- **Dashboard:** `tsc`, `lint`, and jest for the feedback section's empty and filled states.
- **Readability:** Thai text size and contrast of every new string, including the accent QR's caption and the grey "ลากเพื่อตอบ" state.

## Left to the builder

- Exact rate-limit numbers.
- Whether the form's language emphasis follows the kiosk's look.
- The face drawings' final paths: mockup v2's are the starting point, and they may be refined as long as the five moods stay distinct at 40 px.
- How the dashboard and the form share face drawings.
- The kiosk button's exact placement inside `.result-side` at both kiosk sizes.
- Whether to add an admin-side "hide rehearsal days" filter in place of the per-date split.
