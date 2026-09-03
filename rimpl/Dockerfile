# rimpl, with an OPTIONAL Tailscale userspace client.
#
# Why this exists: the on-prem model sits on a Tailscale network (`cme-dev`, 100.68.210.69) that a
# Railway container cannot route to. The architecture's answer is to move rimpl on-prem entirely
# (decision D3) — this image is the documented FALLBACK for testing until a host exists, and it does
# not change where PII is processed. Do not read it as the on-prem migration.
#
# Tailscale here is strictly opt-in and strictly non-fatal: without TS_AUTHKEY the entrypoint starts
# node exactly as the previous buildpack did, and if any tailscale step fails it is logged and
# skipped rather than allowed to take rimpl down. rimpl serving Claude is worth more than rimpl
# reaching the tailnet.
FROM node:22-slim

# Pinned deliberately: an unpinned "latest" would change what is inside a container that, in the
# on-prem design, is meant to be attestable.
ARG TAILSCALE_VERSION=1.78.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" -o /tmp/ts.tgz \
 && tar -xzf /tmp/ts.tgz -C /tmp \
 && mv "/tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscale" "/tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscaled" /usr/local/bin/ \
 && rm -rf /tmp/ts.tgz "/tmp/tailscale_${TAILSCALE_VERSION}_amd64" \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3003

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
