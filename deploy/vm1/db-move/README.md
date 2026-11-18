# The database move: Supabase to the private data host (#432, ADR 0012)

**Status: prepared, not run.** Production's database is still the Supabase project (Tokyo). Nothing in
this directory has been run against it, against vm1, or against the data host, which does not exist yet.
The decision is [ADR 0012](../../../docs/adr/0012-on-prem-data-custody.md). Until the owner records the
Supabase deletion date in [`docs/deployment.md`](../../../docs/deployment.md#data-custody), participant
data sits on commercial cloud, and no doc or CREC-facing text may say it is in Thailand.

| File | What it is |
|---|---|
| `move.sh` | The move, run on vm1: preflight, the restore stream (Supabase to the data host, never on a disk), the verify report; also `backup` and `drill` for the nightly dump |
| `roles.sql` | The data host's roles after the move: the app's logins checked not superuser, and `clics_analyst`, a read-only rater/analyst role that reads numbers, times, codes and pseudonyms, never free text or an identity table |
| `backup.sh` | The nightly encrypted dump, run on vm1 from cron |
| [`scripts/db/db-move-test.sh`](../../../scripts/db/db-move-test.sh) | The hermetic test of all three, against two throwaway PostgreSQL clusters (CI job `fast-checks`, step `db-move`) |

## What the move does

`move.sh move` runs on vm1, in a throwaway `supabase/postgres` container (the data host's image, so its
`pg_dump` matches), with `--network host` so it reaches the data host over vm1's tailnet address:

1. **Preflight.** The Supabase URL carries `sslmode=require` or stricter, and the session reports TLS. The
   data host answers, is a different cluster, its user is a superuser, its `public` schema is empty, and
   GoTrue has migrated its `auth` schema (an empty `auth.users`). `pg_dump` is not older than Supabase. The
   source has `booth_plays`, `booth_sort_memos` and `booth_event_purges`, and an audit chain (see below).
2. **One snapshot, one stream, one transaction.** `move.sh` exports one snapshot of Supabase and holds it
   open; the dump and the report both read that moment, so a write to Supabase during the move (a browser
   refreshing its token, say) can neither split the dump nor make the report differ. `pg_dump` of `auth`
   (data only, into GoTrue's tables, without `auth.schema_migrations` and without GoTrue's session state:
   `sessions`, `refresh_tokens`, `mfa_amr_claims`, `flow_state`, `one_time_tokens`; every session ends at
   the move, and a refresh token carried over would stay usable against the new GoTrue), then `public` (schema, data, grants), then a `setval` for every sequence in
   both schemas, read from the source. It is piped into `psql` on the data host inside `begin ... commit`
   with `session_replication_role = replica`, so no trigger fires: `audit_log`'s chain trigger would
   otherwise renumber, re-date and re-hash every row. Default grants to `anon` and `authenticated` are
   revoked before any table is made (ADR 0007). Nothing is written to a file.
3. **Verify report.** Per table in `public` and `auth`: row count and checksum on both ends (md5 over each
   row's text form in the source's column order, so GoTrue's column order does not matter). Every sequence:
   the data host's next value is not lower than Supabase's. The audit chain: `audit_log_verify` on the data
   host, anchored at Supabase's head (`audit_log_head()`), so a re-chained or re-stamped `audit_log` fails
   even though it is internally consistent. The three booth tables by name. `postgrest_exposure()` lists
   nothing. It ends `VERIFY: PASS` or `VERIFY: FAIL (n problems)`, and exits 1 on a FAIL.

The report holds table and column names, counts, checksums and sequence values. It never holds a row, so
it can be pasted into #432.

## Audit chain: a decision before the window

`move.sh` needs `public.audit_log_verify` on the source. Production reports `audit_chain=not_installed`.
Two ways, and the owner picks one before the rehearsal:

- **(a) Apply `db/migration-audit-log-chain.sql` to production first** (as `docs/deployment.md` says: the
  backend is already deployed, so the migration goes on, then `GET /oversight/audit-log/verify` answers
  `consistent`, and its head is recorded outside Supabase). The backfill chains the rows already there in
  `(created_at, id)` order. From then on `audit_log` refuses UPDATE, DELETE and TRUNCATE. `move.sh` then
  runs with the default `AUDIT_CHAIN=required`, and the report's chain line is anchored at the source head.
  This is what ADR 0012 says.
- **(b) Move without a chain.** Run `move.sh` with `AUDIT_CHAIN=checksum`: the report replaces the chain
  check with `audit_log`'s row checksum, which proves the copy equals Supabase at the moment of the move
  and nothing about the rows before it. Apply the chain migration on the data host after verify passes (its
  backfill chains the restored rows) and record its first head in `docs/deployment.md`.

With neither, the preflight stops: `AUDIT_CHAIN=required` refuses a source without a chain.

## Before the window (owner steps)

1. **The data host exists** (Aj. Chanvit): its own `supabase/postgres:17.6.1.136` container on cme-dev,
   not the existing CME Postgres; listening on its tailnet address only; `pg_hba.conf` allows vm1's tailnet
   address only, for `supabase_admin`, `authenticator`, `supabase_auth_admin` and `clics_analyst`; no
   `db/migration-*.sql` run on it (the schema comes from the dump). Disk encryption, capacity and login
   access are CME's answers on #432.
2. **The access probe** (owner-run, output into the PR): from vm1, `psql` connects; from another tailnet
   node, the connection is refused; from the internet, nothing answers. A refusal from another tailnet node
   is the one that counts.
3. **On vm1,** as root, a directory for the move's secrets:
   ```bash
   install -d -o root -g root -m 700 /opt/clics/db-move
   install -o root -g root -m 600 /dev/null /opt/clics/db-move/pgpass
   install -o root -g root -m 600 /dev/null /opt/clics/db-move/supabase-url
   ```
   A human writes, with an editor on vm1 (never on a command line or in a chat): `pgpass`, one line
   `DATA_HOST:5432:postgres:supabase_admin:PASSWORD`; and `supabase-url`, the Supabase session-pooler URL
   (port 5432, session mode: the held snapshot needs one server session; the transaction pooler cannot)
   with the password URL-encoded and `?sslmode=require` (as `rehearsal/README.md` step 3).
4. **The users' notice,** a week before: the date and hour; CLICS answers "being moved" for up to an hour;
   everyone signs in once afterwards, with the same password or Google; an unfinished PLE is kept.
5. **The audit-chain decision** above.
6. **The rehearsal on a copy** (below) has passed, its report is on #432, and the old-password check of
   `rehearsal/README.md` ("Old passwords, for real") says `N of N verify`. If it does not, the force-reset
   plan below is ready and the notice says so.

The commands below run on vm1 from the release the move ships in:

```bash
cd /opt/clics/current/deploy/vm1/db-move
export CLICS_DATA_HOST=DATA_HOST       # the data host's tailnet name; never written into this kit
mv_run() {  # move.sh in the data host's image, on vm1's network, reading the URL file on stdin
  docker run --rm -i --network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    -v "$PWD/move.sh:/db-move/move.sh:ro" -v /opt/clics/db-move/pgpass:/run/pgpass:ro -e PGPASSFILE=/run/pgpass \
    -e CLICS_DATA_HOST -e AUDIT_CHAIN --entrypoint bash supabase/postgres:17.6.1.136 /db-move/move.sh "$@" \
    < /opt/clics/db-move/supabase-url
}
```

## The rehearsal on a copy

The same commands as the window, against the real data host, then the data host is emptied again. Use
the window's freeze (step 1 below) for it as well: the pilot has not started, and a write to Supabase
during the dump fails the report.

1. Window steps 1 to 4 below (freeze, GoTrue migrates the data host, `mv_run move`).
2. Attach the report to #432. Then CME recreates the data host's container on an empty data directory,
   as it was before the rehearsal, and the passwords of step 2 are set again in the window. Lift the
   freeze (window step 1 in reverse).

## The window

Everything here is the owner's to run, in this order. Expect 30 to 60 minutes.

1. **Freeze.** Railway's backend is stopped (it has been since the vm1 cutover; check). In
   `/opt/clics/env/backend.env` add `CLICS_MAINTENANCE=1`, then from the Mac
   `deploy.sh --rollback CURRENT_SHA` (it recreates the backend through both gates). Check:
   `curl -s https://clics.ccme.or.th/health/deep` shows `"maintenance":true`, `curl -si
   https://clics.ccme.or.th/api/ples` answers 503, and the backend log says the eval drain and the reconcile
   sweep were not started. No script, seed or smoke runs against Supabase from here until step 9.
   The freeze covers the backend only: until step 6 the Portal and the dashboard still reach Supabase's
   GoTrue directly, so an open tab refreshing its token, or a Google sign-in, still writes to Supabase's
   `auth` schema. The move's snapshot makes that harmless to the copy; such a write made after the
   snapshot is not carried over (a session ends anyway; an account first created by Google in the window
   signs in again after it).
2. **GoTrue migrates the data host.** On the data host, `\password supabase_auth_admin` and
   `\password authenticator` (psql, as `supabase_admin`). In `/opt/clics/env/gotrue.env`,
   `GOTRUE_DB_DATABASE_URL` points at the data host as `supabase_auth_admin`; in `postgrest.env`,
   `PGRST_DB_URI` as `authenticator`. Start the sign-in services (`../README.md`, *Self-hosted sign-in*):
   ```bash
   cd /opt/clics/current/deploy/vm1
   export CLICS_RELEASE=$(basename "$(readlink /opt/clics/current)") CLICS_ENV_DIR=/opt/clics/env \
          CLICS_UID=$(id -u clics) CLICS_GID=$(id -g clics)
   docker compose -p clics -f docker-compose.yml -f docker-compose.auth.yml up -d --wait gotrue
   ```
   GoTrue migrates the empty `auth` schema at start. Stop it again before the restore
   (`docker compose -p clics -f docker-compose.yml -f docker-compose.auth.yml stop gotrue`), so nothing
   writes `auth` during it.
3. **Preflight.** `mv_run preflight` (with `AUDIT_CHAIN=checksum` exported if option (b) was chosen). It
   must end `preflight ok`.
4. **Move.** `mv_run move | tee /root/db-move-report.txt`. It must end `VERIFY: PASS`. On a FAIL, stop:
   go to *Rollback*. Attach the report to #432.
5. **Roles.** On the data host, as `supabase_admin`: `psql -X -v ON_ERROR_STOP=1 -f roles.sql` (copy it
   over, or pipe it in), then `\password clics_analyst`. It must end `COMMIT` with no error: the app's
   roles are not superusers, and `postgrest_exposure()` lists nothing.
6. **Switch the services to the data host.**
   - Start the sign-in services for good:
     `docker compose -p clics -f docker-compose.yml -f docker-compose.auth.yml up -d --wait gotrue postgrest supabase-gw`.
   - Mint the keys from GoTrue's secret (`../README.md`, *Self-hosted sign-in*) and, in `backend.env` and
     `rimpl.env`: `SUPABASE_URL=http://supabase-gw:8080`, the new `SUPABASE_ANON_KEY` and
     `SUPABASE_SERVICE_ROLE_KEY`. Remove `CLICS_MAINTENANCE=1`.
   - The Portal's `CLICS_SUPABASE_URL` and anon key point at `https://clics.ccme.or.th`, and nginx's
     `/auth/v1` location is installed (`../rehearsal/README.md`, *What only the owner can run*, 1).
   - From the Mac: `deploy.sh --rollback CURRENT_SHA` (or a deploy of the release carrying the Portal
     change). Both gates must pass.
7. **Check, as a user would** (the acceptance lines of #432):
   - `https://clics.ccme.or.th/health/deep` is `ok`, `service: backend`, no `maintenance`, and its
     `postgrest_surface` is clean.
   - An existing user signs in with their old password, and one with Google. The access token's `iss` is
     `https://clics.ccme.or.th/auth/v1`.
   - An unfinished PLE opens with its whole transcript and takes a turn.
   - A token issued by Supabase before the window gets 401, and the Portal shows its login page (no loop,
     no blank page).
8. **Supabase becomes the read-only rollback.** No writer points at it: Railway stopped, vm1's env files
   no longer name it, no script's env does. Record on #432 the time the window closed. Keep the
   Supabase project unchanged until the deletion below.
9. **Nightly backup on** (below), and the first restore drill passes before the window is declared closed.

### Rollback (any step before 8 fails)

The backend has written nothing to Supabase since step 1 (GoTrue's own session rows aside), so it is
still the system of record. Put the old
`backend.env` and `rimpl.env` lines back (the hosted `SUPABASE_URL` and keys), stop GoTrue, PostgREST
and supabase-gw, remove `CLICS_MAINTENANCE=1`, and `deploy.sh --rollback CURRENT_SHA`. Empty the data
host before the next attempt. After step 8, writes have landed on the data host: rolling back then means
moving the data host's rows back first, which this kit does not do.

### Force-reset fallback (old passwords do not verify)

If the rehearsal's old-password check fails, do not ship that GoTrue as is. In the window, after step 6:

1. The notice (step 4 of *Before the window*) already says: "after the move, set a new password with
   *Forgot password*, or sign in with Google".
2. From vm1, for every account with a password identity, ask GoTrue for one recovery mail (the backend's
   `/auth/forgot-password`, which the rate limit allows 5 an hour per client, or GoTrue's admin
   `generate_link` through supabase-gw in a one-off backend container). Accounts with a Google identity
   need nothing.
3. Until a user resets, their old password is refused with GoTrue's `invalid_credentials`; that is the
   expected state, not an outage. Track resets against the account list on #432.

## Nightly backup

`backup.sh OUT_DIR` runs on vm1 as root from cron, for example `30 2 * * *`. It runs `move.sh backup` in
the data host's image: the data host's restore stream, read in one exported snapshot, with that snapshot's
verify report carried inside the stream as SQL comments. The stream goes straight into `gpg`, encrypted to
a public key, and only the encrypted file is written. Set-up, once:

- `/opt/clics/backup/` (root, 700) with `backup.env` (`CLICS_DATA_HOST=...`), `pgpass` (both root, 600)
  and `recipient.asc`, the **public** key. The key holder (Aj. Chanvit's answer on #432) makes the key pair
  on their own machine and keeps the private key off vm1 and off the backup host. `backup.sh` refuses a
  `recipient.asc` that holds a private key.
- `OUT_DIR` is where CME's existing backup job picks files up and copies them to another CME host or its
  NAS snapshot. That is allowed (#432) because the file is encrypted and its key is not on the NAS.

### Restore drill

Monthly, and before the window is declared closed. On vm1, into a throwaway database that lives in memory
(the rehearsal's tmpfs database, `../rehearsal/README.md`), never into the data host:

1. Fresh rehearsal secrets, as for the sign-in rehearsal: `rehearsal/run.sh vm1-env ENV_DIR` (a root-only
   directory).
2. The key holder decrypts on vm1 and streams into the drill, with the key on a removable token or typed
   in, never copied to vm1's disk:
   ```bash
   cd /opt/clics/current/deploy/vm1
   gpg --decrypt /PATH/TO/clics-STAMP.sql.gpg | rehearsal/run.sh vm1-drill ENV_DIR
   ```
   It starts the rehearsal's in-memory `db`, lets GoTrue migrate an empty `auth`, restores the stream and
   checks it against the report the stream carries. It must end `VERIFY: PASS`. Paste the report into #432
   with the backup's file name.
3. `rehearsal/run.sh down ENV_DIR` removes the drill database.

## Recording the Supabase deletion

Before participant 1, the owner deletes the Supabase project, with its backups, and records in
[`docs/deployment.md`](../../../docs/deployment.md#data-custody), *Data custody*:

- the date of deletion;
- Supabase's confirmation (the email or dashboard notice, quoted with its date, no secret in it);
- that the project ref no longer answers: the output of
  `curl -s -o /dev/null -w '%{http_code}\n' https://PROJECT_REF.supabase.co/auth/v1/health` and
  `dig +short PROJECT_REF.supabase.co`, run on that date.

Only from that date may a doc or CREC-facing text say that the data is in Thailand (ADR 0012).
