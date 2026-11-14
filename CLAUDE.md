# CLAUDE.md

Guidance for Claude Code working in this repository. This file is an **index** — detailed docs live in [`docs/`](docs/). Read the relevant doc before changing that area.

**CLICS** (Case-based Learning Intelligence Credit System) is an AI-mediated platform that scores physician clinical reasoning from physician–AI dialogue sessions (**PLEs** — Professional Learning Episodes), replacing attendance-based CME/CPD credit. On-premise pilot for a Thai medical licensing body; **the pilot has not started** and the published July–September 2026 schedule is superseded — see [docs/pilot-timeline.md](docs/pilot-timeline.md).

**New here (human dev)?** Start with [README.md](README.md), then [CONTRIBUTING.md](CONTRIBUTING.md) (local setup + conventions) and [docs/HANDOFF.md](docs/HANDOFF.md) (current state + what to work on next). Each layer also has its own README: [backend](backend/README.md) · [rimpl](rimpl/README.md) · [physician-ui](physician-ui/README.md) · [audit-dashboard](audit-dashboard/README.md). The 2026-06 design audit added shared front-end primitives — physician-ui `js/{icons,ui}.js`; audit-dashboard `components/{BiLabel,Overlays,Markdown,DomainScorer}.tsx` + `lib/{chart-colors,pis7-rubric}.ts` (`pis7-rubric.ts` mirrors `rimpl/src/lib/prompts.js`).

## Critical rules (read before changing anything)

