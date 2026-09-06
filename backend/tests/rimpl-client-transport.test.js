// Real sockets and the real fetch/dispatcher: a mock fetch cannot prove that a userspace
// Tailscale proxy carries the request. The fake RIMPL hostname resolves only inside our proxy.
const http = require('node:http');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const worker = `
  const client = require('./src/services/rimpl-client');
  const methods = {
    chat: () => client.rimplChat({ message: 'synthetic', patient_ref: 'TEST-ONLY' }),
    discuss: () => client.rimplAuditDiscuss({ message: 'synthetic' }),
    evaluate: () => client.rimplEvaluate({ ple_id: 'synthetic', transcript: [] }),
    criteria: () => client.rimplEvaluateCriteria({ transcript: [] }),
    deep: () => client.probeRimplDeep(),
    provider: () => client.probeRimplProvider({ name: 'local', purpose: 'chat' }),
    unrelated: async () => (await fetch(process.env.UNRELATED_URL)).json(),
  };
  (async () => {
    const results = [];
    for (const method of process.env.METHODS.split(',')) {
      try { results.push({ method, result: await methods[method]() }); }
      catch (e) { results.push({ method, error: { name: e.name, message: e.message, cause: e.cause?.message, status: e.status, code: e.code, retryAfterMs: e.retryAfterMs } }); }
    }
    process.stdout.write(JSON.stringify(results), () => process.exit(0));
  })().catch(() => process.exit(1));
`;

let servers;
let sockets;
let received;
let tunnels;
let upstream;
let proxy;
let responseStatus;
let hangProxy;

async function listen(server) {
  servers.push(server);
  server.on('connection', track);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
function track(socket) {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => socket.destroy());
}

beforeEach(async () => {
  servers = []; sockets = new Set(); received = []; tunnels = [];
  responseStatus = 200; hangProxy = false;
  upstream = await listen(http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ path: req.url, method: req.method, token: req.headers['x-internal-token'], body: body ? JSON.parse(body) : null });
      res.writeHead(responseStatus, { 'content-type': 'application/json', 'retry-after': '7' });
      res.end(JSON.stringify(responseStatus === 200 ? { status: 'ok' } : { status: 'degraded', code: 'queue_full' }));
    });
  }));
  const proxyServer = http.createServer((req, res) => {
    // This test proxy implements CONNECT, like the tailscaled transport we use.
    res.writeHead(405); res.end();
  });
  proxyServer.on('connect', (req, downstream, head) => {
    tunnels.push(req.url);
    if (hangProxy) return;
    const target = net.connect(new URL(upstream).port, '127.0.0.1', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(downstream); downstream.pipe(target);
    });
    track(target);
    downstream.on('close', () => target.destroy());
    target.on('close', () => downstream.destroy());
  });
  proxy = await listen(proxyServer);
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

async function run(methods, env = {}) {
  const { stdout } = await exec(process.execPath, ['-e', worker], {
    cwd: require('node:path').resolve(__dirname, '..'),
    timeout: 8000,
    env: { ...process.env, RIMPL_URL: 'http://rimpl.invalid:3003', RIMPL_HTTP_PROXY: proxy,
      INTERNAL_TOKEN: 'synthetic-test-token', METHODS: methods, ...env },
  });
  return JSON.parse(stdout);
}

test('all six RIMPL operations reach the proxy-only destination with their auth and payload intact', async () => {
  const result = await run('chat,discuss,evaluate,criteria,deep,provider');
  expect(result.filter((r) => r.error)).toEqual([]);
  expect(received.map((r) => r.path)).toEqual([
    '/chat', '/audit-discuss', '/evaluate', '/evaluate-criteria', '/health/deep', '/health/provider/local?purpose=chat',
  ]);
  expect(received.map((r) => r.method)).toEqual(['POST', 'POST', 'POST', 'POST', 'GET', 'GET']);
  expect(received.every((r) => r.token === 'synthetic-test-token')).toBe(true);
  expect(received[0].body).toMatchObject({ message: 'synthetic', patient_ref: 'TEST-ONLY' });
  expect(result[0].result.provider).toBe('anthropic');
  expect(result[4].result).toEqual({ httpStatus: 200, body: { status: 'ok' } });
  expect(tunnels.length).toBeGreaterThan(0);
  expect(tunnels.every((host) => host === 'rimpl.invalid:3003')).toBe(true);
});

test('unset proxy preserves direct access to the existing private-network RIMPL', async () => {
  const [result] = await run('chat', { RIMPL_HTTP_PROXY: '', RIMPL_URL: upstream });
  expect(result.result).toEqual({ status: 'ok', provider: 'anthropic' });
  expect(received).toHaveLength(1);
  expect(tunnels).toHaveLength(0);
});

test('the RIMPL dispatcher does not route unrelated fetches through Tailscale', async () => {
  const result = await run('chat,unrelated', { UNRELATED_URL: `${upstream}/unrelated` });
  expect(result.filter((r) => r.error)).toEqual([]);
  expect(received.map((r) => r.path)).toEqual(['/chat', '/unrelated']);
  expect(received[1].token).toBeUndefined();
  expect(tunnels.every((host) => host === 'rimpl.invalid:3003')).toBe(true);
});

test('a failed proxy never retries directly even when the destination is locally reachable', async () => {
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await new Promise((resolve) => dead.close(resolve));
  const [result] = await run('chat', { RIMPL_HTTP_PROXY: deadUrl, RIMPL_URL: upstream });
  expect(result.error).toBeDefined();
  expect(received).toHaveLength(0);
});

test('invalid proxy configuration fails the RIMPL call without a direct request', async () => {
  const [result] = await run('chat', { RIMPL_HTTP_PROXY: 'not-a-url', RIMPL_URL: upstream });
  expect(result.error).toBeDefined();
  expect(received).toHaveLength(0);
});

test('readiness deadline still aborts a proxy that never opens its tunnel', async () => {
  hangProxy = true;
  const [result] = await run('deep', { HEALTH_RIMPL_TIMEOUT_MS: '250' });
  expect(result.error.name).toBe('TimeoutError');
  expect(tunnels.length).toBeGreaterThan(0);
  expect(received).toHaveLength(0);
});

test('proxied 503 retains readiness status and evaluation retry metadata', async () => {
  responseStatus = 503;
  const result = await run('deep,evaluate');
  expect(result[0].result).toEqual({ httpStatus: 503, body: { status: 'degraded', code: 'queue_full' } });
  expect(result[1].error).toMatchObject({ status: 503, code: 'queue_full', retryAfterMs: 7000 });
});
