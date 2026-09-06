# D3 — backend to on-prem RIMPL

Prepared 2026-09-06. **PR preparation only; no production cutover or merge is implied.**
The source baseline is `afaf012`. The parked `feat/backend-tailnet-client` image/entrypoint is
included with the previously missing dispatcher and dependency, rather than deployed separately.

## What this release contains

- `backend/Dockerfile`, `docker-entrypoint.sh`, `.dockerignore`: optional userspace Tailscale.
  No `TS_AUTHKEY` means the application command starts directly. Login is bounded by
  `TS_UP_TIMEOUT` (default `20s`); an unavailable tailnet does not prevent the backend from starting.
- `backend/src/services/rimpl-client.js`: `RIMPL_HTTP_PROXY` applies only to chat, discuss,
  evaluation, criteria, deep readiness and provider readiness. Other service calls do not use this
  proxy. An unavailable or invalid proxy fails the RIMPL operation; there is no direct fallback.
- Undici `8.10.1`: the proxied path uses the package's fetch and ProxyAgent together. Passing its
  dispatcher directly to Node 22's bundled fetch fails with `invalid onRequestStart method`.
  The backend runtime floor is therefore `>=22.19.0`. Request AbortSignals retain their existing
  deadlines, including the longer background evaluation deadline.
- `.github/workflows/backend-container.yml`: builds Linux amd64 and exercises the real entrypoint
  without network access, including failed Tailscale login. It never publishes an image or deploys.
  PR CI does not receive credentials for the existing live dashboard smoke.

`node:22-slim` pins a release line, not a patch or image digest. Record the resolved image digest and
Node version when building a release. Tailscale remains fixed at the parked image's `1.78.1`.

## Gates before deployment

- [ ] The owner authorizes installation, supplies the account, and confirms the accepted Docker or
  Node service setup, outbound access, service administrator, and startup/restart policy.
- [ ] Verify `cme-dev` is online and the recorded key-expiry issue has been resolved. The 2026-09-05
  port sweep is historical evidence from the **Railway RIMPL container**, not today's backend.
- [ ] Rotate the exposed Tailscale auth key and Open WebUI JWT before placing project credentials
  on the owner's machine. Do not paste secrets into this runbook, shell history, PR or test output.
- [ ] From the approved host, identify the actual endpoint serving `deepseek-v4-flash-dspark`.
  `192.168.1.178:8000/v1` and `cme-dgx:8888/v1` are candidates; neither is confirmed by this PR.
  Do not substitute the unrelated Ollama service on `:11434`.
- [ ] The Docker build and hermetic tests pass for the exact candidate commit. On a machine with
  Docker: `docker build --platform linux/amd64 -t clics-backend:d3 backend`.
- [ ] Inspect Railway's current backend build/start settings and actual runtime. A service-level
  start override may replace the Docker CMD. Verify entrypoint behavior in an isolated Railway
  environment before promoting it. Merely adding this Dockerfile changes the next backend build.
- [ ] Record the previous backend and Railway RIMPL deployment IDs, current `RIMPL_URL`, and which
  proxy/Tailscale variables were absent. Store any secret values only in the approved secret store.

## Install and validate on-prem RIMPL before routing production

Follow the owner-approved installation method in [Thai install spec](ONPREM-INSTALL.th.md). For a
Docker bridge deployment, publish port 3003 bound to the **verified host Tailscale IP**, not to all
interfaces. If host networking is chosen, confirm host-side access controls restrict port 3003 to
the approved tailnet sources. Do not assume `EXPOSE` or `INTERNAL_TOKEN` restricts network exposure.
Confirm outbound LAN access to the verified inference server from the actual RIMPL container.

- [ ] Use a protected environment file, set the matching `INTERNAL_TOKEN`, and start only the
  CLICS service. Do not reboot or restart the shared inference host to test our service.
