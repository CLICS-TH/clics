# ADR 0002 — Topology B on vm1: backend and RIMPL on the shared CME host

- **Status:** Accepted, 2026-10-21. **Prepared, not live.** Production stays on Railway until the
  cutover in [`deploy/vm1/README.md`](../../deploy/vm1/README.md) is run.
- **Scope:** where the CLICS backend and RIMPL run, how the backend reaches RIMPL, and what the host must
  enforce while they run there. The front ends (Vercel) and the database (Supabase, Tokyo) do not move.
- **Supersedes in part [ADR 0001](0001-d3-transport-topology.md).** Its decision was to build no
  transport until a GDCC host existed. One now does, and its first trigger row ("VM provisioned, answers
  to 1–3 favourable → adopt Topology B, close #90, write ADR 0002") is what this record carries out. Its
  statement on data custody still stands unchanged.

## Why this exists

ADR 0001 parked the D3 transport work until three facts about a GDCC host were known. They are now
known, but the host is not the dedicated VM that ADR imagined. It is the CME team's existing production
web server, shared with other teams. This record says why that host is acceptable, which conditions make
it acceptable, and which risks remain anyway, so that nobody later has to reconstruct the reasoning from
a compose file.

## Context (verified 2026-10-21, read-only)

**vm1** is Tailscale node `098215-u`, the ccme.or.th production web host. We reach it over Tailscale SSH
as root.

| | |
|---|---|
| OS | Ubuntu 20.04.6, kernel-mode Tailscale (`tailscale0`) |
| Capacity | 8 vCPU, 15 GiB RAM (12 GiB free), 289 GB disk free, no GPU |
| Runtime | Docker 28.1.1 |
| Network | Public IPv4, plus a GDCC LAN interface |
| Web | nginx serves 80/443/8443 for ccme.or.th, headscale.ccme.or.th and score.ccme.or.th. TLS is renewed by a CME cert-manager GitHub runner. |
| Ports in use | 22, 80, 443, 8443, 3000, 3002, 3007, 4118, 8088, 6379 (loopback), 53 (resolver stub), a tailscaled port |
| Neighbours | WordPress/php-fpm, a superset container, three self-hosted GitHub Actions runners belonging to other teams, Trend Micro agents |

**It is a shared production host.** Everything below follows from that.

ADR 0001's three open questions now have answers:

1. **Public 443:** yes, through the shared nginx, which already terminates TLS for three CME sites.
2. **Tailscale allowed:** yes. It is installed and runs in kernel mode with a TUN device.
3. **Known administrator:** the CME team (Aj. Chanvit).

The owner chose vm1 rather than asking for a second VM.

## Decision

**Adopt Topology B on vm1.** The backend and RIMPL run as one Docker Compose project, `clics`, from
`deploy/vm1/`:

```
browser ──HTTPS──▶ nginx on vm1 (CME's; vhost clics.ccme.or.th) ──▶ 127.0.0.1:3101
                                                                       │ docker port publish (loopback only)
                                                                       ▼
                                              ┌──────── docker network `clics` (on vm1) ────────┐
                                              │  backend :3001  ──HTTP──▶  rimpl :3003          │
                                              │  (no other port)           (no host port)       │
                                              └──────────┬────────────────────────┬────────────┘
                                                         │ host egress (NAT)      │ host egress (NAT)
                                                         ▼                        ▼
                                          Supabase (Tokyo), Resend   Anthropic; later the on-prem model
                                                                     via vm1's tailscale0 or GDCC LAN
```

- The **front ends stay on Vercel**. At cutover they point at `https://clics.ccme.or.th`.
- The **database stays in Supabase, Tokyo.** Moving the application does not move data custody.
- **No Tailscale runs inside any container.** RIMPL's optional userspace client (`rimpl/Dockerfile`)
  stays off because `TS_AUTHKEY` is never set on vm1. Model endpoints on the tailnet or the GDCC LAN are
  reached through the host's own routing table, via docker's default NAT egress.
- The backend image is built from `deploy/vm1/backend.Dockerfile`, **never `backend/Dockerfile`**:
  Railway auto-detects that path and would switch the live backend's builder away from Railpack (ADR
  0001). A guard test fails if the file ever appears. RIMPL is built from `rimpl/Dockerfile` unchanged,
  so the Railway build of the same file is unaffected.

