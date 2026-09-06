#!/bin/sh
# Start the OPTIONAL Tailscale client, then hand over to node.
#
# The single rule here: nothing in this script may prevent the backend from starting. The backend
# serving the pilot is worth far more than the backend reaching the tailnet, so every tailscale step
# is best-effort and every failure is logged and stepped over. `set -e` is deliberately NOT used.
#
# With TS_AUTHKEY unset — which is every deployment today, and any redeploy that has not opted in —
# this is a no-op and node starts exactly as it did under the previous buildpack.

log() { echo "[entrypoint] $*"; }

if [ -z "$TS_AUTHKEY" ]; then
  log "TS_AUTHKEY not set — starting without Tailscale (rimpl is reached over Railway's private network, which is correct today)."
  exec "$@"
fi

TS_HOSTNAME="${TS_HOSTNAME:-clics-backend}"
TS_PROXY_PORT="${TS_PROXY_PORT:-1055}"
mkdir -p /var/run/tailscale /var/lib/tailscale 2>/dev/null

# Userspace networking: a Railway container has no TUN device and no NET_ADMIN. The consequence is
# load-bearing and easy to miss — with no TUN there are no kernel routes to the tailnet, so an
# ordinary outbound connection does NOT reach it. Only traffic sent through one of these two
# listeners does.
#
# Set RIMPL_HTTP_PROXY=http://127.0.0.1:${TS_PROXY_PORT} when RIMPL_URL moves onto the tailnet.
# src/services/rimpl-client.js uses its own Undici fetch + ProxyAgent for all six RIMPL operations.
# The proxy is never registered globally, so Supabase and other services retain direct access.
log "starting tailscaled (userspace, http proxy on 127.0.0.1:${TS_PROXY_PORT}, socks5 on 127.0.0.1:${TS_SOCKS_PORT:-1080})"
/usr/local/bin/tailscaled \
  --tun=userspace-networking \
  --state=/var/lib/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock \
  --socks5-server="127.0.0.1:${TS_SOCKS_PORT:-1080}" \
  --outbound-http-proxy-listen="127.0.0.1:${TS_PROXY_PORT}" &
TS_PID=$!

# Give the daemon a moment to open its socket before asking it to log in.
i=0
while [ $i -lt 20 ]; do
  [ -S /var/run/tailscale/tailscaled.sock ] && break
  kill -0 "$TS_PID" 2>/dev/null || break
  i=$((i + 1)); sleep 0.5
done

# --accept-routes so an on-prem subnet router works later without another image change.
# An ephemeral, pre-authorised, tagged key is the right kind here: the node disappears from the
# tailnet when the container stops, instead of accumulating a dead machine per deploy. (It also
# draws a fresh address every deploy — see GATE0 §8.9 on why that rules out an address allowlist.)
if /usr/local/bin/tailscale --socket=/var/run/tailscale/tailscaled.sock up \
     --authkey="$TS_AUTHKEY" \
     --hostname="$TS_HOSTNAME" \
     --timeout="${TS_UP_TIMEOUT:-20s}" \
     --accept-routes \
     --accept-dns=false; then
  log "tailscale up as ${TS_HOSTNAME}"
  /usr/local/bin/tailscale --socket=/var/run/tailscale/tailscaled.sock status 2>&1 | head -5
else
  log "WARNING: tailscale up failed — continuing without it; anything behind the tailnet stays unreachable."
  kill "$TS_PID" 2>/dev/null
fi

exec "$@"
