# CLICS daily summary email

A daily Thai-language progress email for non-developer readers (e.g. a manager),
sent every morning at **08:00 Asia/Bangkok**, cloud-run so it works while the
laptop is off.

## Why this exists (the 2026-06-19 cutover)

The original sender ran entirely inside an Anthropic cloud `/schedule` routine: a
Python script POSTed to `api.resend.com` from the sandbox. On **2026-06-19** the
sandbox's network **egress allowlist** began blocking that host
(`HOST not in allowlist`), so the send failed and fell back to a Gmail *draft*
every day. (The Resend API key was also hardcoded in the routine's script.)

The fix moves the **send** to GitHub Actions — GitHub-hosted runners have open
egress — and keeps the **summary generation** in the routine, where the LLM is
free and needs no API key. This mirrors the sibling `jjnnaappaatt/lidar-hpe`
"Daily Update Email" workflow.

## Architecture

```
08:00 Asia/Bangkok
  │
  ▼
claude.ai routine  ── "CLICS Daily Summary Email"  (trig_013if2V1ttgvCmpEhxDq2Pma)
  • git metrics for the last 24h
  • plain-Thai, non-technical summary (LLM, no API key)
  • writes data.json
  • gh workflow run "CLICS Daily Summary" -R jjnnaappaatt/clics \
        --ref master -f payload="$(cat data.json)"
  │  (GitHub API egress from the sandbox already works — only Resend was blocked)
  ▼
GitHub Actions  ── .github/workflows/daily-summary.yml
  • writes the payload to data.json
  • python3 scripts/daily-summary/send.py
        → render HTML dashboard + plain-text fallback
        → POST api.resend.com  (RESEND_API_KEY secret, open egress)
  ▼
Resend → napat72235@gmail.com   (one threaded conversation)
```

The routine is the **reliable clock** (native GitHub `schedule:` cron is
throttled and skips runs; `workflow_dispatch` is not). If the routine cannot
reach `gh`, it still falls back to a Gmail draft so a day is never lost.

## Files

| File | Role |
|------|------|
| `.github/workflows/daily-summary.yml` | `workflow_dispatch` trigger; writes payload → runs `send.py` |
| `scripts/daily-summary/send.py` | Renders the HTML dashboard + text fallback, sends via Resend. Secrets from env. |
| `scripts/daily-summary/gen_fallback.py` | Builds a *raw* `data.json` from git when run with no payload (smoke tests) |

## Setup (one-time)

1. **Add the Resend secret** (encrypted; never committed):
   ```bash
   gh secret set RESEND_API_KEY -R jjnnaappaatt/clics --body 'YOUR_RESEND_KEY'
   ```
   The previously hardcoded key was exposed in the routine config — **rotate it
   at resend.com first**, then set the new value here.

2. *(optional)* Override the recipient via a repo **variable** (defaults to
   `napat72235@gmail.com`):
   ```bash
   gh variable set DAILY_TO -R jjnnaappaatt/clics --body 'someone@example.com'
   ```

## Test it

```bash
# Polished email — pass a real data.json as the payload:
gh workflow run "CLICS Daily Summary" -R jjnnaappaatt/clics --ref master \
    -f payload="$(cat data.json)"

# Raw fallback — no payload (uses gen_fallback.py):
gh workflow run "CLICS Daily Summary" -R jjnnaappaatt/clics --ref master

# Watch it:
gh run list -R jjnnaappaatt/clics --workflow="CLICS Daily Summary" --limit 1
```

Locally (sends a real email to `DAILY_TO`):
```bash
RESEND_API_KEY=... DATA_FILE=./data.json python3 scripts/daily-summary/send.py
```

## data.json shape

```json
{
  "date": "19/06/2569",
  "branch": "master",
  "metrics": { "commits": 7, "files": 39, "added": 1183, "removed": 84 },
  "updates":   ["...plain Thai, non-technical..."],
  "remaining": ["...ordered most-important first..."],
  "summary":   ["...2–3 overview bullets..."]
}
```
`updates` / `remaining` / `summary` may be empty arrays. The four metrics are
integers. When `remaining` is non-empty the email appends a ready-to-paste
"continue work" prompt box.
