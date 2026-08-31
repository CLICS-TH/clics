# CLICS load / concurrency test

Proves how many concurrent users the app sustains (goal **>100**), with a **$1 Claude budget**.

```bash
node scripts/loadtest/loadtest.js          # targets the live backend by default
CLICS_BASE=http://localhost:3001 node scripts/loadtest/loadtest.js   # or local
```

Dependency-free (Node 18+ global `fetch`). Writes `/tmp/loadtest-results.json`.

## What it does (4 phases, concurrency swept 50 → 100 → 150 → 200)

| Phase | Endpoint(s) | Cost | Measures |
|-------|-------------|------|----------|
| **A** | `GET /health` (no auth, no DB) | $0 | Raw Node/Railway-instance HTTP ceiling |
| **B** | mixed authed reads (`/auth/me`, `/admin/users`, `/admin/ples`, `/auditor/queue`, `/ples`, …) | $0 | Realistic per-user load → the Supabase REST-pool ceiling |
| **C** | `POST /auth/login` | $0 | Supabase auth throughput |
| **D** | `POST /guest/message` (guest mode → Claude) | ~$0.45 | AI-path concurrency, **hard-capped at `MAX_AI_CALLS=12`** turns |

Per level it reports: requests, ok/errors, error-rate, throughput (req/s), and latency p50/p95/p99/max. The **verdict** line states the highest concurrency each phase sustained at <1% errors.

## Faithful distinct-user variant — `loadtest-distinct-long.js` (recommended)

`loadtest.js` Phase B reuses 4 tokens (a request-flood). For a literal "N *unique* users at once":

```bash
cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/loadtest/loadtest-distinct-long.js
```

It provisions 130 distinct accounts (service-role), logs each in for its own token **paced sequentially** (≈1 login/1.5 s — avoids the auth *burst* limit), fires concurrent reads where **every request carries a different user's token**, then **deletes all the accounts**. Read-only → $0 Claude. **Achieves ≥110 distinct concurrent users at 0 errors** (see `docs/LOADTEST-2026-06.md`).

`loadtest-distinct.js` is the earlier *bursted* variant (batches of 8) — it stalls at ~60 tokens because Supabase's auth limit is **burst/concurrency-based**, not a volume cap. Kept for comparison; prefer the `-long` script.

## Budget safety
Only Phase D calls Claude. A global counter (`aiCalls`) stops at `MAX_AI_CALLS` (≈ $0.5 worst-case) — well under $1. Phase D uses **guest** sessions, which hit the AI but write **zero** DB rows (no pollution). Phases A–C are read/auth only.

## Notes
- Runs against **production** (the only deployed env). Bursts are short and ramped; only a few ephemeral guest sessions touch the AI.
- The expected bottleneck is the single Railway instance + Supabase REST pool, not the Node code (there is no rate-limiting / concurrency-cap middleware). See `docs/LOADTEST-2026-06.md` for the measured numbers + recommendations.
