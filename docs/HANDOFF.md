# CLICS — Handoff Snapshot

*State of the app as of **2026-06-15**, for the developer continuing this project. Pairs with
[../README.md](../README.md) (orientation), [../CONTRIBUTING.md](../CONTRIBUTING.md) (how to work in it),
and [ROADMAP.md](ROADMAP.md) (what to build next).*

## What's live in production

The prototype is feature-complete and deployed (both front-ends on Vercel, backend + RIMPL on Railway,
Supabase Postgres). Working end-to-end today:

- **Auth & roles** — one login portal (physician-ui); Google OAuth (flag-gated by `OAUTH_ENABLED`) +
  email/password + invites. Four roles (Physician / Auditor / Admin / Superadmin) across **multiple
  councils** with council isolation. The CLICS token is the Supabase session token (see the never-`signOut`
  rule). License-No./TMC verification was retired. See [roles.md](roles.md), [AUTH-SETUP.md](AUTH-SETUP.md).
- **Physician flow** — create a PLE (with chief complaint), chat with the AI (citations + a Socratic
  follow-up per turn), pause/resume, end → CLE gate → PIS-7 evaluation → result + LPDP trend. Guest mode
  (anonymous, 2 prompts, no persistence). Per-user **$0.50 AI cap** with an allowance meter.
- **Auditor flow** — blind PIS-7 scoring of *evaluated* sessions assigned via `ples.auditor_id`; the
  rubric-anchored **DomainScorer** (tappable 0–5 chips, no silent-0 default, submit blocked until all 7
  domains are set); AI score revealed only after submit; ICC(2,1) of AI-vs-auditor.
- **Admin/Superadmin** — PLE list + assignment, flagged-QA queue, invites, users + usage management,
  executive overview, ICC dashboard. De-identified `/admin/export`.
- **Integrity** — consent gate, PII stripping in RIMPL before any cloud call, pseudonyms (`P-NNN`),
  Helmet + rate limits. Concurrency benchmarked: 200+ concurrent reads / 110 distinct simultaneous users,
  0 errors (the AI path's ceiling is Anthropic **OTPM** — see [PERFORMANCE-BENCHMARK.md](PERFORMANCE-BENCHMARK.md)).

## What just shipped (2026-06-15)

A test-hardening + mobile-polish cycle, pushed to master (`1d9a6db`…`e433d41`, CI green) with the
**audit-dashboard redeployed to Vercel**:

- **Automated test pipeline (CI).** `.github/workflows/ci.yml` runs the whole hermetic set on every
  push/PR: backend (**222** tests) + rimpl (all 8 suites now hermetic — the `chat`/`rag-pii`/
  `evaluate-validation` integration suites mock Supabase, no env) + license-verifier + audit-dashboard
  (jest **component tests** + tsc + **blocking ESLint**), each with **coverage-threshold gates**
  (`--coverage`). Six cross-role suites prove the role handoffs. See [TESTING.md](TESTING.md).
- **Dashboard refactor (deployed).** The `react-hooks/set-state-in-effect` debt fixed by migrating
  theme/viewport/auth to `useSyncExternalStore` (`lib/client-store.ts`); `/admin/ples` reads its
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
live by reassigning an evaluated PLE to `auditor1`. The original Claude Design audit PDF is in
[design/](design/).

> ⚠️ **Demo-data note:** live verification (the design-audit smoke + the 2026-06-15 role-chain / browser
> E2E / cross-council smokes) mutated demo data on the shared Supabase — several evaluated PLEs were
> (re)assigned to auditor1 and one (`e2ba5470`) scored, and a 2nd-council demo auditor `auditor2@clics.th`
> (Pharmacy) was seeded. All of it is throwaway pre-pilot data that `db/reset-demo.js` clears before real participants.

## Where to start (improvement on-ramp)

[ROADMAP.md](ROADMAP.md) is the prioritized backlog. The **P1 (pilot-readiness)** items are the natural
first contributions:

- `db/reset-demo.js` — one-command reproducible demo (incl. an assigned auditor queue item, so the scorer
  is always demoable). *(Backend route tests, CI, and coverage gates shipped 2026-06-15 — see
  [TESTING.md](TESTING.md); what's left there is dashboard component coverage + a staging smoke job.)*
- `/health/deep` on RIMPL + a backend pre-routing check, so an outage surfaces cleanly instead of per-message 502s.
- Cross-pause active-time persistence; Resend sending-domain verification.

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
`doctor1@clics.th` → create a PLE → chat → expect content + ≥1 `(Source, Year)` ref + a Socratic
question → end → result. As `auditor1@clics.th` → QA Queue → an assigned evaluated PLE → DomainScorer.
As `superadmin@clics.th` → overview / ICC / users.
