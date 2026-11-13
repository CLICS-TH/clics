# Contributing to CLICS

How to set up, work in, test, and ship this repo. Read [`README.md`](README.md) first for the big
picture, then this. AI agents should also read [`CLAUDE.md`](CLAUDE.md) (critical rules + doc index).

## 1. Local development

Prereq: **Node ≥ 22**, plus the project's **Supabase credentials** (URL, anon key, service-role key)
from the team — real keys are never in git.

```bash
(cd backend && npm install) && (cd rimpl && npm install)
(cd audit-dashboard && npm install) && (cd physician-ui && npm install)

cp backend/.env.example backend/.env
cp rimpl/.env.example rimpl/.env
cp audit-dashboard/.env.example audit-dashboard/.env.local
```

**One command (all four layers):** run `npm run install:all` once, then `npm run dev` from the repo
root — it boots every layer together via `concurrently` (Ctrl-C stops all of them). Prefer separate
terminals? Use the per-layer commands below. Locally the prod boot-checks are relaxed
(`NODE_ENV` ≠ `production`), so missing optional vars fall back to dev defaults:

| Layer | Command | Port |
|-------|---------|------|
| backend | `cd backend && npm run dev` | 3001 |
| rimpl | `cd rimpl && npm run dev` | 3003 |
| physician-ui | `cd physician-ui && npm run dev` | 3000 |
| audit-dashboard | `cd audit-dashboard && npm run dev -- -p 3002` | 3002 (under `/audit`) |
| one origin | `npm run dev:one-origin` | 3080 |

`npm run dev` is `node --watch` for backend/rimpl, `npx serve public` for physician-ui, and `next dev`
for the dashboard (pass `-p 3002` — `next dev` defaults to 3000 and would collide with the portal).
Open the app on `http://localhost:3080`: it routes `/` to the Portal, `/audit` to the dashboard and `/api`
to the backend, as vm1's nginx does, and the staff handoff needs that shared origin.

**Env vars by layer** (names only — values come from the Supabase project / team):

