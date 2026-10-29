# CLAUDE.md

Guidance for Claude Code working in this repository. This file is an **index** — detailed docs live in [`docs/`](docs/). Read the relevant doc before changing that area.

**CLICS** (Case-based Learning Intelligence Credit System) is an AI-mediated platform that scores physician clinical reasoning from physician–AI dialogue sessions (**PLEs** — Professional Learning Episodes), replacing attendance-based CME/CPD credit. On-premise pilot for a Thai medical licensing body; **the pilot has not started** and the published July–September 2026 schedule is superseded — see [docs/pilot-timeline.md](docs/pilot-timeline.md).

**New here (human dev)?** Start with [README.md](README.md), then [CONTRIBUTING.md](CONTRIBUTING.md) (local setup + conventions) and [docs/HANDOFF.md](docs/HANDOFF.md) (current state + what to work on next). Each layer also has its own README: [backend](backend/README.md) · [rimpl](rimpl/README.md) · [physician-ui](physician-ui/README.md) · [audit-dashboard](audit-dashboard/README.md). The 2026-06 design audit added shared front-end primitives — physician-ui `js/{icons,ui}.js`; audit-dashboard `components/{BiLabel,Overlays,Markdown,DomainScorer}.tsx` + `lib/{chart-colors,pis7-rubric}.ts` (`pis7-rubric.ts` mirrors `rimpl/src/lib/prompts.js`).

## Critical rules (read before changing anything)

1. **Data boundary:** PII never leaves the on-premise RIMPL layer; only de-identified JSON reaches cloud AI. See [docs/architecture.md](docs/architecture.md).
2. **No secrets in git:** live keys live only in gitignored `backend/.env` / `rimpl/.env` and platform env vars. Never `git add -A` blindly. See [docs/constraints.md](docs/constraints.md).
3. **Railway deploys need `railway up . --path-as-root --service backend|rimpl --ci`** (plain `railway up` builds but never promotes; without `--service` a directory linked to the wrong service deploys over it, which replaced the backend with rimpl on 2026-10-14); the audit-dashboard needs `NEXT_PUBLIC_API_URL` on Vercel. See [docs/deployment.md](docs/deployment.md).
4. **audit-dashboard is Next.js 16** — newer than training data; read `audit-dashboard/node_modules/next/dist/docs/` before touching Next APIs.
5. **One login portal:** everyone signs in at **physician-ui** (Google or email+password); admins/auditors/superadmins are handed to the audit-dashboard via `/login?token=`. The dashboard's `/login` only consumes that token — a bare visit redirects to the Portal's `/login`. The **CLICS token IS the Supabase session access token** (`verifyJwt` validates it via `auth.getUser`) — NEVER call `sbClient.auth.signOut()` after storing it (gotrue `/logout` revokes the session → every API call 401s). Onboarding = Google self-signup + invites; License No./TMC verification was retired. See [docs/roles.md](docs/roles.md).
6. **Invite email goes via the Resend HTTPS API** (`RESEND_API_KEY`), not SMTP — Railway egress blocks outbound SMTP. Sandbox delivers only to the account owner's address until a sending domain is verified; everyone else gets the copy-link fallback.

## Commands (repo root; not an npm workspace)

```bash
npm run install:all   # every layer's deps
npm run dev           # backend :3001, rimpl :3003, portal :3000, dashboard :3002 (also .claude/launch.json)
                      # ⚠ local .env = the PROD Supabase; the backend's eval drain runs unless NODE_ENV=test
                      #   (backend/src/index.js:121) → it scores queued PLEs (DB writes + AI spend). Read-only
                      #   driving: .claude/skills/verify-clics/bin/verify-clics launch
npm run test:all      # hermetic: backend, rimpl, license-verifier, dashboard jest
# dashboard blocking gates: cd audit-dashboard && npx tsc --noEmit && npm run lint
```

## Team Orchestration Rules (subagents)

Five CLICS-tuned subagents live in `.claude/agents/`. Prefer them over generic agents (`Explore`, `general-purpose`, `code-reviewer`) — each has the 4 layers, the critical rules, and the exact test/deploy commands baked in. Claude auto-delegates on match, or invoke by name. Each may spawn up to 3 sonnet helpers for a large task (nesting verified 2026-10-26) and keeps a project memory in `.claude/agent-memory/<agent>/MEMORY.md`; for an exhaustive multi-agent fan-out use `/code-review ultra` or a top-level Workflow instead.

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

## Subagents in the feature loop
poteto-agent writes the code. Repo agents join at fixed points:
- review: after verify and before `gh pr create`, and in /jjstack:doublej. Sort what it finds by Ticket scope in Feature loop.
- spec: during /jjstack:jjflow, ask it the domain-fact questions the grill needs.
- verify: run it during verify, next to the verify skill (`.claude/skills/verify-clics/`, read-only scope).

