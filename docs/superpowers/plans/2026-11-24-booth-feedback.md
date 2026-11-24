# Booth Feedback Survey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a Booth Mode play, a visitor taps "ให้ความเห็น" on the kiosk, scans a QR and answers an anonymous one-minute survey on their phone. The answers are stored in CLICS and read on the Booth Mode admin page.

**Architecture:**
- **Backend:** a new public `POST /booth/feedback` (plus `GET /booth/feedback` for the open check) on the booth router, backed by `services/booth-feedback.js`. It writes to a new deny-all table `booth_feedback` that has a date and no time. Comments are de-identified through rimpl `/deidentify` before storage, and screened again on every read.
- **Portal:** a static form page and a kiosk overlay.
- **Dashboard:** a feedback section, a superadmin read, and an audited export.

**Tech Stack:** Node/Express + zod + supertest/jest (backend), vanilla ES modules + Playwright harness (`npm run test:booth`, physician-ui), Next.js 16 + RTL/jest (audit-dashboard), Postgres via Supabase.

**Spec:** `docs/superpowers/specs/2026-11-24-booth-feedback-design.md`. Visual reference: `design/booth-feedback-mockup-v2.html` (untracked; copy its face and icon paths).

**Branch:** cut from `origin/master`, which has PR #525's Booth Mode page, its export and ADR 0014. Use a worktree: other sessions share this checkout.

## Global Constraints

- Form version `fb-1`. Comment ≤ 1000 characters. Kiosk feedback limit ≈ 30 per minute per IP. `/feedback` is outside the router's general budget.
- Feedback is accepted **only while the booth is open**. Otherwise the reply is `closed` and nothing is stored.
- **Stored columns:**
  - `id`, `event_code`, `case_id`, `form`, `submitted_on` (a Bangkok date), `answers`, `comment`.
  - **No timestamp column. No tag or play id anywhere.**
- **Comments:**
  - A comment is stored only as the text rimpl `/deidentify` returned. If de-identification fails, nothing is stored (fail closed).
  - The backend never logs a comment.
  - Every read screens a comment with `flaggedForAuditor` (`backend/src/services/booth-dialogue.js`). A flagged comment is shown as `withheld: 'flagged'`, never its text.
- **Answer values:**
  - `role` ∈ `physician|resident|student|other`
  - `mood` ∈ `stressed|confused|neutral|enjoyed|excited`
  - `felt_like` is 1–6 distinct values of `exam|real_patient|ward_round|game|textbook|other`
  - `easy`, `real`, `fair` are integers 1–5; `use` is an integer 0–10
- **Copy** is Thai-first with English second, exactly as in the spec's question table. Thai text ≥ 15.36 px on the phone, at the kiosk's floor on the kiosk. WCAG AA contrast.
- **Faces and icons** are our own SVGs (`stroke="currentColor"`, `aria-hidden`). No system emoji anywhere.
- **Kiosk switch:** the button and the result-page card show only when `window.CLICS_BOOTH_FEEDBACK === true` (default `false` in `js/config.js`).
- **Prod:** never start the backend locally against prod `.env`. Migrations are applied by the owner only. No deploy in this plan.
- **Git:** stage named paths only. Each commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Venue Wi-Fi shares one IP between the kiosk and the phones.** A burst of feedback must never throttle the kiosk's plays. Test: `/booth/feedback` calls do not reduce the general budget (Task 1).
2. **A visitor taps Submit twice, or reloads after submitting.** Expect one row per tap at most. The page disables the button while sending and shows the thank-you on reload (Task 3).
3. **The booth closes while the form is open.** Expect a `closed` notice and nothing stored, not an error page (Tasks 1 and 3).
4. **The comment holds only spaces or newlines.** Expect it to be stored as null, with no rimpl call (Task 1).
5. **The QR is drawn in the accent colour.** A phone camera must read it at kiosk size. The harness decodes the rendered QR (Task 4).

