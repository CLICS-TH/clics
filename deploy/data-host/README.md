# The CLICS data host on cme-dev (#432, ADR 0012)

**Status: prepared and tested locally (2026-11-24), not yet run on cme-dev.** The layout is the hybrid one:
the app, GoTrue, PostgREST and nginx on vm1; the database here, on cme-dev, in a PostgreSQL cluster of its
own that holds only `clics_mentor`.

**Who runs it (CME's rules, 25 Nov 2026).** The CLICS team has no account on cme-dev. These files reach
CME on a branch CME reviews and merges; CME builds the image and runs every step below as root, holds the
LUKS passphrase (its own decision who), and sends back the evidence listed in *Evidence for the CLICS
team*. SQL that changes the schema reaches CME the same way, as files, and runs only after CME's RLS
refusal tests (D6) pass.

| File | What it is |
|---|---|
| `Dockerfile` | PostgreSQL 18.7 (`postgres:18.7`, pinned by digest) with pgvector 0.8.7 (pinned by commit), built on cme-dev |
| `docker-compose.yml` | One service, `clics-mentor-postgres`: runs as uid 999, no capabilities, read-only root, the port published on cme-dev's tailnet address only, data and settings only from inside the encrypted volume |
| `postgresql.conf` | TLS on, scram passwords, connection logging (who, from where, refused or not; never a row or a statement) |
| `pg_hba.conf.template` | vm1 only, TLS only, `clics_mentor` only; the superuser only through the container's socket |
| `setup.sh` | Every step below, each printing what it did and stopping on the first problem |

The restore drill (`../vm1/db-move/README.md`, Restore drill) runs this same image, in memory, and so
does CI's hermetic sign-in replay (`../vm1/rehearsal/run.sh hermetic-data-host`).

What it guarantees, and how each is checked:

- **Encrypted at rest.** The data directory exists only inside a LUKS2 volume. While the volume is locked,
  `/srv/clics-data/pg` does not exist and Docker refuses to start the server (`bind source path does not
  exist`), so it can never start an empty cluster on the plain disk. `setup.sh check`: mounted from
  `/dev/mapper/clics-data`, type LUKS2.
- **Reachable from vm1 only, over TLS.** The port listens on cme-dev's tailnet address only. `pg_hba.conf`
  admits `hostssl` from vm1's tailnet address, to `clics_mentor`, for `authenticator` (PostgREST),
  `supabase_auth_admin` (GoTrue), `clics_backup` (the nightly backup) and `clics_analyst`; everything else
  is rejected. The move and the nightly backup check the server's certificate (`sslmode=verify-full`);
  GoTrue and PostgREST connect with `sslmode=require` (TLS, inside the tailnet's WireGuard tunnel).
- **No values in the log.** The server's log lies outside the volume (Docker's, on the plain disk), so it
  keeps connections and refusals only: no statement, no query error (its text can carry a value).
- **No superuser password at rest.** The superuser (`postgres`) has no password; it works only through the
  container's own socket (`setup.sh psql`). It gets a password for the move window only, and
  `setup.sh lock` takes it away afterwards.

## Before starting (pre-checks, on cme-dev as root)

```bash
docker compose version          # v2 or newer
cryptsetup --version            # LUKS2 support
tailscale ip -4                 # cme-dev's tailnet address: CLICS_DATA_BIND
ss -Hltn 'sport = :5432'        # nothing may listen on 5432 at that address yet
lsblk                           # the disk CME gave for the volume, or the free space for a 10 GB file
```

Also needed: vm1's tailnet address, and the passphrase holder (CME's decision) at the keyboard for step 3.

## Set-up, once

1. **Release directory.** The repository at the release commit in `/opt/clics-data/current`, so that
   `deploy/data-host/` and `deploy/vm1/db-move/prepare-plain-pg.sql` are both there. The commands below
   run from `/opt/clics-data/current/deploy/data-host`.
2. **Settings.**
   ```bash
   install -d -m 700 /opt/clics-data/env
   install -m 600 /dev/null /opt/clics-data/env/data.env
   ```
   With an editor: one line, `CLICS_DATA_BIND=` and cme-dev's tailnet address.
3. **The encrypted volume.** The passphrase holder types at cryptsetup's own prompts (`YES`, then the
   passphrase twice to format and once to open). It is never on a command line or in a file.
   ```bash
   ./setup.sh volume /dev/DISK                       # a whole disk for it (asks for the path again; erases it)
   ./setup.sh volume-file /var/lib/clics-data.img 10   # or a 10 GB file in an existing directory (the DB is 18 MB)
   ```
