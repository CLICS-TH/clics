# Booth visitors can leave anonymous feedback, kept apart from their play

Status: accepted 2026-11-24 (owner).

After a play, a visitor can answer a short survey (form `fb-1`: role, mood, what it felt like, easy, real, fair, would use for CME credit, and an optional comment). The answers go to `POST /booth/feedback` and are stored in `booth_feedback`, a table with its own rows and no link to `booth_plays`.

The survey is anonymous so that visitors answer about the product, not about their own score. A row holds only:

- the event code, the form version and the answers
- the case id, when it names a case of the open event (otherwise null, so a stale link still saves the answers)
- the date, in Asia/Bangkok: no timestamp column exists, so an answer cannot be matched to a play by the time it was sent
- the comment, only as rimpl's de-identified copy

There is no tag, no play id, no score and no IP or device data, and the request schema has no field for any of them. The row id is a random v4 uuid, which carries no time.

A comment is sent to rimpl `/deidentify` as one message and only the masked text is stored. When rimpl cannot be reached the request answers 503 `comment_unavailable` and stores nothing, so the page can retry or send without the comment. rimpl's filter misses some shapes (#449, #451), so every read of a comment screens it again (`flaggedForAuditor`), the same two-layer rule ADR 0010 and 0014 follow for a play's typed text. The backend never logs a comment, raw or masked.

Feedback is taken only while the booth is open, for the open event the backend resolves itself. After closing time the reply is `closed` and nothing is stored, so a visitor who answers late loses that answer. The event purge also deletes the event's feedback rows.

## The scope of "anonymous"

The owner set the scope: what CLICS stores and shows (the table, the admin page, the export) cannot be matched to a play. Server access logs (the vm1 proxy, the backend's request logs) and the rate limiter's in-memory store keep recording request times, as they do for every booth request today. Only whoever runs the server can read them, and they are never joined to the feedback data. This ADR states that limit; no log redaction is built.

## The case id

The case id is kept because it says which case felt unreal. On a quiet rehearsal day, the case and the date together could narrow an answer to one or two plays. This is accepted: the answers are about the product and stay internal.

## Considered options

- **Link the answer to the play** (the tag or a play id): would let a score explain a mood. But the answer would stop being anonymous, and visitors who did badly would have a reason to skip it or soften it.
- **Drop the case id**: closes the rehearsal-day gap. But then a low "real" answer could not be traced to its case.
- **Accept feedback after the booth closes**: nobody loses an answer. But the backend would have to guess the event, and a stale QR could write into a finished event's data.

## Consequences

- The migration `db/migration-booth-feedback.sql` is applied by the owner before the backend deploy.
- A visitor who answers after closing time loses the answer.
- Phones on the forum Wi-Fi share one public IP with the kiosk, so `/feedback` has its own per-IP limit (30 a minute) and is left out of the booth router's general budget.
