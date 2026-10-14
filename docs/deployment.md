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
- **backend, evaluation queue (2026-09-02, optional — defaults shown):** `EVAL_DRAIN_INTERVAL_MS=60000`, `EVAL_DRAIN_CONCURRENCY=1`, `EVAL_LEASE_S=600`, `EVAL_MAX_ATTEMPTS=20`, `RIMPL_EVAL_TIMEOUT_MS=480000`, `RIMPL_CRITERIA_TIMEOUT_MS=180000`. **Never set `EVAL_DRAIN_ONLY_COUNCILS` in prod — the backend refuses to start.**
- **rimpl, on-prem model over Tailscale (2026-09-03, TESTING ONLY):** `TS_AUTHKEY` (ephemeral,
  pre-authorised, tagged), `TS_HOSTNAME=clics-rimpl`, `TS_PROXY_PORT=1055`,
  `LOCAL_AI_HTTP_PROXY=http://127.0.0.1:1055`, plus `LOCAL_AI_BASE_URL` / `LOCAL_AI_MODEL`
  (`LOCAL_AI_API_KEY` if the endpoint wants one). rimpl now builds from `rimpl/Dockerfile`, which
  carries an OPTIONAL userspace Tailscale client — **with `TS_AUTHKEY` unset the image behaves
  exactly like the old buildpack**, and every tailscale step is non-fatal by design. Only the local
  provider's requests use the proxy (`services/providers/local.js`); Anthropic and Supabase keep the
  normal route. This is the documented FALLBACK to decision D3 (move rimpl on-prem) and does **not**
  change where PII is processed — it is for reachability testing, not for the pilot.
- **rimpl, on-prem TUTOR model (2026-10-14, optional — dormant until routed):** a second on-prem
  endpoint, provider `local-tutor`, so the tutor (chat/discuss) and the PIS-7 evaluator (`local`,
  evaluate/criteria) can be different models on different boxes (CCME R3). `LOCAL_TUTOR_AI_BASE_URL` /
  `LOCAL_TUTOR_AI_MODEL` (`LOCAL_TUTOR_AI_API_KEY` if the endpoint wants one), plus the same optional
  knobs as the evaluator under its own names: `LOCAL_TUTOR_AI_TIMEOUT_MS`, `_MIN_CONTEXT`, `_NUM_CTX`,
  `_MAX_PROMPT_TOKENS`, `_THINKING_STYLE`, and queue `LOCAL_TUTOR_MAX_CONCURRENCY` /
  `_INTERACTIVE_RESERVE` / `_MAX_QUEUE_INTERACTIVE` / `_MAX_QUEUE_BACKGROUND` / `_QUEUE_RETRY_AFTER_S` /
  `_MAX_RETRIES` / `_RETRY_BASE_MS`. It reuses `LOCAL_AI_HTTP_PROXY` unless `LOCAL_TUTOR_AI_HTTP_PROXY` is
  set (empty = direct). Nothing routes to it until `ai_provider_chat` / `ai_provider_discuss` names it;
  rimpl refuses it for evaluate / criteria / embed, and `/health/deep` reports it as `local_tutor_ai`
  only while it is routed. Backend bills it at `LOCAL_TUTOR_INPUT_PER_M` / `_OUTPUT_PER_M` (default 0).
- **backend, `/health/deep` queue verdict (2026-09-03, optional — defaults shown):** `HEALTH_PROBE_TIMEOUT_MS=2000`, `HEALTH_QUEUE_STUCK_S=900`, `HEALTH_QUEUE_STUCK_ETA_MULTIPLE=3`. The evaluation queue can now fail the verdict, so `/health/deep` answering 200 finally means the drain is claiming work. The stuck grace is `max(HEALTH_QUEUE_STUCK_S, predicted_wait × multiple)` where the prediction uses the same `eval_drain_concurrency` / `eval_p50_seconds` the physician's queue ETA uses — raise the multiple if a legitimate cohort backlog ever reads red.
- **rimpl** (Railway): `INTERNAL_TOKEN` (must match backend byte-for-byte), `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT=3003`. Local-model lanes (optional, defaults): `LOCAL_MAX_CONCURRENCY=2`, `LOCAL_INTERACTIVE_RESERVE=1`, `LOCAL_MAX_QUEUE_INTERACTIVE=4`, `LOCAL_MAX_QUEUE_BACKGROUND=2`, `RIMPL_BODY_LIMIT=2mb`. **Never set `PROVIDER_SETTINGS_SOURCE=env` in prod (rimpl refuses to boot); leave `CHAT_FAILOVER_PROVIDER` unset (CREC decision pending).**
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
- Live chat e2e: login as physician → create PLE → `POST /ples/:id/message` → expect content + ≥1 `(Source, Year)` ref + a `socratic_question`.
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
  where indexname in ('ples_auditor_idx','ples_status_idx','lpdp_snapshots_ple_idx');  -- perf-indexes
