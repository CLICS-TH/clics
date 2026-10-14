# CLICS daily summary email

A daily Thai-language progress email for non-developer readers (e.g. a manager),
sent every morning at **08:11 Asia/Bangkok**, cloud-run so it works while the
laptop is off.

## Why this exists (the 2026-06-21 redesign)

This email kept landing as a Gmail **draft** instead of sending. Every failure was
a quirk of the Anthropic cloud `/schedule` **sandbox** it used to run in:

| Date | Sandbox quirk | Symptom |
|------|---------------|---------|
| early | `jq` not installed | build the payload with `python3` instead |
| early | urllib default User-Agent | Resend's Cloudflare 403s it (error 1010) — set a normal UA |
| 2026-06-18 | sandbox Python <3.12 | backslash-in-f-string `SyntaxError` |
| 2026-06-19 | egress allowlist blocked `api.resend.com` | send failed → moved the **send** to GitHub Actions |
| 2026-06-21 | `gh` not present in the sandbox | the routine's `gh workflow run` never fired → drafted |

The 2026-06-21 redesign removes the sandbox from the path entirely. The report is
now generated **deterministically inside GitHub Actions** (no LLM) and triggered
by **native cron** — the same self-contained shape as the sibling
`jjnnaappaatt/lidar-hpe` `daily_update.py`, which has run reliably this way for
weeks. The trade-off: deterministic Thai is a little less polished than an LLM's,
but it never silently degrades to a draft.

## Architecture

```
GitHub Actions cron  ──  .github/workflows/daily-summary.yml
  schedule: 01:11 UTC (08:11 Bangkok)  + 01:41 UTC backstop
  │
  ├─ dedup guard (gh run list): a scheduled run sends only if no run
  │     already succeeded today → the 08:41 backstop fires only if the
  │     08:11 primary was dropped by GitHub (rare cron skip)
  │
  ├─ python3 scripts/daily-summary/gen_summary.py > data.json
  │     • 24h git metrics (commits / files / +/−)
  │     • plain-Thai humanization of the commits (no LLM, no network)
  │     • pending P1 backlog → curated Thai sentences
  │
  └─ python3 scripts/daily-summary/send.py
        → render HTML dashboard + plain-text fallback
        → POST api.resend.com  (RESEND_API_KEY secret, open egress)
  ▼
Resend → napat72235@gmail.com   (one threaded conversation)
```

There is **no Claude `/schedule` routine in the path** anymore — the old one
(`trig_013if2V1ttgvCmpEhxDq2Pma`) is disabled. Native cron is the clock; GitHub
occasionally drops a single scheduled run under load, so the 08:41 run is a
self-heal backstop guarded against double-sending.

## Files

| File | Role |
|------|------|
| `.github/workflows/daily-summary.yml` | native cron ×2 + dedup guard; builds `data.json` → runs `send.py` |
| `scripts/daily-summary/gen_summary.py` | deterministic plain-Thai `data.json` from git + the P1 backlog (no LLM) |
| `scripts/daily-summary/send.py` | renders the HTML dashboard + text fallback, sends via Resend. Secrets from env. |

## Setup (one-time)

1. **Add the Resend secret** (encrypted; never committed):
   ```bash
   gh secret set RESEND_API_KEY -R CLICS-TH/clics --body 'YOUR_RESEND_KEY'
   ```
   Rotate at resend.com first if the value was ever exposed.

2. *(optional)* Override the recipient via a repo **variable** (defaults to
   `napat72235@gmail.com`):
   ```bash
   gh variable set DAILY_TO -R CLICS-TH/clics --body 'someone@example.com'
   ```

## Test it

```bash
# Send now (manual dispatch always sends, bypassing the dedup guard):
gh workflow run "CLICS Daily Summary" -R CLICS-TH/clics --ref master

# Watch it:
gh run list -R CLICS-TH/clics --workflow="CLICS Daily Summary" --limit 1
```

Preview the generated content locally (no send):
```bash
python3 scripts/daily-summary/gen_summary.py | python3 -m json.tool
```

Send a real email locally:
```bash
RESEND_API_KEY=... python3 scripts/daily-summary/gen_summary.py > data.json
RESEND_API_KEY=... DATA_FILE=./data.json python3 scripts/daily-summary/send.py
```

## Editing the Thai output

`gen_summary.py` is rule-based, so two tables control wording:

- **`PREFIX_TH`** — conventional-commit type → Thai outcome verb (`feat:` →
  "เพิ่มความสามารถใหม่", etc.). Add a prefix here if you start using a new one.
- **`CURATED`** — `(keyword triggers) → Thai sentence` for the standing backlog.
  Only **P1** ROADMAP bullets that match a trigger appear in "งานที่ยังเหลือ"; an
  un-mapped bullet is dropped (so raw English jargon never reaches the email).
  When the backlog shifts, edit these triggers/sentences.

## data.json shape

```json
{
  "date": "21/06/2026",
  "branch": "master",
  "metrics": { "commits": 7, "files": 39, "added": 1183, "removed": 84 },
  "updates":   ["...plain-Thai-framed commit lines..."],
  "remaining": ["...curated Thai backlog sentences..."],
  "summary":   ["...2–3 overview bullets..."]
}
```
`updates` / `remaining` / `summary` may be empty arrays. The four metrics are
integers. When `remaining` is non-empty the email appends a ready-to-paste
"continue work" prompt box.