## Why vm1

- **Access already exists.** Tailscale SSH as root, verified 2026-10-21. A second VM would need a new
  request, a new image, a new firewall conversation and a new administrator.
- **Resources are ample.** The two services are capped at 1 GiB and 2 CPUs each, about 13% of RAM
  and half the cores at worst, with 12 GiB free.
- **443 and TLS are already solved.** nginx and the cert-manager runner serve three sites today. We add a
  fourth vhost; we do not operate a TLS stack.
- **A TUN device and a static address.** Topology A's whole mechanism (userspace Tailscale, an HTTP
  proxy dispatcher, `undici`) existed only because a Railway container has neither (ADR 0001).
- **It is in GDCC,** the environment CREC082 §10.1 names (see ADR 0001 on what that clause does and does
  not require). Whether a *shared* CME host meets the protocol's "project-controlled" wording is for the
  PI to state. This record does not decide it.

## Why a shared host is acceptable, and on what terms

It is acceptable because **no PII rests on vm1**. The database stays in Supabase and RIMPL is
stateless, so what vm1 holds is code, images, two env files of secrets, and rotated container logs.
PII exists there only in the memory of the two containers while a request runs. The public surface is
one nginx vhost that proxies to one loopback port.

That holds only while these requirements hold. They are requirements, not preferences:

