# vm1 runbook: CLICS backend + rimpl on the CME host (Topology B)

**Status: prepared, not live. Until the cutover below is run, production stays on Railway.** Nothing in
this directory changes Railway, Vercel or DNS. The decision and its risks are in
[ADR 0002](../../docs/adr/0002-vm1-topology-b.md).

vm1 is a **shared production host** (ccme.or.th, WordPress, superset, three other teams' CI runners). It
is administered by the CME team. We own `/opt/clics` and the `clics` compose project, and nothing else on
it.

| File | What it is |
|---|---|
| `docker-compose.yml` | Project `clics`: `backend` (loopback port 3101) and `rimpl` (no host port), hardened |
| `backend.Dockerfile` (+ `.dockerignore`) | The backend image. Deliberately **not** `backend/Dockerfile`, which Railway would detect |
| `backend.env.example`, `rimpl.env.example` | Variable **names** only, each marked same / changes on vm1 / Railway-only |
| `nginx/clics.ccme.or.th.conf` | The vhost CME installs: TLS, SSE-safe proxying to `127.0.0.1:3101` |
| `deploy.sh` | Run on the Mac: ship a git ref over Tailscale SSH, build, gate, start, flip `current`; `--attach` re-follows the last activation |
| `remote/*.sh` | The steps `deploy.sh` runs on vm1: preflight, launch (starts activate detached, then follows it), activate, attach. `lib.sh` is prepended to each |
| `health-gate.cjs` | The two health gates, run inside the backend image on the compose network |

Rimpl is built from `rimpl/Dockerfile` unchanged.

## Layout on vm1

```
/opt/clics/
  releases/<sha>/      one immutable release per commit (git archive of backend/ rimpl/ deploy/vm1/)
  current -> releases/<sha>    the live release (moves only after both gates pass)
  previous -> releases/<sha>   the one before it
  env/                 owner clics, mode 700
    backend.env        owner clics, mode 600, filled in by a human
    rimpl.env          owner clics, mode 600, filled in by a human
  runs/<run>/          one per activation, root-only: activate.sh (as staged), log, status (exit code)
  runs/latest -> <run> the most recent activation (what `deploy.sh --attach` follows)
  deploys.log          one line per successful activation
```

## 1. One-time host setup (a human, as root on vm1)

```bash
# The service user: no home, no login shell. Containers run as its uid.
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin clics

# Code is root-owned and world-readable; env is clics-only.
install -d -o root -g root -m 755 /opt/clics /opt/clics/releases
install -d -o clics -g clics -m 700 /opt/clics/env

# Create the env files EMPTY, at the right owner and mode, before any secret goes in.
install -o clics -g clics -m 600 /dev/null /opt/clics/env/backend.env
install -o clics -g clics -m 600 /dev/null /opt/clics/env/rimpl.env
```

Then **a human** fills the two files in with an editor on vm1, one `NAME=value` per line, using the
names in `backend.env.example` and `rimpl.env.example`:

- Take the values marked `[same]` from Railway, from the dashboard or from
  `railway variables --service backend --kv` in a private terminal on the Mac. Never paste a value
  into a chat, a ticket, a commit or a command line (shell history).
- `INTERNAL_TOKEN` is new for the vm1 pair. Run `openssl rand -base64 48` once, and put the **same**
  value in both files, written the same way (unquoted, one line each). The preflight compares the two
  lines byte for byte (by sha256, so it never prints them) and refuses any difference.
- `IDENTITY_ENC_KEY` must be **byte-identical** to Railway's. It decrypts rows already in the database.
- Keep `RECONCILE_INTERVAL_MS=0` in `backend.env`, as the example ships it (see *Parallel run*). A blank
  `RECONCILE_INTERVAL_MS=` is **not** 0: the backend reads it as every 6 hours. The preflight refuses a
  blank, non-numeric or non-zero value until cutover step 5.
- Leave out `TS_AUTHKEY`, `LOCAL_AI_HTTP_PROXY`, `PORT`, `NODE_ENV`, `RIMPL_URL` and every
  `RAILWAY_*`. The preflight refuses the first two.
- Delete optional lines you do not need. A blank `NAME=` sets the variable to an empty string.
- If a value contains `$`, `#` or a space, wrap it in single quotes. Compose interpolates unquoted
  values.

## 2. Asks to the CME team

1. **DNS:** an A record `clics.ccme.or.th` pointing to vm1's public IPv4.
2. **Certificate:** issue one for `clics.ccme.or.th` from the cert-manager runner, and fill in the two
   `PLACEHOLDER` paths in `nginx/clics.ccme.or.th.conf` with where it writes the files.
3. **nginx:** install the site, test it, then reload:
   ```bash
   cp clics.ccme.or.th.conf /etc/nginx/sites-available/clics.ccme.or.th.conf
   ln -s /etc/nginx/sites-available/clics.ccme.or.th.conf /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   ```
   `nginx -t` fails until the certificate paths are real. That is deliberate.
4. **SSH:** turn off password authentication on the public SSH port (key-only, or SSH only from the
   tailnet or LAN). This is CME's change. We do not make it.

### Open questions for CME

1. Who is in the `docker` group, and which users run the three self-hosted GitHub runners? Is any of
   them root or in `docker`? (Either means our secrets and in-flight PII are readable. ADR 0002, risks 1–2.)
2. Is Ubuntu Pro / ESM enabled? Is there a plan to move off 20.04?
3. Is anything in front of nginx (CDN, GDCC load balancer, WAF)? If so, nginx needs `real_ip`. Without
   it every user shares one client address and the backend's login limit (10/min per IP) locks
   everyone out.
4. Which challenge does the cert-manager runner use (HTTP-01 via webroot, or DNS-01)? Where does it
   write the files, and does it reload nginx itself?
5. Does the nginx install use `sites-enabled/` or `conf.d/`? Which nginx version is it?
6. Is egress filtered? Builds need Docker Hub, `deb.debian.org`, `registry.npmjs.org` and
   `pkgs.tailscale.com`. At runtime the services need Supabase, Anthropic and Resend on 443.
7. Does Trend Micro scan or quarantine files under `/var/lib/docker` or `/opt/clics`? Are exclusions
   needed?
8. Which tailnet is vm1's `tailscale0` on? Is node-key expiry disabled (deploys depend on Tailscale
   SSH)? For later: will the model host accept vm1's tailnet or LAN address, and on which port?
