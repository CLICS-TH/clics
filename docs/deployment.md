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

- **backend** (Railway): `INTERNAL_TOKEN`, `RIMPL_URL=http://rimpl.railway.internal:3003`, `SITE_URL` (portal origin for invite-accept links + the password-reset redirect — `https://physician-ui.vercel.app`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `ALLOWED_ORIGINS` (both Vercel origins), `IDENTITY_ENC_KEY` (AES-256-GCM key for the OAuth identity vault — long random string), `GUEST_TOKEN_SECRET` (HMAC secret for ephemeral guest tokens). **The prod boot check now refuses to start if `RIMPL_URL`, `SITE_URL`, `SUPABASE_ANON_KEY`, or any of the above are missing** (they otherwise fall back to localhost/insecure-dev silently). The last two MUST be set in prod (the backend uses an insecure dev fallback only when `NODE_ENV` ≠ `production`); generate each with e.g. `openssl rand -base64 48`.
- **rimpl** (Railway): `INTERNAL_TOKEN` (must match backend byte-for-byte), `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT=3003`.
- **audit-dashboard** (Vercel): `NEXT_PUBLIC_API_URL`.

## Seed the 4 role accounts (idempotent)

```bash
cd backend && NODE_PATH="$PWD/node_modules" node ../db/seed-users.js
```
Reads `backend/.env` for the prod Supabase service-role key; creates/updates the role accounts (incl. a 2nd-council Pharmacy auditor for cross-council tests; resets passwords each run). Solves the superadmin bootstrap (the only way to create the first superadmin, since `POST /admin/users` is itself superadmin-gated).

## Demo credentials (throwaway — rotate before the real pilot)

Defined in `db/seed-users.js`:

| Role | Email | Password |
|------|-------|----------|
| Superadmin | superadmin@clics.th | ClicsSuper#2026r2 |
| Admin | admin@clics.th | ClicsAdmin#2026r2 |
| Physician | doctor1@clics.th | ClicsDoc#2026r2 |
| Auditor | auditor1@clics.th | ClicsAudit#2026r2 |
| Auditor · 2nd council (Pharmacy) | auditor2@clics.th | ClicsAudit2#2026r2 |

(Passwords rotated to the `r2` family in `db/seed-users.js`. A separate soak/E2E cohort — `soakdoc01..NN@example.com`, `soakaud1..N@example.com`, password `SoakPass#2026` — exists from load testing; `db/reset-demo.js` clears it before the real pilot.)

## Verify after deploying

- `curl <backend>/health` → `{"status":"ok"}`.
- Live chat e2e: login as physician → create CLE → `POST /cles/:id/message` → expect content + ≥1 `(Source, Year)` ref + a `socratic_question`.
- `curl <rimpl-internal>/health` from outside → `000` (confirms internal-only).

### Migration-applied gate (run in the Supabase SQL editor — scaletest, then prod)

The backend now degrades *safely* when these are absent (the usage meter no longer runs negative without
`reserve_usage`; dup-eval reads fall back to the first row without `*_ple_uniq`), but the actual
protections only exist once the SQL is applied. Each query returns rows iff applied:

```sql
select proname from pg_proc where proname = 'reserve_usage';                          -- usage-reserve
select conname from pg_constraint
  where conname in ('ai_evaluations_ple_uniq','lpdp_snapshots_ple_uniq',              -- eval-unique
                    'can_audit_physician_only');                                       -- can-audit-check
select indexname from pg_indexes
  where indexname in ('cles_auditor_idx','cles_status_idx','lpdp_snapshots_ple_idx');  -- perf-indexes
```

**Deploy ordering:** apply `migration-usage-reserve.sql` + `migration-eval-unique.sql` BEFORE (or with)
a backend deploy — never a new backend against a DB missing them. (`migration-eval-unique.sql` was
historically orphaned from the runbooks — it is required, not optional.)
