# The database move: Supabase to the private data host (#432, ADR 0012)

**Status: prepared, not run.** Production's database is still the Supabase project (Tokyo). Nothing in
this directory has been run against it, against vm1, or against the data host, which does not exist yet.
The decision is [ADR 0012](../../../docs/adr/0012-on-prem-data-custody.md). Until the owner records the
Supabase deletion date in [`docs/deployment.md`](../../../docs/deployment.md#data-custody), participant
data sits on commercial cloud, and no doc or CREC-facing text may say it is in Thailand.

| File | What it is |
|---|---|
| `move.sh` | The move, run on vm1: preflight, the restore stream (Supabase to the data host, never on a disk), the verify report; also `backup` and `drill` for the nightly dump |
| `run-move.sh` | The move's one entry under CME's rules: sudo runs it, it asks for the Supabase URL and the data host's superuser password at the terminal, and runs `move.sh preflight`, `move` or `verify` in a throwaway container. No file holds either secret |
| `roles.sql` | The data host's roles after the move: the app's logins checked not superuser; `clics_analyst`, a read-only rater/analyst role that reads numbers, times, codes and pseudonyms, never free text or an identity table; and `clics_backup`, the nightly backup's login, which reads every row and writes nothing, so no file on vm1 holds a superuser's password after the move |
| `prepare-plain-pg.sql` | Only for a data host on plain PostgreSQL (not the `supabase/postgres` image): the roles, the `auth` schema and the (empty) `extensions` schema the image would have, before GoTrue's first start |
| `backup.sh` | The nightly encrypted dump, run on vm1 from cron |
| [`scripts/db/db-move-test.sh`](../../../scripts/db/db-move-test.sh) | The hermetic test of all three, against two throwaway PostgreSQL clusters (CI job `fast-checks`, step `db-move`) |

## Under CME's rules (25 Nov 2026)

CME's reply on #432 sets how anyone outside CME works on its machines. The CLICS team holds requests, results
and files, not rights on a machine:

- **cme-dev:** no account for CLICS. Files reach CME as a branch CME reviews and merges; CME builds and runs
  the data host from them and sends the evidence back (`../../data-host/README.md`). DDL on the data host is
  SQL files on that branch only, after CME's RLS refusal tests (D6) pass.
- **vm1:** the CLICS operator's account has no root, is not in the docker group, and may not run `docker
  run`, `docker exec` or a shell through sudo. sudo runs only commands CME has listed, path and arguments
  fixed.
- **The data host superuser's password is never in a file, not even for the window.** Its holder types
  it at the moment it is used.

So the move runs like this:

| What | Who | How |
|---|---|---|
| The data host: build, `prepare-plain-pg.sql`, `\password`, emptying it, `roles.sql`, `setup.sh lock` | CME, on cme-dev | the files from the branch |
| The access probe (*Before the window*, 2) | CME | sends its output for the PR |
| The kit on vm1: `run-move.sh`, `move.sh`, `backup.sh`, `db-move.conf`, the sudo entries | CME, as root | from the reviewed main (*Before the window*, 3) |
| `preflight`, `move`, `verify` | the CLICS operator types the Supabase URL; the holder of the data host's superuser password types it, at the same terminal | `sudo /usr/local/lib/clics-db-move/run-move.sh preflight` (or `move`, `verify`) |
| GoTrue and PostgREST on vm1: env, start, stop; the backend's maintenance switch; a deploy | CME, until it installs a deploy entry the CLICS operator may run | `../README.md`, *Under CME's rules*, Deploying under these rules |
| The nightly backup: its `pgpass`, keys and cron | CME, as root | *Nightly backup* |
| The restore drill that counts | the key holder, on a third machine CME names | *Restore drill* |

Still open with CME:

- **D6 and the restore.** The restore creates every table in `public`, which is DDL, and D6 tests refusals
  on those tables, so "D6 before any DDL" cannot hold for the restore itself. Which comes first is CME's
  call.
- **What the restore runs as the superuser.** The restore stream is SQL that comes from the source (Supabase
  today), and the data host's superuser runs it. A `CHECK` constraint, an expression index, a generated
  column or a materialized view that calls a function runs that function while the rows load, with the
  superuser's rights, and a superuser can reach the data host's operating system (`COPY ... TO PROGRAM`).
  So whoever can change the source's schema could run code on cme-dev during the window. Today the source's
  schema is CLICS's own migrations, reviewed on main. Two ways to close it, CME's choice: a preflight check
  that refuses a source with any such object outside the list the migrations make, or a restore role that
  is not a superuser (the stream's `session_replication_role` then needs `GRANT SET ON PARAMETER`).
- **The nightly backup's `pgpass`.** It is a password file, for `clics_backup` (reads every row, writes
  none), because a nightly job has nobody at a terminal (*Nightly backup*). Whether that is allowed, or the
  backup takes another form, is CME's call. vm1's env files (`backend.env` and the rest) hold the services'
  secrets the same way; they sit in the `clics`-owned env directory the rules already provide for.

## What the move does

`move.sh move` runs on vm1 through `run-move.sh`, in a throwaway container of the data host's PostgreSQL
version (`CLICS_PG_IMAGE` in `db-move.conf`, so its `pg_dump` is not older than either end), with
`--network host` so it reaches the data host over vm1's tailnet address:

1. **Preflight.** The Supabase URL carries `sslmode=require` or stricter, and the session reports TLS. The
   data host answers over TLS too (`CLICS_DATA_SSLMODE`, default `require`), is a different cluster, its
   user is a superuser, its `public` schema is empty, and GoTrue has migrated its `auth` schema (an empty
   `auth.users`). It has every role Supabase's `public` schema grants to or writes a policy for, every
   extension Supabase keeps in `public` (today `vector`), `auth.uid()` and `auth.role()`, and every column
   of Supabase's moved `auth` tables (pg_dump writes each column even of an empty table, so one the
   target's GoTrue lacks stops the load); each missing one is named. `pg_dump` is not older than Supabase. The source has `booth_plays`, `booth_sort_memos`
   and `booth_event_purges`, and an audit chain (see below).
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
Two ways. **Decided 2026-11-18: (a).** Option (b) stays in the script as a fallback only:

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

## Before the window

1. **The data host exists**: on cme-dev, the PostgreSQL cluster of its own that [`../../data-host/`](../../data-host/README.md)
   sets up (plain PostgreSQL 18 with pgvector, on an encrypted volume); or its own
   `supabase/postgres:17.6.1.136` container, or a
   plain PostgreSQL database prepared as in *Plain PostgreSQL target* below, best in a cluster of its own
   (the Supabase role names are cluster-wide and GoTrue's JWTs name them, so two such stacks cannot share
   them safely); not a database another service writes to; listening on its tailnet address only, with
   TLS on; `pg_hba.conf` (`hostssl` lines naming the target database, e.g. `clics_mentor`) allows only
   vm1's tailnet address and the host GoTrue and PostgREST run on, for the move's superuser,
   `authenticator`, `supabase_auth_admin`, `clics_backup` and `clics_analyst`; no `db/migration-*.sql` run on it (the
   schema comes from the dump). Disk encryption, capacity and login access are CME's answers on #432.
2. **The access probe** (CME runs it and sends the output, which goes into the PR): from vm1, `psql`
   connects; from another tailnet node, the connection is refused; from the internet, nothing answers. A
   refusal from another tailnet node is the one that counts.
3. **On vm1, CME installs the move's kit** from the reviewed main, as root. The directory and every file
   in it are root's and writable by root only: `run-move.sh` checks that before it runs, because sudo
   running a file the operator could change would make the operator root.
   ```bash
   install -d -o root -g root -m 755 /usr/local/lib/clics-db-move
   install -o root -g root -m 755 deploy/vm1/db-move/run-move.sh deploy/vm1/db-move/move.sh \
     deploy/vm1/db-move/backup.sh /usr/local/lib/clics-db-move/
   install -o root -g root -m 644 /dev/null /usr/local/lib/clics-db-move/db-move.conf
   ```
   `db-move.conf` holds no secret, one `NAME=value` per line; `run-move.sh` refuses any other name:
   ```
   CLICS_PG_IMAGE=postgres:18.7@sha256:f5cbc081c25690710f3fc6f4c61a7565382bae01ca0d0f2028a53d7926b85a20
   CLICS_DATA_HOST=DATA_HOST
   CLICS_DATA_DB=clics_mentor
   CLICS_DATA_USER=postgres
   CLICS_DATA_SSLMODE=verify-full
   CLICS_DATA_SSLROOTCERT=/etc/clics/data-ca.crt
   ```
   `CLICS_PG_IMAGE` is an image with bash, psql and pg_dump of the data host's major version (the data
   host's base, `../../data-host/Dockerfile`; `supabase/postgres:17.6.1.136` for an image data host). CME
   pulls it on vm1 and checks it: `docker run --rm --entrypoint pg_dump IMAGE --version`. The data host's
   certificate (its CA, not its key) goes in `/etc/clics/data-ca.crt`, root's, mode 644, in a directory
   only root can write. For option (b) of *Audit chain*, add `AUDIT_CHAIN=checksum`.

   The sudo entries, with `visudo -f /etc/sudoers.d/clics-db-move` (OPERATOR is the CLICS operator's
   account):
   ```
   Cmnd_Alias CLICS_DB_MOVE = /usr/local/lib/clics-db-move/run-move.sh preflight, \
     /usr/local/lib/clics-db-move/run-move.sh move, /usr/local/lib/clics-db-move/run-move.sh verify
   OPERATOR ALL=(root) NOLOG_INPUT: NOLOG_OUTPUT: CLICS_DB_MOVE
   ```
   Both tags matter when sudo's I/O log is on (`log_input`, `log_output`): `read -s` hides the typed
   password from the screen, not from an input log, and the move's output can carry a row (a psql error
   quotes the values it failed on). The tags govern sudo's own log only. A session recorder outside sudo
   that keeps the operator's keystrokes still sees the password; what limits it then is that the password
   opens the data host's superuser for the window only, and `setup.sh lock` takes it away (*The window*, 8).
4. **The users' notice,** a week before: the date and hour; CLICS answers "being moved" for up to an hour;
   everyone signs in once afterwards, with the same password or Google; an unfinished PLE is kept.
5. **The audit chain on production** (decision (a) above): `db/migration-audit-log-chain.sql` applied by the
   owner, `GET /oversight/audit-log/verify` answers `consistent`, and the head is recorded outside Supabase.
6. **The rehearsal on a copy** (below) has passed, its report is on #432, and the old-password check of
   `rehearsal/README.md` ("Old passwords, for real") says `N of N verify`. If it does not, the force-reset
   plan below is ready and the notice says so.

The move's commands, on vm1, as the CLICS operator:

```bash
sudo /usr/local/lib/clics-db-move/run-move.sh preflight
sudo /usr/local/lib/clics-db-move/run-move.sh move | tee ~/db-move-report.txt
sudo /usr/local/lib/clics-db-move/run-move.sh verify
```

Each asks two questions at the terminal and shows neither answer:

1. **The Supabase session-pooler URL**, typed (or pasted) by the CLICS operator: port 5432, session mode
   (the held snapshot needs one server session; the transaction pooler cannot), the password URL-encoded,
   ending `?sslmode=require`.
2. **The data host superuser's password**, typed by whoever holds it (CME). `setup.sh` gives the superuser
   a password for the window only; `setup.sh lock` takes it away again (step 8).

`run-move.sh` refuses to read them from a pipe or a file. It hands both to `move.sh` as two lines on its
stdin (`CLICS_DATA_PASSWORD=stdin`), so neither is ever a file, an argument, a `docker run -e` value (which
`docker inspect` would show), or a line in Docker's log (the container runs with `--log-driver none`).
Inside the container, `move.sh` gives the password to each psql it starts against the data host as
`PGPASSWORD`, in that psql's own environment only, for as long as it runs. Its first line names the
kit and image it ran (`kit: run-move.sh 1a2b..., move.sh 3c4d...; image ...`): keep it with the report.

### Plain PostgreSQL target

When the data host is plain PostgreSQL (CME's plan: PostgreSQL 18, database `clics_mentor`) rather than
the `supabase/postgres` image, three things the image did come first, in this order, all before window
step 2 (and before the rehearsal):

1. **Extensions.** Every extension Supabase keeps in `public` is installable on the data host. Today that
   is `vector` (pgvector) only; `move.sh` creates it in the restore. `preflight` names any that is not.
2. **Roles and the `auth` schema.** CME, as the superuser, in the target database:
   `psql -X -v ON_ERROR_STOP=1 -d clics_mentor -f prepare-plain-pg.sql`, then `\password authenticator`
   and `\password supabase_auth_admin`. It makes `anon`, `authenticated`, `service_role`, `authenticator`,
   `supabase_auth_admin` and a no-login `supabase_admin` (the dump's default privileges name it), none a
   superuser, and the `auth` schema owned by `supabase_auth_admin` (with CREATE on the database, as
   GoTrue's own set-up asks). It also makes an empty `extensions` schema: PostgREST searches it
   (`PGRST_DB_EXTRA_SEARCH_PATH`) and, without it, loads no schema cache, so every backend request fails.
   It sets no default privileges: the dump brings production's at its end, and default privileges set
   before the restore would hand `service_role` a table production revoked it from (pg_dump writes no
   line for a table that has only its owner's grants). It revokes CONNECT on the database from PUBLIC and grants it to the CLICS
   roles only. Roles are per cluster: if another database (e.g. `clics_evaluator`) is in the cluster and
   any of these roles already exists, it stops, because changing them (or `\password authenticator`) would
   change another service's login. Ask CME for a cluster of its own; only if CME confirms no other service
   uses these role names, rerun with `PGOPTIONS='-c clics.shared_roles_ok=on'`.
3. **GoTrue migrates it once,** wherever GoTrue runs (on vm1 as in window step 2, or on CME's host): a
   GoTrue that carries every migration the hosted project has run. Compare its newest file in
   `/usr/local/etc/auth/migrations` with `select max(version) from auth.schema_migrations` on Supabase.
   On 2026-11-24 the hosted project was at `20261030120000` (`saml_providers.dedicated_scope`), which
   `v2.197.0` lacks and `v2.198.0` carries, so the target needs `v2.198.0` or newer; that is the
   release `docker-compose.auth.yml` pins. Supabase keeps upgrading the hosted GoTrue, so check again on
   the day. Point `GOTRUE_DB_DATABASE_URL` at the
   target database as `supabase_auth_admin` with `sslmode=require`. Start it once so its migrations make
   `auth.users` and the `auth.uid()` and `auth.role()` functions, then **stop it until window step 6**:
   nothing may write `auth` during the load. The rehearsal must run with the same GoTrue version as the
   window. `move.sh` never talks to GoTrue, only to the database.

`run-move.sh preflight` then checks the lot: a role, extension, function or `auth` column the restore would
name and the target lacks is listed, before anything is written, and so is a missing `extensions` schema.

`rehearsal/run.sh hermetic-data-host` (CI runs it) replays every sign-in path against this target shape:
the data host's image, `prepare-plain-pg.sql`, GoTrue's own migrations, `db/schema.sql` with production's
default privileges standing in for the restore.

A local rehearsal of this path ran on 2026-11-24 with throwaway containers, against neither Supabase nor
vm1. The source was PostgreSQL 17 with TLS and a real GoTrue `auth` schema. The target was plain
PostgreSQL 18 `clics_mentor`, prepared only by `prepare-plain-pg.sql` and migrated by
`supabase/gotrue:v2.197.0` (75 migrations, `auth.uid()` and `auth.role()` present), and again with
`v2.198.0` (77 migrations, every production `auth` column present). `move.sh` ran in a
`postgres:18` container, as the window runs it. The results:

- `VERIFY: PASS` on 28 tables, the chain anchored at the source head;
- `roles.sql` ok;
- a moved user signed in with their old password (HTTP 200; a wrong password got 400);
- `backup.sh` encrypted to two keys, and refused a secret, subkey-only, sign-only, expired or revoked key,
  and a file with two keys;
- the backup's drill passed on both PostgreSQL 18 and 17.

## The rehearsal on a copy

The same commands as the window, against the real data host, then the data host is emptied again. Use
the window's freeze (step 1 below) for it as well: the pilot has not started, and a write to Supabase
during the dump fails the report.

1. Window steps 1 to 4 below (freeze, GoTrue migrates the data host, `run-move.sh move`).
2. Attach the report to #432. Then empty the data host, as it was before the rehearsal (see *Emptying
   the data host* below), and lift the freeze (window step 1 in reverse).

### Emptying the data host

- **Image container of its own:** CME recreates the container on an empty data directory; the passwords
  of window step 2 are set again in the window.
- **Plain PostgreSQL:** never recreate the cluster or its data directory (it may hold other databases,
  e.g. `clics_evaluator`). CME, as the superuser, with GoTrue and PostgREST stopped:
  `drop database clics_mentor; create database clics_mentor;`, then *Plain PostgreSQL target* steps 2
  and 3 again (`prepare-plain-pg.sql`, then GoTrue migrates once). The roles and their passwords are
  cluster-wide and stay; skip the `\password` lines.

## The window

The owner runs the window with CME, in this order; the steps only CME can run are marked **(CME)**. Expect
30 to 60 minutes. Steps 1, 2 and 6 and *Rollback* edit vm1's env files, start containers or deploy, which
the CLICS operator's account cannot do under CME's rules: CME runs them, or the deploy entry does once CME
installs one (`../README.md`, *Under CME's rules*). Each is marked **(CME or the deploy entry)**.

1. **Freeze. (CME or the deploy entry)** Railway's backend is stopped (it has been since the vm1 cutover; check). In
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
2. **GoTrue migrates the data host.** (Plain PostgreSQL, or GoTrue on CME's host: *Plain PostgreSQL
   target*, steps 2 and 3, instead, unless they ran on this empty database already; then go to step 3
   below.) **(CME)** On the data host, `\password supabase_auth_admin` and
   `\password authenticator` (psql, as `supabase_admin`). **(CME or the deploy entry)** In
   `/opt/clics/env/gotrue.env`, `GOTRUE_DB_DATABASE_URL` points at the data host as `supabase_auth_admin`;
   in `postgrest.env`, `PGRST_DB_URI` as `authenticator`. Start the sign-in services (`../README.md`,
   *Self-hosted sign-in*):
   ```bash
   cd /opt/clics/current/deploy/vm1
   export CLICS_RELEASE=$(basename "$(readlink /opt/clics/current)") CLICS_ENV_DIR=/opt/clics/env \
          CLICS_UID=$(id -u clics) CLICS_GID=$(id -g clics)
   docker compose -p clics -f docker-compose.yml -f docker-compose.auth.yml up -d --wait gotrue
   ```
   GoTrue migrates the empty `auth` schema at start. Stop it again before the restore
   (`docker compose -p clics -f docker-compose.yml -f docker-compose.auth.yml stop gotrue`), so nothing
   writes `auth` during it.
3. **Preflight.** `sudo /usr/local/lib/clics-db-move/run-move.sh preflight`, the operator and CME's
   password holder at the terminal (`AUDIT_CHAIN=checksum` in `db-move.conf` if option (b) was chosen). It
   must end `preflight ok`.
4. **Move.** `sudo /usr/local/lib/clics-db-move/run-move.sh move | tee ~/db-move-report.txt`. It must end
   `VERIFY: PASS`. On a FAIL, stop: go to *Rollback*. Attach the report to #432.
5. **Roles. (CME)** On the data host, as the move's superuser, in the target database:
   `psql -X -v ON_ERROR_STOP=1 -d DBNAME -f roles.sql` (from the branch), then `\password clics_analyst`
   and `\password clics_backup`. It must end `COMMIT` with no error: the app's roles are not superusers,
   `clics_backup` can write nothing, and `postgrest_exposure()` lists nothing.
6. **Switch the services to the data host. (CME or the deploy entry)**
   - Start the sign-in services for good, wherever they run. On vm1:
     `docker compose -p clics -f docker-compose.yml -f docker-compose.auth.yml up -d --wait gotrue postgrest supabase-gw`;
     on CME's host, CME starts its GoTrue, PostgREST and gateway against the target database.
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
8. **Supabase becomes the read-only rollback, and the move is closed.** No writer points at it:
   Railway stopped, vm1's env files no longer name it, no script's env does. Record on #432 the time the
   window closed. Keep the Supabase project unchanged until the deletion below. No file holds a move
   secret, so there is nothing to delete. **(CME)** Removes the `CLICS_DB_MOVE` sudo entry, so the move
   cannot run again, and takes the superuser's password away on the data host: on cme-dev,
   `setup.sh lock`, and `setup.sh check` prints `ok    superuser has no password`
   (`../../data-host/README.md`).
9. **Nightly backup on** (below), and the first restore drill passes before the window is declared closed.

### Rollback (any step before 8 fails)

**(CME or the deploy entry.)** The backend has written nothing to Supabase since step 1 (GoTrue's own session rows aside), so it is
still the system of record. Put the old
`backend.env` and `rimpl.env` lines back (the hosted `SUPABASE_URL` and keys), stop GoTrue, PostgREST
and the gateway wherever they run, remove `CLICS_MAINTENANCE=1`, and `deploy.sh --rollback CURRENT_SHA`.
Empty the data host (*Emptying the data host*) before the next attempt. After step 8, writes have landed on the data host: rolling back then means
moving the data host's rows back first, which this kit does not do.

### Force-reset fallback (old passwords do not verify)

If the rehearsal's old-password check fails, do not ship that GoTrue as is. In the window, after step 6:

1. The notice (step 4 of *Before the window*) already says: "after the move, set a new password with
   *Forgot password*, or sign in with Google".
2. From vm1, for every account with a password identity, ask GoTrue for one recovery mail (the backend's
   `/auth/forgot-password`, which the rate limit allows 5 an hour per client, or, **(CME)**, GoTrue's admin
   `generate_link` through supabase-gw in a one-off backend container). Accounts with a Google identity
   need nothing.
3. Until a user resets, their old password is refused with GoTrue's `invalid_credentials`; that is the
   expected state, not an outage. Track resets against the account list on #432.

## Nightly backup

`backup.sh OUT_DIR` runs on vm1 as root from cron, for example
`30 2 * * * /usr/local/lib/clics-db-move/backup.sh OUT_DIR` (the root-owned copy of *Before the window*, 3;
never one under `/opt/clics/current`, which a deploy can change). It runs `move.sh backup` in
a container of the data host's PostgreSQL version: the data host's restore stream, read in one exported
snapshot, with that snapshot's verify report carried inside the stream as SQL comments. The stream goes
straight into `gpg`, encrypted to every key holder's public key, and only the encrypted file is written.
The container keeps no log (`--log-driver none`): Docker would otherwise copy the whole dump, in clear,
into the container's log on vm1's disk. CME sets it up, once, as root:

- `/opt/clics/backup/` (root, 700) with `backup.env` (`CLICS_DATA_HOST=...`, `CLICS_DATA_USER=clics_backup`,
  and for plain PostgreSQL `CLICS_DATA_DB=clics_mentor`), `pgpass` (one line,
  `DATA_HOST:5432:DBNAME:clics_backup:PASSWORD`, the password CME set at step 5; both root, 600). This
  `pgpass` is the one password file the kit keeps: a nightly job runs with nobody at a terminal. It holds
  `clics_backup`'s, which reads every row and can write none; optionally
  `data-ca.crt` (the data host's certificate; with it, put `CLICS_DATA_SSLMODE=verify-full` in
  `backup.env`), `image` (one
  line, the same image as `CLICS_PG_IMAGE` above; without it, `supabase/postgres:17.6.1.136`) and
  `recipients.d/NAME.asc`, one **public** key per key holder (Aj. Chanvit's answer on #432; two holders
  mean any one of them can decrypt, so a lost key does not lose the backups). Each holder makes the key
  pair on their own machine and keeps the private key off vm1 and off the backup host. `backup.sh` reads
  each file with `gpg --show-keys` and refuses one that holds a private key, or more or less than one
  public key.
- `OUT_DIR` is where CME's existing backup job picks files up and copies them to another CME host or its
  NAS snapshot. That is allowed (#432) because the file is encrypted and its key is not on the NAS.

### Restore drill

Monthly, and before the window is declared closed, into a throwaway database that lives in memory (the
rehearsal's tmpfs database, `../rehearsal/README.md`), never into the data host. Under CME's rules a backup
counts only after one real restore on a third machine: neither vm1 nor the data host, but a machine CME
names, with Docker and this release on it. The key holder runs it there. The steps are the same on any
such machine; `vm1-drill` is only the command's name.

The drill's database is the data host's own PostgreSQL (`../rehearsal/docker-compose.data-host.yml`:
`clics-data-pg:18.7-pgvector0.8.7` from `../../data-host/`, with `prepare-plain-pg.sql`), so a backup is
restored into the major version it was taken from. `move.sh drill` refuses a backup from a newer major
than the drill database's, before its first row. The first drill on a machine builds that image from the
release's `deploy/data-host/`, which needs Docker Hub and github.com; without them, copy the image cme-dev
built: `docker save clics-data-pg:18.7-pgvector0.8.7` there, `docker load` on the drill machine (an image,
no data).

1. Fresh rehearsal secrets, as for the sign-in rehearsal: `rehearsal/run.sh vm1-env ENV_DIR` (a root-only
   directory).
2. The key holder decrypts on the drill machine and streams into the drill, with the key on a removable
   token or typed in, never copied to that machine's disk:
   ```bash
   cd RELEASE/deploy/vm1
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
