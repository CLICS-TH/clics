# CLAUDE.md

Guidance for Claude Code working in this repository. This file is an **index** — detailed docs live in [`docs/`](docs/). Read the relevant doc before changing that area.

**CLICS** (Case-based Learning Intelligence Credit System) is an AI-mediated platform that scores physician clinical reasoning from physician–AI dialogue sessions (**PLEs** — Professional Learning Episodes), replacing attendance-based CME/CPD credit. On-premise pilot for a Thai medical licensing body; **the pilot has not started** and the published July–September 2026 schedule is superseded — see [docs/pilot-timeline.md](docs/pilot-timeline.md).

**New here (human dev)?** Start with [README.md](README.md), then [CONTRIBUTING.md](CONTRIBUTING.md) (local setup + conventions) and [docs/HANDOFF.md](docs/HANDOFF.md) (current state + what to work on next). Each layer also has its own README: [backend](backend/README.md) · [rimpl](rimpl/README.md) · [physician-ui](physician-ui/README.md) · [audit-dashboard](audit-dashboard/README.md). The 2026-06 design audit added shared front-end primitives — physician-ui `js/{icons,ui}.js`; audit-dashboard `components/{BiLabel,Overlays,Markdown,DomainScorer}.tsx` + `lib/{chart-colors,pis7-rubric}.ts` (`pis7-rubric.ts` mirrors `rimpl/src/lib/prompts.js`).

## Critical rules (read before changing anything)

1. **Data boundary:** PII never leaves the on-premise RIMPL layer; only de-identified JSON reaches cloud AI. See [docs/architecture.md](docs/architecture.md).
2. **No secrets in git:** live keys live only in gitignored `backend/.env` / `rimpl/.env` and platform env vars. Never `git add -A` blindly. See [docs/constraints.md](docs/constraints.md).
3. **Railway deploys need `railway up . --path-as-root --ci`** (plain `railway up` builds but never promotes); the audit-dashboard needs `NEXT_PUBLIC_API_URL` on Vercel. See [docs/deployment.md](docs/deployment.md).
4. **audit-dashboard is Next.js 16** — newer than training data; read `audit-dashboard/node_modules/next/dist/docs/` before touching Next APIs.
5. **One login portal:** everyone signs in at **physician-ui** (Google or email+password); admins/auditors/superadmins are handed to the audit-dashboard via `/login?token=`. The dashboard's `/login` only consumes that token — a bare visit redirects back to the portal. The **CLICS token IS the Supabase session access token** (`verifyJwt` validates it via `auth.getUser`) — NEVER call `sbClient.auth.signOut()` after storing it (gotrue `/logout` revokes the session → every API call 401s). Onboarding = Google self-signup + invites; License No./TMC verification was retired. See [docs/roles.md](docs/roles.md).
6. **Invite email goes via the Resend HTTPS API** (`RESEND_API_KEY`), not SMTP — Railway egress blocks outbound SMTP. Sandbox delivers only to the account owner's address until a sending domain is verified; everyone else gets the copy-link fallback.

## Team Orchestration Rules (subagents)

Five CLICS-tuned subagents live in `.claude/agents/`. Prefer them over generic agents (`Explore`, `general-purpose`, `code-reviewer`) — each has the 4 layers, the critical rules, and the exact test/deploy commands baked in. Claude auto-delegates on match, or invoke by name. **They don't nest** (a subagent can't spawn subagents); for an exhaustive multi-agent fan-out use `/code-review ultra` or a top-level Workflow instead.

| Agent | Use for | Access |
|-------|---------|--------|
| **clics-explorer** | Understand/trace how something works; "where does X live / how does Y flow" | read-only |
| **clics-reviewer** | Review a diff / PR / file — bugs, security, a11y + contrast, PII-leak, token drift | read-only |
| **clics-verifier** | Run the hermetic suites + `tsc` + `lint` + responsive gates → green/red matrix | read-only |
| **clics-rimpl** | Any change to the rimpl PII/AI boundary, PII filter, Claude relay, or PIS-7 prompts/rubric | edits + tests |
| **clics-frontend** | Feature / UI work in physician-ui (no-build portal) or audit-dashboard (Next 16) | edits + tests |