---

### Task 1: Feedback storage and the public endpoints

**Files:**
- Create: `db/migration-booth-feedback.sql`
- Create: `backend/src/services/booth-feedback.js`
- Modify: `backend/src/services/booth.js` (export `openEvent`)
- Modify: `backend/src/routes/booth.js`
- Create: `backend/tests/booth-feedback.test.js`
- Create: `backend/tests/booth-feedback-limit.test.js`
- Create: `docs/adr/0015-booth-anonymous-feedback.md`

**Interfaces:**
- Produces:
  - `FORM_VERSION = 'fb-1'`, `COMMENT_MAX_CHARS = 1000`, and `ROLES`, `MOODS`, `FELT_LIKE` (frozen arrays of the values above).
  - `FeedbackSchema`: a zod object `{ form, case_id?, answers: {role, mood, felt_like, easy, real, fair, use}, comment? }`. It is `.strict()` at both levels.
  - `feedbackOpen(now?: Date) -> Promise<{ body: { open: boolean } } | { refused: 'unavailable' }>`
  - `submitFeedback(input: unknown, now?: Date) -> Promise<{ body: {} } | { refused: 'bad_request' | 'closed' | 'unavailable' | 'comment_unavailable' }>`
  - Row written to `booth_feedback`: `{ event_code, case_id: string|null, form, submitted_on: 'YYYY-MM-DD' (Asia/Bangkok), answers, comment: string|null }`. The service sets `submitted_on`; the migration's default is a backstop.
  - Route statuses: `GET /booth/feedback` → 200 `{open}`. `POST /booth/feedback` → 201 `{}`. Refusals use the router's `REFUSAL` map, plus `comment_unavailable: [503, 'The comment could not be checked. Send again, or send without it.']`.
- Consumes:
  - `openEvent(now)` from `booth.js` (now exported), which returns `{event}` or `{refused}`.
  - `eventCases(code)`.
  - `rimplDeidentify({messages})` from `services/rimpl-client.js`.

- [ ] **Step 1: Write the failing tests** in `backend/tests/booth-feedback.test.js`. Use the `booth-monitor.test.js` harness:
  - mock `dotenv`, the supabase mock, and `rimpl-client` with `rimplDeidentify: jest.fn()`;
  - a temp `BOOTH_CASES_DIR` holding the fixture case under `NFCME-2026`;
  - `app_settings` rows that open the event (`booth_enabled` 1, `booth_opens_at` and `booth_closes_at` around now, `booth_play_ceiling_usd` 3, `booth_event_code` `'NFCME-2026'`).

  `const GOOD = { form: 'fb-1', case_id: kase.case_id, answers: { role: 'physician', mood: 'enjoyed', felt_like: ['real_patient', 'exam'], easy: 4, real: 5, fair: 3, use: 9 } }`

  Tests:
  - `'stores one row for the open event with the date and no time'`: POST GOOD returns 201 and body `{}`. Exactly one `booth_feedback` insert, whose payload has exactly the keys `['answers','case_id','comment','event_code','form','submitted_on']`. `submitted_on` matches `/^\d{4}-\d{2}-\d{2}$/` and equals the Bangkok date of now. `comment` is null. `rimplDeidentify` is not called.
  - `'refuses unknown keys, out-of-range values and play identifiers'`: `test.each` over GOOD plus `{tag: 42}`, plus `{play_id: 'x'}`, `answers.easy: 6`, `answers.use: 11`, `answers.easy: 2.5`, `felt_like: []`, `felt_like: ['exam','exam']`, `mood: 'happy'`, `form: 'fb-2'`, and a comment of 1001 characters. Each returns 400 and nothing is inserted.
  - `'refuses while the booth is closed and stores nothing'`: with `booth_enabled` 0, POST returns 403 `{reason: 'closed'}` and GET returns `{open: false}`.
  - `'stores an unknown case as null'`: `case_id: 'no-such-case'` returns 201 and the row's `case_id` is null.
  - `'stores only the de-identified comment'`: `comment: ' นพ.สมชาย ดูแลดีมาก '`, with `rimplDeidentify` resolving `{messages: [{role: 'user', content: '[NAME-1] ดูแลดีมาก'}]}`. `rimplDeidentify` is called once with `{messages: [{role: 'user', content: 'นพ.สมชาย ดูแลดีมาก'}]}`, and the row's comment is `'[NAME-1] ดูแลดีมาก'`.
  - `'a blank comment is null and skips rimpl'`: `comment: '  \n '` stores a null comment, with no rimpl call.
  - `'fails closed when de-identification fails'`: `rimplDeidentify` rejects. The reply is 503 `{reason: 'comment_unavailable'}`, there is no insert, and the comment text appears in no `console.*` call (spy on `console.error`, `warn` and `log`).
  - **In a separate file**, `backend/tests/booth-feedback-limit.test.js`, so the rate limiter's in-memory count starts fresh and no other test's requests count against it:
    - `'feedback calls stay out of the kiosk general budget'`: 45 `POST /booth/feedback` calls from one IP, then `GET /booth/status` still returns 200 (the general limit is 40 per minute).
    - `'feedback has its own per-IP limit'`: the 31st POST within a minute returns 429.
