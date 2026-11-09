# Sample replies

The AI replies inside the sample transcripts that the path score table build scores (#373, ADR 0009). Live builds are off until #408 gives the build a spend cap that holds, so these replies were scored once, in run `ptb-202611040911-a71a`, and wait for #408 before any new run. They are written in a Claude Code session, not by the API, following the booth reply rules in `rimpl/src/lib/prompts.js` (`BOOTH_RULES` and `BOOTH_FIELD_RULES`). The evaluator scores the physician turns, so a reply moves the transcript, not the score of a choice.

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

A bank's key is `step1`, `step2.<tier>` or `step3.<tier><tier>`, the same tier letters as the case file's banks. Every option of every bank has one reply: the reply a physician gets after tapping that option.

Check a case's replies from the repo root. The check runs each reply through the booth API's own reply checks, so a reply passes only if the kiosk would show it unchanged.

```bash
node scripts/booth/path-table-sample.js adhf
```