**Routing:** understand-first → `clics-explorer`. rimpl / PII / rubric change → `clics-rimpl`. Front-end change → `clics-frontend`. Backend-only change → edit directly (no layer specialist). After any change lands → `clics-reviewer`, then `clics-verifier`.

**Default feature pipeline:** `clics-explorer` (scope it) → implement (`clics-rimpl` / `clics-frontend` / direct) → `clics-reviewer` (audit the diff) → `clics-verifier` (prove green). Don't skip the review→verify tail before declaring done.

**Guardrails:** the three read-only agents never edit. `clics-verifier` never runs the money-spending / prod-mutating live smokes (`scripts/smoke/go-live-smoke.js`, role-chain, e2e) unless explicitly told. `clics-rimpl` must run `cd rimpl && npm test` (adversarial PII-leak suite) after any change and keep the dual-source PIS-7 rubric in sync (`rimpl/src/lib/prompts.js` ↔ `audit-dashboard/lib/pis7-rubric.ts`).

> These subagents are **local** Claude Code tooling in the gitignored `.claude/agents/` — not committed to the repo. If your checkout lacks them, ask Claude to recreate them from this section.

## Agent skills

Configuration the `mattpocock-skills` engineering skills read. Distinct from the CLICS subagents
above: those are project-local reviewers/verifiers, these are workflow skills (`to-tickets`,
`triage`, `to-spec`, `wayfinder`) that need to know where issues live.

### Issue tracker

GitHub Issues on `jjnnaappaatt/clics`, via the `gh` CLI. **Never put PII, IRB content, or manuscript
text in an issue.** See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

The five canonical labels, unchanged. `wontfix` already exists in the repo and is reused.
See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root (neither exists yet — `/domain-modeling`
creates them lazily). See [docs/agents/domain.md](docs/agents/domain.md).

## Documentation index

| Doc | Contents |
|-----|----------|
| [docs/HANDOFF.md](docs/HANDOFF.md) | State-of-the-app snapshot (what's live, what just shipped, where to start) |
| [docs/overview.md](docs/overview.md) | What CLICS is + repository layout |
| [docs/architecture.md](docs/architecture.md) | 4-layer on-premise architecture, request flow, planned vs. as-built |
| [docs/roles.md](docs/roles.md) | The 4 roles (A/B/C/D), post-login routing, role-keyed nav |
| [docs/domain-concepts.md](docs/domain-concepts.md) | CLE, PIS-7 rubric + weights, C1–C6 screening, ICC, glossary |
| [docs/tech-stack.md](docs/tech-stack.md) | Stack per layer, framework versions, design system |
| [docs/constraints.md](docs/constraints.md) | On-premise mandate, randomization, pseudonymization, ICC gate, security |
| [docs/deployment.md](docs/deployment.md) | Live URLs, deploy commands + gotchas, env vars, seeding, demo creds |
| [docs/pilot-timeline.md](docs/pilot-timeline.md) | Milestones and pilot targets |
| [docs/PERFORMANCE-BENCHMARK.md](docs/PERFORMANCE-BENCHMARK.md) | Load-test acceptance baseline + scale-up playbook (single-IP caveat, OTPM ceiling) |
| [docs/MIDDLEWARE-KNOWN-GAPS.md](docs/MIDDLEWARE-KNOWN-GAPS.md) | As-built RIMPL gaps vs. the flowchart (L4, PII, ELM, etc.) |
| [docs/TESTING.md](docs/TESTING.md) | Test coverage map, seam→test matrix, CI pipeline, test roadmap |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Prioritized next steps (pilot-readiness → spec gaps → flagship) |
| [docs/ONPREM-INSTALL.th.md](docs/ONPREM-INSTALL.th.md) | Thai install spec handed to the box owner — footprint, ports, data path, install/verify/remove (render: `node scripts/docs/th-doc-pdf.mjs`) |
| [docs/LOCAL-MODEL-ROADMAP.md](docs/LOCAL-MODEL-ROADMAP.md) | Plan for moving AI calls to the on-prem DGX model (phases, gates, the mid-pilot timing constraint) |