- [ ] **Step 2: Run them and see them fail.** `cd backend && npx jest tests/booth-feedback.test.js`. Expected: FAIL, because the route is missing (404).
- [ ] **Step 3: Write `db/migration-booth-feedback.sql`** with the table from the spec, section 5.
  - RLS on and no policy (copy the comment style of `migration-booth-plays.sql:101`).
  - Index on `(event_code, submitted_on)`.
  - A header saying the owner applies it before the backend deploy, and that the table has no time column on purpose (ADR 0015).
- [ ] **Step 4: Implement `services/booth-feedback.js`. Then edit `booth.js` and `routes/booth.js`.**
  - **`booth.js`:** add `openEvent` to `module.exports`.
  - **Service order:** parse, then `openEvent`, then trim the comment, then de-identify, then insert. Return `unavailable` when the insert fails.
  - **Bangkok date:** use `toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })`.
  - **Route:** `const FEEDBACK_PER_MIN = 30`. Change the general limiter's skip to `req.path === '/draw' || req.path === '/feedback'`. Add `router.use('/feedback', limit(60_000, FEEDBACK_PER_MIN, 'Too many answers from this network. Try again in a minute.'))`, plus `router.get('/feedback', route(() => feedback.feedbackOpen()))` and `router.post('/feedback', route((req) => feedback.submitFeedback(req.body), 201))`.
- [ ] **Step 5: Write ADR 0015**, "Booth visitors can leave anonymous feedback, kept apart from their play". Follow ADR 0014's form and cover the spec's section 7 bullets:
  - the owner's anonymity scope: stored and shown data are anonymous; server access logs are not covered;
  - open-only acceptance;
  - case id kept, and its rehearsal-day risk.
- [ ] **Step 6: Run the tests and see them pass.** `cd backend && npx jest tests/booth-feedback.test.js tests/booth-feedback-limit.test.js tests/booth.test.js`. Expected: PASS, and `booth.test.js` stays green.
- [ ] **Step 7: Commit.** `git add db/migration-booth-feedback.sql backend/src/services/booth-feedback.js backend/src/services/booth.js backend/src/routes/booth.js backend/tests/booth-feedback.test.js backend/tests/booth-feedback-limit.test.js docs/adr/0015-booth-anonymous-feedback.md && git commit -m "feat(booth): anonymous post-play feedback endpoint and table (ADR 0015)"`

### Task 2: Superadmin read, audited export, purge

**Files:**
- Modify: `backend/src/services/booth-feedback.js`
- Modify: `backend/src/routes/superadmin.js` (beside `GET /booth/export.json`, about line 591)
- Modify: `scripts/booth/purge-event.mjs`
- Test: `backend/tests/booth-feedback.test.js` (new `describe('admin')`)

