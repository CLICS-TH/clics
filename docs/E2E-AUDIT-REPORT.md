# CLICS E2E Audit + 80K-Scale + TMC Scraper — Report

_Audit of: all-roles E2E, the new Google/invite/license flows, ~80K-user DB scale, and the live TMC scraper. Generated during the 2026-06-09 audit session._

## 1. Summary

| Area | Verdict |
|---|---|
| **All-roles logic (A/B/C/D + invite/license)** | ✅ Proven by **84 backend tests** (16 suites), incl. 9 new auth-flow integration tests |
| **80K-user DB scale** | ✅ Bottlenecks fixed (indexes, O(1) pseudonyms, pagination, SQL aggregates); live benchmark pending test-Supabase |
| **TMC scraper** | ✅ **Works live** against `checkmd.tmc.or.th` — no captcha; one branch (verified) needs a real license to confirm |
| **Google sign-in + invite EMAIL** | ⏳ Logic proven; **real delivery needs Supabase SMTP + Google provider** → `docs/E2E-RUNBOOK.md` |

Nothing was deployed; the prod DB was untouched. Live phases run against a throwaway **test Supabase** (creds pending).

## 2. All-roles coverage

| Role | Covered | How |
|---|---|---|
| **A — Superadmin** | users/slots/stats/ICC/export, per-council ICC, manual license-verify | `role-chain-smoke.js`, `superadmin-guard`, `auth-flows`, unit |
| **B — Admin** | council-scoped PLEs/requests/assign, invites (own council), license badge/verify | `role-chain-smoke.js`, `auth-flows`, unit |
| **C — Physician** | consent gate, chat→CLE→eval, signup (email-OTP + Google logic), invite-accept (soft license) | `go-live-smoke.js`, `consent-gate`, `usage-budget`, `auth-flows` |
| **D — Auditor** | blind queue/scoring, ICC, invite-only creation, **hard license gate**, self-eval block | `role-chain-smoke.js`, `auth-flows`, `auditor` route + trigger |

**New auth-flow tests (`backend/tests/auth-flows.test.js`, hermetic):** signup-OTP→physician active w/ correct `license_status`; invalid OTP → no provisioning; invite physician active even on `name_mismatch`; invite auditor non-verified → `202 pending_license_review` + `deactivated`; auditor verified → active; idempotent re-accept → 409; manual-verify activates a pending auditor.

**Live validation (2026-06-09, test Supabase, Postgres 17 + 80K seeded rows) — 16/16 passed:** all 4 role logins; `/admin/users` paginated (page of 50, `X-Total-Count=80005`); `/admin/stats` via SQL RPC; create-physician → `next_pseudonym()` returned `P-002`; invite create → public `GET /auth/invite/:token` (email-bound) → revoke → 404; admin council-scoping on `/admin/ples` + `/admin/auditors`. **DB invariants fired correctly live:** active auditor + unverified license → rejected by `enforce_auditor_license`; + verified → allowed; non-superadmin without council → rejected by `prof_council_required`. _(Caught + fixed a real bug: `db/seed-users.js` seeded the demo auditor active+unverified, which the trigger now rejects — set to `manual_verified`.)_

## 3. 80K-user scale — bottlenecks → fixes

| Bottleneck (before) | Fix (applied) |
|---|---|
| `nextPseudonym()` scanned **all 80K rows per signup** | `pseudonym_seq` + `next_pseudonym()` RPC — **O(1)** (`db/migration-scale.sql`); code falls back pre-migration |
| Missing composite index → every slot-check scanned `professionals` | `professionals(role,status)` + `(council_id,role,status)` indexes |
| `/admin/ples`, `/admin/users` **unpaginated** (PostgREST silently truncates at 1000) | `?limit&offset` (default 50) + `X-Total-Count` header + dashboard **"load more"** |
| `/admin/export` loaded all physicians + all ples | page-bounded: one page of sessions + only that page's physicians/scores |
| `/admin/stats`, `/usage-settings` aggregated in JS over all rows | SQL `ple_status_counts()` / `total_usage_sum()` RPCs |
| `/superadmin/icc` loaded all 400K ples | bounded to **scored sessions** via `audit_scores.council_id` |
| Missing `ples(physician_id)`, `messages(ple_id)`, `ai_evaluations(ple_id)`, `audit_scores(ple_id,auditor_id)`, `lpdp_snapshots(physician_id)` | all added |

