# Project Overview

**CLICS** (Case-based Learning Intelligence Credit System) is an AI-mediated platform for assessing physician clinical reasoning in Continuing Medical Education (CME/CPD). It replaces attendance-based credits with evidence of cognitive engagement captured from physician–AI dialogue sessions called **PLEs** (Professional Learning Episodes).

This is an on-premise pilot system for a Thai medical licensing body, designed for ~75 physicians completing 3 PLEs each. **The pilot has not started** — CREC approval, which data collection is defined relative to, has not been granted, and the published July–September 2026 schedule is superseded. See [pilot-timeline.md](pilot-timeline.md).

## Repository layout

| Path | What it is | Deployed to |
|------|------------|-------------|
| `physician-ui/` | Static HTML/JS physician portal (10 HTML pages, no build step) | Vercel |
| `audit-dashboard/` | Next.js 16 dashboard for Admin / Superadmin / Auditor | Vercel |
| `backend/` | Node.js/Express REST API + Supabase SDK | Railway |
| `rimpl/` | On-premise RIMPL middleware (internal-only) | Railway |
| `db/` | Postgres schema + seed scripts (`seed-users.js`, `seed-documents.js`) | — |
| `docs/` | This documentation set | — |

See [deployment.md](deployment.md) for live URLs and how to deploy.
