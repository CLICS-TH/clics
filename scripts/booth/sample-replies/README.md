# Sample replies

The AI replies inside the sample transcripts that the path score table build scores (#373, ADR 0009). The NFCME-2026 replies were scored once, in run `ptb-202611040911-a71a`. A new run spends against the machine's path-table cap (#408), which the $30.49 already spent has used up until the owner opens a new budget. They are written in a Claude Code session, not by the API, following the booth reply rules in `rimpl/src/lib/prompts.js` (`BOOTH_RULES` and `BOOTH_FIELD_RULES`). The evaluator scores the physician turns, so a reply moves the transcript, not the score of a choice.

There is one file per case, at `<event_code>/<case_id>.json`.

```json
{
  "case_id": "adhf",
  "replies": {
    "step1": { "<option id>": { "strength": "...", "weigh": "...", "safety": "" } },
    "step2.B": { "...": {} },
    "step3.BR": { "...": {} }
  }
}
```

A bank's key is the case file's own bank key. A three-step case has `step1`, `step2.<tier>` and `step3.<tier><tier>`. A five-step case has `step1`, then `step2.<tier>` through `step5.<tier>`, each keyed on the tier of the step before. Every option of every bank has one reply: the reply a physician gets after tapping that option.

Check a case's replies from the repo root. The check runs each reply through the booth API's own reply checks, so a reply passes only if the kiosk would show it unchanged.

```bash
node scripts/booth/path-table-sample.js adhf
```
