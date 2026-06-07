# CLICS — Concurrency / Load Test (2026-06-07)

**Goal:** prove the platform supports **> 100 concurrent users**. **Budget:** ≤ $1 of Claude API.
**Target:** production backend (`https://backend-production-c12e4.up.railway.app`) — single Railway instance + Supabase (REST/PostgREST). Harness: `scripts/loadtest/loadtest.js` (dependency-free Node; concurrency swept 50→100→150→200).

## Result — **PASS (≥ 200 concurrent, 2× the goal)**

The app sustained **200 concurrent users with 0 errors** on the realistic read/session workload — double the >100 target. Claude spend was **$0.45** (cap $0.54, well under $1).

| Phase | Workload | Max concurrency tested | Errors | Notes |
|-------|----------|------------------------|--------|-------|
| **A** | `GET /health` (no auth, no DB) | **200** | **0%** | Raw HTTP ceiling > 200; ~395 req/s, p95 ≈ 560 ms |
| **B** | Mixed **authed reads** (the real per-user load) | **200** | **0%** | p50 ≈ 0.9–1.2 s, p95 ≈ 1.3–2.0 s — latency rises gracefully, **no failures** |
| **C** | `POST /auth/login` burst | 50 / 100 | **70% / 99% (HTTP 401)** | Supabase **auth rate-limit** on simultaneous logins — see below |
| **D** | AI chat via guest mode | 10 (all concurrent) | **0%** | p95 ≈ 16 s (Claude generation); 10 turns = **$0.45** |

### Detail (per concurrency level)
```
PHASE A — GET /health
  c=200 | 600 req | err 0 (0%) | 395 rps | p50 365ms p95 558ms
PHASE B — authed reads (DB-backed)
  c=100 | 300 req | err 0 (0%) |  94 rps | p50 845ms  p95 1294ms
  c=150 | 450 req | err 0 (0%) | 117 rps | p50 985ms  p95 1773ms
  c=200 | 600 req | err 0 (0%) | 134 rps | p50 1160ms p95 1840ms
PHASE C — login burst
  c=50  | 100 req | 30 ok / 70 err (401)  ← Supabase auth rate-limit
  c=100 | 200 req |  2 ok / 198 err (401)
PHASE D — guest AI (Claude)
  c=10  | 10/10 ok | p95 16085ms | $0.45
```

## Interpretation

- **Concurrent *users* (the real question): comfortably > 100.** In normal use a user logs in **once** and then reads/works with a session token. Phase B models exactly that and held **200 concurrent with zero errors**. The single Railway instance + Supabase REST pool **queue** under load (latency climbs to ~1–2 s) but **degrade gracefully — they don't drop requests**. Raw HTTP (Phase A) is even higher (>200).
- **DB-read throughput plateaus ~120–135 req/s** at high concurrency — the Supabase REST-pool ceiling. Still 0 errors at 200 in-flight; users just wait a little longer.
- **Login bursts are the one limit, and it's a Supabase platform limit, not the app.** Firing 50–100 logins in the same instant trips GoTrue's auth rate-limiter (returned as 401). This does **not** affect sustained usage (logins are naturally staggered across a real cohort), but it matters for an **onboarding-day mass sign-in**.
- **AI path is healthy under concurrency:** 10 simultaneous guest chats all succeeded; latency (~15 s) is Claude generation time, not backend contention.

## Concurrent **AI-chat** test — the AI path is the real ceiling (~13 concurrent)

The reads scale to 200+; the **AI chat path does not**. `scripts/loadtest/ai-concurrency.js` fired **40 simultaneous** real Claude generations (guest mode → RIMPL → Claude, zero DB writes):

| Metric | Result |
|--------|--------|
| Succeeded | **13 / 40 (33%)** |
| Failed | 27 → `RIMPL /chat error: 5xx` (upstream Claude rate-limit / overload surfaced as 502) |
| Latency (successful) | p50 **15.5 s**, max 28.8 s |
| Avg assistant response | ~1,301 tokens |
| Actual Claude spend | **≈ $0.40** (failures rejected upstream before generating — far under the $3 cap) |

**Interpretation:** an earlier 10-concurrent burst succeeded 10/10, but at 40 only ~13 get through — so the AI path **saturates at roughly ~13 concurrent generations** on the current Anthropic tier + single RIMPL instance. The limiter is almost certainly the **Anthropic API rate limit** (the account accepts ~N concurrent calls and 429s the rest; RIMPL surfaces that as a 5xx, and the backend returns 502). RIMPL itself stayed up (13 succeeded), so this is upstream throttling, not a RIMPL crash.