4. **The certificate.** `./setup.sh tls NAME ADDRESS` (cme-dev's tailnet name and address). It prints the
   certificate's fingerprint. Copy `/srv/clics-data/conf/server.crt` (never the key) to vm1, as
   `/etc/clics/data-ca.crt` (the move) and `/opt/clics/backup/data-ca.crt` (the nightly backup), both
   root's.
5. **Who may connect.** `./setup.sh hba VM1_ADDRESS` (later changes: then `./setup.sh reload`).
6. **Build and start.**
   ```bash
   docker compose -p clics-data --env-file /opt/clics-data/env/data.env build
   ./setup.sh init
   ```
   `init` makes the cluster (data checksums on), takes the superuser's password away, and applies
   `prepare-plain-pg.sql` (the roles and the `auth` schema GoTrue expects, and the `extensions` schema
   PostgREST searches). Then the two service logins get
   their passwords, typed at psql's prompt and written only into vm1's `gotrue.env` and `postgrest.env`:
   ```
   ./setup.sh psql
   \password authenticator
   \password supabase_auth_admin
   ```
7. **Post-checks.**
   - `./setup.sh check`: every line `ok`, exit 0.
   - From vm1: `psql "host=CME_DEV_ADDRESS dbname=clics_mentor user=authenticator sslmode=verify-full
     sslrootcert=/etc/clics/data-ca.crt" -c 'select 1'` answers; the same with
     `sslmode=disable` is rejected.
   - From another tailnet node: rejected. From the internet: nothing answers.
   - `./setup.sh logs | grep 'connection received'` shows vm1's
     tailnet address as `host=`. If it shows a Docker address (172.x), stop: Docker is rewriting the
     source, and pg_hba would then judge every client by that one address. Never write a Docker address
     into `pg_hba.conf`.

## After a reboot

The volume stays locked until the passphrase holder opens it; until then the server does not start (by
design).

```bash
./setup.sh open /dev/DISK            # or: ./setup.sh open /var/lib/clics-data.img
./setup.sh start
./setup.sh check
```

`./setup.sh close` stops the server, unmounts and locks, whatever state it finds.

## The move window (data host side)

The steps are `../vm1/db-move/README.md`, *The window*. What happens here:

- Before: the superuser gets a password for the window only: `./setup.sh psql`, `\password postgres`. Its
  holder types it again at `run-move.sh`'s second prompt on vm1, for each of `preflight`, `move` and
  `verify`; it is never written into a file (`db-move.conf` has `CLICS_DATA_DB=clics_mentor`,
  `CLICS_DATA_USER=postgres`). The move's PostgreSQL image is this one's base:
  `postgres:18.7@sha256:f5cbc081c25690710f3fc6f4c61a7565382bae01ca0d0f2028a53d7926b85a20`.
- Step 5 (roles): `docker compose -p clics-data --env-file /opt/clics-data/env/data.env exec -T -u postgres
  clics-mentor-postgres psql -X -v ON_ERROR_STOP=1 -d clics_mentor < ../vm1/db-move/roles.sql` (from this
  directory), then
  `./setup.sh psql`: `\password clics_analyst`, `\password clics_backup`.
- Step 8: CME removes the move's sudo entry on vm1, and here `./setup.sh lock`. `./setup.sh check` prints
  `ok    superuser has no password`.

## Evidence for the CLICS team

What CME sends back after the set-up (and the parts that change, after each window), so the CLICS team can
accept the data host without logging in. None of it is a secret: no password, no key, no row.

1. **The commit** the files came from (CME's merge of the branch), and `git diff --stat` against it on
   cme-dev's checkout: empty.
2. **The image:** `docker image inspect clics-data-pg:18.7-pgvector0.8.7 --format '{{.Id}}'`, its
   `postgres --version`, and pgvector's version as the server sees it
   (`select default_version from pg_available_extensions where name = 'vector'`: `0.8.7`).
3. **`./setup.sh check`**, all of it: every line `ok`, exit 0. It covers the LUKS2 mount, port 5432 on the
   tailnet address only, PostgreSQL 18.7, TLS on, pgvector 0.8.7, the superuser without a password, the
   databases, `pg_hba.conf` (parses, every accepting network line `hostssl`) and the server's uid.
4. **The certificate:** its SHA-256 fingerprint and end date, as `setup.sh tls` printed them. vm1 trusts
   exactly this certificate.
5. **The connection tests** of step 7, each with its output: from vm1, `verify-full` as `authenticator`
   answers and `sslmode=disable` is rejected; from another tailnet node, rejected; from the internet,
   nothing answers; `./setup.sh logs | grep 'connection received'` shows vm1's tailnet address.
6. **`pg_hba.conf` as installed** (`/srv/clics-data/conf/pg_hba.conf`): it names addresses and roles, no
   password.

## Emptying it (after an evaluation with real data, or to start over)

```bash
./setup.sh close
cryptsetup erase /dev/DISK           # or the volume file: every key slot destroyed, the data unreadable
rm /var/lib/clics-data.img           # the file case only
```

Then set it up again from step 3. Erasing the key slots, not deleting files, is what makes the copy
unreadable: on an SSD a deleted file's blocks can survive.

## Tested, and not

Tested on 2026-11-24, in the colima Linux VM (Ubuntu 24.04, arm64) and a privileged throwaway container:
the image builds (pgvector 0.8.0, production's version, does not build on PostgreSQL 18; 0.8.7 does);
`tls`, `hba`, `init`, `check`, `lock`; the server sees the client's real address; `verify-full` as
`authenticator` connects over TLS 1.3, and no-TLS, the superuser over the network, another database and
another address are refused; a restart works with the emptied bootstrap file; while locked the server
refuses to start; LUKS `volume-file`, `close`, `open` (right and wrong passphrase), a failed format leaving
nothing open; `cryptsetup erase` leaves the passphrase useless; the log keeps a refused connection and a
`reload`, and none of a duplicate key's or a bad input's value (no ERROR, DETAIL or STATEMENT line), in
Docker's `local` driver capped at 3 × 10 MB. `scripts/db/db-move-test.sh` passes on PostgreSQL 18.7 as well
as 17.

Not tested: cme-dev itself (x86-64, its Docker and tailnet), a whole-disk `volume`, the tailnet path from
vm1, and a real move into it. That is the evaluation run's job.
