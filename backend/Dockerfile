# The CLICS backend, with an OPTIONAL Tailscale userspace client.
#
# Why this exists: under decision D3 rimpl moves on-premise onto a tailnet node, and `RIMPL_URL`
# stops being `rimpl.railway.internal:3003`. The 2026-09-05 port sweep proved a Railway container
# can already open TCP to `cme-dev:3003` with no firewall change on the box — but those packets left
# the *rimpl* container, the only Railway service whose image carried a Tailscale client. This gives
# the backend the same one, which docs/LOCAL-MODEL-ROADMAP.md lists as a prerequisite of that phase.
# See docs/GATE0-DGX-RESULTS.md §8.9.
#
# It changes nothing about where PII is processed. It is transport only, and the hop it enables still
# has to be authenticated end-to-end by `INTERNAL_TOKEN` — network reachability is not authorisation.
#
# Tailscale here is strictly opt-in and strictly non-fatal: without TS_AUTHKEY the entrypoint starts
# node exactly as the previous buildpack did, and if any tailscale step fails it is logged and
# skipped rather than allowed to take the backend down. The backend serving the pilot is worth far
# more than the backend reaching the tailnet.
FROM node:22-slim

# Node follows the Node 22 release line (>=22.19.0 is required by Undici 8); its patch release
# is resolved at build time. Tailscale is fixed explicitly below. Record the built image digest
# and actual Node version at deployment; neither the Node major tag nor a source SHA pins an image.
# amd64 is Railway's builder architecture. Building this image on an arm64 host produces an unusable
# tailscale binary (the build still succeeds — nothing here executes it), so pass
# `--platform linux/amd64` when building on Apple Silicon.
ARG TAILSCALE_VERSION=1.78.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" -o /tmp/ts.tgz \
 && tar -xzf /tmp/ts.tgz -C /tmp \
 && mv "/tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscale" "/tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscaled" /usr/local/bin/ \
 && rm -rf /tmp/ts.tgz "/tmp/tailscale_${TAILSCALE_VERSION}_amd64" \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source-only change does not reinstall them. `npm ci` against the committed
# lockfile, `--omit=dev` because the only devDependencies are jest + supertest and `tests/` is not
# copied into the image — every bare require under src/ resolves to a listed `dependency`.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Railway sets RAILWAY_ENVIRONMENT but not necessarily NODE_ENV (see src/lib/crypto.js), and every
# fail-closed check but one is already OR'd against RAILWAY_ENVIRONMENT. Setting this makes the
# remaining one (lib/guest.js) fail closed too; it can only tighten, never loosen.
ENV NODE_ENV=production

# Documentation only — Railway injects PORT, and src/index.js reads it (falling back to 3001).
EXPOSE 3001

# `node` directly, not `npm start`: SIGTERM has to reach the process that installed the graceful
# drain handler, so a Railway redeploy finishes in-flight chat turns instead of killing them.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
