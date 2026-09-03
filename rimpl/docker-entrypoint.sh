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
  --socks5-server="127.0.0.1:${TS_SOCKS_PORT:-1080}" \
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


# One-shot reachability probe, logged shortly after boot.
#
# "fetch failed" from the app says nothing about WHICH hop broke. curl through the same proxies
# separates the candidates: a tailnet or ACL problem fails every row, a proxy-protocol problem fails
# one and not the other, and a wrong URL returns an HTTP status rather than a connect failure.
#
# It runs in the BACKGROUND on purpose. An earlier version ran it inline and three 15-second curls
# delayed `exec node` past the point where the platform expects the port to be listening, so the
# deploy was marked failed by a diagnostic. Nothing here may sit between boot and the listening port.
if [ -n "$LOCAL_AI_BASE_URL" ]; then
  (
    probe() {
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" \
        ${LOCAL_AI_API_KEY:+-H "Authorization: Bearer ${LOCAL_AI_API_KEY}"} \
        "${LOCAL_AI_BASE_URL}/models" 2>/dev/null)
      echo "${code:-connect-failed}"
    }
    log "probe direct     -> $(probe)"
    log "probe http-proxy -> $(probe --proxy http://127.0.0.1:${TS_PROXY_PORT})"
    log "probe socks5     -> $(probe --socks5-hostname 127.0.0.1:${TS_SOCKS_PORT:-1080})"
  ) &
fi

exec "$@"
