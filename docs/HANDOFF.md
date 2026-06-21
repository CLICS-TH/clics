# CLICS — Handoff Snapshot

*State of the app as of **2026-06-21**, for the developer continuing this project. Pairs with
[../README.md](../README.md) (orientation), [../CONTRIBUTING.md](../CONTRIBUTING.md) (how to work in it),
and [ROADMAP.md](ROADMAP.md) (what to build next).*

## What's live in production

The prototype is feature-complete and deployed (both front-ends on Vercel, backend + RIMPL on Railway,
Supabase Postgres). Working end-to-end today:

- **Auth & roles** — one login portal (physician-ui); Google OAuth (flag-gated by `OAUTH_ENABLED`) +
  email/password + invites. Four roles (Physician / Auditor / Admin / Superadmin) across **multiple
  councils** with council isolation. The CLICS token is the Supabase session token (see the never-`signOut`
  rule). License-No./TMC verification was retired. See [roles.md](roles.md), [AUTH-SETUP.md](AUTH-SETUP.md).
- **Physician flow** — create a CLE (with chief complaint), chat with the AI (citations every turn;
  the Socratic follow-up is now **mode-dependent** — see the experiment below: CLE1/3 are natural,
  CLE2 + 3×-T1-fail remediation are Socratic), pause/resume, end → CLE gate → PIS-7 evaluation →
  result + LPDP trend. Guest mode (anonymous, 2 prompts, no persistence). Per-user **$0.50 AI cap**
  with an allowance meter.
- **Auditor flow** — blind PIS-7 scoring of *evaluated* sessions assigned via `cles.auditor_id`; the
  rubric-anchored **DomainScorer** (tappable 0–5 chips, no silent-0 default, submit blocked until all 7
  domains are set); AI score revealed only after submit; ICC(2,1) of AI-vs-auditor.
- **Admin/Superadmin** — CLE list + assignment, flagged-QA queue, invites, users + usage management,
  executive overview, ICC dashboard. De-identified `/admin/export`.
