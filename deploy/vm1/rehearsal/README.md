# Sign-in rehearsal (#427)

Proves the self-hosted GoTrue and PostgREST (`../docker-compose.auth.yml`) keep every sign-in path working,
first on synthetic data, then on a copy of the production database. Production is not switched: the
rehearsal runs as its own compose project, `clics-rehearsal`, beside the live `clics` containers, and its
backend has no host port.

| File | What it is |
|---|---|
| `run.sh` | Drives it: `hermetic`, `vm1-env`, `vm1-up`, `vm1-paths`, `vm1-mail`, `down` |
| `docker-compose.rehearsal.yml` | Adds a throwaway `supabase/postgres` on **tmpfs**, mailpit, and takes the backend's host port away |
| `auth-paths.mjs` | The replay. Runs in a one-off backend container on the rehearsal network |
| `failure-probes.mjs` | `hermetic` only, after the replay: a failed mail send and one client's wrong codes and passwords (429 expected), then `run.sh` checks no auth container log names an address |
| `docker-compose.hermetic.yml` | `hermetic` only: the stand-ins for Google (`fake-google.mjs`, as `accounts.google.com`) and for Resend's relay (mailpit as `smtp.resend.com:465`, implicit TLS and SMTP AUTH), on certificates from a throwaway CA only the rehearsal's GoTrue trusts. A vm1 run never loads it |
| `fake-google.mjs` | The Google stand-in: discovery, signing key, consent, code exchange, and a test-only endpoint that hands out id_tokens as Google Identity Services does |

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

`hermetic` adds these, against the stand-ins (`docker-compose.hermetic.yml`). GoTrue runs its own Google and
mail code; only the far end is a stand-in:

12. The relay refuses a clear-text client and a TLS client without SMTP AUTH, so the OTP and reset mails of
    steps 8 and 9, which arrive, came over verified TLS with AUTH as `resend` (the shape of `smtp.resend.com:465`).
13. Google in-page: an id_token whose nonce is SHA-256 of the raw nonce, traded at `/token?grant_type=id_token`
    as `signInWithIdToken` does, then `/auth/oauth/google/complete` provisions an active physician.
14. The controls for 13: a wrong nonce, a withheld nonce, a key not in Google's `/certs` and another client's
    audience are each refused, and none creates an auth user.
15. Google redirect fallback: `/authorize` sends the browser to Google, Google back to GoTrue's `/callback`, and
    GoTrue to the Portal's `/auth/callback` with a session in the hash.
16. An invite accepted with Google: another Google account is refused (403), the invited one accepted (201).
17. Link Google: a Google sign-in with the password account's address lands on the same auth user (identities
    `email` and `google`), `/auth/link-google` records it, a Google account with another address is refused
    (409), and the password still signs in.

It creates only `@rehearsal.invalid` accounts and deletes them at the end. It prints no token, key or
password. `professionals_single_superadmin` allows one superadmin, so on a restored copy the replay sets the
existing superadmin's role to `analyst` for the run and puts it back at the end. This touches only the copy.
The backend limits sign-in attempts per minute (a 429). To replay again within a minute, restart
`clics-rehearsal-backend-1` first.

## Hermetic (CI, or a laptop with docker)

```bash
deploy/vm1/rehearsal/run.sh hermetic
```