- **backend** (`backend/.env.example`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
  `RIMPL_URL`, `INTERNAL_TOKEN`, `ALLOWED_ORIGINS`, `PORT`, `IDENTITY_ENC_KEY`, `GUEST_TOKEN_SECRET`,
  `OAUTH_ENABLED`, `SITE_URL`, `INVITE_EXPIRY_DAYS`, `LICENSE_*`, `RECONCILE_INTERVAL_MS`,
  `SMTP_*`/`MAIL_FROM` (or `RESEND_API_KEY` in prod). The production boot-check (`backend/src/index.js`)
  *requires* `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `INTERNAL_TOKEN`,
  `GUEST_TOKEN_SECRET`, `IDENTITY_ENC_KEY`, `ALLOWED_ORIGINS`, `RIMPL_URL`, `SITE_URL`.
- **rimpl** (`rimpl/.env.example`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`,
  `INTERNAL_TOKEN` (must match backend byte-for-byte), `PORT`. `OPENAI_API_KEY` is reserved (L4, not wired).
- **audit-dashboard** (`audit-dashboard/.env.example`): `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_PORTAL_URL`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`. `NEXT_PUBLIC_*` is **inlined at build time** — rebuild
  after changing. `NEXT_PUBLIC_PORTAL_URL` unset falls back to the prod Portal, so a local stack without it signs
  out to prod; set it to `http://localhost:3000`.
- **physician-ui**: none — `public/js/config.js` auto-targets localhost vs prod by hostname.

**How the layers talk:** frontend → backend over HTTPS with a `Bearer` JWT (the Supabase session token);
backend → RIMPL over internal HTTP with an `x-internal-token` shared secret; backend → Supabase via SDK;
rimpl → Claude via the Anthropic SDK.

## 2. Code conventions

- **backend / rimpl** — CommonJS Node. Routes in `src/routes/*.js`, request validation with **zod**
  schemas (`backend/src/lib/schemas.js`), shared helpers in `src/lib/*`, business logic in `src/services/*`.
  No TypeScript, no build step.
- **physician-ui** — vanilla HTML/CSS/JS, **no build**. CSS design tokens live in `public/css/main.css`.
  The per-page `<head>` (no-FOUC theme snippet + font links) is **intentionally duplicated** across the
  HTML files — without a build there's no way to share it, and the boot snippet must be inline to run
  before first paint. Shared modules: `public/js/icons.js` (inline-SVG line icons via `icon(name,size)`),
  `public/js/ui.js` (`toast()` / `confirmModal()`), `public/js/labels.js` (`cssVar`, bilingual labels).
  Use the `.bi` / `.bi-en` classes for bilingual labels (Thai primary, English dimmed).
- **audit-dashboard** — Next.js 16 App Router + React 19 + Tailwind **v4** (`@theme` block in
  `app/globals.css`, config-less) + shadcn-on-Base-UI. Design tokens (`--coral-active`, `--chart-*`) are
  CSS vars in `globals.css`; **recharts needs hex constants** (CSS `var()` doesn't resolve in SVG
  attributes) so charts import `lib/chart-colors.ts`. Bilingual labels via `components/BiLabel.tsx`;
  toasts/confirms via `components/Overlays.tsx`; markdown via `components/Markdown.tsx`. ⚠️ This Next is
  newer than most training data — **read `audit-dashboard/node_modules/next/dist/docs/` before any Next
  API change** (see `audit-dashboard/AGENTS.md`).

## 3. How to add things

- **A backend route** — add/extend a router in `backend/src/routes/`, validate the body with a zod schema
  in `src/lib/schemas.js`, and mount it in `src/index.js`. **If you use a new HTTP method, add it to the
  hand-rolled CORS allow-list** in `src/index.js` (`Access-Control-Allow-Methods` is currently
  `GET,POST,PUT,PATCH,DELETE,OPTIONS`) — a missing method blocks the browser preflight, and **curl will
  not catch it** (curl skips preflight). Add a `supertest` test under `backend/tests/`.
- **A physician-ui page** — copy the `<head>` boot snippet from an existing page, include the JS modules
  you need (`config.js`, `api.js`, and `icons.js`/`ui.js` for icons/dialogs), and use `.bi`/`.bi-en`
  for bilingual text. No build — just add the `.html` under `public/` and the `.js` under `public/js/`.
- **An audit-dashboard page/component** — add an App Router page under `app/`, reuse `BiLabel`,
  `Overlays`, `Markdown`, and the design tokens; the page consumes the backend via `lib/api.ts`.
- **A DB migration** — write `db/migration-*.sql`, then apply it in the **Supabase SQL editor**. The
  editor runs a script as **one transaction** — if any statement errors the whole thing rolls back, so
  **split DDL (tables/columns/indexes) and RLS policies into separate queries**. **Apply the migration
  *before* deploying backend code that reads the new columns** (otherwise `verifyJwt`/`/login` selects on
  a missing column and locks everyone out). Re-seed after (`db/seed-users.js` is idempotent). See
  [`docs/deployment.md`](docs/deployment.md) for the migration-applied verification queries.

## 4. Testing

```bash
npm run test:all                 # repo root — every hermetic suite (backend + rimpl + license-verifier + dashboard)
cd backend         && npm test   # jest — hermetic
cd rimpl           && npm test   # jest — all 8 suites hermetic (incl. PII-leak adversarial)
cd audit-dashboard && npm test   # jest + React Testing Library (jsdom)
cd audit-dashboard && npm run lint && npx tsc --noEmit   # blocking CI gates
```

Strong coverage today, **all hermetic**: CLE gate, ICC math, auth/invite flows, usage budget,
dual-role, crypto, PII filter + adversarial leak, the **cross-role integration suites** (folder CRUD,
CLE lifecycle, admin→auditor assign, auditor blind-score/409/ICC, role-access/council isolation, and an
end-to-end role-chain), and **audit-dashboard component tests** (DomainScorer, TranscriptView, the
labels/badge single source of truth). End-to-end auth proof: `scripts/e2e/`. Load & soak:
`scripts/loadtest/` and `scripts/soak/` (budget-capped — read the script header before running).
**Full coverage map, how-to-write-a-cross-role-test, CI, and the test roadmap live in
[docs/TESTING.md](docs/TESTING.md).**

## 5. Commits, deploy, and the rules

- **Commits:** Conventional Commits — the history uses `feat(scope): …`, `fix(scope): …`, `docs: …`.
  Never `git add -A` blindly; the `.gitignore` covers `.env`, `LOGIN-ACCOUNTS.txt`, `*.creds`, and the
  provision rosters, but stage explicit paths and check `git status` before committing.
- **Deploy** ([`docs/deployment.md`](docs/deployment.md)): backend/rimpl → Railway with
  `railway up . --path-as-root --service backend|rimpl --ci` (plain `railway up` builds but never
  promotes; always name the service, because a directory's link can point at the other one); both
  front-ends → Vercel with `vercel --prod --yes`. The audit-dashboard needs `NEXT_PUBLIC_API_URL` set on
  Vercel or its login silently hangs in prod. Each migration's order relative to its code is stated in
  `docs/deployment.md`: most new ones ship code first (the code tolerates the missing object), a few
  must land before. Never rename or drop anything ahead of the code.
- **Never `sbClient.auth.signOut()` after storing the token** — the CLICS token *is* the Supabase session
  access token; gotrue's `/logout` revokes it and every subsequent API call 401s.