**Cross-origin fix:** added `Access-Control-Expose-Headers: X-Total-Count` (else the prod dashboard couldn't read the total and "load more" would never appear).

**Validated live (80K rows on test Supabase, `EXPLAIN ANALYZE`):**

| Hot path | Before | After |
|---|---|---|
| slot-count `where role+status` | seq scan | **Index-Only Scan** (`professionals_role_status_idx`), 0 heap fetches, 13ms |
| `next_pseudonym()` (per signup) | ~15ms + **ships 80K rows to JS** | **0.16ms** (O(1) sequence) |
| paginated `/admin/users` `order by created_at limit 50` | 24ms top-N sort over 80K | **0.077ms** Index Scan |

The `/users` result is what surfaced the missing `created_at` index — added `professionals(created_at)` + `ples(created_at)` (the ~300× win above). 80K rows seeded in 4s.

## 4. TMC scraper — LIVE test verdict

Ran the `license-verifier/` service standalone against the real `https://checkmd.tmc.or.th/En/v3`:

| Check | Result |
|---|---|
| Service boot + `x-internal-token` gate | ✅ `{status:'ok'}`; 401 without the token |
| Reaches the live site | ✅ **no network block, no captcha** |
| Form fill → submit → parse | ✅ synthetic name → `not_found` via explicit no-record detection |
| Input validation | ✅ missing name → `unavailable` (fast) |
| Latency | ⏱️ **~14–15s/lookup** (headless-Chromium launch dominates) |
| `verified` / `name_mismatch` branch | ⚠️ **untested** — needs a real licensed Thai name + license number |

**Verdict:** the scraping mechanism is **viable** today (the page is server-rendered, no captcha, parses cleanly). It stays **best-effort** (a captcha or markup change → `unavailable`, never a false negative) and is gated behind the backend circuit-breaker + admin manual-verify, so it can never hard-block a legitimate user. Enable with `LICENSE_VERIFIER_ADAPTER=tmc_scrape` + `LICENSE_VERIFIER_URL` once reviewed.

**Scale caveat (important before enabling):** the license check runs **synchronously** inside `signup/verify-otp` and invite-accept. With the stub it's instant; with `tmc_scrape` it adds **~15s** to a physician signup. Since physicians are **soft-gated** (the result only flags for review), the physician-path verify should be made **async** (provision immediately, verify in the background, update `license_status` on completion). Keep the auditor path synchronous (hard gate). _Recommended, not yet implemented — the system is held on `stub`._

## 5. Proven-now vs. pending-live-config

| Flow | Status | Notes |
|---|---|---|
| Email-OTP signup send + **verify** + provision | ✅ **proven LIVE** | real OTP via Resend SMTP → P-003, license verified, real session (2026-06-09) |
| Forgot-password / OTP email **delivery** | ✅ **proven LIVE** | Resend delivered real emails; OTP template (Confirm-signup + Magic-link both → `{{ .Token }}`) |
| **Google sign-in** (real token → backend validate → login) | ✅ **proven LIVE** | real Google consent → Supabase session → `/auth/oauth/google/complete` → 200 (2026-06-09) |
| Invite create / accept / license soft+hard gate / manual-verify | ✅ **proven LIVE** | physician→active, auditor→pending_license_review→manual_verify→active |
| TMC `not_found`/`unavailable`/validation | ✅ **live** | real `checkmd.tmc.or.th`, no captcha |
| TMC `verified`/`name_mismatch` | ⏳ | needs a real licensed name+license |
| 80K query performance | ✅ **proven LIVE** | 80K seeded; index-only scans, `next_pseudonym` 0.16ms, `/users` 0.077ms |

**Live-validation prerequisites discovered (now in `docs/AUTH-SETUP.md`):** OTP needs custom SMTP **and** `{{ .Token }}` in **both** the "Confirm signup" AND "Magic Link" templates (the new-account path uses Confirm-signup); the backend now verifies both `email` and `signup` OTP types.

`docs/E2E-RUNBOOK.md` is the command-by-command script for the ⏳ rows once Supabase is configured.

## 6. Recommendations (priority order)

1. **Run the migrations** before live use: `db/migration-license-invites.sql` (pending) + `db/migration-scale.sql`.
2. **Configure Supabase** (SMTP, `{{ .Token }}` template, Google provider, anon key) — the gate for OTP/Google/reset. See `docs/AUTH-SETUP.md`.
3. **Make the physician license-verify async** before flipping to `tmc_scrape` (removes the ~15s from signup at scale).
4. **Provide test-Supabase creds** to run the 80K benchmark + the live all-roles E2E; optionally a real license to confirm the scraper's `verified` branch.
