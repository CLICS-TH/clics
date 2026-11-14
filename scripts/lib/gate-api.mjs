// Which request URLs the browser gates (scripts/readability/audit.mjs, scripts/responsive/nav-width-audit.mjs)
// answer from fixtures instead of letting them reach a server. Package-free, so a node --test suite can check it
// (scripts/dev/gate-api.test.mjs).
//
// The dashboard calls `${NEXT_PUBLIC_API_URL}/...`, inlined at build time. Since #429 an unset value means `/api`
// on the dashboard's own origin, so a dashboard built the default way (`cd audit-dashboard && npm run build`,
// basePath /audit) and served on DASH_URL=http://127.0.0.1:3002/audit calls http://127.0.0.1:3002/api/...; a
// gate that answers only http://localhost:3001 lets those calls through to Next, which answers 404, and every
// page renders its error or empty state. The Portal pages the gates serve on a bare localhost port still call
// http://localhost:3001 (physician-ui/public/js/config.js). A build made with NEXT_PUBLIC_API_URL set needs the
// same value in the gate's environment.
export function gateApiBases({ dashUrl = '', apiUrl = '' } = {}) {
  const bases = new Set(['http://localhost:3001/', 'http://127.0.0.1:3001/']);
  if (dashUrl) bases.add(new URL('/api/', dashUrl).href);
  if (apiUrl) bases.add(new URL(`${apiUrl.replace(/\/+$/, '')}/`, dashUrl || 'http://localhost:3001').href);
  return [...bases];
}

export function isGateApiCall(url, bases) {
  return bases.some((b) => url.startsWith(b));
}