- [ ] `/health` is liveness. `/health/deep` is also intentionally accessible without a token and
  reports configured dependencies; protected application/provider-probe routes still require
  `x-internal-token`. A 200 liveness response alone does not prove readiness or authorization.
- [ ] A request without/with a wrong internal token to a protected route is rejected. Verify the
  correctly authenticated path with synthetic content, including de-identification/provenance.
- [ ] Confirm the approved service restart policy works and the log does not contain raw test
  identifiers, auth keys or tokens. Check only CLICS's process, binding and health.

The PDF's unauthenticated `/health/deep` example reflects the actual monitor route; its broad claim
that every endpoint except `/health` needs a token does not. Use the code's route-level policy above.

## Isolated backend validation and production cutover

Use a separate Railway environment with synthetic data first. Configure one variable per command
or use the platform's variable editor; do not combine variable assignments with shell commands.

| Variable | Value or source |
|---|---|
| `RIMPL_URL` | Verified on-prem RIMPL HTTP address, port 3003; never the model's API URL |
| `RIMPL_HTTP_PROXY` | `http://127.0.0.1:1055` for the bundled Tailscale proxy |
| `TS_PROXY_PORT` | `1055`, matching the proxy URL |
| `TS_HOSTNAME` | `clics-backend` (use a distinct name in the isolated environment) |
| `TS_AUTHKEY` | Fresh, approved key from the secret store |
| `INTERNAL_TOKEN` | Must match the on-prem RIMPL service |
| `TS_UP_TIMEOUT` | `20s`, unless a different bounded login window is justified |

- [ ] From the actual candidate backend process, check both deep and provider readiness, then
  synthetic chat/criteria/discuss/evaluation. Verify the provider/model actually reported in the
  response/provenance, auth behavior, latency and error propagation. A laptop curl is not this test.
- [ ] Explicitly stop the candidate's proxy in the isolated environment: RIMPL calls must fail,
  while unrelated backend services retain their normal routes. Restore it and confirm recovery.
- [ ] Confirm on-prem RIMPL's selected dependencies are healthy, including retrieval only when
  enabled. See [RAG rollout checklist](RAG-ROLLOUT-CHECKLIST.md).
- [ ] Only after review and explicit cutover authorization, deploy the approved release using
  the verified Railway settings. Observe readiness, queue progress and a synthetic transaction.
  Keep the previous Railway RIMPL deployment available during the observation window.

Relocation and provider selection are separate operations. `/evaluate` remains on
`claude-sonnet-4-6`; this PR cannot satisfy the human baseline or evaluator acceptance gate.
Any later criteria/discuss/chat provider rollout follows its own readiness and observation gates.

## Rollback

If auth, readiness, queue progress or synthetic request behavior fails, restore the previous
backend deployment and its **matching configuration**: `RIMPL_URL=http://rimpl.railway.internal:3003`,
with `RIMPL_HTTP_PROXY` removed. Restore Tailscale variable presence/absence to the recorded baseline.
Verify the original Railway RIMPL is active and the backend's deep check/queue recover. Keep
`INTERNAL_TOKEN` consistent between whichever backend/RIMPL pair is active.

Changing `RIMPL_URL` alone is insufficient: a remaining proxy would try to resolve Railway's private
hostname through Tailscale. A source rollback that still includes `backend/Dockerfile` also does not
restore Nixpacks. Use the recorded previous deployment/build configuration when reverting builders.
Stop only the CLICS on-prem service after traffic has returned; do not alter the shared model stack.

## Evidence for the transport choices

- [Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking)
- [Tailscale 1.78.1 login timeout implementation](https://github.com/tailscale/tailscale/blob/v1.78.1/cmd/tailscale/cli/up.go)
- [Undici v7-to-v8 migration guide](https://github.com/nodejs/undici/blob/main/docs/docs/best-practices/migrating-from-v7-to-v8.md)

Hermetic tests establish behavior against local synthetic peers. They do not establish current
tailnet permissions, owner authorization, model identity/custody, or production connectivity.
