# Sign-in rehearsal (#427)

Proves the self-hosted GoTrue and PostgREST (`../docker-compose.auth.yml`) keep every sign-in path working,
first on synthetic data, then on a copy of the production database. Production is not switched: the
rehearsal runs as its own compose project, `clics-rehearsal`, beside the live `clics` containers, and its
backend has no host port.

| File | What it is |
|---|---|
| `run.sh` | Drives it: `hermetic`, `vm1-env`, `vm1-up`, `vm1-paths`, `down` |
| `docker-compose.rehearsal.yml` | Adds a throwaway `supabase/postgres` on **tmpfs**, mailpit, and takes the backend's host port away |
| `auth-paths.mjs` | The replay. Runs in a one-off backend container on the rehearsal network |

## What the replay proves

Each line is one check in `auth-paths.mjs`. A run ends `SIGN-IN REPLAY: all passed`, or names each failure.

1. GoTrue answers, and its version is printed.
2. GoTrue's settings are the ones the paths need (email on, Google on, phone off, signup open, autoconfirm
   off). With `hosted-settings.json` they are also compared with the hosted project's `GET /auth/v1/settings`.
3. PostgREST serves the backend through `supabase-gw` with the service-role key.
4. ADR 0007: `postgrest_exposure()` lists nothing, and an anon read is refused.
5. Email and password sign-in through `POST /auth/login`. `verifyJwt` accepts the token. Its claims carry
   `aud`, `role` and `app_metadata.providers`.
6. `GET /user` carries `app_metadata.providers` in the shape `isGoogleSession` reads, for an email user and
   for a Google-provider user.
7. Superadmin create and purge through the backend routes. Deleting the auth user removes its
   `professionals` row (the cascade).
8. An invite accepted with a password. The OTP is read from the mail GoTrue sent.
9. Forgot password. The recovery link signs in at `/reset`, the new password works and the old one is refused.
10. Global sign-out. The next request with the same token is 401.
11. Old passwords from the restored database still verify, when `old-passwords.tsv` is given.

It creates only `@rehearsal.invalid` accounts and deletes them at the end. It prints no token, key or
password.

## Hermetic (CI, or a laptop with docker)

```bash
deploy/vm1/rehearsal/run.sh hermetic
```

This uses fresh secrets, a database loaded from `db/schema.sql`, and mailpit for the mail. CI runs it in the
`deploy-vm1` job. It also checks the running containers: GoTrue is on `127.0.0.1:3102` only, PostgREST,
`supabase-gw`, the database and the backend are unpublished, and every auth container is non-root with a
read-only root. `KEEP=1` leaves the stack up for a look, and `run.sh down` removes it.

## On vm1, against a copy of production

Every step needs the owner's go-ahead (vm1 is the shared CME host). The dump streams from Supabase into a
database that lives **in memory only**, inside the rehearsal container. No copy lands on vm1's disk or on a
laptop, and step 7 deletes it. While the rehearsal runs, vm1 holds participant data in RAM, which R5 does
not otherwise allow. Keep the window short.

1. **Ship the files.** The rehearsal needs `backend/` and `deploy/vm1/` of the branch under test. From the
   Mac:
   ```bash
   git archive --format=tar HEAD backend deploy/vm1 | tailscale ssh root@VM1_TAILNET_NAME \
     'install -d -m 700 /opt/clics/rehearsal /opt/clics/rehearsal/src /opt/clics/rehearsal/env && tar -x -C /opt/clics/rehearsal/src'
   ```
2. **Fresh secrets.** On vm1, as root:
   ```bash
   cd /opt/clics/rehearsal/src/deploy/vm1 && rehearsal/run.sh vm1-env /opt/clics/rehearsal/env
   ```
3. **The source URL.** A human writes the Supabase session-pooler connection string (Project, Connect,
   Session pooler, which vm1 reaches over IPv4) into `/root/.supabase-db-url`, mode 600. It is never typed
   on a command line or pasted into a chat.
4. **Restore and start.** Size it first: the tmpfs is 2 GB by default (`REHEARSAL_DB_TMPFS=4g` raises it).
   ```bash
   rehearsal/run.sh vm1-up /opt/clics/rehearsal/env < /root/.supabase-db-url
   ```
   GoTrue migrates the empty `auth` schema first. Then `public` (schema, data, grants) and `auth` (data only)
   are restored with triggers off. A column the hosted GoTrue has and v2.197.0 lacks fails here, by name. The
   step ends by printing the restored user count and checking the container surface.
5. **Old passwords and hosted settings (optional files in the env directory).**
   - `old-passwords.tsv`: one `email<TAB>password` line per test account (the SANDBOX accounts). A human
     writes it.
   - `hosted-settings.json`: the hosted project's settings, fetched with the public anon key from
     `physician-ui/public/js/config.js`:
     `curl -s https://PROJECT_REF.supabase.co/auth/v1/settings -H 'apikey: ANON_KEY' > hosted-settings.json`
6. **Replay.**
   ```bash
   rehearsal/run.sh vm1-paths /opt/clics/rehearsal/env
   ```
   If an old password does not verify, do not ship this GoTrue. Record the error code the replay prints, and
   write the force-reset plan into #432: every account gets a recovery mail in the window, and the notice
   tells users before the window.
7. **Remove it.**
   ```bash
   rehearsal/run.sh down /opt/clics/rehearsal/env && rm -rf /opt/clics/rehearsal /root/.supabase-db-url
   ```

### Not covered by the replay

These paths need Google and a browser on a public origin, so they are run by hand once the origin exists:
Google in-page (id_token with nonce), the Google redirect fallback, an invite accepted with Google, and Link
Google. Each needs four things:

- `API_EXTERNAL_URL` at `https://clics.ccme.or.th/auth/v1`, with nginx's `/auth/v1` location installed.
- That origin as an Authorized JavaScript origin on the Google client.
- `…/auth/v1/callback` as a redirect URI on the Google client.
- A Portal that points its Supabase URL at that origin (#429).

Delivery through Resend's SMTP (`smtp.resend.com:465`, user `resend`) is proved with one real mail: point
`gotrue.env`'s SMTP lines at Resend with a separate key, recreate `gotrue`, and send a recovery to the
account owner's address. vm1's outbound SMTP is question 5 to CME in #423.