**Interfaces:**
- Consumes: Task 1's table and constants, `flaggedForAuditor`, `logEventStrict` from `lib/audit`, and `readBoothEvent`.
- Produces:
  - `FeedbackRow = { date: string, case_id: string|null, answers: object, comment: string|null, withheld?: 'flagged' }`. When withheld, `comment` is null.
  - `readFeedback() -> Promise<{ body: { event_code: string, form: 'fb-1', rows: FeedbackRow[], counts: { answers: number, comments: number, comments_withheld: number } } } | null>`. Rows are newest date first; within a date they are sorted in code by case id (none last), then the answers as text, then id, never in database order (ADR 0015). The id is used only for the sort and is not in the row.
  - `exportFeedback() -> Promise<{ filename: string, body } | null>`, where `filename` is `booth-feedback-<EVENT>.json` and `body` is `{ export: { event_code, counts, form }, rows }`.
  - `GET /admin/booth/feedback` returns 200 with the `readFeedback` body, or 502.
  - `GET /admin/booth/feedback.json` returns the attachment after the audit row `booth.feedback_export` (metadata `{event_code, ...counts}`). If the audit write fails, it returns 503 and sends nothing.

- [ ] **Step 1: Write the failing tests:**
  - `'superadmin reads every row of the current event, newest date first, flagged comments withheld'`. Seed three rows: one comment `'ดีมาก'`, one `'โทร 0812345678'` (flagged by the long digit run), and one null. Expect `counts` `{answers: 3, comments: 2, comments_withheld: 1}`. The flagged row has `comment: null` and `withheld: 'flagged'`. No row of another event appears.
  - `'only a superadmin can read or export'`: ADMIN, AUDITOR and PHYSICIAN each get 403 on both paths.
  - `'export writes its audit row first and sends nothing when it fails'`. Expect a `Content-Disposition` of `booth-feedback-NFCME-2026.json`. `logEventStrict` is called with `action: 'booth.feedback_export'`. With `logEventStrict` resolving `{error: 'x'}`, the reply is 503 with no file body.
- [ ] **Step 2: Run them and see them fail** (404).
- [ ] **Step 3: Implement `readFeedback` and `exportFeedback`, and the two routes.**
  - The event is the one named by the `booth_event_code` setting (`readBoothEvent()`), whether or not the booth is open.
  - Rows are read with `.eq('event_code', code)`, paged past 1000 the way `booth-monitor.js` pages plays.
  - The routes copy the `/booth/export.json` handler's shape.
- [ ] **Step 4: Purge.** In `purge-event.mjs`:
  - **Dry run:** add a line "feedback rows: N" (head count on `booth_feedback`).
  - **`--delete`:** after the plays delete succeeds, `delete().eq('event_code', code)` on `booth_feedback`, then recount. If any remain, exit 1 with a `next` line, the way the `booth_plays` recount does. Update the header comment.
- [ ] **Step 5: Run.** `cd backend && npx jest tests/booth-feedback.test.js tests/booth-monitor.test.js`, then `npm run test:booth-scripts` (repo root). Expected: PASS.
- [ ] **Step 6: Commit.** `git add backend/src/services/booth-feedback.js backend/src/routes/superadmin.js backend/tests/booth-feedback.test.js scripts/booth/purge-event.mjs && git commit -m "feat(booth): superadmin feedback read, audited export, purge"`

### Task 3: The phone form page