- **Integrity** — consent gate, PII stripping in RIMPL before any cloud call, pseudonyms (`P-NNN`),
  Helmet + rate limits. Concurrency benchmarked: 200+ concurrent reads / 110 distinct simultaneous users,
  0 errors (the AI path's ceiling is Anthropic **OTPM** — see [PERFORMANCE-BENCHMARK.md](PERFORMANCE-BENCHMARK.md)).

## What just shipped (2026-06-21) — daily-summary email: removed the cloud sandbox entirely

Ops/tooling fix (not an app-runtime path — the $0.50 cap, blind scoring, and PII boundary are untouched).
The daily Thai progress-summary email kept silently landing as a **Gmail draft** instead of sending. The
2026-06-19 fix (move the *send* to GitHub Actions, keep *generation* in the routine) wasn't enough: on
**2026-06-21** the routine drafted again because `gh` was **not present in the cloud sandbox**, so its
`gh workflow run` dispatch never fired. Root cause, with decisive evidence: the sibling `lidar-hpe`
routine succeeded **4 minutes later in the same cloud environment** — so `gh` availability is **per-repo
GitHub-connection**, and clics's connection is intermittently absent where lidar's is solid. Every failure
this email ever had (jq missing → urllib UA → Python <3.12 f-string → Resend egress block → now `gh`
missing) was a **cloud-sandbox quirk**. So the fix removes the sandbox from the path.

Fix (mirrors lidar-hpe's self-contained `daily_update.py`): generate the report **deterministically inside
GitHub Actions** — no LLM, no sandbox — and trigger it with **native cron**.

- **`scripts/daily-summary/gen_summary.py`** (new, replaces `gen_fallback.py`) — builds the whole `data.json`
  from the runner's git checkout: 24h metrics + a rule-based plain-Thai humanization of the commits
  (conventional-commit prefix → Thai outcome verb, light de-jargon) + the pending **P1** backlog mapped to
  curated Thai sentences (un-mapped bullets are dropped, never leaked as English). Stdlib only, no network.
- **`.github/workflows/daily-summary.yml`** — now triggered by native `schedule:` cron run **twice**
  (08:11 + 08:41 Asia/Bangkok); the 08:41 run is a self-heal **backstop** gated by a dedup guard
  (`gh run list`) so it sends only if the 08:11 run didn't already succeed today → exactly one email on a
  normal day, still covered if GitHub drops the first cron. `workflow_dispatch` stays for manual sends.
  `send.py` (unchanged) renders + POSTs to Resend with the `RESEND_API_KEY` secret.
- **Old LLM routine disabled** (`trig_013if2V1ttgvCmpEhxDq2Pma`, set `enabled:false`) so it can't draft or
  double-send. Trade-off: deterministic Thai is a little less polished than the routine's LLM, but it never
  silently degrades to a draft. Runbook in `scripts/daily-summary/README.md`.

## What just shipped (2026-06-17 / 18) — protocol alignment + readiness

The **CREC/NRCT protocol-alignment** cycle (8 phases) plus a readiness-checks add — merged to `master`
(`d84595a`…`b49c370`) and live in prod (migrations applied to the shared Supabase; Railway + Vercel
redeployed). This is the cycle that built the **research experiment** the protocol hinges on:

- **CLE episode sequencing + Socratic toggle (the experiment).** `cles.episode_number` (1–3, 4th
  blocked), `socratic_active`/`socratic_reason`, `professionals.consecutive_t1_fails`. CLE1/3 run
  **natural** (no forced ❓); CLE2 runs **Socratic-from-start**; a natural session flips to Socratic
  `t1_remediation` after **3 consecutive Tier-1 fails** (resets on a pass). The rimpl prompt split into
  NATURAL / EXAMINER variants threaded by a `socratic` flag. Physician sees "CLE n/3" but not the mode.
- **Pilot Test Mode.** Superadmin toggle (`app_settings.pilot_test_mode`, on the dashboard Overview)
  that lets the team pick Natural/Socratic directly + bypass the 3-CLE cap; such CLEs are `is_test`
  (out of real export/ICC). Exercises Socratic without completing CLE1→CLE2.
- **PLE → CLE rename** across DB + all 4 layers + tests + docs (table `ples`→`cles`, `ple_id`→`cle_id`).
- **Study compliance scaffolding.** `cle_code` (CLE-NNN) + `exp_code` (EXP-NNN) pseudonyms; append-only
  `audit_log` + `logEvent()`; evaluator **version provenance** (`prompt_version`/`rubric_version` hashes);
  structured `consents` table with a physician consent modal + an **auditor confidentiality/COI gate**;
  **Tier-3 analyst** + **Tier-4 ethics** read-only oversight roles (`/oversight`); **compensation report**
  (`/admin/compensation`, ฿500/CLE capped ฿1500). Final consent *wording* still comes from the PI.
- **`/health/deep` readiness checks (P1).** Both RIMPL and the backend now expose `GET /health/deep`
  (the shallow `/health` stays a liveness ping). RIMPL probes Anthropic-key/SDK-constructibility (zero
  token spend) + Supabase; the backend aggregates its own Supabase + RIMPL's deep check, bubbling a
  per-dependency map (200 all-up / 503 degraded). The chat-route 502 gained a stable
  `code: 'rimpl_unavailable'`. See `{backend,rimpl}/src/routes/health.js`.
- **Return-to-Physician** NavBar button for dual-role (`can_audit`) users; **mobile container-query** fix
  (layout grids collapse via `@min-[…px]:` so the forced-mobile preview + real phones go 1-col).

> Reconciliation note: `db/schema.sql` is kept in sync for fresh installs; the 8 migrations
> (`migration-cle-rename.sql` first → … → `migration-oversight-roles.sql`) were applied in order to the
> shared prod Supabase, preserving data.

## What shipped 2026-06-15

A test-hardening + mobile-polish cycle, pushed to master (`1d9a6db`…`e433d41`, CI green) with the
**audit-dashboard redeployed to Vercel**:

- **Automated test pipeline (CI).** `.github/workflows/ci.yml` runs the whole hermetic set on every
  push/PR: backend (**222** tests) + rimpl (all 8 suites now hermetic — the `chat`/`rag-pii`/
  `evaluate-validation` integration suites mock Supabase, no env) + license-verifier + audit-dashboard
  (jest **component tests** + tsc + **blocking ESLint**), each with **coverage-threshold gates**
  (`--coverage`). Six cross-role suites prove the role handoffs. See [TESTING.md](TESTING.md).
- **Dashboard refactor (deployed).** The `react-hooks/set-state-in-effect` debt fixed by migrating
  theme/viewport/auth to `useSyncExternalStore` (`lib/client-store.ts`); `/admin/cles` reads its
  `?status=` drill-down via `useSearchParams` + a Suspense boundary; all 54 `no-explicit-any` typed
  (`lib/types.ts`). `next.config.ts` pins the Turbopack / output-tracing root (the new root
  `package.json` for the dev stack otherwise confused Next's multi-lockfile detection).
- **Mobile layout fixed (deployed).** The nav action cluster no longer overflows phones (icon-only
  toggles + RoleBadge subtitle hidden < 640px) and the auditor scoring page stacks correctly
  (`grid-cols-1`). Audited every page at 320–390px → 0 horizontal overflow.
- **One-command local stack.** `npm run dev` at the repo root boots all four layers (`concurrently`);
  `npm run test:all` runs every hermetic suite.
- **Cross-council guard in the live smoke.** `scripts/smoke/role-chain-smoke.js` now asserts a
  cross-council assign → 409; a 2nd-council (Pharmacy) auditor `auditor2@clics.th` was seeded so it
  fires on real data — live run **21/21**. Full role-chain also browser-E2E'd on prod.

## What shipped before that (2026-06-13 / 14)

Commit **`bf9d5f8`** — the **Claude Design UX/UI audit + a simplify pass**, applied to both front-ends
(frontend only — backend/rimpl untouched, so the $0.50 cap, blind-scoring, and PII boundary are unchanged),
then **deployed to Vercel**. Highlights:

- Flat coral CTA (`#a9583e`, white text 5.06:1 — passes WCAG AA; was a ~3:1 gradient).
- Rubric-anchored **`DomainScorer`** replacing the old `DomainSliders` (deleted); themed
  confirm-modal + toast (`Overlays.tsx` / physician-ui `ui.js`) replacing native dialogs; lucide /
  inline-SVG line-icons replacing functional emoji; bilingual hierarchy (`BiLabel` / `.bi`).
- Auditor gets the physician-grade markdown transcript (`react-markdown` + `remark-gfm`).
- Chart status colors centralized into tokens (`--chart-pass/-fail/-threshold/-warn`); `TranscriptView`
  memoized; physician usage meter reframed to "AI allowance %".
- New shared modules: physician-ui `public/js/{icons,ui}.js`; audit-dashboard
  `components/{BiLabel,DomainScorer,Markdown,Overlays}.tsx`, `lib/{chart-colors,pis7-rubric}.ts`.
  **`lib/pis7-rubric.ts` mirrors `rimpl/src/lib/prompts.js` — keep the two in sync.**

Prod auth'd smoke (superadmin + auditor) passed with **0 console errors**; the DomainScorer was verified
live by reassigning an evaluated CLE to `auditor1`. The original Claude Design audit PDF is in
[design/](design/).

> ⚠️ **Demo-data note:** live verification (the design-audit smoke + the 2026-06-15 role-chain / browser
> E2E / cross-council smokes) mutated demo data on the shared Supabase — several evaluated CLEs were
> (re)assigned to auditor1 and one (`e2ba5470`) scored, and a 2nd-council demo auditor `auditor2@clics.th`
> (Pharmacy) was seeded. All of it is throwaway pre-pilot data that `db/reset-demo.js` clears before real participants.

## Where to start (improvement on-ramp)

[ROADMAP.md](ROADMAP.md) is the prioritized backlog. The **P1 (pilot-readiness)** *engineering* items
are now done — verified 2026-06-18: `db/reset-demo.js` (protocol-aware), cross-pause `active_seconds`
(client accumulates incrementally → server clamps to wall-clock → C1 gate reads it), automated CI, and
`/health/deep`. What remains under P1 is **org-only**: rotate `ANTHROPIC_API_KEY` + demo passwords, and
verify a Resend sending domain (see [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md)).

So the natural next contributions are **P2 spec gaps** — top of the list is full reversible PII
pseudonymization (`P-`/`CLE-` lookup table + broader Thai-name coverage in `rimpl/src/services/pii-filter.js`).

## Known gaps & deferred work

- **Full middleware spec** — [MIDDLEWARE-KNOWN-GAPS.md](MIDDLEWARE-KNOWN-GAPS.md): L4 multi-provider
  rotation not built (Claude-only, `claude-sonnet-4-6`); the "4 pre-filter signals" and "ELM" are
  spec'd but not implemented; PII is regex-mask + pseudonym, not yet a fully reversible lookup table
  (residual risk: bare unlabelled Thai names — see `rimpl/src/services/pii-filter.js`).
- **#12b full i18n** — only the *label hierarchy* exists (`BiLabel`/`.bi`); there is **no i18n system**
  (a ไทย/EN toggle showing one language at a time, hundreds of strings). Deferred; needs a real i18n layer.
- **LINE OAuth** absent (Supabase has no native LINE provider — needs custom OIDC). Google is live.
- The `2026-06-04` plan/spec under `docs/superpowers/` is **historical** and superseded by the design
  audit (it still describes slider-based scoring) — kept for reference, banner-flagged.

## Before real participants (non-engineering gates)

From [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md): IRB sign-off; **rotate `ANTHROPIC_API_KEY`** and the
demo passwords (`db/seed-users.js`); run `db/reset-demo.js` for a clean slate; verify the
migration-applied gate ([deployment.md](deployment.md)); optionally verify a Resend sending domain.

## Verify the app works

Sign in at the portal with a demo account (creds in [deployment.md](deployment.md)):
`doctor1@clics.th` → create a CLE → chat → expect content + ≥1 `(Source, Year)` ref + a Socratic
question → end → result. As `auditor1@clics.th` → QA Queue → an assigned evaluated CLE → DomainScorer.
As `superadmin@clics.th` → overview / ICC / users.
