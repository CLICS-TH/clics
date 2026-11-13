#!/usr/bin/env node
// The local stand-in for vm1's nginx (deploy/vm1/nginx/clics.ccme.or.th.conf): one origin on :3080 for the
// Portal (/ -> :3000), the dashboard (/audit -> :3002, prefix kept, as its basePath expects) and the backend
// (/api -> :3001, prefix stripped). The dashboard reads the session the Portal's sign-in stored, so the staff
// handoff works only on a shared origin. Responses stream through as they arrive (the chat turn is SSE).
// Zero dependencies. `npm run dev` starts it with the four servers.
//   node scripts/dev/one-origin.mjs [--port 3080]
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

const PORTAL = 'http://127.0.0.1:3000';
const API = 'http://127.0.0.1:3001';
const DASHBOARD = 'http://127.0.0.1:3002';

// Where a request path goes, and the path it arrives with there.
export function route(url) {
  const [pathname] = url.split('?');
  if (pathname === '/api' || pathname.startsWith('/api/')) return { upstream: API, path: url.slice(4) || '/' };
  if (pathname === '/audit' || pathname.startsWith('/audit/')) return { upstream: DASHBOARD, path: url };
  return { upstream: PORTAL, path: url };
}

export function proxy(req, res) {
  const { upstream, path } = route(req.url);
  const target = new URL(path.startsWith('/') ? path : `/${path}`, upstream);
  const up = request(target, { method: req.method, headers: { ...req.headers, host: target.host, 'x-forwarded-host': req.headers.host } }, (r) => {
    res.writeHead(r.statusCode, r.statusMessage, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`one-origin: ${upstream} is not answering (${e.code || e.message})\n`);
  });
  req.pipe(up);
}

// WebSocket upgrades (the dashboard dev server's hot reload): the raw connection is spliced through.
export function tunnel(req, socket, head) {
  const { upstream, path } = route(req.url);
  const { hostname, port } = new URL(upstream);
  const up = connect(Number(port), hostname, () => {
    const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket).pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const port = Number(i >= 0 ? process.argv[i + 1] : 3080);
  createServer(proxy).on('upgrade', tunnel).listen(port, '127.0.0.1', () => {
    console.log(`one-origin: http://localhost:${port}  (/ -> ${PORTAL}, /audit -> ${DASHBOARD}, /api -> ${API})`);
  });
}