| Agent | Role | Covers |
|---|---|---|
| clics-reviewer | review | every diff: bugs, security, PII leak, rubric drift, blinding, a11y/contrast, Thai type, tokens |
| clics-explorer | spec | cross-layer "where/how/why" questions, doc-vs-code drift |
| clics-rimpl | spec (rimpl, PII, PIS-7 rubric, provider routing, calibration provenance) | `rimpl/`, `audit-dashboard/lib/pis7-rubric.ts` |
| clics-frontend | spec (portal + dashboard conventions) | `physician-ui/`, `audit-dashboard/` |
| clics-verifier | verify | hermetic suites, tsc, lint, responsive/readability gates |

## Learning loop
After /jjstack:doublej, and whenever I correct an agent (a ticket session does not reflect: doublej sees what its review caught):
1. Read and follow pstack's `reflect` skill on this session's transcript.
2. Route a lesson about a repo agent's domain to that agent's memory in `.claude/agent-memory/<agent>/`.
   Edit the agent file itself only when its role or scope changes.
3. Prune as you add: read the whole file a lesson lands in and cut, in the same edit, lines it replaces
   or contradicts, repeats, and lines stale against the code. Show the Accepted additions and cuts together
   and wait for my approval before changing any file.
4. Ship approved edits through review as one small `chore(agents): <lesson>` PR cut from origin/master, never on a ticket branch:
   lessons on parallel ticket branches collide in the same `.claude/**` files. A lesson whose file an open PR also edits waits for that PR to merge.
   **CLICS exception:** `.claude/` is gitignored here, so agent files and memory are local-only — apply approved edits in place, no PR, and back up `.claude/agents/` + `.claude/agent-memory/` before a batch edit.
A mistake made twice goes to /pstack:correct instead, which enforces it in the code.

## Feature loop
1. /jjstack:jjflow <idea>: grill, spec issue, tickets
2. Per ticket, new session: /pstack:poteto-mode implement #<ticket>
3. After the round's PRs are open: /jjstack:doublej #<spec>
4. Merge only what you pick in /jjstack:doublej
Ticket scope: one ticket, one PR. Fix in that PR only what fails today against the ticket's acceptance criteria or a repo invariant. Hardening, a risk from some later edit, and any other finding, from any reviewer, go into one `needs-triage` issue that links the ticket, listed in the PR body; they wait for the next /jjstack:jjflow. A new session or PR starts only when I ask for one. A bug outside the ticket that cannot wait comes to me as a question, with its issue already filed. Judge "cannot wait" by naming every live path the bug or finding breaks, and whether it bites before the next /jjstack:jjflow round or a fixed field date. A broken sign-in, claim or token link always cannot wait.
Lessons: see Learning loop. Repeated mistakes: /pstack:correct

## Agent skills

Configuration the `mattpocock-skills` engineering skills read. Distinct from the CLICS subagents
above: those are project-local reviewers/verifiers, these are workflow skills (`to-tickets`,
`triage`, `to-spec`, `wayfinder`) that need to know where issues live.

### Issue tracker

GitHub Issues on `CLICS-TH/clics`, via the `gh` CLI. **Never put PII, IRB content, or manuscript
text in an issue.** See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

The five canonical labels, unchanged. `wontfix` already exists in the repo and is reused.
See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: [`CONTEXT.md`](CONTEXT.md) (the glossary) + [`docs/adr/`](docs/adr/) (ADRs 0001–0006).
See [docs/agents/domain.md](docs/agents/domain.md).

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
| [docs/ARCHITECTURE-MAPPING-CCME.md](docs/ARCHITECTURE-MAPPING-CCME.md) | CCME's 2026-10 architecture proposal mapped against what is built (R1–R10, 8 of 10 present), plus which model endpoints are reachable from the tailnet. **Read before designing anything for the on-prem move.** |
| [docs/adr/](docs/adr/) | Architecture decision records. **0001 — build no more D3 transport until a GDCC VM exists** (read before designing any backend→RIMPL network path), superseded in part by **0002 — Topology B on vm1**, the shared CME host (prepared, not live; runbook `deploy/vm1/README.md`). **0003 — the Portal root keeps the OAuth rescue and the `?logout=1` handler, whatever it renders.** **0004 — booth plays live outside pilot data** (own `booth_plays` table, scores only, no transcripts; read before touching Booth Mode). **0005 — booth cases are admitted by AI safety review + the physician sandbox, not a physician read.** **0006 — the grill play picks question variants and options from a vetted bank and never writes option text** |