9. Which private ranges are used on the GDCC LAN or advertised as tailnet subnet routes? Docker gives
   the `clics` network a range from its default pool, and that range must not overlap them.
10. Where do host backups go? `/opt/clics/env` holds secrets.
11. Optional: would CME accept a `DOCKER-USER` rule so that only the host's nginx reaches the `clics`
    bridge? (ADR 0002, risk 5.)

## 3. Deploying

From the Mac, in a checkout of this repo. Replace `VM1_TAILNET_NAME` with vm1's tailnet host name (the
Tailscale node ADR 0002 names), without brackets or quotes. The name is not a secret; it is passed in
rather than written into `deploy/vm1/` so that nothing in the kit is tied to one host.

On macOS, `tailscale ssh` needs the **Standalone** Tailscale app (the "macsys" download from
tailscale.com); the Mac App Store variant does not have it.

```bash
git fetch origin
VM1_HOST=VM1_TAILNET_NAME deploy/vm1/deploy.sh --dry-run    # prints every remote step, sends nothing
VM1_HOST=VM1_TAILNET_NAME deploy/vm1/deploy.sh              # origin/master
VM1_HOST=VM1_TAILNET_NAME deploy/vm1/deploy.sh --attach     # follow the last activation again (read-only)
```

What happens on vm1:

1. **preflight** (read-only): x86_64, docker + compose + systemd-run present, user `clics` exists, both
   env files exist at mode 600 owned by `clics`, the required names have values, each file has exactly
   one `INTERNAL_TOKEN=` line and the two lines are byte-identical, no Railway-only names,
   `RECONCILE_INTERVAL_MS` is an explicit 0 (or `CLICS_CUTOVER_DONE=1` is set), port 3101 free or
   CLICS's own, the compose project name `clics` is not used by anyone else, and `current` (if any)
   points at a release that is on the host.
2. **upload**: the tarball is unpacked to `/opt/clics/releases/<sha>`. A sha already there is not
   unpacked again.
3. **stage + launch**: the activate script is written to `/opt/clics/runs/<run>/activate.sh` and
   started **detached**, as a systemd transient unit (`clics-activate-<run>`). `deploy.sh` then prints
   its log as it grows and exits with its result. If the connection drops (the Mac sleeps), only the
   printing stops: the activation carries on, and `deploy.sh --attach` prints its log from the first
   line to its result.
4. **activate**: repeat the env checks, build both images (`clics-backend:<sha>`, `clics-rimpl:<sha>`),
   then start **rimpl**. **Gate 1** runs inside the backend image: rimpl `/health/deep` must be 200, and
   `GET /manifest` must accept the backend's `INTERNAL_TOKEN`. Only then does the **backend** start.
   **Gate 2**: `/health/deep` must say `service: backend`, rimpl up and Supabase up, and port 3101 must
   listen on loopback only. Then `current` flips.
5. **On any failure** the previously live release is put back in the same order: its rimpl, gate 1,
   then its backend. If its rimpl cannot pass gate 1, the backend is **stopped** and stays stopped, and
   the last log line says so. On a first deploy, CLICS's containers are stopped instead. Nothing is ever
   removed (`down` is never run).