1. **Data boundary:** PII never leaves the on-premise RIMPL layer; only de-identified JSON reaches cloud AI. See [docs/architecture.md](docs/architecture.md).
2. **No secrets in git:** live keys live only in gitignored `backend/.env` / `rimpl/.env` and platform env vars. Never `git add -A` blindly. See [docs/constraints.md](docs/constraints.md).
3. **Railway deploys need `railway up . --path-as-root --service backend|rimpl --ci`** (plain `railway up` builds but never promotes; without `--service` a directory linked to the wrong service deploys over it, which replaced the backend with rimpl on 2026-10-14); on vm1 (#429) the Portal, the dashboard (`/audit`) and the backend (`/api`) share the origin `https://clics.ccme.or.th` and deploy together with `deploy/vm1/deploy.sh`; the Vercel projects are redirects to it. See [docs/deployment.md](docs/deployment.md).
4. **audit-dashboard is Next.js 16** — newer than training data; read `audit-dashboard/node_modules/next/dist/docs/` before touching Next APIs.
5. **One login portal:** everyone signs in at **physician-ui** (Google or email+password); admins/auditors/superadmins go on to the audit-dashboard at `/audit`, on the same origin, which reads the session the Portal stored in `localStorage` (`clics_token`). No token travels in a URL: the dashboard's `/audit/login` drops a `?token=` unread, and without a stored session sends the visit to the Portal's `/login`. Locally, use `http://localhost:3080` (`npm run dev`'s one-origin proxy) for the handoff. The **CLICS token IS the Supabase session access token** (`verifyJwt` validates it via `auth.getUser`) — NEVER call `sbClient.auth.signOut()` after storing it (gotrue `/logout` revokes the session → every API call 401s). Onboarding = Google self-signup + invites; License No./TMC verification was retired. See [docs/roles.md](docs/roles.md).
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
- verify: run it during verify, next to the verify skill.
The verify skill here is `.claude/skills/verify-clics/` (read-only scope). Booth Mode facts live in the `clics-booth` skill, preloaded by clics-frontend, clics-rimpl and clics-reviewer.

| Agent | Role | Covers |
|---|---|---|
| clics-reviewer | review | every diff: bugs, security, PII leak, rubric drift, blinding, a11y/contrast, Thai type, tokens, Booth Mode |
| clics-explorer | spec | cross-layer "where/how/why" questions, doc-vs-code drift |
| clics-rimpl | spec | rimpl, PII, PIS-7 rubric, provider routing, calibration provenance, booth turns: `rimpl/`, `audit-dashboard/lib/pis7-rubric.ts` |
| clics-frontend | spec | portal + dashboard conventions, booth kiosk: `physician-ui/`, `audit-dashboard/` |
| clics-verifier | verify | hermetic suites, tsc, lint, responsive/readability gates |

## Learning loop
/jjstack:doublej reflects once per spec, when the spec closes, and only when its gates left evidence (a FAIL, a fix round,
a parked or BLOCKED PR, a correction from me). The same steps run whenever I correct an agent (a ticket session does not
reflect: doublej sees what its review caught):
1. Draft lessons from the record (the gate's state file and posted comments, or my correction), never from a whole transcript.
   Steps 2-4 decide where a lesson lands and how it ships; nothing under `plugins/cache/` is edited.
2. Agents propose lessons in their final reports and never write their own memory. Route a lesson about a
   repo agent's domain to that agent's memory in `.claude/agent-memory/<agent>/`; you, the parent, write it
   on step 4's branch. Edit the agent file itself only when its role or scope changes.
   A lesson about how to gate, verify, fix or ship (not a domain fact) goes to `.claude/skills/lessons/`,
   one file per lesson, by jjstack's `lessons` skill; jjstack's own skills are never edited from here.
   A lesson that recurs, or that more than one agent needs, moves to the domain skill's `references/` and
   leaves memory in the same edit. A lesson that would push a file over the budgets in jjstack's
   agent-architecture standard lands in a `references/` file, with an index line.
3. Prune as you add: read the whole file a lesson lands in and cut, in the same edit, lines it replaces
   or contradicts, repeats, and lines stale against the code. The PR body shows the additions and cuts together,
   each as exact text: my merge is the approval.
4. Ship them as one small `chore(agents): lessons from #<spec>` PR cut from origin/main, never on a ticket branch:
   lessons on parallel ticket branches collide in the same `.claude/**` files. No gate reviews or merges that PR: I do.
   A lesson whose file an open PR also edits waits for that PR to merge.
   **CLICS exception:** `.claude/` is gitignored here, so agent files, skills and memory are local-only. There is no PR:
   show the additions and cuts together as exact text, wait for my approval, back up `.claude/agents/`,
   `.claude/agent-memory/` and `.claude/skills/` before a batch edit, then apply them in place.

An agent that still has a `memory:` field can write into the checkout it runs in, despite step 2. After any
repo-agent run, list each write under `.claude/agent-memory/` (path plus one line) in your reply, and ship it
with the step-4 PR or name it as held for me.

A mistake made twice goes to /pstack:correct instead, which enforces it in the code.

## Feature loop
1. /jjstack:jjflow <idea>: grill, spec issue, tickets. The grill is the only place I am asked: its last answers set the slices and the spec's `Merge:` line. jjflow then starts one session per ticket and one /jjstack:doublej gate for the spec.
2. A ticket session runs /pstack:poteto-mode implement #<ticket> and ends at its PR. From there /jjstack:doublej owns CI, review threads and fixes.
3. /jjstack:doublej #<spec> reviews each PR by its ticket's tier, fixes what fails (two rounds a ticket, then the PR is parked on an issue) and starts the tickets a merge unblocks.
4. Merges follow the spec's `Merge:` line: `auto` merges the PRs the gate proved clean, `auto-partial` also those proved only on a stand-in (their unproven lines filed first); under `pick`, and for any PR that is not clean, I pick.
Ticket scope: one ticket, one PR. Fix in that PR only what fails today against the ticket's acceptance criteria or a repo invariant. Hardening, a risk from some later edit, and any other finding, from any reviewer, go into one `needs-triage` issue that links the ticket, listed in the PR body; they wait for the next /jjstack:jjflow. A new session or PR starts only when I ask for one. A bug outside the ticket that cannot wait comes to me as a question, with its issue already filed. Judge "cannot wait" by naming every live path the bug or finding breaks, and whether it bites before the next /jjstack:jjflow round or a fixed field date. A broken sign-in, claim or token link always cannot wait.
Lessons: see Learning loop. Repeated mistakes: /pstack:correct
Canary (/jjstack:setup 2026-11-13): verify-clics caught a planted portal-back-links fault, after its sign-out check was fixed (`.claude/skills/verify-clics/CANARY.md`). The browser driver runs only outside the Bash sandbox, through its `excludedCommands` entry.

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

Single-context: [`GLOSSARY.md`](GLOSSARY.md) (the glossary) + [`docs/adr/`](docs/adr/) (ADRs 0001–0011).
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
| [docs/BOOTH-RUNBOOK.th.md](docs/BOOTH-RUNBOOK.th.md) | One-page Thai runbook for booth staff (kiosk start-up, touch, Wi-Fi then hotspot, the bars, the event switch, retention); print it with `th-doc-pdf.mjs` |
| [docs/BOOTH-REHEARSAL.md](docs/BOOTH-REHEARSAL.md) | Mon 2 Nov rehearsal checklist: freeze, table-score p95 < 60 s and reply p95 < 15 s (`scripts/booth/score-latency.mjs`), failover, offline, switch, post-rehearsal purge |
| [docs/LOCAL-MODEL-ROADMAP.md](docs/LOCAL-MODEL-ROADMAP.md) | Plan for moving AI calls to the on-prem DGX model (phases, gates, the mid-pilot timing constraint) |
| [docs/ARCHITECTURE-MAPPING-CCME.md](docs/ARCHITECTURE-MAPPING-CCME.md) | CCME's 2026-10 architecture proposal mapped against what is built (R1–R10, 8 of 10 present), plus which model endpoints are reachable from the tailnet. **Read before designing anything for the on-prem move.** |
| [docs/adr/](docs/adr/) | Architecture decision records. **0001 — build no more D3 transport until a GDCC VM exists** (read before designing any backend→RIMPL network path), superseded in part by **0002 — Topology B on vm1**, the shared CME host (prepared, not live; runbook `deploy/vm1/README.md`). **0003 — the Portal root keeps the OAuth rescue and the `?logout=1` handler, whatever it renders.** **0004 — booth plays live outside pilot data** (own `booth_plays` table, scores only, no transcripts; read before touching Booth Mode). **0005 — booth cases are admitted by AI safety review + the physician sandbox, not a physician read.** **0006 — the grill play picks question variants and options from a vetted bank and never writes option text.** **0007 — PostgREST is not an app surface: `anon`/`authenticated` hold no privilege in `public`; all data goes through the backend/RIMPL on service_role** (read before granting anything or adding a client-side query) **0008 — Portal Google sign-in runs in-page via Google Identity Services, loads Google's script only on click, and keeps the Supabase redirect behind `CLICS_GOOGLE_SIGNIN`** (read before touching any Google sign-in path) **0009 — a booth play's demo score is read from the case's path score table, built offline by the locked evaluator; no evaluator call during a play** **0010 — booth plays keep de-identified transcripts as open research data and booth audits, with no 30-day delete (supersedes part of 0004)** **0011 — five-step grill play keyed on the previous tier, tapped answers replied from a reviewed reply bank (amends 0006; wave 2)** (read 0004–0006 and 0009–0011 before touching Booth Mode) |
