// Real provider/fetch/proxy on loopback: mocked fetch hid Node 22's incompatible dispatcher protocol
// with Undici 8. The synthetic model hostname is reachable only through our CONNECT proxy.
const http = require('node:http');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const worker = `
  const local = require('./src/services/providers/local');
  const args = { systemPrompt: 'synthetic instructions', messages: [{ role: 'user', content: 'synthetic question' }], purpose: 'chat' };
  const methods = {
    ready: () => local.ready(), chat: () => local.call(args), embed: () => local.embed('synthetic question'),
    unrelated: async () => (await fetch(process.env.UNRELATED_URL)).json(),
    abort: async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      return local.call({ ...args, signal: controller.signal });
    },
  };
  (async () => {
    const results = [];
    for (const method of process.env.METHODS.split(',')) {
      try { results.push({ method, result: await methods[method]() }); }
      catch (e) { results.push({ method, error: { name: e.name, message: e.message, cause: e.cause?.message, status: e.status, retryAfter: e.headers?.get('retry-after'), aborted: e.aborted, localTimeout: e.localTimeout } }); }
    }
    process.stdout.write(JSON.stringify(results), () => process.exit(0));
  })().catch(() => process.exit(1));
`;

let servers, sockets, received, tunnels, upstream, proxy, responseStatus, hangProxy;
function track(socket) {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => socket.destroy());
}
async function listen(server) {
  servers.push(server);
  server.on('connection', track);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
beforeEach(async () => {
  servers = []; sockets = new Set(); received = []; tunnels = []; responseStatus = 200; hangProxy = false;
  upstream = await listen(http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const replies = {
        '/v1/models': { data: [{ id: 'synthetic-chat' }] },
        '/api/show': { model_info: { 'test.context_length': 32768 } },
        '/v1/chat/completions': { choices: [{ message: { content: 'synthetic answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 }, model: 'synthetic-chat' },
        '/v1/embeddings': { data: [{ embedding: [0.1, 0.2, 0.3] }] },
        '/unrelated': { ok: true },
      };
      res.writeHead(responseStatus, { 'content-type': 'application/json', 'retry-after': '7' });
      res.end(JSON.stringify(responseStatus === 200 ? replies[req.url] : { error: 'synthetic busy' }));
    });
  }));
  const proxyServer = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
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
    cwd: require('node:path').resolve(__dirname, '..'), timeout: 8000,
    env: { ...process.env, PROVIDER_SETTINGS_SOURCE: 'database',
      LOCAL_AI_BASE_URL: 'http://model.invalid:3000/v1', LOCAL_AI_HTTP_PROXY: proxy,
      LOCAL_AI_MODEL: 'synthetic-chat', LOCAL_AI_EMBED_MODEL: 'synthetic-embed', LOCAL_AI_API_KEY: 'synthetic-key',
      LOCAL_AI_MIN_CONTEXT: '16384', LOCAL_AI_MAX_PROMPT_TOKENS: '0', LOCAL_MAX_RETRIES: '0',
      LOCAL_AI_TIMEOUT_MS: '1000', HEALTH_PROBE_TIMEOUT_MS: '300', METHODS: methods, ...env },
  });
  return JSON.parse(stdout);
}

test('readiness, context lookup, chat and embeddings cross the real proxy with auth and payload intact', async () => {
  const result = await run('ready,chat,embed');
  expect(result.filter((r) => r.error)).toEqual([]);
  expect(result[0].result.checks.local_ai).toMatchObject({ status: 'up', model: 'synthetic-chat', context_length: 32768 });
  expect(result[1].result).toMatchObject({ text: 'synthetic answer', inputTokens: 4, outputTokens: 2, stopReason: 'end_turn' });
  expect(result[2].result).toEqual([0.1, 0.2, 0.3]);
  expect(received.map((r) => r.path)).toEqual(['/v1/models', '/api/show', '/v1/chat/completions', '/v1/embeddings']);
  expect(received.map((r) => r.method)).toEqual(['GET', 'POST', 'POST', 'POST']);
  expect(received.every((r) => r.authorization === 'Bearer synthetic-key')).toBe(true);
  expect(received[2].body.messages).toEqual([
    { role: 'system', content: 'synthetic instructions' }, { role: 'user', content: 'synthetic question' },
  ]);
  expect(received[3].body).toEqual({ model: 'synthetic-embed', input: 'synthetic question' });
  expect(tunnels.length).toBeGreaterThan(0);
  expect(tunnels.every((host) => host === 'model.invalid:3000')).toBe(true);
});
test('unset proxy retains direct local provider access', async () => {
  const result = await run('ready,chat,embed', { LOCAL_AI_HTTP_PROXY: '', LOCAL_AI_BASE_URL: `${upstream}/v1` });
  expect(result.filter((r) => r.error)).toEqual([]);
  expect(result[0].result.checks.local_ai.status).toBe('up');
  expect(result[1].result.text).toBe('synthetic answer');
  expect(received).toHaveLength(4);
  expect(tunnels).toHaveLength(0);
});
test('local provider proxy leaves unrelated global fetch calls direct', async () => {
  const result = await run('chat,unrelated', { UNRELATED_URL: `${upstream}/unrelated` });
  expect(result.filter((r) => r.error)).toEqual([]);
  expect(received.map((r) => r.path)).toEqual(['/v1/chat/completions', '/unrelated']);
  expect(received[1].authorization).toBeUndefined();
  expect(tunnels.every((host) => host === 'model.invalid:3000')).toBe(true);
});
test('an unreachable proxy never falls back to a directly reachable model', async () => {
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await new Promise((resolve) => dead.close(resolve));
  const [result] = await run('chat', { LOCAL_AI_HTTP_PROXY: deadUrl, LOCAL_AI_BASE_URL: `${upstream}/v1` });
  expect(result.error).toBeDefined();
  expect(received).toHaveLength(0);
});
test('the local deadline still aborts a proxy that never opens its tunnel', async () => {
  hangProxy = true;
  const [result] = await run('chat');
  expect(result.error).toMatchObject({ name: 'TimeoutError', localTimeout: true });
  expect(tunnels.length).toBeGreaterThan(0);
  expect(received).toHaveLength(0);
});
test('caller cancellation still aborts a proxied request', async () => {
  hangProxy = true;
  const [result] = await run('abort');
  expect(result.error.aborted).toBe(true);
  // Cancellation may win before the CONNECT request reaches the proxy. Requiring a tunnel here
  // turns event-loop scheduling into part of the contract; the transport tests above prove routing.
  expect(received).toHaveLength(0);
});
test('proxied model errors retain their status and retry header', async () => {
  responseStatus = 503;
  const result = await run('ready,chat');
  expect(result[0].result.checks.local_ai).toMatchObject({ status: 'down', error: expect.stringMatching(/503/) });
  expect(result[1].error).toMatchObject({ status: 503, retryAfter: '7' });
});