**Files:**
- Create: `physician-ui/public/booth-feedback.html`
- Create: `physician-ui/public/js/booth-feedback.js`
- Create: `physician-ui/public/css/booth-feedback.css`
- Create: `physician-ui/public/js/booth-faces.js`
- Create: `physician-ui/public/js/booth-feedback-link.js`
- Modify: `physician-ui/public/js/icons.js`. Add `clipboardCheck`, `stethoscope`, `users`, `gamepad`, `bookOpen`, `lock` and `trophy`, using lucide path data as in the mockup.
- Modify: `physician-ui/public/js/booth-copy.js`. Add a frozen `FEEDBACK_COPY`; no imports.
- Modify: `scripts/booth/harness.mjs`. Change `phone(path, { width, height, stub })`, so a phone page reaches the stub's routes the way `kiosk()` does.
- Create: `scripts/booth/scenarios/feedback.mjs`

**Interfaces:**
- Produces:
  - **`booth-faces.js`:**
    - `MOODS` (the five mood ids in order);
    - `moodFace(mood: string) -> string` (SVG markup);
    - `scaleFace(t: number) -> string`, for t in [0,1]: sad brows at t ≤ 0.1, cheeks at t ≥ 0.7, happy eyes at t ≥ 0.95.
    - Each SVG uses `viewBox="0 0 48 48"`, `class="face"` and `aria-hidden="true"`.
  - **`booth-feedback-link.js`:**
    - `FEEDBACK_PATH = '/booth-feedback.html'`;
    - `feedbackUrl({ caseId, look }) -> string`, absolute from `location.origin`, fragment `#c=<id>&l=<look>`;
    - `parseFeedbackFragment(hash) -> { caseId: string|null, look: string }`. `caseId` must match `/^[a-z0-9-]{1,64}$/`, otherwise it is null. An unknown `look` becomes `DEFAULT_LOOK`.
  - **`FEEDBACK_COPY`:** every string from the spec's question table, the 1–5 labels, and these:
    - `title`
    - `progress` (`'ตอบแล้ว {n} จาก 7 ข้อ · ไม่ระบุตัวตน'`)
    - `drag` (`'ลากเพื่อตอบ'`)
    - `privacy`
    - `submit`
    - `thanks`
    - `closed` (`'บูทปิดรับแบบประเมินแล้ว ขอบคุณที่ร่วมเล่น'`)
    - `retry` (`'ลองอีกครั้ง'`)
    - `sendWithout` (`'ส่งโดยไม่มีความเห็น'`)
    - `busy`
  - **Page:**
    - On load it reads `GET /booth/feedback`. On submit it posts the `FeedbackSchema` body.
    - DOM hooks the harness relies on: `[data-feedback-form]`, `[data-q="<id>"]`, `[data-submit]`, `[data-thanks]`, `[data-closed]`, `[data-comment-failed]`.
    - The `sessionStorage` key is `clics.booth.feedback.sent`.

- [ ] **Step 1: Write the failing scenarios** in `scripts/booth/scenarios/feedback.mjs` (`export default [...]`). Each opens `h.phone('/booth-feedback.html#c=cap-adult&l=th', { stub })` with a stub for `GET /booth/feedback` and `POST /booth/feedback`.
  - `'feedback: submit stays off until the seven are answered, and untouched sliders send nothing'`: answer six, so submit is disabled. Answer the seventh by keyboard (focus the slider, press ArrowRight), so submit is enabled. The posted body deep-equals the expected `answers`, `case_id: 'cap-adult'`, `form: 'fb-1'`, and has no `comment` key.
  - `'feedback: a slider's face and words follow the value'`: dragging `easy` to 1 shows `aria-valuetext` starting with `'น้อยมาก'`, and to 5 starting with `'มากที่สุด'`. The face's SVG markup differs between 1 and 5.
  - `'feedback: one answer per page'`: double-clicking submit posts once. After a reload, `[data-thanks]` shows and the form does not.
  - `'feedback: a closed booth shows the closed notice'`: GET `{open:false}` shows only `[data-closed]`. A POST answered 403 `closed` shows `[data-closed]` too.
  - `'feedback: a failed comment check offers retry and send-without'`: a POST answered 503 `comment_unavailable` keeps every answer selected and shows both buttons. "ส่งโดยไม่มีความเห็น" posts again without `comment`.
  - `'feedback: readable on phones'`: `h.screenCheck(page, ...)` at 320×640, 375×812 and 430×932, with no page errors and no request that leaves the origin.
