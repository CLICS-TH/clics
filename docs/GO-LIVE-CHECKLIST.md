# CLICS — Go-Live Checklist (Stage 1: de-identified validation pilot, ≤30 physicians, no credit yet)

Decisions: **de-identified/hypothetical cases** (cloud OK, on-prem not triggered) · **validation only, no CME credit yet** (credit waits for the July calibration) · **≤30 physicians, staggered** · **in-app informed consent required**.

## ✅ Track A — engineering hardening (delivered in code)
- **Security:** rate limiting (`/auth/login` 10/min, `/auth/request-access` 5/hr, `/guest` 15/min, general 300/min) + `helmet` + 1 MB body cap + `trust proxy`; **fail-closed boot check** (prod refuses to start without the 6 secrets) + **CORS locked** to the two prod origins; account-creation **password policy** (≥10 chars, letter + digit).
- **Informed consent:** `consented_at` column + `POST /auth/consent`; **`POST /ples` is gated** (403 `consent_required`) until consent; physician-ui shows a consent + privacy screen on first login and an **always-on banner** ("de-identified cases only · scores provisional, not CME credit").
- **Study + reliability:** `GET /admin/export` (pseudonym-keyed, de-identified sessions + AI + auditor scores) and `POST /admin/reconcile-evaluations` (re-scores any session stranded at `ple_pass` so no credit is silently lost).
- **Login = email + password only.** Social sign-in (Google/LINE) was a stubbed handshake with a public `mock-callback` (could mint pending users) — now **disabled**: backend routes 404 unless `OAUTH_ENABLED=true`, and the Google/LINE buttons are removed from the physician-ui login + request-access pages. Re-enable only when a real provider handshake is wired.
- Tests: `consent-gate`, `oauth-disabled` added; backend `jest` 41/41 green.

## ✅ Deployed + verified live (2026-06-07)
- Migration `consented_at timestamptz` applied (Supabase). Backend redeployed to Railway, physician-ui to Vercel.
- **Backend hardening confirmed live** on the prod response: `helmet` headers (`x-content-type-options`, HSTS, `x-frame-options`, no `x-powered-by`) + `ratelimit-*` headers.
- **physician-ui live**: consent modal + TH/EN "de-identified / provisional" banner present in the deployed JS.
- **Smoke E2E 18/18 green** (`scripts/smoke/go-live-smoke.js`): consent gate blocks `POST /ples` **and** `/message` + `/end` before consent → passes after; 4 live AI turns return content+refs+socratic_question; PLE gate runs; `/admin/export` is de-identified (pseudonym-keyed, no PII); `/admin/reconcile-evaluations` reports nothing stranded.

### Pre-launch adversarial review (read-only, 15 agents) — verdict: **GO**
Independent agents audited consent-integrity, authz/roles, PII→cloud leak, and config/DoS/secrets, each finding cross-verified by skeptics. **0 launch-blocking.** The 4 confirmed real-but-non-blocking items: 3 were fixed + redeployed immediately as defense-in-depth —
- consent gate extended to `POST /ples/:id/message` + `/end` (was creation-only);
- rimpl `/evaluate` + `/evaluate-criteria` now `stripHistoryPii()` before Claude (matches `/chat`);
- `/admin/export` pseudonymizes `auditor_id` (stable `A-<hash>`).

The 4th (**live Supabase/Anthropic keys in local `.env`** — correctly gitignored, not in git history) is a **Track B** action: confirm prod reads keys from platform env (already true) and **rotate `ANTHROPIC_API_KEY`** before participants hit prod.

## Track B — org / process (only your team can do these)
1. **Ethics/IRB approval** + the final **consent + privacy-notice wording** (the screen is built; supply the text).
2. **Provision real participants** — clinicians request access → admin approves → pseudonyms; issue **strong unique credentials** (no shared demo passwords). Clear the demo cohort first (`db/reset-demo.js`) and change the superadmin password.
3. **Rotate `ANTHROPIC_API_KEY`** (it has been used in dev) — Railway → RIMPL env. (Other prod secrets are set + verified.)
4. **Replace throwaway creds in the repo:** remove `LOGIN-ACCOUNTS.txt` from git + gitignore it; make `db/seed-users.js` env-driven (these are dev-only conveniences today).
5. **Data sign-off:** Supabase region / DPA + a retention policy for the de-identified study data.
6. **Pilot comms:** instruct participants to use **de-identified cases only**; provide a support channel; stagger logins (Supabase throttles simultaneous-login bursts).

## Stage 2 (later — out of scope now)
- **Enable CME credit** only after the **July calibration workshop** lifts AI↔expert agreement to **ICC ≥ 0.75** (currently 0.66).
- If real patient PII is ever entered: **on-premise database** + full reversible PLE/patient pseudonymization (broaden `pii-filter.js` beyond HN/date/ward to names/age/phone/email/MRN).

## Deferred hardening (nice-to-have for Stage 1; recommended soon)
- `/health/deep` on RIMPL + a backend pre-routing check (graceful "AI busy, try again" instead of a raw 502).
- Cross-pause active-time accrual (C1 duration across paused/resumed sessions).
- Broader supertest route coverage (gate transitions, role guards, double-submit).
- Calibration harness (a repeatable "score fixed set → ICC vs human" tool for the July workshop).

## Verification (after the migration + deploy)
Walk the gated flow: a physician must accept consent before starting; the banner shows; a chat turn + score works; admin Stats reconcile + `/admin/export` returns data; auditor scores an unscored session; superadmin opens a user's score explorer. Plus a ~$1 smoke E2E on the hardened build.
