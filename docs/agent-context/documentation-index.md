# Documentation index

Moved out of `CLAUDE.md` (it was over the 16,000-char budget). The doc names are repo-root paths; the link targets are relative to this file.

| Doc | Contents |
|-----|----------|
| [docs/HANDOFF.md](../HANDOFF.md) | State-of-the-app snapshot (what's live, what just shipped, where to start) |
| [docs/overview.md](../overview.md) | What CLICS is + repository layout |
| [docs/architecture.md](../architecture.md) | 4-layer on-premise architecture, request flow, planned vs. as-built |
| [docs/roles.md](../roles.md) | The 4 roles (A/B/C/D), post-login routing, role-keyed nav |
| [docs/domain-concepts.md](../domain-concepts.md) | CLE, PIS-7 rubric + weights, C1–C6 screening, ICC, glossary |
| [docs/tech-stack.md](../tech-stack.md) | Stack per layer, framework versions, design system |
| [docs/constraints.md](../constraints.md) | On-premise mandate, randomization, pseudonymization, ICC gate, security |
| [docs/deployment.md](../deployment.md) | Live URLs, deploy commands + gotchas, env vars, seeding, demo creds |
| [docs/pilot-timeline.md](../pilot-timeline.md) | Milestones and pilot targets |
| [docs/PERFORMANCE-BENCHMARK.md](../PERFORMANCE-BENCHMARK.md) | Load-test acceptance baseline + scale-up playbook (single-IP caveat, OTPM ceiling) |
| [docs/MIDDLEWARE-KNOWN-GAPS.md](../MIDDLEWARE-KNOWN-GAPS.md) | As-built RIMPL gaps vs. the flowchart (L4, PII, ELM, etc.) |
| [docs/TESTING.md](../TESTING.md) | Test coverage map, seam→test matrix, CI pipeline, test roadmap |
| [docs/ROADMAP.md](../ROADMAP.md) | Prioritized next steps (pilot-readiness → spec gaps → flagship) |
| [docs/ONPREM-INSTALL.th.md](../ONPREM-INSTALL.th.md) | Thai install spec handed to the box owner — footprint, ports, data path, install/verify/remove (render: `node scripts/docs/th-doc-pdf.mjs`) |
| [docs/BOOTH-RUNBOOK.th.md](../BOOTH-RUNBOOK.th.md) | One-page Thai runbook for booth staff (kiosk start-up, touch, Wi-Fi then hotspot, the bars, the event switch, retention); print it with `th-doc-pdf.mjs` |
| [docs/BOOTH-REHEARSAL.md](../BOOTH-REHEARSAL.md) | Mon 2 Nov rehearsal checklist: freeze, table-score p95 < 60 s and reply p95 < 15 s (`scripts/booth/score-latency.mjs`), failover, offline, switch, post-rehearsal purge |
| [docs/LOCAL-MODEL-ROADMAP.md](../LOCAL-MODEL-ROADMAP.md) | Plan for moving AI calls to the on-prem DGX model (phases, gates, the mid-pilot timing constraint) |
| [docs/ARCHITECTURE-MAPPING-CCME.md](../ARCHITECTURE-MAPPING-CCME.md) | CCME's 2026-10 architecture proposal mapped against what is built (R1–R10, 8 of 10 present), plus which model endpoints are reachable from the tailnet. **Read before designing anything for the on-prem move.** |
| [docs/adr/](../adr/) | Architecture decision records. **0001 — build no more D3 transport until a GDCC VM exists** (read before designing any backend→RIMPL network path), superseded in part by **0002 — Topology B on vm1**, the shared CME host (prepared, not live; runbook `deploy/vm1/README.md`). **0003 — the Portal root keeps the OAuth rescue and the `?logout=1` handler, whatever it renders.** **0004 — booth plays live outside pilot data** (own `booth_plays` table, scores only, no transcripts; read before touching Booth Mode). **0005 — booth cases are admitted by AI safety review + the physician sandbox, not a physician read.** **0006 — the grill play picks question variants and options from a vetted bank and never writes option text.** **0007 — PostgREST is not an app surface: `anon`/`authenticated` hold no privilege in `public`; all data goes through the backend/RIMPL on service_role** (read before granting anything or adding a client-side query) **0008 — Portal Google sign-in runs in-page via Google Identity Services, loads Google's script only on click, and keeps the Supabase redirect behind `CLICS_GOOGLE_SIGNIN`** (read before touching any Google sign-in path) **0009 — a booth play's demo score is read from the case's path score table, built offline by the locked evaluator; no evaluator call during a play** **0010 — booth plays keep de-identified transcripts as open research data and booth audits, with no 30-day delete (supersedes part of 0004)** **0011 — five-step grill play keyed on the previous tier, tapped answers replied from a reviewed reply bank (amends 0006; wave 2)** **0013 — a five-step booth visitor sees a fixed 0–100 rescale (`display-v1`) of the stored raw demo score; storage, auditors and research keep the raw score** **0014 — a superadmin may export every booth play for internal research, tag and full times included, typed text screened again and every export audit-logged; the open dataset keeps 0010's rules (amends 0010)** (read 0004–0006, 0009–0011, 0013 and 0014 before touching Booth Mode) |
