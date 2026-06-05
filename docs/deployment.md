# Deployment

Deploys run from the **local working tree** (not GitHub). Backend + RIMPL on **Railway** (project `CLICS-Pilot`), both front-ends on **Vercel**.

## Live URLs

| Service | URL |
|---------|-----|
| Physician portal | https://physician-ui.vercel.app |
| Audit dashboard (Admin / Superadmin / Auditor) | https://audit-dashboard-rouge.vercel.app |
| Backend API | https://backend-production-c12e4.up.railway.app |
| RIMPL | internal-only — `rimpl.railway.internal:3003` (no public domain) |

## Deploy commands (and the gotchas that break prod silently)

- **Railway deploys MUST use `railway up . --path-as-root --ci`.** Plain `railway up` builds but the new image **never promotes** (old deployment stays active / "Deploy failed"), because each service has a configured root directory.
  - Backend: `cd backend && railway up . --path-as-root --service backend --ci`
  - RIMPL: `cd rimpl && railway up . --path-as-root --service rimpl --ci`  ← the local `rimpl/` dir is mis-linked to the `backend` service, so **always pass `--service rimpl`**.
  - `railway up` often prints a `reqwest timeout` even on success — verify with `railway status --json` (look for a fresh active deployment), not the CLI message.
- **Front-ends:** `cd physician-ui && vercel --prod --yes` · `cd audit-dashboard && vercel --prod --yes`.
- **The audit-dashboard needs `NEXT_PUBLIC_API_URL` set on Vercel** or its login silently hangs in prod (build inlines the `localhost:3001` fallback). Set once, then rebuild:
  ```bash
  echo "https://backend-production-c12e4.up.railway.app" | vercel env add NEXT_PUBLIC_API_URL production
  cd audit-dashboard && vercel --prod --yes   # NEXT_PUBLIC_* is inlined at build time
  ```
  physician-ui is unaffected (uses hardcoded `public/js/config.js`).

## Required env vars

- **backend** (Railway): `INTERNAL_TOKEN`, `RIMPL_URL=http://rimpl.railway.internal:3003`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ALLOWED_ORIGINS` (both Vercel origins).
- **rimpl** (Railway): `INTERNAL_TOKEN` (must match backend byte-for-byte), `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT=3003`.
- **audit-dashboard** (Vercel): `NEXT_PUBLIC_API_URL`.

## Seed the 4 role accounts (idempotent)

```bash
cd backend && NODE_PATH="$PWD/node_modules" node ../db/seed-users.js
```
Reads `backend/.env` for the prod Supabase service-role key; creates/updates the four accounts (resets passwords each run). Solves the superadmin bootstrap (the only way to create the first superadmin, since `POST /admin/users` is itself superadmin-gated).

## Demo credentials (throwaway — rotate before the real pilot)

Defined in `db/seed-users.js`:

| Role | Email | Password |
|------|-------|----------|
| Superadmin | superadmin@clics.th | ClicsSuper#2026 |
| Admin | admin@clics.th | ClicsAdmin#2026 |
| Physician | doctor1@clics.th | ClicsDoc#2026 |
| Auditor | auditor1@clics.th | ClicsAudit#2026 |

## Verify after deploying

- `curl <backend>/health` → `{"status":"ok"}`.
- Live chat e2e: login as physician → create PLE → `POST /ples/:id/message` → expect content + ≥1 `(Source, Year)` ref + a `socratic_question`.
- `curl <rimpl-internal>/health` from outside → `000` (confirms internal-only).