```

```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'ples_status_check'; -- ple-status-values (must list ple_*)
select proname from pg_proc where proname = 'claim_ple_evaluations';                   -- local-ai-capacity (RPC)
select column_name from information_schema.columns
  where table_name = 'ples' and column_name in ('eval_enqueued_at','context_tokens');   -- local-ai-capacity (columns)
select key, value from app_settings where key in ('standard_usage_limit_tokens','ple_max_transcript_tokens','eval_drain_concurrency');
```

**`migration-audit-log-chain.sql` (hash-chained, append-only `audit_log`) goes the OTHER way: deploy
the backend first, then apply it.** The code reports `not_installed` until the functions exist. After
applying, check `select has_function_privilege('service_role','public.audit_log_genesis()','execute')`
is true and `GET /oversight/audit-log/verify` answers `consistent`. Then record the head from
`/health/deep` → `checks.audit_chain` somewhere outside Supabase; that copy is the anchor that turns
`consistent` into `intact`. From then on, `audit_log` refuses UPDATE / DELETE / TRUNCATE for every role,
so no script may clean it up.

**Deploy ordering:** apply `migration-usage-reserve.sql` + `migration-eval-unique.sql` BEFORE (or with)
a backend deploy — never a new backend against a DB missing them. (`migration-eval-unique.sql` was
historically orphaned from the runbooks — it is required, not optional.)

**Applied to prod 2026-09-02 (Supabase MCP): `migration-ple-status-values.sql` (`ple_status_values`) and
`migration-local-ai-capacity.sql` (as `local_ai_capacity_queue_and_settings` + `local_ai_capacity_reservation_rpcs`).**
`migration-ple-rename.sql` had been applied 2026-08-31 but left `ples.status` values as `cle_*`; the
status-values migration finishes it. **Consequence: the deployed backend (master, `.from('cles')`) has
been inconsistent with the database since 2026-08-31 — every PLE route fails until a backend from this
branch is deployed.** Rollback files exist for both rename halves.

**⚠ `db/migration-local-ai-capacity.sql` MUST be applied BEFORE deploying any backend from `ddbba2a`
onward.** From that commit the evaluation drain is the *only* thing that calls rimpl `/evaluate`, and it
claims work through `claim_ple_evaluations()`. Against a database without that RPC every tick fails,
**no PLE is ever evaluated**, and the only symptom is `checks.eval_queue.drain.last_error` on
`/health/deep` plus a growing `queued` count. The migration is re-runnable; it also redefines
`reserve_usage` / `reserve_auditor_usage` with a fourth, defaulted argument (the old 3-arg overload is
dropped first so PostgREST resolution stays unambiguous). Token ceilings seed **0 = no cap** — set them
deliberately from the capacity report.

**Before switching rimpl to `EVAL_CONSISTENCY=adaptive`:** it issues 2–3 serial local calls (plus up to 2 re-asks) per
evaluation. The backend's `RIMPL_EVAL_TIMEOUT_MS=480000` and `EVAL_LEASE_S=600` assume the superadmin setting
`eval_drain_concurrency` is **1**; with N in flight the calls interleave in rimpl's background lane and the last
evaluation finishes at ≈3·N·T (T ≈ 70–115 s measured), past the deadline — the drain then defers and retries the same
work. Keep the drain at 1, or size both timeouts at ≥ 3 × N × p95 first.
