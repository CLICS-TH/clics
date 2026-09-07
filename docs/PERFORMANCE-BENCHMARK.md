# CLICS — Performance Benchmark & Scale-Up Playbook

The **acceptance baseline** every future load test measures against, plus the **levers** to scale beyond the pilot. Detailed test narratives live in [LOADTEST-2026-06.md](LOADTEST-2026-06.md); this file is the durable benchmark.

**Pilot target:** 75 physicians × 3 PLEs — true simultaneity is far below the headcount (physicians read/think between turns). The **Aug–Sep 2026** window this was sized against is superseded and no replacement window has been set ([pilot-timeline.md](pilot-timeline.md)); the headcount and the shape of the load are what this benchmark rests on, not the dates.

---

## 1. Verified baseline (PASS — prod, current hardened build)

Last verified **2026-06-11** against `https://backend-production-c12e4.up.railway.app` (single Railway instance + Supabase REST/PostgREST).

| Dimension | Result | Notes |
|-----------|--------|-------|
| **Distinct concurrent users** (unique token each — real auth + per-user DB) | **100, 0 errors** · p50 ~680 ms · p95 ~1.4 s | The faithful "N unique users at once" test |
| **Concurrent requests** (reads/sessions) | **200, 0 errors** · p95 ~1.8 s | 2× the >100 goal (2026-06-07) |
| **Raw HTTP** (`/health`) | **>200** · ~395 rps · p95 ~560 ms | HTTP ceiling above the app ceiling |
| **DB read throughput** | plateaus **~120–135 rps** at high concurrency | Supabase REST-pool ceiling; 0 errors, just higher latency |
| **AI-chat path** | **~88% at 40-concurrent burst** after RIMPL queue+retry | Bound by Anthropic **OTPM ≈ 8,000/min**, not RPM/input-TPM |
| **AI cost** | ~$0.045/turn observed (~$0.065 conservative) | per-user $0.50 cap enforced in-app |

**Verdict: pilot-grade with margin.** 100 clean distinct users (from a single IP, worst case) comfortably covers 75 physicians across many IPs.

## 2. Acceptance thresholds (what "PASS" means on a re-test)

A build passes the performance gate when, on prod:
- **≥ 100 distinct concurrent users with 0 server errors** (5xx). *Per-IP `429`s in a single-IP test are NOT failures* — they're the rate limiter (see §3).
- **p95 < 2.0 s** on authed reads at 100 concurrent.
- **AI path: no 5xx rate-limit failures** under the RIMPL queue at the *expected peak simultaneous generations* (size the Anthropic tier to peak, not headcount).
- **Logins staggered**, not burst (Supabase auth burst limit — see §3).

Re-run before any launch-scale change, after a Railway/Supabase plan change, or after touching auth/DB hot paths.

## 3. Methodology & the single-IP caveat (read before testing)

Harnesses (`scripts/loadtest/`): `loadtest-distinct-long.js` (distinct users, **$0**), `loadtest.js` (mixed, Phases A–C free / D ≤$0.5), `ai-concurrency.js` (AI burst, **capped ≤ $2** = 28×$0.065).

**Rate limiters added since the original test now intercept single-machine load** — a one-IP test measures the *limiter*, not raw capacity:

| Limiter (`backend/src/index.js`) | Cap | Trips a single-IP test at |
|----------------------------------|-----|---------------------------|
| general | **300 / min / IP** | ~110 distinct users × 3 rounds = 330 req in <2 s → `429` |
| `/guest` | **15 / min / IP** | a burst of guest-AI chats → "Guest limit reached" |
| `/auth/login` | **10 / min / IP** | mass-login bursts → `401`/`429` (collect tokens paced ~1/1.5 s) |

**Implication:** from one machine, test **≤ 100 concurrent**. To measure raw ceilings higher, use **distributed / multi-IP load** (k6 Cloud, Artillery, multiple egress IPs) or a **temporary limiter exemption**. Real users come from distinct IPs and never bunch against a per-IP cap.

**Capacity *design* assumptions (NOT concurrency, NOT tested):** the `professionals` table is paginated to hold **~80K** records, `ples` **~400K** rows. Storage targets — never claim "80K concurrent users."

## 4. Scale-up playbook (beyond pilot)

Each row = a **trigger** (when to act) → **lever** (what to change). Ordered by likely bind.

| Trigger | Lever |
|---------|-------|
| Simultaneous **AI generations** > OTPM allows (5xx rate-limit under the RIMPL queue) | **Raise the Anthropic OTPM tier** (root lever — directly multiplies AI concurrency) · shorten responses (fewer output tokens) · scale RIMPL replicas · multi-provider fallback (L4 roadmap) |
| Concurrent **sessions** approaching ~150–200 | Add **Railway replicas** (backend is stateless) · raise the **Supabase pool / plan** |
| DB **read latency** climbing at high concurrency | Cache hot reads (`/admin/slots`, `/admin/users`, `/admin/auditors`) · raise Supabase plan |
| **Onboarding-day** mass sign-in | Raise Supabase **auth burst limit** or **stagger** logins · surface `429` distinctly from `401` so clients back off |
| **Public** launch (abuse exposure) | Tune per-IP limiters · add bot/abuse protection · re-run a **multi-IP** load test to re-measure raw ceilings |
| Registered population → tens of thousands | Already paginated; verify index coverage; consider read replicas |

**Sizing rule:** size the Anthropic tier and Railway replica count to the **expected peak simultaneous generations / sessions**, not the total headcount.

## 5. Change log

- **2026-06-11** — Re-confirmed 100 distinct concurrent users / 0 errors on the hardened build; established this benchmark. Single-IP tests now bounded by the per-IP limiters above (graceful `429`s, not failures). AI burst re-run measured the guest limiter (15/min/IP), real Claude spend ≈ $0.14.
- **2026-06-07** — Original load test: 200 concurrent / 110 distinct, 0 errors; AI path 33% → 75% → 88% after RIMPL queue+retry + quick-win pass; OTPM identified as the binding AI dimension.