- [ ] **Step 2: Run and see it fail.** `BOOTH_ONLY=feedback npm run test:booth`. Expected: FAIL, because the page is missing.
- [ ] **Step 3: Implement** the HTML page (head, CSP and fonts as in `booth-result.html`), the CSS (booth tokens; the mockup v2 styles moved onto booth tokens), the faces, the link module and the page script.
  - The page builds its DOM with `el` and `bi` from `booth-dom.js`, and icons with `window.icon`.
  - Sliders are native `<input type="range">` with the "unanswered" state from the spec.
  - Chips are `<button aria-pressed>`.
  - The submit button is disabled while a request is in flight.
- [ ] **Step 4: Run and see it pass.** `BOOTH_ONLY=feedback npm run test:booth`, then the full `npm run test:booth`. Expected: PASS; the existing scenarios are unchanged.
- [ ] **Step 5: Commit.** `git add` the eight files above, then `git commit -m "feat(booth): anonymous feedback form page with CLICS faces"`

### Task 4: Kiosk button, QR pop-up, and the result-page card

**Files:**
- Create: `physician-ui/public/js/booth-feedback-qr.js`
- Modify: `physician-ui/public/js/booth-play.js` (`scored`, `.result-side`)
- Modify: `physician-ui/public/js/booth-result.js` (beside `workshopCard()`, about line 133)
- Modify: `physician-ui/public/js/config.js` (`window.CLICS_BOOTH_FEEDBACK = false;`, with a comment naming the rollout order)
- Modify: `physician-ui/public/css/booth.css` and `physician-ui/public/css/booth-result.css`
- Modify: `physician-ui/public/js/booth-copy.js` (`COPY.feedback`, `COPY.feedbackScan`, `COPY.feedbackTags`)
- Test: `scripts/booth/scenarios/feedback.mjs` (add scenarios)

**Interfaces:**
- Consumes:
  - `qrSvg(url, label)` from `booth-play.js`;
  - `feedbackUrl` and `FEEDBACK_PATH` from Task 3;
  - `currentLook()` from `booth-dom.js`.
- Produces:
  - `feedbackButton({ host, caseId }) -> HTMLButtonElement | null`. It returns null when the switch is off. Its overlay is `[data-feedback-overlay]` with `role="dialog"` and `aria-modal`; it moves focus to Close and returns focus on close. Like `openBoard`, it has a backdrop tap to close and `OVERLAY_IDLE_MS` auto-close.
  - `feedbackCard(caseId, look) -> HTMLElement | null`, for the result page; null when the switch is off.

- [ ] **Step 1: Write the failing scenarios.** Turn the switch on the way `board.mjs:104` appends `CLICS_BOOTH_LANDING_QR`.
  - `'feedback kiosk: the button opens one QR to the form, without tag or play id'`: play to `scored` (copy `toResult` from `keep.mjs`) and tap `[data-action="feedback"]`. Decode the overlay's QR with the decoder `scripts/booth/promo/qr-check.mjs` uses; it equals `feedbackUrl({caseId: TREE.case_id, look})`. Check that the URL contains neither the tag nor `PLAY_ID`. The screen shows exactly one QR before the tap and one inside the overlay after it. Close returns focus to the button. Run at 1080×1920 and 2160×3840, with `h.screenCheck` on the open overlay.
  - `'feedback kiosk: switched off shows nothing'`: with no flag, there is no `[data-action="feedback"]` on the scored screen and no `[data-feedback]` card on the result page.
  - `'feedback result page: the card links to the form for this case'`: with the switch on, open a GOOD2 r2 result link. The card's `href` equals `feedbackUrl({caseId: 'cap-adult', look})`.
