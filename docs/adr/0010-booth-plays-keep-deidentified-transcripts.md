# Booth plays keep de-identified transcripts as open research data and audit material

Status: accepted 2026-11-04. Supersedes ADR 0004 in part: what a booth play stores and how long. Booth plays still live outside the pilot data model, for 0004's reasons.

From round 2 on, a booth play also stores its dialogue: per step the question variant id, the three offered option ids, the chosen option id or, for a typed answer, rimpl's de-identified text of it (the backend never writes the raw text), and the AI reply; plus the language look and the score source (live evaluator or path score table). The rows are kept, with no 30-day delete. An export builds the open booth dataset (plays, transcripts, case files, path score tables, a data dictionary and a README of its limits), released under CC BY 4.0 on Zenodo only after the event's booth is switched off for good, because the case files reveal every tier. The booth tag and the time of day stay out of the export, and a row with typed text is released only after a PII scan and an AI read pass, with a human sign-off on anything flagged. Auditors may score booth plays blind in a booth case-study queue and then compare with the demo score, as in the pilot console; those audits live in a booth-only table and never reach pilot ICC, payouts, the XLSX export or the calibration anchors. We chose this because the owner wants booth plays as open data for a digital-twin paper and as an auditor case study (#355, 2026-11-04), on the reading that de-identified answers are not personal data.

## Consequences

- The visitor notice stays "no personal data kept". Visitors are not told that their answers, typed ones included, are kept and published: this is the owner's decision, and the point an ethics committee is most likely to ask about.
- rimpl's booth reply returns the de-identified typed text, so critical rule 1 (PII never leaves rimpl) holds for what the backend stores.
- `scripts/booth/purge-event.mjs` stays for a test event or an owner-ordered removal. Step 8 of the booth runbook no longer deletes an event's plays.
- The 3–4 Nov 2026 NFCME-2026 plays carry only a tier path and a live-evaluator score.