This uses fresh secrets, a database loaded from `db/schema.sql`, and the stand-ins of
`docker-compose.hermetic.yml` for Google and for Resend's relay (mailpit behind TLS and SMTP AUTH). CI runs it in the
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
   Session pooler, which vm1 reaches over IPv4) into `/root/.supabase-db-url`, mode 600, with the password
   URL-encoded (Supabase's Connect panel does this). It is never typed on a command line or pasted into a
   chat. `run.sh` splits it into libpq variables, so it is not in any process's argv either.
4. **Restore and start.** Size it first: the tmpfs is 2 GB by default (`REHEARSAL_DB_TMPFS=4g` raises it), and
   the db container's memory cap is 3 GB (`REHEARSAL_DB_MEM`), which must stay above the tmpfs and fit in
   `free -m`. The container gets no swap, and `run.sh` stops before the restore unless the kernel enforces
   that (`memory.swap.max` is 0), so the copy cannot reach vm1's disk through swap.
   ```bash
   rehearsal/run.sh vm1-up /opt/clics/rehearsal/env < /root/.supabase-db-url
   ```
   GoTrue migrates the empty `auth` schema first. Then `auth` (data only) and `public` (schema, data,
   grants) are restored, in that order, with triggers off. If any step fails, the whole rehearsal project is
   taken down, so no partial copy stays in memory. A column the hosted GoTrue has and v2.197.0 lacks fails here, by name. The
   step ends by printing the restored user count and checking the container surface.
5. **Old passwords and hosted settings (optional files in the env directory).**
   - `old-passwords.tsv`: one `email<TAB>password` line per test account (the SANDBOX accounts). A human
     writes it at mode 644: the replay runs as the clics uid, and the directory's mode 700 keeps it from
     everyone else.
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

### What only the owner can run (on vm1, real Google and Resend)

The hermetic run proves GoTrue's and the backend's side of every path. Three things depend on the real outside
services and on secrets only the owner holds, so they are run by hand on vm1 and #427 closes on them:

1. **Google, for real.** This needs a GoTrue that serves the public origin, which the rehearsal GoTrue never
   does (it has no host port, so a copy of production's identities is never public). It runs on the `clics`
   project's own GoTrue (`docker-compose.auth.yml`, built but not switched on), before any production data is in
   its database, so it is the first step of #432's activation, in this order:
   - On the Google OAuth client the Portal uses (`CLICS_GOOGLE_CLIENT_ID`): add
     `https://clics.ccme.or.th/auth/v1/callback` as an Authorized redirect URI and `https://clics.ccme.or.th` as
     an Authorized JavaScript origin.
   - In `/opt/clics/env/gotrue.env`: that client's id and secret, `GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI` at that
     callback, `API_EXTERNAL_URL=https://clics.ccme.or.th`, `GOTRUE_JWT_ISSUER=https://clics.ccme.or.th/auth/v1`,
     and `GOTRUE_SITE_URL` and `GOTRUE_URI_ALLOW_LIST` on that origin (`gotrue.env.example` says each).
   - nginx's `/auth/v1` location installed (only after `swapon --show` is known; the #460 gate's activation
     note), and a Portal build whose `CLICS_SUPABASE_URL` and anon key point at `https://clics.ccme.or.th`. The
     Portal deployed by #429 still points at the hosted Supabase: a sign-in there proves nothing about this
     GoTrue.
   - Sign in once each way: Google in-page, the redirect fallback (the flow's `CLICS_GOOGLE_SIGNIN` entry set to
     anything but `gis`), an invite accepted with Google, and Link Google from a password account. Each counts
     only if the session is this GoTrue's: the access token's `iss` is `https://clics.ccme.or.th/auth/v1`, not
     `https://<project>.supabase.co/auth/v1`, and the user is in the self-hosted `auth.users`.
2. **Resend's relay, for real.** On vm1 during the rehearsal (steps 1 to 4), edit the rehearsal's
   `gotrue.env` (`/opt/clics/rehearsal/env/gotrue.env`) by hand: `GOTRUE_SMTP_HOST=smtp.resend.com`,
   `GOTRUE_SMTP_PORT=465` (587 if CME's egress allows only that, question 5 in #423), `GOTRUE_SMTP_USER=resend`,
   `GOTRUE_SMTP_PASS` a Resend API key made for GoTrue alone (not the backend's `RESEND_API_KEY`), and
   `GOTRUE_SMTP_ADMIN_EMAIL` a sender on the domain verified in Resend. Then recreate GoTrue and ask it for one
   recovery mail to the owner's own address, which has an account in the restored copy (on stdin, so it is in no
   argv):
   ```bash
   rehearsal/run.sh vm1-mail /opt/clics/rehearsal/env
   ```
   It must answer 200, and the mail must arrive from that sender. The invite mail stays on the backend's HTTPS
   API (`backend/src/lib/mailer.js`) and is not touched.
3. **Old passwords, for real.** Before this, `swapon --show` and `free -m` on vm1 (step 4's sizing and swap
   guard). Then steps 1 to 6 above with `old-passwords.tsv` holding the SANDBOX test accounts: step 11 must say
   `N of N verify`. If one does not, do not ship this GoTrue: record the error code the replay prints, and write
   the force-reset plan into #432 (every account gets a recovery mail in the window, and the notice tells users
   before the window).
