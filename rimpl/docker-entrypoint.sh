#!/bin/sh
# Start the OPTIONAL Tailscale client, then hand over to node.
#
# The single rule here: nothing in this script may prevent rimpl from starting. rimpl serving Claude
# is worth far more than rimpl reaching the on-prem box, so every tailscale step is best-effort and
# every failure is logged and stepped over. `set -e` is deliberately NOT used.
#
# With TS_AUTHKEY unset — the on-prem deployment, and any redeploy that has not opted in — this is a
# no-op and node starts exactly as it did under the previous buildpack.

log() { echo "[entrypoint] $*"; }

if [ -z "$TS_AUTHKEY" ]; then
  log "TS_AUTHKEY not set — starting without Tailscale (the on-prem model will be unreachable, which is correct for a cloud deployment)."
  exec "$@"
fi

TS_HOSTNAME="${TS_HOSTNAME:-clics-rimpl}"
TS_PROXY_PORT="${TS_PROXY_PORT:-1055}"
mkdir -p /var/run/tailscale /var/lib/tailscale 2>/dev/null

# Userspace networking: a Railway container has no TUN device and no NET_ADMIN. The HTTP proxy is
# what rimpl actually uses — see LOCAL_AI_HTTP_PROXY in services/providers/local.js, which routes
# ONLY the local-model requests through it and leaves Anthropic and Supabase on the normal path.
log "starting tailscaled (userspace, http proxy on 127.0.0.1:${TS_PROXY_PORT})"
/usr/local/bin/tailscaled \
  --tun=userspace-networking \
  --state=/var/lib/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock \
  --outbound-http-proxy-listen="127.0.0.1:${TS_PROXY_PORT}" &
TS_PID=$!

# Give the daemon a moment to open its socket before asking it to log in.
i=0
while [ $i -lt 20 ]; do
  [ -S /var/run/tailscale/tailscaled.sock ] && break
  i=$((i + 1)); sleep 0.5
done

# --accept-routes so an on-prem subnet router works later without another image change.
# An ephemeral, pre-authorised, tagged key is the right kind here: the node disappears from the
# tailnet when the container stops, instead of accumulating a dead machine per deploy.
if /usr/local/bin/tailscale --socket=/var/run/tailscale/tailscaled.sock up \
     --authkey="$TS_AUTHKEY" \
     --hostname="$TS_HOSTNAME" \
     --accept-routes \
     --accept-dns=false; then
  log "tailscale up as ${TS_HOSTNAME}"
  /usr/local/bin/tailscale --socket=/var/run/tailscale/tailscaled.sock status 2>&1 | head -5
else
  log "WARNING: tailscale up failed — continuing without it; the local provider will report itself not ready."
  kill "$TS_PID" 2>/dev/null
fi

exec "$@"
