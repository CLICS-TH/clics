# CLICS — Clinical Learning & Intelligence Credit System

CLICS is an AI-mediated platform that scores physician **clinical reasoning** from physician–AI
dialogue sessions (**PLEs** — Professional/Clinical Learning Episodes), replacing attendance-based
CME/CPD credit with evidence of cognitive engagement. It is an **on-premise pilot** for a Thai
medical licensing body, running **July–September 2026** (~75 physicians × 3 PLEs each).

> **New here?** Read this page, then **[`CONTRIBUTING.md`](CONTRIBUTING.md)** (run it locally + how to
> work in the repo) and **[`docs/HANDOFF.md`](docs/HANDOFF.md)** (current state + what to work on next).
> `CLAUDE.md` is the index/critical-rules file for AI coding agents.

## Architecture at a glance

```
   ┌──────────────────┐      ┌──────────────────┐
   │   physician-ui   │      │  audit-dashboard │     browsers (Vercel)
   │  portal · :3000  │      │ consoles · :3002 │
   └────────┬─────────┘      └────────┬─────────┘
            │   HTTPS + JWT (Supabase session access token)
            ▼                         ▼
   ┌─────────────────────────────────────────────┐
   │   backend   Express REST · :3001 (Railway)   │──►  Supabase  (Postgres + Auth, RLS)
   └────────┬────────────────────────────────────┘
            │   internal HTTP + x-internal-token
            ▼
   ┌─────────────────────────────────────────────┐
   │   rimpl   on-prem PII/AI boundary · :3003    │──►  Cloud AI (Anthropic Claude)
   └─────────────────────────────────────────────┘
        ▲ PII stripped here — only de-identified JSON leaves
```

**The core invariant:** PII never leaves the on-premise RIMPL layer; only de-identified JSON reaches
cloud AI. Full request flow and the planned-vs-as-built picture are in
[`docs/architecture.md`](docs/architecture.md).

## Repository layout

| Path | What it is | Deployed to |
|------|------------|-------------|
| [`physician-ui/`](physician-ui/) | Static HTML/JS physician portal (phone-first, bilingual, no build step) | Vercel |
| [`audit-dashboard/`](audit-dashboard/) | Next.js 16 dashboard — Admin / Superadmin / Auditor consoles | Vercel |
| [`backend/`](backend/) | Node.js/Express REST API + Supabase SDK; the only caller of RIMPL | Railway |
| [`rimpl/`](rimpl/) | On-premise RIMPL middleware — PII boundary + AI calls (internal-only) | Railway |
| [`db/`](db/) | Postgres `schema.sql`, `migration-*.sql`, and seed scripts | Supabase |
| [`docs/`](docs/) | The documentation set (see map below) | — |
| [`scripts/`](scripts/) | loadtest / soak / scale / e2e / provision / calibration tooling | — |
| `license-verifier/` | Optional TMC license-scraper microservice (off by default) | Railway |

## Quickstart (local)

Prereq: **Node ≥ 22** and the project's Supabase credentials (ask the team — real keys live only in
gitignored `.env` files, never in git).

```bash
# 1. Install dependencies in each layer
(cd backend && npm install)
(cd rimpl && npm install)
(cd audit-dashboard && npm install)
(cd physician-ui && npm install)

# 2. Configure — copy each .env.example and fill in the Supabase keys
cp backend/.env.example          backend/.env
cp rimpl/.env.example            rimpl/.env
cp audit-dashboard/.env.example  audit-dashboard/.env.local
# physician-ui needs no .env — it auto-targets localhost in public/js/config.js

# 3. Run each layer (4 terminals)
(cd backend && npm run dev)                    # :3001  REST API
(cd rimpl   && npm run dev)                    # :3003  PII/AI middleware
(cd physician-ui && npm run dev)               # :3000  static portal
(cd audit-dashboard && npm run dev -- -p 3002) # :3002  dashboard (portal expects it here)

# 4. Open http://localhost:3000 and sign in with a demo account (creds in docs/deployment.md)
```

**Port map:** physician-ui `3000` · backend `3001` · audit-dashboard `3002` · rimpl `3003`.
Note `next dev` defaults to `3000`, which collides with the portal — run the dashboard with `-p 3002`
so the portal's `CLICS_DASHBOARD_URL` handoff works. Full setup details and conventions are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Live URLs

| Service | URL |
|---------|-----|
| Physician portal | https://physician-ui.vercel.app |
| Audit dashboard | https://audit-dashboard-rouge.vercel.app |
| Backend API | https://backend-production-c12e4.up.railway.app |
| RIMPL | internal-only (`rimpl.railway.internal:3003`, no public domain) |

Deploys run from the **local working tree** (not GitHub) — see [`docs/deployment.md`](docs/deployment.md)
for the exact commands and the two gotchas that break prod silently (Railway `--path-as-root`,
audit-dashboard `NEXT_PUBLIC_API_URL` on Vercel).

## Documentation map

- **Start here:** [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`docs/HANDOFF.md`](docs/HANDOFF.md) · [`CLAUDE.md`](CLAUDE.md) (rules + index)
- **Architecture & domain:** [overview](docs/overview.md) · [architecture](docs/architecture.md) · [roles](docs/roles.md) · [domain-concepts](docs/domain-concepts.md) · [tech-stack](docs/tech-stack.md) · [constraints](docs/constraints.md)
- **Per layer:** [backend](backend/README.md) · [rimpl](rimpl/README.md) · [physician-ui](physician-ui/README.md) · [audit-dashboard](audit-dashboard/README.md)
- **Operations:** [deployment](docs/deployment.md) · [AUTH-SETUP](docs/AUTH-SETUP.md) · [DEPLOY-STAGE2](docs/DEPLOY-STAGE2.md) · [GO-LIVE-CHECKLIST](docs/GO-LIVE-CHECKLIST.md)
- **Testing & performance:** [TESTING](docs/TESTING.md) · [E2E-RUNBOOK](docs/E2E-RUNBOOK.md) · [PERFORMANCE-BENCHMARK](docs/PERFORMANCE-BENCHMARK.md) · [LOADTEST-2026-06](docs/LOADTEST-2026-06.md)
- **Roadmap & gaps:** [ROADMAP](docs/ROADMAP.md) · [MIDDLEWARE-KNOWN-GAPS](docs/MIDDLEWARE-KNOWN-GAPS.md) · [pilot-timeline](docs/pilot-timeline.md)
- **Design:** [DESIGN-claude.md](DESIGN-claude.md) (brand/design system) · [docs/design/](docs/design/) (the original Claude Design audit PDF)
- **For end users / management:** [USER-GUIDE.md](USER-GUIDE.md) · [MANAGER-SUMMARY.md](MANAGER-SUMMARY.md)

## Critical rules (the ones that bite hardest — full list in [`CLAUDE.md`](CLAUDE.md))

1. **Data boundary** — PII never leaves RIMPL; only de-identified JSON reaches cloud AI.
2. **No secrets in git** — live keys live only in gitignored `.env` files; never `git add -A` blindly.
3. **The CLICS token IS the Supabase session token** — never call `sbClient.auth.signOut()` after
   storing it (gotrue `/logout` revokes the session → every API call 401s).
4. **audit-dashboard is Next.js 16** (newer than most training data) — read
   `audit-dashboard/node_modules/next/dist/docs/` before touching Next APIs.

---

*On-premise pilot software for a Thai medical licensing body. Private repository — demo credentials in
the docs are throwaway and rotate before the real pilot.*