| # | Requirement | Where it is enforced |
|---|---|---|
| R1 | Containers run **non-root**, as the host's dedicated `clics` uid (not the image's uid 1000, which may be a real login user on this host) | `docker-compose.yml` `user:`; CI asserts the uid inside both containers |
| R2 | **`no-new-privileges`**, **all capabilities dropped**, **read-only root filesystem** (tmpfs `/tmp` only) | `docker-compose.yml` `x-hardened`; guard test; CI asserts docker reports `ReadonlyRootfs: true` for both containers, and that in each a write to world-writable `/var/tmp` fails while the same write to `/tmp` succeeds |
| R3 | The backend is **published on `127.0.0.1` only** | compose `ports`; guard test (text and, in CI, docker's own rendering); `deploy.sh` refuses a listener beyond loopback |
| R4 | **RIMPL is not published at all.** It is reachable only on the project's docker network | compose; guard test; CI reads RIMPL's bindings with `docker inspect` and fails on any published port or port binding (not `docker compose port`, which prints `:0` for a port the image exposes but compose does not publish) |
| R5 | **No PII at rest on vm1**: no volumes, database in Supabase, RIMPL stateless | compose declares no volume; the apps write no files (checked 2026-10-21) |
| R6 | **Env files mode 600, owned by `clics`**, placed by a human, never shipped by the deploy | `deploy.sh` preflight refuses otherwise; the tarball check refuses any env file; `deploy/vm1/.gitignore` |
| R7 | **Memory, CPU and process limits** (1 GiB, no swap, 2 CPUs, 256 pids each) | `docker-compose.yml` |
| R8 | **Log rotation**: json-file, 10 MB × 5 per container | `docker-compose.yml` |
| R9 | **No IP literal and no tailnet domain in `deploy/vm1/`.** The host comes from `VM1_HOST` at deploy time, so nothing in the kit is tied to vm1. vm1's Tailscale node name (`098215-u`, above) is in this repo and is not a secret: reaching the node still takes tailnet membership and Tailscale SSH access | guard test: no IPv4 literal but loopback, no tailnet domain, under `deploy/vm1/` |
| R10 | **No backend is started by the deploy kit until RIMPL has accepted the backend's `INTERNAL_TOKEN` in gate 1.** This holds on every path that starts it: a deploy, a rollback, and the restore after a failed activation. Gate 1 asks `GET /manifest` with the token every time, so its exit 2 (token accepted, RIMPL degraded) is never a refused token. A deploy also needs RIMPL healthy (exit 0) before `current` moves. The restore starts the backend on exit 0 or 2, and on any other gate failure stops it instead. An activation interrupted by a signal records a failure and restores nothing. Preflight, and activate again before it changes anything, refuse unless each env file has exactly one `INTERNAL_TOKEN=` line and the two are byte-identical. A running backend whose token would no longer match the new RIMPL is stopped before RIMPL is recreated | `deploy/vm1/remote/{preflight,activate}.sh` and `lib.sh`; `scripts/deploy/vm1-remote.test.mjs` (the reason is under *Parallel run*). **Not covered:** a container started by hand on vm1 (`docker start`, `docker compose up`) gets no gate. After a host or daemon restart, docker restarts both containers with the env they were created with, which had passed the gate |

## Residual risks

These remain with every requirement above in place. They are stated because a shared host makes them
real, not hypothetical.

1. **The docker group is root-equivalent.** Anyone who can reach the docker socket can `docker inspect`
   our containers, which prints every environment variable (every secret), or `docker exec` into them and
   read PII in memory. Mode 600 on the env files does nothing against that. Who is in the `docker`
   group on vm1 is unknown (ask).
2. **Other teams' self-hosted runners execute code on this host.** A runner runs whatever its
   repository's workflows tell it to. If a runner's user is root or in the docker group, then a workflow
   run, possibly one triggered from a pull request depending on that repository's settings, has
   everything in risk 1. Unknown (ask).
3. **Ubuntu 20.04 is past standard support** (ended May 2025). Kernel and package fixes continue only
   under Ubuntu Pro / ESM, and container isolation is only as good as the kernel. Whether ESM is enabled
   is unknown (ask).
4. **Public SSH accepts passwords.** That is brute-force exposure on the host that holds our secrets.
   It is the CME team's to fix, and we list it as an ask. We do not change it.
5. **Unpublished does not mean unreachable from the host.** Any local process (php-fpm included) can
   connect to a container's bridge address. RIMPL's `/health` and `/health/deep` are unauthenticated.
   They reveal routing and model configuration, not PII. Every other RIMPL route requires
   `INTERNAL_TOKEN`. A `DOCKER-USER` firewall rule could close this. That is optional and would be CME's
   change.
6. **Shared nginx and certificate automation.** A failed reload by anyone, or a cert-manager failure,
   takes `clics.ccme.or.th` down with the CME sites. We do not control either.
7. **No reservation.** The limits protect the neighbours from us, not us from the neighbours.
8. **Deploys are not zero-downtime.** Recreating a container cuts in-flight chat turns (the backend drains
   for 15 s). Deploy outside session hours. And by design (R10), an activation whose restore cannot get
   RIMPL to accept the backend's `INTERNAL_TOKEN` (gate 1 exits anything but 0 or 2) leaves the backend
   **stopped**, which after cutover is an outage until the env files are fixed. That is the deliberate
   trade: a stopped API comes back with one corrected deploy; a queue drained into manual QA needs a
   human to deal with every flagged PLE. A RIMPL that accepts the token but is **degraded** (exit 2: the
   Supabase probe, an exhausted Anthropic balance, an unreachable local box) does not stop it: the
   restore starts the backend again, because a degraded RIMPL answers `/evaluate` with 500 or 503, which
   the drain retries rather than flagging at once (a 401 is flagged on the first claim). The retries are
   bounded: `EVAL_MAX_ATTEMPTS` (20, about 4 h of capped backoff), after which each claimed PLE is flagged
   `exhausted` for manual QA. So a degraded RIMPL must be fixed within hours, or the backend stopped. A
   deploy still refuses to make a
   degraded RIMPL `current`. An activation stopped by a signal (`systemctl stop`, a reboot) records exit
   143 or 129 and restores nothing. If it had stopped the backend for a token change, the backend stays
   stopped until the next activation, so that is an outage too, reported as one.
9. **Trend Micro agents** may scan or quarantine files under `/var/lib/docker`. The interaction is
   unknown (ask).
10. **Container logs rest on vm1's disk.** They hold ids and error messages. RIMPL's parse-failure log
    carries model output, which is produced from de-identified input. Rotation bounds how much is kept.

Together they mean that **CME's administrators, and anyone with root or docker access on vm1, are inside
the trust boundary for our secrets and for in-flight PII.** On Railway that boundary was Railway's
platform and staff. The move swaps one third party for another; it does not remove the third party.

## D7, re-derived

**What D7 accepted** (`docs/LOCAL-MODEL-ROADMAP.md`, decisions of record): the raw-PII hop from a Railway
backend to an on-premise RIMPL, over Tailscale. `rimplEvaluate` and `rimplChat` carry the raw transcript
and `patient_ref` to RIMPL, which is what strips them.

**What changes on vm1.** Backend and RIMPL share one kernel. The hop is a docker bridge on vm1
(`RIMPL_URL=http://rimpl:3003`): it never leaves the host, crosses no network we do not own, and needs
no WireGuard. **The hop D7 accepted is never built in this topology,** so D7 does not apply to it.
(Topology A, PR #90, was never merged, so that hop never existed in production either.)

**What does not change:**

- **Data custody.** PII at rest stays in Supabase, Tokyo. The backend still reads raw transcripts from
  Tokyo over TLS. They now arrive in Thailand (vm1) instead of the United States (Railway). "PII never
  leaves Thailand" is still false and must not be written anywhere (`docs/LOCAL-MODEL-ROADMAP.md`, *The
  PII hop*). The storage leg is A3, and A3 is a separate decision that has not been taken.
- **PII in memory on a host we do not administer.** On Railway that meant Railway. On vm1 it means CME
  and the residual risks above.
- **What reaches a model is de-identified.** RIMPL strips PII before any model call. Today the model is
  Anthropic. Later, via `LOCAL_AI_*`, it is the on-prem model, reached over vm1's `tailscale0`
  (WireGuard) or over the GDCC LAN (plain HTTP inside GDCC, carrying de-identified text only).
- **On-prem inference is not delivered by this record.** It makes the on-prem model reachable without
  Tailscale in a container. Routing a purpose to `local` is still D3's work and still gated by D18.

## Parallel run during cutover

The cutover deploys vm1 beside Railway, and both backends then run against the same database for up to
7 days. **The evaluation drain is safe to run on both.** Its claim is one SQL statement under a lease,
`FOR UPDATE SKIP LOCKED` (`db/migration-local-ai-capacity.sql:38-66`), so two drains claim disjoint
rows. A claimed row is evaluated once (`attempts: 1`, `backend/src/services/eval-drain.js:92`). If a
lease ever expired mid-call, `UNIQUE(ple_id)` and the `fresh` flag would still stop a second stored score
and a second charge to the physician's meter, though the AI call itself would be paid twice
(`backend/src/services/ple-evaluation.js:32-39`). The lease (600 s) outlasts the evaluate timeout
(480 s), so it should not expire mid-call.

It is safe **on four conditions**:

1. **`INTERNAL_TOKEN` must match every time the vm1 backend boots,** not only the first time: a
   re-activation after an env edit boots it again. The drain claims on boot (`eval-drain.js:180`), and
   RIMPL's 401 is classed as deterministic (`backend/src/services/rimpl-client.js:70`), so each claimed
   PLE would go straight to manual QA (`eval-drain.js:99-101`), and each completion pulls the next row
   (`eval-drain.js:111`), so the whole queue would drain that way. R10 exists for this.
2. **Both RIMPLs must run the same evaluator.** Deploy the commit Railway runs, and compare
   `checks.rimpl.deep.manifest.sha256` on both `/health/deep` endpoints. Otherwise scores in the overlap
   come from two configurations.
3. **Concurrency adds up.** `eval_drain_concurrency` is per process (`eval-drain.js:7-8`), so two
   drains can have twice as many evaluations in flight. That is harmless on Anthropic. Once `evaluate`
   routes to the on-prem box (about 2 slots), the extra calls defer on `queue_full`; nothing is dropped.
4. **Only one reconcile sweep.** Unlike the drain, the 6-hourly sweep re-runs tier-2 screening on
   sessions stuck at `ended` without any lease (`backend/src/services/reconcile.js:49-88` →
   `ple-finalize.js:38-52`). Two overlapping sweeps can classify and meter the same session twice. vm1
   therefore runs with `RECONCILE_INTERVAL_MS=0` until Railway's backend is stopped. A blank value is
   not 0 (the backend reads `value || 6h`), so the preflight refuses a blank or non-numeric value, and
   refuses any non-zero or missing one unless `backend.env` also holds `CLICS_CUTOVER_DONE=1`, which a
   human adds at cutover step 5, once Railway's backend is stopped.

## Consequences

- **Follow-up: close #90** (Topology A). It is dead weight under this decision. This change does not
  close it. Its runbook's access, authentication and rollback gates carry over, as ADR 0001 said they
  would.
- **Railway is untouched.** Nothing under `backend/` or `rimpl/` changes. Railway stays production until
  the cutover, and is the rollback for 7 days after it. Its decommissioning is a separate step.
- **The operational split is explicit.** CME owns DNS, the certificate, nginx, the OS, the Docker daemon
  and the host firewall. We own `/opt/clics`, the compose project and the env files.
- **A new public API origin, `https://clics.ccme.or.th`.** At cutover, `physician-ui/public/js/config.js`
  and the dashboard's `NEXT_PUBLIC_API_URL` change. `ALLOWED_ORIGINS` does not, because the pages stay on
  Vercel. The Railway URL that is hard-coded in scripts (`scripts/smoke`, `scripts/loadtest`, `scripts/soak`,
  `scripts/provision`, `scripts/responsive/mobile-audit.mjs`) and in docs is a follow-up after cutover.
- **What CREC-facing text may say, once live:** the backend and the middleware run on GDCC
  infrastructure in Thailand. **What it may not say:** that participant data stays in Thailand.

## What would change this decision

| Trigger | Then |
|---|---|
| A dedicated GDCC VM becomes available | Move the same compose project there. Nothing in `deploy/vm1` is specific to vm1 except `VM1_HOST`. Residual risks 1, 2 and 5 largely disappear. |
| vm1 is retired, or CME withdraws access | Within 7 days of cutover, roll back to Railway (`deploy/vm1/README.md`). After that, first make sure vm1 runs no reconcile sweep: in vm1's `backend.env` set `RECONCILE_INTERVAL_MS=0` and delete `CLICS_CUTOVER_DONE=1`, then `deploy.sh --rollback CURRENT_SHA`, or stop vm1's containers (`docker stop clics-backend-1 clics-rimpl-1`, CME's to run if our access is gone). Only then redeploy Railway from master, so that two reconcile sweeps never run at once. The Railway path is never altered by this work. |
| CME cannot close password SSH, or a runner user turns out to be in the docker group | Re-open this record. Ask for a dedicated VM rather than accept that exposure for participant data. |
| Tailscale is removed from vm1 | Backend and RIMPL are unaffected (their hop needs no tailnet). Model endpoints are then reached over the GDCC LAN only. |
| Anything is put in front of vm1's nginx (CDN, load balancer) | A configuration change, not a new decision. nginx needs `real_ip`, or the backend's `trust proxy` must count the extra hop, or every user shares one rate-limit bucket. |
| The database moves to Thailand (A3) | A separate ADR. This one does not cover data custody. |