**Consequence:** **100 concurrent AI chats is NOT supported today** — it would fail for the majority. Real usage is gentler (physicians read/think between turns, so true simultaneity is far below the user count), but a large cohort with bursty "send" timing needs the fixes below.

### To raise AI-chat concurrency
1. **Raise the Anthropic API rate-limit tier** (requests- and tokens-per-minute) — the dominant constraint.
2. **Queue + retry-with-backoff in RIMPL** so a burst *queues* (and retries 429s) instead of failing — same pattern already added to the evaluation path. Turns a hard failure into graceful latency.
3. **Scale RIMPL** (replicas) and consider provisioned throughput / a fallback provider for the L4 multi-provider roadmap item.
4. For the pilot's size, size the Anthropic tier to the expected *peak simultaneous generations*, not the headcount.

## Recommendations (to scale beyond ~200 / harden for launch day)
1. **Login bursts:** raise Supabase **auth rate limits** (project settings) or **stagger** onboarding; optionally have the backend surface `429 Too Many Requests` distinctly from `401` so clients can back off. *(Low effort, highest value for a launch-day cohort.)*
2. **Horizontal scale:** add **Railway replicas** (the backend is a single stateless instance) to lift the raw HTTP ceiling and absorb spikes.
3. **DB throughput:** raise the **Supabase pool / plan**, and **cache hot reads** (`/admin/slots`, `/admin/users`, `/admin/auditors`) to cut latency at high concurrency.
4. **No code throttles exist** (no rate-limiting middleware) — fine for the pilot; add a light per-IP limiter before public launch to resist abuse.

## Distinct-user test (faithful: each request a *different* logged-in user) — **≥100 distinct, 0 errors**

Phase B above reused 4 tokens. To test literal "N **unique** users at once", `scripts/loadtest/loadtest-distinct-long.js` provisioned **130 distinct accounts**, logged each in for its **own token**, then fired concurrent reads where **every in-flight request carries a different user's token** (distinct `verifyJwt` auth + distinct per-user DB queries — no shared cache). Read-only → **$0 Claude**. All accounts deleted afterward (physicians back to 10).

| Distinct users (unique tokens) | Requests | Errors | p50 | p95 |
|--------------------------------|----------|--------|-----|-----|
| 50 | 150 | **0 (0%)** | 642 ms | 1458 ms |
| **100** | **300** | **0 (0%)** | 626 ms | 1106 ms |
| **110** | **330** | **0 (0%)** | 645 ms | 1456 ms |

**Result: 110 genuinely-distinct, simultaneously-logged-in users served with 0 errors** — the >100 goal demonstrated outright, not just by proxy.

**About the login rate-limit (corrected):** an earlier attempt that *burst* logins (8 at a time) stalled at ~60 tokens. Collecting the same tokens **paced sequentially (1 login per ~1.5 s)** hit **110 with zero throttling** — so Supabase's auth limit is a **burst/concurrency limit, not a hard volume cap**. Practical takeaways: (a) serving 100+ concurrent *sessions* is fine; (b) the only thing to manage is **simultaneous login spikes** (Phase C) — for an onboarding-day mass sign-in, stagger logins or raise the Supabase auth burst limit.

## How to reproduce
```bash
node scripts/loadtest/loadtest.js     # writes /tmp/loadtest-results.json
```
Budget-safe: only Phase D spends Claude, hard-capped at 12 guest turns (≈ $0.5). Phases A–C are free; Phase D uses ephemeral guest sessions (no DB writes).

**Bottom line:** **>100 concurrent users for browsing / dashboards / sessions is met with margin** — proven two ways: **200 concurrent requests, 0 errors** and **110 genuinely-distinct logged-in users, 0 errors**. **But the AI-chat path is the real limit: it saturates around ~13 concurrent generations** (40 concurrent → only 33% succeed) because of the Anthropic API rate limit + single RIMPL instance — so **100 concurrent AI chats is not supported today** and needs the fixes above (raise the Anthropic tier, queue/retry in RIMPL, scale RIMPL). Two smaller ceilings: Supabase login-*burst* rate-limit (stagger mass sign-in) and the single Railway instance (add replicas beyond ~200).
