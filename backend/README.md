# backend — CLICS REST API

Node.js + Express REST API (port **3001**). The system's control plane: it owns Supabase auth + DB
access, enforces roles and the per-user AI budget, runs the CLE gate, and is the **only** caller of
RIMPL. Deployed to **Railway**. Node **≥ 22**.

See [../README.md](../README.md) for the big picture, [../CONTRIBUTING.md](../CONTRIBUTING.md) for
conventions, and [../docs/architecture.md](../docs/architecture.md) for the request flow.

## Run

```bash
npm install
cp .env.example .env      # fill in Supabase keys + INTERNAL_TOKEN (must match rimpl)
npm run dev               # node --watch, port 3001  (npm start for no-watch)
npm test                  # jest --runInBand
```

## Layout

- `src/index.js` — app bootstrap: prod env boot-check, hand-rolled CORS (the
  `Access-Control-Allow-Methods` allow-list — **add new methods here**), per-route rate limits, and route
  mounting.
- `src/routes/` — `auth.js` (login/signup/invite/OAuth/reset), `cles.js` (CLE lifecycle + chat + end +
  evaluation), `folders.js`, `guest.js` (ephemeral guest mode), `admin.js` (CLE list/assign, flagged,
  invites, users, overview), `auditor.js` (queue + blind scoring + ICC), `superadmin.js` (user mutations,
  usage settings). Note `superadmin.js` mounts on `/admin` *after* `admin.js`.
- `src/lib/` — `schemas.js` (zod request schemas), `supabase.js` (service-role client), `accounts.js` +
  `provisioning.js` + `dual-role.js` (role/council slot model + the `can_audit` virtual role),
  `mailer.js` (Resend/SMTP, fail-soft), `crypto.js` (AES-256-GCM identity vault), `invite-token.js`,
  `usage.js` + `pricing.js` (the $0.50 cap), `db-helpers.js`, `guest.js`.
- `src/services/` — `rimpl-client.js` (the `x-internal-token` call to RIMPL), `cle-gate.js` +
  `cle-finalize.js` (C1–C6 screening → pass/fail/flag), `cle-evaluation.js`, `icc.js` (ICC(2,1)),
  `reconcile.js` (sweep for sessions stranded without an AI score), `license-verifier.js`.
- `tests/` — jest + supertest (19 suites). The auth/invite/usage/dual-role/CLE-gate/ICC paths are covered;
  see [../CONTRIBUTING.md](../CONTRIBUTING.md) §4 for the known route-test gaps.

## Key behaviors

- **JWT auth:** `verifyJwt` validates the bearer token via Supabase `auth.getUser`; the token *is* the
  Supabase session — never `signOut()` it after storing.
- **Data boundary:** transcripts go to RIMPL (which strips PII) — the backend never sends raw PII to cloud AI.
- **Fail modes:** `POST /cles/:id/message` fails **closed** (502 if RIMPL is down); the `/end` Tier-2 check
  fails **open** (flags `cle_flag_t2` for manual QA).

Env var names and the deploy command (`railway up . --path-as-root --service backend --ci`) are in
[../docs/deployment.md](../docs/deployment.md).