- [ ] **Step 2: Run and see it fail.** `BOOTH_ONLY=feedback npm run test:booth`
- [ ] **Step 3: Implement.**
  - Draw the QR in the accent colour.
  - If the decode in Step 1 fails at either size, switch to black modules inside an accent frame (spec section 1), and say so in the commit message.
- [ ] **Step 4: Run and see it pass.** Run the full `npm run test:booth`.
- [ ] **Step 5: Commit.** `git add` the files above, then `git commit -m "feat(booth): kiosk feedback button with QR pop-up, result-page card, off by default"`

### Task 5: Dashboard feedback section

**Files:**
- Create: `audit-dashboard/components/BoothFeedback.tsx`
- Create: `audit-dashboard/components/BoothFaces.tsx` (a TSX port of `moodFace` and `scaleFace` with the same path data)
- Modify: `audit-dashboard/app/admin/booth/page.tsx`
- Modify: `audit-dashboard/lib/types.ts` (`BoothFeedbackRow`, `BoothFeedback`, mirroring Task 2's types)
- Test: `audit-dashboard/__tests__/BoothFeedback.test.tsx`

**Interfaces:**
- Consumes:
  - `GET /admin/booth/feedback` and `/admin/booth/feedback.json` (Task 2);
  - `apiFetch` and `apiDownload` from `@/lib/api`;
  - colours from `lib/chart-colors.ts`.
- Produces: `<BoothFeedback />`, which takes no props and fetches its own data.

- [ ] **Step 1: Write the failing tests.** Mock `@/lib/api` as `BoothPage.test.tsx` does.
  - `'shows counts, per-date split and every question's distribution'`: four rows over two dates. Expect "4" answers, both dates with their counts, the `easy` mean to one decimal, and one bar per `felt_like` choice with its count.
  - `'a case filter narrows every number'`.
  - `'a withheld comment shows its reason, never text'`.
  - `'empty event says so'`.
  - `'export goes to the audited path'`: `apiDownload` is called with `'/admin/booth/feedback.json'` and `'booth-feedback-NFCME-2026.json'`.
- [ ] **Step 2: Run and see them fail.** `cd audit-dashboard && npx jest __tests__/BoothFeedback.test.tsx`
- [ ] **Step 3: Implement** the component and add it to the page under the leaderboard. Labels are bilingual. Bars are horizontal, coloured from `chart-colors.ts`.
- [ ] **Step 4: Run the gates.** `cd audit-dashboard && npx tsc --noEmit && npm run lint && npx jest`. Expected: all green.
- [ ] **Step 5: Commit.** `git add` the files above, then `git commit -m "feat(dashboard): booth feedback section with audited export"`

### Task 6: Whole-change verification and docs

**Files:**
- Modify: `docs/BOOTH-RUNBOOK.th.md`. Add a "แบบประเมิน" section covering:
  - the rollout order from spec section 8;
  - the switch;
  - where answers are read;
  - that a purge removes them.
- Modify: `.claude/skills/clics-booth/SKILL.md` (local only; held for the owner's approval under the Learning loop). Propose one invariant line on feedback anonymity; do not write it.

- [ ] **Step 1: Run every hermetic gate.** `npm run test:all`, `npm run test:booth`, `npm run test:booth-scripts`, `npm run test:readability`, and `cd audit-dashboard && npx tsc --noEmit && npm run lint`. Expected: all pass.
- [ ] **Step 2: Grep checks.** Grep the diff for `console.` near `comment`: there must be none. Grep for any timestamp column in the migration: there must be none.
- [ ] **Step 3: Review and verify.** Run `clics-reviewer` on the branch diff, then `clics-verifier`. Fix findings in scope. List the rest under "Not in this PR".
- [ ] **Step 4: Commit the runbook,** then open the PR with `gh pr create --body-file`. The body names the owner's steps: apply the migration, deploy backend, dashboard and Portal, then flip the switch. It ends with the 🤖 footer.
