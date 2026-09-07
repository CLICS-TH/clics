# START HERE

New to CLICS? This is the on-ramp. **CLICS** (Case-based Learning Intelligence Credit System) scores a
physician's clinical reasoning from a physician–AI dialogue session (a **CLE**) to replace
attendance-based CME/CPD credit — an on-premise pilot for a Thai medical licensing body (Aug–Sep 2026).

> ⚠️ **Deploys run from the local working tree, not from GitHub.** A `git push` updates the repo + runs
> CI, but does **not** deploy. See [docs/deployment.md](docs/deployment.md).

## 1. Read these, in order

| Doc | For |
|-----|-----|
| [README.md](README.md) | What CLICS is + repository layout |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local setup + conventions |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Current state + where to start |
| [docs/ROADMAP.md](docs/ROADMAP.md) · [docs/TESTING.md](docs/TESTING.md) | What to build · how it's tested |
| [CLAUDE.md](CLAUDE.md) | Critical rules — read before changing anything |

## 2. Set up

```bash
git clone <repo-url> && cd CLICS
npm run install:all       # installs all four layers
```

Then create the **gitignored** env files from each layer's `.env.example` template, and fill them with
values you get from a maintainer **out-of-band** (they are never in this repo):

- `backend/.env` — Supabase URL + keys, `INTERNAL_TOKEN`, `IDENTITY_ENC_KEY`, `GUEST_TOKEN_SECRET`, …
- `rimpl/.env` — Supabase URL + service-role key, `ANTHROPIC_API_KEY`, `INTERNAL_TOKEN` (must match backend)
- `audit-dashboard` — `NEXT_PUBLIC_*` (set on Vercel for prod; `.env.local` for dev)

> 🔒 **Secrets never live in git.** API keys and the Supabase project credentials are held only in these
> `.env` files (gitignored) and in the Railway/Vercel dashboards. Ask a maintainer for them; do not commit them.

## 3. Run — one command, all four layers

```bash
npm run dev               # backend :3001 · rimpl :3003 · physician-ui :3000 · audit-dashboard :3002
```

Sign in with the demo accounts listed in [docs/deployment.md](docs/deployment.md). (Prefer separate
terminals? Each layer has its own `npm run dev` — see [CONTRIBUTING.md](CONTRIBUTING.md).)

## 4. Test

```bash
npm run test:all          # backend + rimpl + license-verifier + audit-dashboard (hermetic — no secrets)
```

CI (`.github/workflows/ci.yml`) runs the same hermetic set on every push/PR — coverage-gated, blocking lint.

## 5. Build something

Pick from [docs/ROADMAP.md](docs/ROADMAP.md) (**P1** = pilot-readiness) and the Phase-2 items in
[docs/TESTING.md](docs/TESTING.md). Work on a branch → open a PR → CI green → merge.

## 6. Deploy (from the local tree — see [docs/deployment.md](docs/deployment.md))

- **backend / rimpl** → Railway: `railway up . --path-as-root --service <name> --ci`
- **front-ends** → Vercel: `cd <layer> && vercel --prod --yes`

## Must-know rules ([CLAUDE.md](CLAUDE.md))

- **PII never leaves the on-premise RIMPL layer** — only de-identified JSON reaches cloud AI.
- **No secrets in git** — live keys live only in gitignored `.env` files + platform env vars; never `git add -A` blindly.
- **The CLICS token *is* the Supabase session token** — never call `auth.signOut()` after storing it.
- **audit-dashboard is Next.js 16** — read `audit-dashboard/node_modules/next/dist/docs/` before touching Next APIs.

---

**The loop:** read docs → `install:all` → `dev` → build from ROADMAP → `test:all` → PR/CI → deploy from local.