Gate 1 comes first because the backend's evaluation drain claims real queued PLEs the moment it boots,
and a 401 from rimpl sends each claimed PLE straight to manual QA. For the same reason, when
`INTERNAL_TOKEN` is being changed, the running backend is stopped before rimpl is recreated.

Tailscale SSH in "check" mode may open a browser to re-authenticate on the first call.

## 4. Cutover (in this order)

**Before:** the CME asks are done (`clics.ccme.or.th` resolves, the certificate is installed, the site
is enabled), both env files are filled in, `RECONCILE_INTERVAL_MS=0` is set on vm1, and you are
deploying the commit Railway runs.

1. **Deploy beside Railway.** Run `deploy.sh`. Production is still Railway; nothing points at vm1 yet.
   From this moment vm1's drain also claims queued evaluations, which is safe (see *Parallel run*).

2. **Smoke the public origin:**
   ```bash
   curl -s https://clics.ccme.or.th/health/deep | python3 -m json.tool
   ```
   It must show `"service": "backend"`, `checks.rimpl.status` `"up"` and `checks.supabase.status`
   `"up"`. Compare `checks.rimpl.deep.manifest.sha256` with Railway's
   (`curl -s https://backend-production-c12e4.up.railway.app/health/deep`). They must be equal, or the
   two hosts are scoring with different evaluators. Check CORS for both front-end origins:
   ```bash
   curl -si -X OPTIONS -H 'Origin: https://physician-ui.vercel.app' https://clics.ccme.or.th/health | grep -i '^access-control-allow-origin'
   curl -si -X OPTIONS -H 'Origin: https://audit-dashboard-rouge.vercel.app' https://clics.ccme.or.th/health | grep -i '^access-control-allow-origin'
   ```
   Each must echo its own origin. Optionally, run one streamed chat turn with a test account against
   the new origin. It costs one AI turn, and it is the only check that proves nginx is not buffering SSE.

3. **Point the front ends at the new API.**
   - **`ALLOWED_ORIGINS`: nothing to add.** It lists the origins of the *pages* that call the API (the two
     Vercel apps), and those do not change. vm1's value must list both, as Railway's does, and step 2's
     CORS check proves it. Add `https://clics.ccme.or.th` only if a front end is ever served from it.
   - **physician-ui** reads `window.CLICS_API_URL` from `physician-ui/public/js/config.js:5`, a
     hard-coded string (no env var). Change the non-local value from
     `https://backend-production-c12e4.up.railway.app` to `https://clics.ccme.or.th`, merge, then
     `cd physician-ui && vercel --prod --yes`.
   - **audit-dashboard** reads `process.env.NEXT_PUBLIC_API_URL` (`audit-dashboard/lib/api.ts:1`), which
     is inlined at **build** time, so a rebuild is required:
     ```bash
     cd audit-dashboard
     vercel env rm NEXT_PUBLIC_API_URL production --yes
     echo "https://clics.ccme.or.th" | vercel env add NEXT_PUBLIC_API_URL production
     vercel --prod --yes
     ```
   Signed-in users do not have to sign in again. The CLICS token is a Supabase session token, and both
   backends validate it against the same Supabase project.

4. **Watch** for the first day:
   - `curl -s https://clics.ccme.or.th/health/deep`. A `degraded` status names the failing check.
   - On vm1: `docker logs --tail 200 -f clics-backend-1` and `docker logs --tail 200 -f clics-rimpl-1`.
   - Chat replies stream word by word (if they arrive all at once, nginx is buffering). The evaluation
     queue drains. Logins do not hit "Too many login attempts" (if they do, every client shares one IP:
     see open question 3).
   - Railway's backend should go quiet apart from its drain and sweep ticks.

5. **Keep Railway as the rollback for 7 days.** Do not stop it or change its variables. On day 7,
   stopping Railway is a separate step. Once Railway's backend is stopped, and only then, hand the
   reconcile sweep to vm1. In vm1's `backend.env`:
   - add the line `CLICS_CUTOVER_DONE=1` (read by the preflight only; it records that Railway's backend
     is stopped), and
   - delete the `RECONCILE_INTERVAL_MS=0` line (the default is every 6 h), or set a positive interval.

   Then re-activate the current release (`deploy.sh --rollback CURRENT_SHA`). The preflight refuses a
   non-zero or missing `RECONCILE_INTERVAL_MS` without `CLICS_CUTOVER_DONE=1`, so the sweep cannot be
   switched on by accident while Railway's still runs.

## 5. Rollback

**To the previous vm1 release:**

```bash
VM1_HOST=VM1_TAILNET_NAME deploy/vm1/deploy.sh --rollback PREVIOUS_SHA
```
`PREVIOUS_SHA` is in `/opt/clics/deploys.log`, or `readlink /opt/clics/previous`. Its images are reused
if they still exist; otherwise they are rebuilt from the release directory.

