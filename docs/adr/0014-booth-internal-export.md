# A superadmin can export every booth play for internal research, tag and times included

Status: accepted 2026-11-24 (owner). Amends ADR 0010 for internal use only; 0010's rules for the published open dataset are unchanged.

The Booth Mode page has an export button for internal research, including the owner's digital-twin work. It sends a superadmin one JSON file holding every play of the current event, whatever its status. Each play carries:

- its database id and booth tag (`#042`)
- its full timestamps and its AI spend
- its case and version, tier path and step count
- the raw composite and the display score (ADR 0013; a five-step play scored before display-v1 shipped on 2026-11-18 was shown its raw score). Since ADR 0016 a five-step play's `display_score` is its answer-tier points; a file whose header names `tier_scale` holds tier points, one without it holds the ADR 0013 rescale
- d1–d7, the score source and the language look
- its dialogue as stored (ADR 0010)

ADR 0010 keeps the tag and the time of day out of the open dataset; this export keeps them in, so that a file row can be matched to the leaderboard and to the time it was played. The owner chose this over an export that follows ADR 0010's open-dataset rules.

Free text is still screened. A typed answer is rimpl's de-identified copy, and its reply came from the AI. The bridge into a step is the AI's too, written from the previous step's answer and stored on the step it leads into, so a tapped step carries AI text as well. Before the reply bank (#490), and on a play that is not five steps, a tapped answer's reply also came from the AI. rimpl's write-time filter misses some shapes (#449, #451), so the export screens every step's typed text, reply and bridge again with the auditor read's screen (`flaggedForAuditor`: a long digit run, a Thai digit, or a span under the open dataset's rules), each alone and, as the auditor read joins them, a step's reply with the bridge into the next step. Any finding withholds all three, marked `withheld: "flagged"` (a finding in a joined turn withholds both steps' text); the step's ids and tier stay. Only a step record's known keys go out, so a key some later writer adds is never exported unscreened. A reviewed bank reply (ADR 0006, 0011) does not trip the screen: none of the bank's texts did when this was written.

Every export writes an audit-log row (`booth.export`), and a failed write sends nothing. Only a superadmin can take the file.

## Considered options

- **Follow ADR 0010's open-dataset rules** (a hashed play reference, the date only, no spend): no ADR change needed. But a row could not be matched to a leaderboard place or a time of play, which the owner wants for the digital twin.
- **Send typed text unscreened**: the file would be complete. But the write-time filter is known to miss shapes, and the file leaves the database.

## Consequences

- The file is internal and is not to be published. A public release is still the open booth dataset, built by `scripts/booth/build-open-dataset.mjs` under ADR 0010's rules after the event's booth is off for good.
- Visitors are still not told that their answers are kept (ADR 0010). An internal file that carries the tag and the time is easier to tie back to a person seen at the booth than the open dataset, so this export adds to the point an ethics committee is most likely to ask about.
- A screened step loses all its free text: a lab value in an AI reply or bridge (a platelet count of 110,000, say) withholds that step's text too. The export's `counts` say how many steps each reason withheld.
- The leaderboard on the same page ranks what the kiosk ranks (scored, ranked plays of the event's step count, by raw composite), overall and per case, and shows every row, whatever the event's window.
