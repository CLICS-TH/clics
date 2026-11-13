# Deployment

Deploys run from the **local working tree** (not GitHub). **Production stays on Railway until the owner runs the vm1 cutover** (ADR 0002, runbook [`deploy/vm1/README.md`](../deploy/vm1/README.md)). After it, everything runs on vm1 as the `clics` compose project behind one origin, `https://clics.ccme.or.th` (#429): the Portal at `/`, the audit-dashboard at `/audit`, the backend at `/api`. Railway (project `CLICS-Pilot`) is the rollback for 7 days and is then stopped, and the two Vercel projects become redirects to the new origin. Until then both front-ends are on **Vercel**.

## Live URLs

| Service | URL |
|---------|-----|
| Physician portal | https://physician-ui.vercel.app |
| Audit dashboard (Admin / Superadmin / Auditor) | https://audit-dashboard-rouge.vercel.app |
| Backend API (production) | https://backend-production-c12e4.up.railway.app |
| On vm1, after the owner's cutover: Portal, dashboard, API | https://clics.ccme.or.th, `/audit`, `/api` |
| RIMPL | internal-only: `rimpl.railway.internal:3003` today, vm1's docker network after the cutover |

## vm1 (Topology B): prepared, cutover is the owner's

Backend, RIMPL, the Portal and the audit-dashboard run as one Docker Compose project on vm1
([ADR 0002](adr/0002-vm1-topology-b.md)) behind `https://clics.ccme.or.th`. The host nginx sends `/api/` to the
backend (prefix stripped), `/audit/` to the dashboard (a Next standalone server with `basePath: '/audit'`) and
everything else to the Portal's own nginx. Sharing the origin, the dashboard reads the session the Portal's
sign-in stored in `localStorage`; no token travels in a URL. Until the owner runs the cutover, production is the Railway deployment below. Deploy, cutover and rollback are in [`deploy/vm1/README.md`](../deploy/vm1/README.md);
the public origin is proven by `node scripts/deploy/cutover-check.mjs` (add `--stream` for the one-turn SSE check).
Both front ends call `/api` on their own origin (`physician-ui/public/js/config.js`; the dashboard's
`NEXT_PUBLIC_API_URL`, which defaults to `/api`). Locally, `npm run dev` adds the same routing on
`http://localhost:3080` (`scripts/dev/one-origin.mjs`); open the app there to hand off to the dashboard.
Every script reads the API origin from `scripts/lib/api-origin.cjs` (override: `CLICS_API_ORIGIN`).
Sign-in and the database stay in Supabase (Tokyo) until #427 and #432. The Railway commands below are today's
deploy path and, after the cutover, the rollback, which keeps running unchanged for 7 days.

## Deploy commands (and the gotchas that break prod silently)

- **Railway deploys MUST use `railway up . --path-as-root --service <name> --ci`.** Plain `railway up` builds but the new image **never promotes** (old deployment stays active / "Deploy failed"), because each service has a configured root directory.
  - Backend: `cd backend && railway up . --path-as-root --service backend --ci`
  - RIMPL: `cd rimpl && railway up . --path-as-root --service rimpl --ci`
  - **Never omit `--service`.** Without it the CLI deploys to whatever service the directory is linked to. On 2026-10-14 `rimpl/` was linked to `backend`, so a rimpl deploy replaced the backend: the public URL answered `"service":"rimpl"` with a 503 until the backend was redeployed. After any backend deploy, check `curl -s https://backend-production-c12e4.up.railway.app/health/deep` (Railway) or `https://clics.ccme.or.th/health/deep` (vm1) reports `"service":"backend"`.
  - `railway up` often prints a `reqwest timeout` even on success — verify with `railway status --json` (look for a fresh active deployment), not the CLI message.
- **Front-ends on vm1** deploy with the backend: `deploy/vm1/deploy.sh` builds the `portal` and `dashboard`
  images from the same commit and starts them after the backend's gates. Nothing else to deploy.
- **Vercel is redirects only.** `physician-ui/vercel.json` sends every path 1:1 to `https://clics.ccme.or.th`
  (query string included: invite links carry `?token=<invite>`); `audit-dashboard/vercel.json` sends every
  path under `/audit/` and blanks a `?token=` (it was a session). The owner deploys both at cutover step 4
  (`vercel --prod --yes` in each directory). A Vercel deploy of this repo before then moves the users early.
- **`NEXT_PUBLIC_API_URL`** (dashboard, inlined at build time): unset means `/api` on the dashboard's own
  origin, which is right on vm1 and behind `npm run dev`'s `:3080`. Set it only to point a local build at
  another backend (e.g. `http://localhost:3001`).
- **`NEXT_PUBLIC_PORTAL_URL`**: unset (the default) means the Portal is on the same origin; the dashboard
  sends a bare `/audit/login` to `/login`, Logout to `/login?logout=1`, Return to Physician to `/dashboard`.

## Required env vars

- **backend** (Railway variables, kept for the rollback; vm1's `backend.env` omits `RIMPL_URL`, compose sets it, see `deploy/vm1/README.md`): `INTERNAL_TOKEN`, `RIMPL_URL=http://rimpl.railway.internal:3003`, `SITE_URL` (portal origin for invite-accept links + the password-reset redirect — `https://physician-ui.vercel.app` on Railway, `https://clics.ccme.or.th` on vm1), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `ALLOWED_ORIGINS` (both Vercel origins on Railway; `https://clics.ccme.or.th` on vm1), `IDENTITY_ENC_KEY` (AES-256-GCM key for the OAuth identity vault — long random string), `GUEST_TOKEN_SECRET` (HMAC secret for ephemeral guest tokens). **The prod boot check now refuses to start if `RIMPL_URL`, `SITE_URL`, `SUPABASE_ANON_KEY`, or any of the above are missing** (they otherwise fall back to localhost/insecure-dev silently). The last two MUST be set in prod (the backend uses an insecure dev fallback only when `NODE_ENV` ≠ `production`); generate each with e.g. `openssl rand -base64 48`.
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
  `_MAX_PROMPT_TOKENS`, `_THINKING_STYLE`, `_THINK_PREOPENED`, and queue `LOCAL_TUTOR_MAX_CONCURRENCY` /
  `_INTERACTIVE_RESERVE` / `_MAX_QUEUE_INTERACTIVE` / `_MAX_QUEUE_BACKGROUND` / `_QUEUE_RETRY_AFTER_S` /
  `_MAX_RETRIES` / `_RETRY_BASE_MS`. It reuses `LOCAL_AI_HTTP_PROXY` unless `LOCAL_TUTOR_AI_HTTP_PROXY` is
  set (empty = direct). Nothing routes to it until `ai_provider_chat` / `ai_provider_discuss` names it;
  rimpl refuses it for evaluate / criteria / embed, and `/health/deep` reports it as `local_tutor_ai`
  only while it is routed. Backend bills it at `LOCAL_TUTOR_INPUT_PER_M` / `_OUTPUT_PER_M` (default 0).
- **Local-only mode, both services (ADR 0012, #428 — dormant, off unless set):** `CLICS_LOCAL_ONLY`.
  Unset, blank, `0`, `false`, `off` or `no` is off; any other value is on. **rimpl's is the one that
  counts:** with it on, rimpl refuses every provider but `local` and `local-tutor`, for every purpose,
  before any request (503 `local_only_refused`), and `/health/deep` and `/health/mode` report
  `local_only: on`. The backend's superadmin provider switch hides and refuses every commercial provider
  when its own `CLICS_LOCAL_ONLY` is on **or** rimpl's `/health/mode` says on **or** that read fails
  (`GET /admin/ai-providers` reports `local_only` and `local_only_sources`). Set it in both places with
  the same value; on vm1 the preflight refuses it on in `backend.env` and off in `rimpl.env`.
- **backend, `/health/deep` queue verdict (2026-09-03, optional — defaults shown):** `HEALTH_PROBE_TIMEOUT_MS=2000`, `HEALTH_QUEUE_STUCK_S=900`, `HEALTH_QUEUE_STUCK_ETA_MULTIPLE=3`. The evaluation queue can now fail the verdict, so `/health/deep` answering 200 finally means the drain is claiming work. The stuck grace is `max(HEALTH_QUEUE_STUCK_S, predicted_wait × multiple)` where the prediction uses the same `eval_drain_concurrency` / `eval_p50_seconds` the physician's queue ETA uses — raise the multiple if a legitimate cohort backlog ever reads red.
- **rimpl** (Railway): `INTERNAL_TOKEN` (must match backend byte-for-byte), `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT=3003`. Local-model lanes (optional, defaults): `LOCAL_MAX_CONCURRENCY=2`, `LOCAL_INTERACTIVE_RESERVE=1`, `LOCAL_MAX_QUEUE_INTERACTIVE=4`, `LOCAL_MAX_QUEUE_BACKGROUND=2`, `RIMPL_BODY_LIMIT=2mb`. `RIMPL_CHAT_OPTIONAL_RETRY_CUTOFF_MS` (default `50000`): a language-only or evidence-only chat retry that would start later than this into the turn is skipped and the first reply is delivered. Keep it at about **half the backend's `RIMPL_CHAT_TIMEOUT_MS`** (50000 for the default 100000; about 75000 on the local stack, where `RIMPL_CHAT_TIMEOUT_MS=150000` per `docs/GATE0-DGX-RESULTS.md`), and change the two together. It applies to the **language retry even with `chat_evidence_marker` off**. `RIMPL_CHAT_DEEP_MAX_TOKENS` (default `RIMPL_CHAT_MAX_TOKENS` + 4000 = `8000`, never below the fast ceiling): the `max_tokens` of a chat turn the router serves deep with thinking on, since reasoning tokens count against it. Read only when `chat_router_enabled` = 1 and the chat provider can think. **Never set `PROVIDER_SETTINGS_SOURCE=env` in prod (rimpl refuses to boot); leave `CHAT_FAILOVER_PROVIDER` unset (CREC decision pending).**
- **audit-dashboard**: none required. `NEXT_PUBLIC_API_URL` (default `/api`) and `NEXT_PUBLIC_PORTAL_URL` (default: same origin) are overrides for local builds.

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

### Booth audits (#389): migration, then backend, then dashboard

`db/migration-booth-audits.sql` creates `booth_audits`, which every `/auditor/booth` call and the superadmin
booth card's audit counts read. Production did not have it on 2026-11-10. Run in this order:

1. **Migration.** The owner applies `db/migration-booth-audits.sql` on scaletest, then prod. Nobody else applies
   it. It is re-runnable. `select to_regclass('public.booth_audits');` is non-null once it is applied. The queue
   also reads `booth_plays.language_look`, which `db/migration-booth-plays.sql` adds (#377). The #377 backend
   needs that column too, so check that it is there before this deploy (`docs/BOOTH-REHEARSAL.md` has the check).
   If it is missing, apply `db/migration-booth-plays.sql` first, in #377's order (`docs/BOOTH-REHEARSAL.md`):
   without the column every `/auditor/booth` call answers 502 and every kiosk play ends unscored.
2. **Backend.** `cd backend && railway up . --path-as-root --service backend --ci`. Then `/health/deep` reports
   `"service":"backend"`.
3. **Dashboard.** `cd audit-dashboard && vercel --prod --yes`. This is what shows auditors the "Booth case studies"
   link.

Until the migration is applied, every `/auditor/booth` call (queue, study and submit) answers 502, and the
superadmin booth card shows "—" for audits. The kiosk never reads `booth_audits`, so plays are unaffected.

### #279 round: PostgREST closure + logout contract

`db/migration-postgrest-closed.sql` revokes every privilege `anon` and `authenticated` hold in `public`
(GitHub #281, ADR 0007). After it, nobody reads or writes CLICS data through PostgREST with the anon key or a
CLICS token. The backend is unaffected: it uses the service-role key. **Deploy the backend first, then the
owner applies the migration.** The backend reports `not_installed` until the function exists. Run in this order:

1. **Dashboard.** This round does not change it. Check that #228's build (`25cb3061`) is the live production
   dashboard. If it is not, deploy the dashboard first (`cd audit-dashboard && vercel --prod --yes`).
2. **Backend.** `cd backend && railway up . --path-as-root --service backend --ci`. Then
   `curl -s https://backend-production-c12e4.up.railway.app/health/deep` (this step deploys to Railway; use the vm1 origin once Railway is stopped) reports `"service":"backend"` and
   `checks.postgrest_surface.status` is `"not_installed"`.
3. **Booth smoke, with no successful write.** It proves the #228 routes without touching the kiosk.
   - Superadmin `GET /admin/booth` → 200 with the settings and counts.
   - Superadmin `PATCH /admin/booth` with `{"ceiling_usd": -1}` → 400. A re-GET shows the settings unchanged.
   - An admin or physician token → 403 on both.
4. **Logout smoke.** Sign in a test account and Sign out. The old token now gets 401 on any authed route.
5. **Migration.** The owner applies `db/migration-postgrest-closed.sql` on scaletest, then prod. Nobody else
   applies it. It is re-runnable.
6. **Closed.** `/health/deep` reads `checks.postgrest_surface.status: "closed"`. The production checks are
   metadata queries only:

   ```sql
   select to_regprocedure('public.postgrest_exposure()');   -- non-null once applied
   select * from public.postgrest_exposure();               -- zero rows when closed
   ```

   The function reads catalog metadata only, never a table row. Only `service_role` can execute it.
7. **Portal.** Deploy the Privacy page change (`cd physician-ui && vercel --prod --yes`) only after production
   reads `closed`. Until then the page's auditor line would claim a protection the database does not have.

The migration header records whether `supabase_admin`'s default privileges could be changed. If they could not,
a table created later through the dashboard can reopen the surface. `checks.postgrest_surface` covers that
drift: any row degrades `/health/deep` to 503 and names the objects.

**`migration-chat-turn-flags.sql` (chat router): either order is safe; apply the migration first if you
can.** It needs `migration-message-provenance.sql` and `migration-message-client-turn-id.sql` already
applied. It adds `messages.middleware_flags` and `ples.deep_mode_at`, lets `messages_superseded_reason_check`
accept `'evidence'`, and replaces `store_chat_turn` with ONE function that has three trailing, defaulted
params (`p_middleware_flags`, `p_superseded_draft`, `p_superseded_reason`), so the flags and a streamed
draft are stored in the turn's own transaction.
- *Migration first (preferred):* the deployed backend's old call, with the 12 old param names, resolves to
  the new function through the defaults, so nothing changes for it. `scripts/db/chat-turn-flags-test.sh`
  asserts this.
- *Code first:* also safe, but until the migration lands every turn costs a failed RPC (the new signature)
  before the old-signature retry, plus a failed PATCH while `middleware_flags` is missing. The draft and the
  flags are then written as separate updates, and the backend logs `[turn-idem] store_chat_turn has only its
  old 12-param signature` and `[router] … missing`, throttled. The turn itself is unaffected.

The file is re-runnable. If `migration-message-client-turn-id.sql` is ever re-run after it, re-run this one
too, because the old file re-creates the 12-param overload. Verified by `scripts/db/chat-turn-flags-test.sh`
(CI job `chat-turn-flags`). Gate, which returns `1|15` once applied:
`select count(*), max(pronargs) from pg_proc where proname = 'store_chat_turn';`

**App setting `chat_router_enabled`** (0/1, default 0; a missing row means off): when 1, the backend sends
rimpl `router_enabled: true`, and rimpl picks a fast or deep tier for each turn. It has no superadmin
toggle, so set the row directly (`insert into app_settings (key, value) values ('chat_router_enabled', 1)
on conflict (key) do update set value = excluded.value`). **`migration-chat-turn-flags.sql` MUST be applied
before it is set to 1** (check the gate above). Without the migration, deep mode cannot stick to a session
and the per-turn flags are not recorded.

**The evaluator Model Lock: `migration-evaluator-model-lock.sql`, then `migration-evaluator-lock-manifest.sql`
(GitHub #75, CCME R2).** Apply them in that order: the second refuses to run without the first (`apply
db/migration-evaluator-model-lock.sql first`). The first file's header says "apply BEFORE deploying the
backend", and until now no runbook carried it. From this backend on, either order is safe, because the code
fails closed and nothing is written until both are applied:
- `POST /admin/evaluator-lock` answers **503 `migration_required`**, naming the file or files still missing.
- `GET /admin/evaluator-lock` lists them in `migrations_pending` and keeps the form closed (`blockers`
  includes `migration_required`).
- `/health/deep` is unaffected while the evaluator is unlocked, which is the state production is in.

Apply both **before anyone declares a lock**. A lock also needs rimpl at #156 or later, which serves
`GET /manifest` behind `INTERNAL_TOKEN`. An older rimpl answers 404, and POST then refuses with **503
`manifest_unavailable`** (`reason: unreachable`). Both files are re-runnable. The second adds
`shadow_evaluations.decoding` only when that table exists, so **re-run it if
`migration-shadow-evaluations.sql` is applied later**. Verified by `scripts/db/evaluator-lock-manifest-test.sh`
(CI job `evaluator-lock-manifest`). Gate, run in this order:

```sql
select to_regclass('public.evaluator_model_lock');                      -- model-lock: non-null once applied
select count(*) from information_schema.columns                         -- lock-manifest: 3 once applied
  where table_schema = 'public' and table_name = 'evaluator_model_lock'
    and column_name in ('manifest_sha256', 'manifest', 'evaluator_sha256');
select relrowsecurity from pg_class where oid = 'public.evaluator_model_lock'::regclass;  -- true (deny-all)
select count(*) from information_schema.columns                         -- 1 when shadow_evaluations exists
  where table_schema = 'public' and table_name = 'shadow_evaluations' and column_name = 'decoding';
```

**What the lock freezes: the evaluator only.** At declaration the backend stores three things on the lock
record: `manifest_sha256` (the whole manifest, for the record), `manifest` (its expected half), and
`evaluator_sha256`, the digest of the **scoring instrument**. `evaluator_sha256` is sha256 over canonical
JSON (object keys sorted recursively, array order kept), tagged `clics-evaluator-scope/v3` plus the locked
provider, over exactly these keys of the manifest's `expected` (one helper, `evaluatorDigest` in
`backend/src/services/model-lock.js`, used at lock time and at health time):

- `code.evaluator` (prompt versions incl. the local addendum, rubric version)
- `code.model_version_prefix`
- `code.decoding.evaluate`
- `code.decoding.num_ctx.<locked provider>`, **only for an on-prem provider** (not `anthropic`): the
  `LOCAL_AI_NUM_CTX` context override the local transport sends on every call when it is above 0. It decides
  how much of the transcript the model sees. The Anthropic transport sends no such option.
- `code.consistency` **minus its `shadow` key, as it governs the locked provider.** rimpl's rule
  (`consistencyModeFor` in `rimpl/src/lib/consistency-config.js`): `EVAL_CONSISTENCY` reaches only the
  provider named in `code.consistency.evaluate.mode.applies_to` (`local`), and every other provider runs the
  code default mode (`off`).
  - When it governs the locked provider, that is, the provider is `applies_to` or the default mode is not
    `off`, the whole block is in: `agree` (`max_domain_delta`, `max_sum_delta`), `evaluate` (mode, JSON
    retries), `method`, `modes` and `rules`. This is how the local evaluator's repeated scores are reconciled
    into one.
  - Otherwise only `evaluate.mode.applies_to` and `evaluate.mode.default` are in, because changing either
    would put the rule on that provider's scores. An `anthropic` lock is therefore not moved by the local
    arm's consistency settings.
  - A manifest that does not name `applies_to` keeps the whole block in for every provider (fails closed).
- `code.providers.allowed.evaluate`
- `declared.providers.evaluate`
- `declared.<locked provider>` (e.g. `declared.local`: engine + model)
- `code.anthropic`, only when the locked provider is `anthropic`

Tutor, router, chat, the shadow evaluator's consistency settings, other providers' declared blocks and other
providers' `num_ctx` are outside it. Changing them after a lock is allowed. Changing any listed key needs a
new declaration (`REPLACE THE LOCK`).

Scope history: `v1` covered `code.consistency.evaluate` alone. `v2` widened it to all of `code.consistency`
except `shadow`. `v3` (2026-10-15) adds the on-prem evaluator's `num_ctx`, which `v2` missed although it
truncates what the evaluator sees. It also limits consistency to the provider the rule governs, because
under `v2` an `anthropic` lock was blocked and degraded by `EVAL_CONSISTENCY`, which never reaches it. No
lock was taken under `v1` or `v2`. A frozen digest can only be recomputed by the scope it was taken under,
so any further change to the scope needs a new tag.

**Post-lock scores carry the declaration (#75 criterion 7).** While a lock is in force, each evaluation
also carries `lock_declaration_sha256`. It is sha256 over canonical JSON, tagged `clics-lock-declaration/v1`,
of the in-force record's declared fields: `weights_sha256`, `inference_engine`, `quantization`,
`environment`, `system_prompt_version`, `evaluator_prompt_version`, `rubric_version`, `decoding`, `provider`
and `model_version` (`lockDeclarationDigest` in `backend/src/services/model-lock.js`). rimpl stamps it in
`provenance` and folds it into `config_fingerprint`. So two locks over the same weights checksum, for
example the same file served at fp8 and at bf16, now give different fingerprints. It enters the
fingerprint **only while locked**: unlocked and pre-lock scores send nothing and keep their fingerprint
byte for byte. Re-declaring identical values gives the same digest, because `id`, `locked_at`,
`locked_by`, `gate`, `note` and the manifest columns are left out. `POST /admin/evaluator-lock` returns
the value and records it in its audit entry. If the record behind the flag cannot be read, is missing,
or names other weights than `evaluator_weights_sha256`, the evaluation defers (503, retried by the drain).
A rimpl older than this change makes locked evaluations defer, not mis-stamp: the backend saves a locked
score only if its provenance echoes both digests it sent (else 503 `lock_declaration_not_stamped` /
`lock_weights_not_stamped`, then manual QA after `EVAL_MAX_ATTEMPTS`), so deploy rimpl first.

**Once a lock is in force,** `/health/deep` → `checks.model_lock` fetches rimpl `GET /manifest` (internal
token, cached at most 60 s: `HEALTH_MANIFEST_CACHE_MS`, default and ceiling `60000`; fetch bounded by
`HEALTH_RIMPL_TIMEOUT_MS`, default `2500`; a failed fetch is cached too, and a successful declaration
clears the cache), recomputes the evaluator digest with the same helper, and compares it with
`evaluator_sha256`:
- **match, whole manifest unchanged** → `up`.
- **match, whole manifest changed** → `up` with `note: 'tutor_or_router_changed_since_lock'` and both shas
  (`manifest_sha256`, `live_sha256`). Informational: the scoring instrument is unchanged.
- **mismatch** → **503**, `reason: 'evaluator_changed_since_lock'` (both evaluator digests reported). The
  instrument the study froze is no longer the one scoring: roll rimpl back, or stop scoring and re-declare
  (`REPLACE THE LOCK`).
- **503 also when** rimpl reports a live override on an evaluator key (`evaluator_live_drift`, below),
  rimpl cannot report a code-matched manifest (`live_manifest_unknown`), the lock record
  has no `evaluator_sha256` or provider (`lock_not_bound_to_manifest`: a lock taken before this change, or
  set by hand), the record table is unmigrated (`lock_record_unmigrated`) or unreadable
  (`lock_record_unreadable`). An unreadable lock state reports `unknown`.
- **Unlocked:** unchanged. Never degrades, and makes no manifest fetch.

**Live overrides on the evaluator's keys block a lock, and degrade one in force.** The evaluator digest is
taken over the manifest's `expected` half: code defaults plus the declared file. An env override changes
what rimpl runs without changing that half, so the digest cannot see it. rimpl reports the difference
separately, as `GET /manifest` → `drift[]` (key names from `rimpl/src/lib/manifest.js`). The backend reads
only the **keys** that fall in the evaluator's scope (`evaluatorDriftKeys` in
`backend/src/services/model-lock.js`). It never relays the values, which that endpoint returns raw.

| Drift key | What sets it on rimpl |
|-----------|-----------------------|
| `code.consistency.evaluate_mode` (when consistency governs the provider: a `local` lock) | `EVAL_CONSISTENCY` (applies to the `local` arm only) |
| `code.consistency.max_sum_delta` (same condition) | `EVAL_CONSISTENCY_MAX_SUM_DELTA` |
| `code.consistency.json_retries` (same condition) | `EVAL_JSON_RETRIES` |
| `code.decoding.num_ctx.local` (local lock) | `LOCAL_AI_NUM_CTX` |
| `code.decoding.evaluate.temperature`, `code.decoding.evaluate.max_tokens` | No env var: `EVAL_DECODING` is fixed in `rimpl/src/lib/decoding.js`. Drifts only if the running code is not the manifest's. |
| `declared.providers.evaluate` | `app_settings.ai_provider_evaluate`, then `AI_PROVIDER_EVALUATE`, then `AI_PROVIDER` (default `anthropic`) |
| `declared.local.model` (local lock) | `LOCAL_AI_MODEL` |
| `declared.local.served_model`, `.engine`, `.system_fingerprint` (local lock) | What the server at `LOCAL_AI_BASE_URL` reported on its last call. Not compared until it has answered once since rimpl booted. |
| `code.models.anthropic` (anthropic lock) | No env var: `ANTHROPIC_MODEL` is pinned in `rimpl/src/lib/provider-policy.js`. |

So a `local` lock watches 11 keys and an `anthropic` lock watches 4 (`code.decoding.evaluate.*`,
`declared.providers.evaluate`, `code.models.anthropic`). The consistency condition is read from the
manifest's own `code.consistency.evaluate.mode`. Without it, the consistency keys stay in (fails closed).

**Unclassified keys count as the instrument (fails closed).** Every drift key is classified by an explicit
rule: in (the keys above), or out. A key that matches neither counts as **in**. That covers a knob rimpl
adds later, such as `code.think_preopened.local` or `code.evaluator.prompt_override`, which blocks a lock and
degrades a locked one until someone classifies it. A key that is not a plain dotted name counts as in too,
and is reported as `(malformed drift key)`, never as the string it carried. The out rules
(`DRIFT_OUT` in `backend/src/services/model-lock.js`):

- chat, shadow, criteria and discuss decoding (`code.decoding.{chat,shadow,criteria,discuss}.*`, their
  `temperature` keys included)
- the shadow evaluator's consistency (`code.consistency.shadow*`)
- the thinking style (`code.thinking_style.*`), which is sent on chat turns only
- another provider's `num_ctx` (`code.decoding.num_ctx.<other>`)
- another provider's declared block (`declared.<other>.*`)
- another purpose's route (`declared.providers.<anything but evaluate>`)
- `code.models.anthropic`, for a non-anthropic lock
- the consistency keys, for a provider the rule does not govern

`backend/tests/evaluator-model-lock.test.js` checks that, for `anthropic` and for `local`, the in and out
rules partition all 33 keys rimpl emits, with no key in both and none in neither. A new rimpl key fails that
test until it is classified.

**The server-reported keys are blind until the server has answered once.** rimpl compares
`declared.local.served_model`, `.engine` and `.system_fingerprint` only against what the local server
reported on its most recent call since rimpl booted (unobserved is not drift). Straight after a rimpl
restart, a lock can therefore be declared before a server mismatch is visible. This is left as is. Once
the first evaluate call lands, the next manifest fetch sees the mismatch, and `/health/deep` degrades
(`evaluator_live_drift`) within the 60 s cache window.

- **Declaring:** `GET /admin/evaluator-lock` adds the blocker `evaluator_live_drift`, with the keys in
  `blocker_detail.evaluator_live_drift`. `POST` refuses with **409 `evaluator_live_drift`** (`keys`,
  `provider`). Remove the override. If the change is intended, make it in the code or in
  `rimpl/src/model-manifest.declared.json`, regenerate the manifest (`node scripts/manifest/build.mjs`),
  redeploy rimpl, then lock.
- **Locked:** `checks.model_lock` → **503**, `reason: 'evaluator_live_drift'`, `drift_keys: [...]`, while the
  digest still matches. `/admin/ai-readiness` → `model_lock` reports the same. When the digest has changed
  as well, the reason is `evaluator_changed_since_lock`, and `drift_keys` is still listed. Remove the
  override, or stop scoring and re-declare (`REPLACE THE LOCK`).
- **Shown on the screens, keys only:** `GET /admin/evaluator-lock` → `manifest.evaluator_drift_keys` (always
  present on a verified manifest, `[]` when nothing on the scope drifts) and `manifest.evaluator_provider`
  (the candidate's provider, or the one serving `evaluate` when there is no candidate).
  `GET /admin/ai-readiness` → `manifest.evaluator_drift_keys` and `manifest.evaluator_provider`, beside
  rimpl's public block. These are computed for the locked provider while locked, otherwise for the serving
  one, and both are `null` when neither can be read. The public block carries the same drift keys, but not
  the manifest's expected half. So when a consistency key is present, the route reads `GET /manifest`
  through the same 60 s cache. The dashboard PR that follows this one (6c) reads these fields instead of
  re-implementing the filter. Until it ships, the lock page shows a generic blocked message for
  `evaluator_live_drift`.
- **Never block or degrade:** `SHADOW_EVAL_MAX_TOKENS`, `SHADOW_EVAL_CONSISTENCY`, `RIMPL_DISCUSS_MAX_TOKENS`,
  `RIMPL_CHAT_MAX_TOKENS`, `RIMPL_CHAT_DEEP_MAX_TOKENS`, `AI_PROVIDER_CHAT` / `_CRITERIA` / `_DISCUSS`, every
  `LOCAL_TUTOR_AI_*` variable (including `LOCAL_TUTOR_AI_NUM_CTX`) and `LOCAL_AI_THINKING_STYLE`. For an
  `anthropic` lock, add `EVAL_CONSISTENCY`, `EVAL_CONSISTENCY_MAX_SUM_DELTA`, `EVAL_JSON_RETRIES`,
  `LOCAL_AI_NUM_CTX` and `declared.local.*`. For a `local` lock, add `code.models.anthropic`.
- **Unlocked:** unchanged. rimpl's own `/health/deep` warns on drift. The backend's `/health/deep` fetches no
  manifest and never degrades. (`/admin/ai-readiness` may still read `GET /manifest` while unlocked, as
  described above, to compute `evaluator_drift_keys`.)

**Declaring needs the candidate to be serving.** POST refuses with 409 `candidate_not_serving` unless the
candidate's provider is the one in `ai_provider_evaluate`, and with 409 `manifest_mismatch` (a `provider`
entry) unless it equals the manifest's `declared.providers.evaluate`. Switch `evaluate` to the candidate
first, then lock. Backend env `RIMPL_MANIFEST_TIMEOUT_MS` (default `8000`) bounds the manifest fetch at
declaration. **The quick lock is gone:** `PATCH /admin/ai-providers {evaluator_locked: true}` now answers
409 `use_model_lock`. Locking happens only at `/admin/evaluator-lock`, and unlocking (`evaluator_locked:
false` + `UNLOCK EVALUATOR`) clears the flag **and** the weights digest. Never set `evaluator_locked_at` or
`evaluator_weights_sha256` by hand: a hand-set lock has no record and degrades `/health/deep` until replaced.

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