**Back to Railway (within the 7 days):** Railway was never changed, so only the front ends move back.
1. Revert `physician-ui/public/js/config.js` to the Railway URL and run `vercel --prod --yes`.
2. Set `NEXT_PUBLIC_API_URL` back to `https://backend-production-c12e4.up.railway.app` the same way as
   above, and rebuild the dashboard.
3. vm1 may keep running (its drain is safe to leave on). If vm1 itself is the problem, stop it:
   `docker stop clics-backend-1 clics-rimpl-1` (with `restart: unless-stopped`, they stay stopped).

**Remove CLICS from vm1 entirely:** `docker rm -f clics-backend-1 clics-rimpl-1`,
`docker network rm clics_clics`, `docker image rm` the `clics-*` images, `rm -rf /opt/clics`. Then ask
CME to remove the nginx site, the certificate and the DNS record.

## 6. Operating it

| Task | Command (on vm1) |
|---|---|
| Status | `docker ps --filter label=com.docker.compose.project=clics` |
| Logs | `docker logs --tail 200 -f clics-backend-1` (or `clics-rimpl-1`) |
| Change an env value | Edit `/opt/clics/env/*.env`, then `deploy.sh --rollback CURRENT_SHA` from the Mac (recreates the containers with both gates) |
| Rotate `INTERNAL_TOKEN` | Write the same new value into **both** files, then `deploy.sh --rollback CURRENT_SHA`. The running backend is stopped before rimpl is recreated, and starts again only after gate 1. Editing one file alone is refused by the preflight, with nothing changed |
| Follow the last activation | `deploy.sh --attach` from the Mac. On vm1: `/opt/clics/runs/latest/log`, and `status` once it has finished |
| Backend left stopped by a failed restore | Fix the env files, then `deploy.sh --rollback CURRENT_SHA`. Do not `docker start` it by hand: that skips gate 1 |
| Disk | Keep the two releases `current` and `previous` point at (`readlink -f /opt/clics/current /opt/clics/previous`): a failed activation restores `current` from its directory, and the preflight refuses to deploy while it is missing. Remove any other release by name: `rm -rf /opt/clics/releases/<sha>`, `docker image rm clics-backend:<sha> clics-rimpl:<sha>`. Old `runs/` directories can go too, except the one `runs/latest` points at while it runs |

## Parallel run (Railway and vm1 against one database)

Both backends run their evaluation drain and reconcile sweep in-process.

- **The drain is safe on both.** A claim is one SQL statement under a 600 s lease with
  `FOR UPDATE SKIP LOCKED` (`db/migration-local-ai-capacity.sql:38-66`), so the two drains claim
  disjoint rows. `UNIQUE(ple_id)` backs that up. Two drains can have twice as many evaluations in flight
  (`eval_drain_concurrency` is per process). Both rimpls must score with the same evaluator: compare
  the manifest sha in step 2.
- **Only one reconcile sweep.** It re-runs tier-2 screening on sessions stuck at `ended` without a lease
  (`backend/src/services/reconcile.js:49-88`), so two sweeps could classify and meter one session twice.
  vm1 runs with `RECONCILE_INTERVAL_MS=0` until Railway's backend is stopped (cutover step 5), and the
  preflight enforces it: anything but an explicit `0` needs `CLICS_CUTOVER_DONE=1`.
- Rate limits and the guest counters are in-process memory, so a client split across both backends
  could get up to twice its allowance during the switch. That is harmless at pilot scale.

## trust proxy

The backend sets `app.set('trust proxy', 1)` (`backend/src/index.js:34`): it trusts exactly one proxy hop,
and takes the client address from the right-most `X-Forwarded-For` entry. On vm1 that hop is nginx,
which appends `$remote_addr` (`$proxy_add_x_forwarded_for`). Docker's loopback port publish is
TCP-level and adds no hop. So per-IP rate limiting works on vm1 with **no code change**, as it did
behind Railway's proxy. A guard test pins the setting at `1`; `true` would let a client spoof its
address. If anything is ever put in front of nginx, either nginx sets `real_ip` for it, or `trust proxy`
must count the extra hop.

## What deploy.sh never does

- Copy an env file. The tarball is a `git archive` of tracked files, and it is refused if it contains
  any env file other than an `*.env.example`.
- Need GitHub credentials on vm1. The code arrives as a tarball over Tailscale SSH.
- Touch Railway, Vercel, DNS, nginx or the host's configuration.
- Hard-code a host. It comes from `VM1_HOST`; a guard test keeps IP literals and tailnet domains out of
  `deploy/vm1/`.
- Run `docker compose down`, or start a backend before rimpl has passed gate 1.
