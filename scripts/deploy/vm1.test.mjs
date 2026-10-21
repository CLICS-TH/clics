// Guards for the vm1 deployment (Topology B, docs/adr/0002-vm1-topology-b.md). Package-free, like the
// other script suites: `node --test scripts/deploy/*.test.mjs`.
//
// vm1 is a SHARED production host, so the properties checked here are requirements from ADR 0002, not
// style: the backend is published on loopback only, rimpl is not published at all, no IP literal or
// tailnet domain is committed under deploy/vm1/, nginx does not switch HTTP/2 on for the host's other
// sites, and nothing appears at backend/Dockerfile (Railway would switch the live backend's builder).
// deploy.sh and health-gate.cjs are exercised against fakes: no docker, no network beyond loopback, no
// remote host. Where docker IS available (CI), the compose file is also checked as docker renders it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import {
  readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeDummyEnv, exampleNames } from './vm1-ci-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VM1 = path.join(ROOT, 'deploy', 'vm1');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');
const COMPOSE = read('deploy', 'vm1', 'docker-compose.yml');
const scratch = (tag) => mkdtempSync(path.join(tmpdir(), `clics-vm1-${tag}-`));

// ---- a minimal reader for the compose file's own layout (2-space indents, services at depth 1) -------
// Comment and blank lines are dropped first. docker's own rendering is checked separately when docker is
// installed; this reader is what runs everywhere, including a Mac without docker.
const meaningful = (text) => text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
function topBlock(name) {
  const lines = meaningful(COMPOSE);
  const i = lines.findIndex((l) => l === `${name}:` || l.startsWith(`${name}: &`)); // `key:` or `key: &anchor`
  assert.ok(i >= 0, `compose has a top-level ${name}:`);
  const out = [];
  for (const l of lines.slice(i + 1)) { if (!l.startsWith(' ')) break; out.push(l); }
  return out;
}
function serviceBlock(name) {
  const lines = topBlock('services');
  const i = lines.indexOf(`  ${name}:`);
  assert.ok(i >= 0, `compose defines service ${name}`);
  const out = [];
  for (const l of lines.slice(i + 1)) { if (!l.startsWith('    ')) break; out.push(l); }
  return out;
}
function listUnder(block, key) { // items of `    key:` as a block list
  const i = block.indexOf(`    ${key}:`);
  if (i < 0) return null;
  const out = [];
  for (const l of block.slice(i + 1)) { if (!l.startsWith('      ')) break; out.push(l.trim()); }
  return out.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).replace(/^["']|["']$/g, ''));
}

// ---- 1. the boot check's required names are all accounted for ---------------------------------------
test('every name in the backend boot check is in backend.env.example, or set by compose', () => {
  const src = read('backend', 'src', 'index.js');
  const m = /const required = \[([^\]]+)\]/.exec(src);
  assert.ok(m, 'backend/src/index.js still declares `const required = [...]`');
  const required = [...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]);
  assert.ok(required.length >= 9, `parsed ${required.length} required names`);

  const example = read('deploy', 'vm1', 'backend.env.example');
  const assigned = new Set(exampleNames('backend.env'));
  const backendBlock = serviceBlock('backend');
  const envStart = backendBlock.indexOf('    environment:');
  assert.ok(envStart >= 0, 'the backend service has an environment: map');
  const composeSet = new Set();
  for (const l of backendBlock.slice(envStart + 1)) {
    if (!l.startsWith('      ')) break;
    const key = /^ {6}([A-Z0-9_]+):/.exec(l)?.[1];
    if (key) composeSet.add(key);
  }

  for (const name of required) {
    if (assigned.has(name)) continue;
    // Not assigned in the file: it must be documented there as compose-provided, and compose must set it.
    assert.match(example, new RegExp(`\\[compose\\][^\\n]*\\b${name}\\b|^#\\s+${name}\\b`, 'm'),
      `${name} is neither a NAME= line in backend.env.example nor documented there as [compose]`);
    assert.ok(composeSet.has(name), `${name} is documented as compose-provided but docker-compose.yml does not set it`);
  }
});

// The one value an example ships: RECONCILE_INTERVAL_MS=0. Blank would mean the 6-hourly default
// (`'' || 6h` in backend/src/index.js), i.e. the sweep ON beside Railway's.
const SHIPPED_VALUES = { 'backend.env.example': ['RECONCILE_INTERVAL_MS=0'] };
test('the env examples hold names only: no line assigns a value except RECONCILE_INTERVAL_MS=0', () => {
  for (const file of ['backend.env.example', 'rimpl.env.example']) {
    const allowed = SHIPPED_VALUES[file] || [];
    for (const line of read('deploy', 'vm1', file).split('\n')) {
      if (!line.trim() || line.startsWith('#') || allowed.includes(line)) continue;
      assert.match(line, /^[A-Z][A-Z0-9_]*=$/, `${file}: "${line}" is not a bare NAME=`);
    }
    for (const want of allowed) assert.ok(read('deploy', 'vm1', file).split('\n').includes(want), `${file} ships ${want}`);
  }
  assert.match(read('backend', 'src', 'index.js'), /parseInt\(process\.env\.RECONCILE_INTERVAL_MS \|\| /,
    'the backend still reads a blank RECONCILE_INTERVAL_MS as the default; if that changed, revisit the preflight check');
});

test('Railway-only names are never assigned in the vm1 examples', () => {
  for (const file of ['backend.env', 'rimpl.env']) {
    for (const name of exampleNames(file)) {
      assert.ok(!/^RAILWAY_/.test(name), `${file}.example assigns ${name}`);
      assert.ok(!['TS_AUTHKEY', 'LOCAL_AI_HTTP_PROXY', 'PORT', 'NODE_ENV', 'RIMPL_URL'].includes(name),
        `${file}.example assigns ${name}, which is Railway-only or set by compose`);
    }
  }
});

// ---- 2. what the host can see: loopback backend, unpublished rimpl ----------------------------------
test('compose publishes the backend on 127.0.0.1 only, and nothing for rimpl', () => {
  const backendPorts = listUnder(serviceBlock('backend'), 'ports');
  assert.deepEqual(backendPorts, ['127.0.0.1:3101:3001']);
  const rimpl = serviceBlock('rimpl');
  assert.equal(listUnder(rimpl, 'ports'), null, 'rimpl must not publish a port');
  assert.ok(!rimpl.some((l) => /^\s{4}(ports|expose):/.test(l)), 'rimpl has no ports/expose key');
  // The only ports: key in the whole file is the backend's (an anchor or another service cannot add one).
  assert.equal(meaningful(COMPOSE).filter((l) => /^\s*ports:/.test(l)).length, 1);
  for (const forbidden of [/network_mode:/, /privileged:\s*true/, /\bpid:\s*host/, /docker\.sock/, /cap_add:/]) {
    assert.ok(!meaningful(COMPOSE).some((l) => forbidden.test(l)), `compose must not contain ${forbidden}`);
  }
});

test('compose carries the ADR 0002 hardening on both services', () => {
  const anchor = topBlock('x-hardened');
  for (const want of ['  read_only: true', '  init: true', '  restart: unless-stopped', '    - no-new-privileges:true',
    '    - ALL', '  mem_limit: 1g', '    driver: json-file', '      max-size: "10m"']) {
    assert.ok(anchor.includes(want), `x-hardened lacks: ${want.trim()}`);
  }
  assert.ok(anchor.some((l) => /^ {2}user: "\$\{CLICS_UID:\?/.test(l)), 'containers run as the host clics uid');
  for (const svc of ['backend', 'rimpl']) {
    assert.ok(serviceBlock(svc).includes('    <<: *hardened'), `${svc} merges x-hardened`);
    assert.ok(!serviceBlock(svc).some((l) => /^\s{4}(user|read_only|security_opt|cap_drop|mem_limit):/.test(l)),
      `${svc} must not override a hardening key`);
  }
  assert.ok(serviceBlock('backend').includes('      RIMPL_URL: http://rimpl:3003'));
});

test('the backend image is built from deploy/vm1, rimpl from rimpl/Dockerfile unchanged', () => {
  const b = serviceBlock('backend');
  assert.ok(b.includes('      context: ../../backend'));
  assert.ok(b.includes('      dockerfile: ../deploy/vm1/backend.Dockerfile'));
  const r = serviceBlock('rimpl');
  assert.ok(r.includes('      context: ../../rimpl'));
  assert.ok(r.includes('      dockerfile: Dockerfile'));
  const df = read('deploy', 'vm1', 'backend.Dockerfile');
  assert.match(df, /^FROM node:22-slim$/m);
  assert.match(df, /^RUN npm ci --omit=dev/m);
  assert.match(df, /^USER node$/m);
  // The same start command as backend/package.json.
  const start = JSON.parse(read('backend', 'package.json')).scripts.start;
  assert.equal(start, 'node src/index.js');
  assert.match(df, /^CMD \["node", "src\/index\.js"\]$/m);
});

// ---- 3. the Railway auto-detect hazard ----------------------------------------------------------------
test('no backend/Dockerfile exists (Railway would switch the live backend off Railpack)', () => {
  const hits = readdirSync(path.join(ROOT, 'backend')).filter((n) => n.toLowerCase() === 'dockerfile');
  assert.deepEqual(hits, [], 'move it to deploy/vm1/ (ADR 0001, ADR 0002)');
});

// ---- 4. no IP literals or tailnet domains under deploy/vm1/ (ADR 0002 R9) ------------------------------
function filesUnder(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}
test('no IPv4 literal other than 127.0.0.1 / 0.0.0.0, and no tailnet domain, under deploy/vm1/', () => {
  const allowed = new Set(['127.0.0.1', '0.0.0.0']);
  for (const f of filesUnder(VM1)) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g)) {
      assert.ok(allowed.has(m[0]), `${path.relative(ROOT, f)} contains the IPv4 literal ${m[0]}`);
    }
    assert.ok(!/\.ts\.net\b/i.test(text), `${path.relative(ROOT, f)} names a tailnet domain`);
  }
});

// ---- 5. the three places that name the backend's loopback port agree --------------------------------
test('nginx, compose and deploy.sh agree on the loopback port; backend trusts exactly one proxy hop', () => {
  const nginx = read('deploy', 'vm1', 'nginx', 'clics.ccme.or.th.conf');
  const upstream = /^\s*server 127\.0\.0\.1:(\d+);/m.exec(nginx);
  assert.ok(upstream, 'nginx upstream is a loopback address');
  assert.equal(upstream[1], '3101');
  assert.match(read('deploy', 'vm1', 'deploy.sh'), /^HOST_PORT=3101$/m);
  assert.ok(!/proxy_pass\s+http:\/\/(?!clics_backend\b)/.test(nginx), 'nginx proxies only to the backend upstream');
  assert.match(nginx, /proxy_read_timeout\s+(\d+)s;/);
  assert.ok(Number(/proxy_read_timeout\s+(\d+)s;/.exec(nginx)[1]) >= 180);
  assert.match(nginx, /client_max_body_size 1m;/);
  // nginx 1.18 merges `http2` across every server on an address:port, so it must not appear on a listen
  // line here: it would switch HTTP/2 on for the other teams' sites on 443.
  const listens = meaningful(nginx).filter((l) => /^\s*listen\s/.test(l)).map((l) => l.trim());
  assert.deepEqual(listens, ['listen 80;', 'listen 443 ssl;']);
  assert.ok(!meaningful(nginx).some((l) => /\bhttp2\b/.test(l)), 'no http2 directive or listen flag');
  assert.match(read('backend', 'src', 'index.js'), /express\.json\(\{ limit: '1mb' \}\)/);
  // nginx appends one X-Forwarded-For hop; trust proxy must stay 1 (true would let a client spoof req.ip).
  assert.match(read('backend', 'src', 'index.js'), /app\.set\('trust proxy', 1\)/);
});

// ---- 6. docker's own rendering, where docker exists (CI) ----------------------------------------------
const hasDocker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
test('docker compose config renders the same guarantees', { skip: !hasDocker && 'docker not installed here; CI runs it' }, () => {
  const envDir = writeDummyEnv(path.join(scratch('cfg'), 'env'));
  const r = spawnSync('docker', ['compose', '-f', path.join(VM1, 'docker-compose.yml'), 'config', '--format', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, CLICS_RELEASE: 'test', CLICS_ENV_DIR: envDir, CLICS_UID: '10001', CLICS_GID: '10001' },
  });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(r.stdout);
  const { backend, rimpl } = cfg.services;
  assert.equal(rimpl.ports, undefined, 'rimpl publishes nothing');
  assert.equal(backend.ports.length, 1);
  assert.equal(backend.ports[0].host_ip, '127.0.0.1');
  assert.equal(String(backend.ports[0].published), '3101');
  assert.equal(backend.ports[0].target, 3001);
  for (const s of [backend, rimpl]) {
    assert.equal(s.read_only, true);
    assert.equal(s.user, '10001:10001');
    assert.ok(s.security_opt.includes('no-new-privileges:true'));
    assert.deepEqual(s.cap_drop, ['ALL']);
    assert.equal(s.logging.driver, 'json-file');
    assert.ok(s.mem_limit, 'memory limit set');
  }
  assert.equal(backend.environment.RIMPL_URL, 'http://rimpl:3003');
});

// ---- 7. health-gate.cjs against fake rimpl / backend servers -------------------------------------------
function fakeServer(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const h = routes[req.url];
      if (!h) { res.writeHead(404); return res.end(); }
      const [status, body] = h(req);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function gate(mode, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(VM1, 'health-gate.cjs'), mode], {
      env: { PATH: process.env.PATH, GATE_TIMEOUT_MS: '3000', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}
const rimplDeep = (status = 200) => () => [status, { service: 'rimpl', status: status === 200 ? 'ok' : 'degraded',
  manifest: { sha256: 'a'.repeat(64) }, checks: { supabase: { status: status === 200 ? 'up' : 'down' } } }];
const manifestFor = (token) => (req) => (req.headers['x-internal-token'] === token ? [200, { ok: true }] : [401, { error: 'Unauthorized' }]);

test('gate rimpl: passes on a healthy rimpl with the right token, and says which check failed otherwise', async () => {
  const token = 'gate-test-token';
  const ok = await fakeServer({ '/health/deep': rimplDeep(200), '/manifest': manifestFor(token) });
  const sick = await fakeServer({ '/health/deep': rimplDeep(503), '/manifest': manifestFor(token) });
  try {
    const url = (s) => `http://127.0.0.1:${s.address().port}`;
    let r = await gate('rimpl', { RIMPL_URL: url(ok), INTERNAL_TOKEN: token });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /INTERNAL_TOKEN matches/);
    r = await gate('rimpl', { RIMPL_URL: url(ok), INTERNAL_TOKEN: 'a-different-token' });
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /does not match the one rimpl runs with \(rimpl answered 401\)/);
    assert.ok(!/NOT started/.test(r.out), 'the gate reports; the shell step says what happens next');
    assert.ok(!r.out.includes('a-different-token'), 'the gate never prints a token');
    r = await gate('rimpl', { RIMPL_URL: url(sick), INTERNAL_TOKEN: token });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /supabase=down/);
    r = await gate('rimpl', { RIMPL_URL: 'http://127.0.0.1:9', INTERNAL_TOKEN: token });
    assert.equal(r.code, 6, r.out);
    r = await gate('rimpl', { INTERNAL_TOKEN: token });
    assert.equal(r.code, 64, r.out);
  } finally { ok.close(); sick.close(); }
});

// Exit 2 must mean "token accepted": activate's restore() starts the live backend on it. So the token is
// asked on every run, and a degraded rimpl that refuses it is a 3, never a 2.
test('gate rimpl: always checks the token, so exit 2 means "token accepted, rimpl degraded" and nothing else', async () => {
  const token = 'gate-test-token';
  const degraded = () => [503, { service: 'rimpl', status: 'degraded', checks: {
    supabase: { status: 'down', error: 'connect to https://secret-host.invalid refused' },
    anthropic_serving: { status: 'down', error: 'payment required (402)' },
    anthropic: { status: 'up' }, manifest: { status: 'warn', warning: 'drift' },
  } }];
  const servers = {
    degraded: await fakeServer({ '/health/deep': degraded, '/manifest': manifestFor(token) }),
    degraded403: await fakeServer({ '/health/deep': degraded, '/manifest': () => [403, { error: 'Forbidden' }] }),
    degraded500: await fakeServer({ '/health/deep': degraded, '/manifest': () => [500, { error: 'boom' }] }),
    healthy403: await fakeServer({ '/health/deep': rimplDeep(200), '/manifest': () => [403, { error: 'Forbidden' }] }),
    notRimpl: await fakeServer({ '/health/deep': () => [200, { service: 'backend', status: 'ok' }], '/manifest': manifestFor(token) }),
  };
  const url = (s) => `http://127.0.0.1:${s.address().port}`;
  try {
    let r = await gate('rimpl', { RIMPL_URL: url(servers.degraded), INTERNAL_TOKEN: token });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /INTERNAL_TOKEN matches/);
    // The line activate.sh parses: the down checks, by name and status only, after "; down: ".
    assert.match(r.out, /rimpl is DEGRADED: \/health\/deep HTTP 503, .*; down: supabase=down, anthropic_serving=down$/m);
    assert.ok(!/secret-host|payment required/.test(r.out), `names and statuses only, never error text:\n${r.out}`);

    r = await gate('rimpl', { RIMPL_URL: url(servers.degraded), INTERNAL_TOKEN: 'a-different-token' });
    assert.equal(r.code, 3, `degraded AND refused is a token mismatch: ${r.out}`);
    assert.ok(!r.out.includes('a-different-token'));
    for (const [name, want] of [['degraded403', 3], ['healthy403', 3], ['degraded500', 4], ['notRimpl', 7]]) {
      r = await gate('rimpl', { RIMPL_URL: url(servers[name]), INTERNAL_TOKEN: token });
      assert.equal(r.code, want, `${name}: ${r.out}`);
    }
  } finally { for (const s of Object.values(servers)) s.close(); }
});

test('gate backend: requires service "backend", rimpl up and Supabase up; other degradations only warn', async () => {
  const body = (over = {}) => ({ service: 'backend', status: 'ok',
    checks: { supabase: { status: 'up' }, rimpl: { status: 'up', deep: { manifest: { sha256: 'b'.repeat(64) } } }, ...over.checks },
    ...over.top });
  const cases = [
    [200, body(), 0],
    [503, body({ top: { status: 'degraded' }, checks: { eval_queue: { status: 'down' } } }), 0], // warn only
    [200, body({ top: { service: 'rimpl' } }), 5], // the 2026-10-14 outage shape
    [503, body({ checks: { rimpl: { status: 'down' } } }), 5],
    [503, body({ checks: { supabase: { status: 'down' } } }), 5],
  ];
  for (const [status, b, want] of cases) {
    const s = await fakeServer({ '/health/deep': () => [status, b] });
    try {
      const r = await gate('backend', { BACKEND_URL: `http://127.0.0.1:${s.address().port}` });
      assert.equal(r.code, want, `${JSON.stringify(b)} -> ${r.out}`);
      if (status === 503 && want === 0) assert.match(r.out, /WARNING/);
    } finally { s.close(); }
  }
});

// ---- 8. deploy.sh against a fake Tailscale CLI, in a throwaway repo ------------------------------------
// The fake records each invocation's argv and stdin and never contacts anything. The throwaway repo holds
// deploy/vm1 as committed here plus stub backend/ and rimpl/ trees, so a real `git archive` runs.
function fakeRepo({ trackedEnv = false } = {}) {
  const dir = scratch('repo');
  const repo = path.join(dir, 'repo');
  mkdirSync(path.join(repo, 'deploy', 'vm1', 'nginx'), { recursive: true });
  for (const f of filesUnder(VM1)) {
    const rel = path.relative(VM1, f);
    mkdirSync(path.dirname(path.join(repo, 'deploy', 'vm1', rel)), { recursive: true });
    copyFileSync(f, path.join(repo, 'deploy', 'vm1', rel));
  }
  chmodSync(path.join(repo, 'deploy', 'vm1', 'deploy.sh'), 0o755);
  mkdirSync(path.join(repo, 'backend', 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'backend', 'package.json'), '{"scripts":{"start":"node src/index.js"}}\n');
  writeFileSync(path.join(repo, 'backend', 'src', 'index.js'), '// stub\n');
  writeFileSync(path.join(repo, 'backend', '.env.example'), 'NAME=\n');
  mkdirSync(path.join(repo, 'rimpl', 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'rimpl', 'Dockerfile'), 'FROM node:22-slim\n');
  writeFileSync(path.join(repo, 'rimpl', 'src', 'index.js'), '// stub\n');
  if (trackedEnv) writeFileSync(path.join(repo, 'rimpl', '.env'), 'SECRET=x\n');
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q');
  git('add', '-A', '-f');
  git('-c', 'user.name=vm1-test', '-c', 'user.email=vm1-test@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'fixture');
  // An UNTRACKED env file in the working tree, where a careless human might leave one: must not ship.
  writeFileSync(path.join(repo, 'deploy', 'vm1', 'backend.env'), 'SUPABASE_SERVICE_ROLE_KEY=do-not-ship\n');
  const fakeTs = path.join(dir, 'fake-tailscale');
  writeFileSync(fakeTs, [
    '#!/usr/bin/env bash',
    'n=$(ls "$FAKE_TS_LOG" | grep -c "\\.args$" || true)',
    'printf "%s\\n" "$@" > "$FAKE_TS_LOG/call-$n.args"',
    'cat > "$FAKE_TS_LOG/call-$n.stdin"',
    '[ "${FAKE_TS_FAIL_AT:-}" = "$n" ] && { echo "fake remote failure" >&2; exit "${FAKE_TS_EXIT:-7}"; }',
    'exit 0',
  ].join('\n') + '\n');
  chmodSync(fakeTs, 0o755);
  const log = path.join(dir, 'log');
  mkdirSync(log);
  return { dir, repo, sha: git('rev-parse', 'HEAD'), fakeTs, log };
}
function runDeploy(fx, args, env = {}) {
  rmSync(fx.log, { recursive: true, force: true }); mkdirSync(fx.log);
  const r = spawnSync('bash', [path.join(fx.repo, 'deploy', 'vm1', 'deploy.sh'), ...args], {
    encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: fx.dir, TMPDIR: fx.dir, TAILSCALE_BIN: fx.fakeTs, FAKE_TS_LOG: fx.log, VM1_HOST: 'vm1-test', ...env },
  });
  const calls = readdirSync(fx.log).filter((n) => n.endsWith('.args'))
    .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0])).map((n) => {
      const base = path.join(fx.log, n.replace(/\.args$/, ''));
      return { args: readFileSync(`${base}.args`, 'utf8').trim().split('\n'), stdin: readFileSync(`${base}.stdin`) };
    });
  return { ...r, calls };
}
const tarList = (buf, dir) => {
  const f = path.join(dir, 'upload.tgz');
  writeFileSync(f, buf);
  const r = spawnSync('tar', ['-tzf', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
};
const cleanFx = (fx) => rmSync(fx.dir, { recursive: true, force: true });
// The run id deploy.sh mints: UTC timestamp, the sha's first 12, the mode.
const runId = (sha, mode) => new RegExp(`^\\d{8}T\\d{6}Z-${sha.slice(0, 12)}-${mode}$`);
const bracedScript = (buf) => {
  const script = buf.toString();
  assert.match(script, /^\{\n/, 'the remote script is one brace group');
  assert.match(script, /\n\} <\/dev\/null\n$/, 'run with stdin closed, so nothing inside can eat the script');
  assert.ok(!/do-not-ship/.test(script));
  return script;
};
const remoteSrc = (name) => read('deploy', 'vm1', 'remote', `${name}.sh`);

test('deploy.sh --dry-run prints every remote step, including the detached activation, and sends nothing', () => {
  const fx = fakeRepo();
  try {
    const r = runDeploy(fx, ['--dry-run', 'HEAD']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.calls.length, 0, 'the Tailscale CLI was never invoked');
    for (const step of ['preflight', 'upload', 'stage', 'launch', 'detached activation']) {
      assert.match(r.stdout, new RegExp(`\\[dry-run\\] ${step}`));
    }
    const run = new RegExp(`bash -s -- /opt/clics clics 3101 ${fx.sha} deploy (\\d{8}T\\d{6}Z-${fx.sha.slice(0, 12)}-deploy)`).exec(r.stdout);
    assert.ok(run, r.stdout);
    // The staged activate script, and the resolved command that starts it detached.
    assert.match(r.stdout, /docker compose -p "\$PROJECT" -f docker-compose\.yml/);
    assert.match(r.stdout, /gate_rimpl \|\| g=\$\?/);
    assert.match(r.stdout, new RegExp(`systemd-run --unit=clics-activate-${run[1]} --collect --quiet .* /bin/bash /opt/clics/runs/${run[1]}/activate\\.sh /opt/clics clics 3101 ${fx.sha} deploy ${run[1]}`));
    assert.match(r.stdout, /nothing was sent to vm1-test/);
  } finally { cleanFx(fx); }
});

test('the detached command --dry-run shows has the same systemd-run options launch.sh runs', () => {
  const opts = (text) => [...new Set([.../systemd-run((?:\s+(?:--[a-z-]+(?:=\S+)?|\\\n))+)/.exec(text)[1].matchAll(/--([a-z-]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(opts(read('deploy', 'vm1', 'deploy.sh').replace(/DETACHED_CMD="/, '')), opts(remoteSrc('launch')));
  assert.deepEqual(opts(remoteSrc('launch')), ['collect', 'quiet', 'setenv', 'unit']);
});

test('deploy.sh ships tracked code only, stages and launches the activation, and never an env file', () => {
  const fx = fakeRepo();
  try {
    const r = runDeploy(fx, ['HEAD']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.calls.length, 4, 'preflight, upload, stage, launch');
    const [pre, up, stage, launch] = r.calls;
    for (const c of r.calls) assert.deepEqual(c.args.slice(0, 2), ['ssh', 'root@vm1-test']);
    const run = pre.args.at(-1);
    assert.match(run, runId(fx.sha, 'deploy'));
    for (const c of [pre, launch]) assert.deepEqual(c.args.slice(2), ['bash', '-s', '--', '/opt/clics', 'clics', '3101', fx.sha, 'deploy', run]);
    assert.ok(bracedScript(pre.stdin).includes(remoteSrc('preflight').trim()));
    assert.ok(bracedScript(launch.stdin).includes(remoteSrc('launch').trim()));
    // The stage writes lib.sh + activate.sh to runs/<RUN>/activate.sh; it is not run over SSH.
    assert.match(stage.args[2], new RegExp(`r='/opt/clics/runs/${run}'`));
    assert.match(stage.args[2], /umask 077/);
    const staged = bracedScript(stage.stdin);
    assert.ok(staged.includes(remoteSrc('lib').trim()) && staged.includes(remoteSrc('activate').trim()));
    assert.match(up.args[2], new RegExp(`/opt/clics/releases/${fx.sha}`));
    const files = tarList(up.stdin, fx.dir);
    assert.ok(files.includes('deploy/vm1/docker-compose.yml'));
    assert.ok(files.includes('backend/src/index.js'));
    assert.ok(files.includes('rimpl/Dockerfile'));
    assert.ok(!files.includes('deploy/vm1/backend.env'), 'an untracked env file never ships');
    assert.deepEqual(files.filter((f) => /(^|\/)(\.env|[^/]*\.env|\.env\.[^/]*)$/.test(f) && !f.endsWith('.env.example')), []);
    assert.ok(!up.stdin.includes(Buffer.from('do-not-ship')));
  } finally { cleanFx(fx); }
});

test('deploy.sh refuses a ref whose tree tracks an env file, before contacting the host', () => {
  const fx = fakeRepo({ trackedEnv: true });
  try {
    const r = runDeploy(fx, ['HEAD']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refusing to ship env files: rimpl\/\.env/);
    assert.equal(r.calls.length, 0);
  } finally { cleanFx(fx); }
});

test('deploy.sh --rollback re-activates a release without uploading', () => {
  const fx = fakeRepo();
  try {
    const r = runDeploy(fx, ['--rollback', fx.sha.slice(0, 10)]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.calls.length, 3, 'preflight, stage, launch; no upload');
    const [pre, stage, launch] = r.calls;
    const run = pre.args.at(-1);
    assert.match(run, runId(fx.sha, 'rollback'));
    for (const c of [pre, launch]) assert.deepEqual(c.args.slice(2), ['bash', '-s', '--', '/opt/clics', 'clics', '3101', fx.sha, 'rollback', run]);
    assert.match(stage.args[2], new RegExp(`/opt/clics/runs/${run}`));
  } finally { cleanFx(fx); }
});

test('deploy.sh --attach follows the latest activation read-only, and takes no ref', () => {
  const fx = fakeRepo();
  try {
    let r = runDeploy(fx, ['--attach']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0].args.slice(2), ['bash', '-s', '--', '/opt/clics', 'clics', '3101', '-', 'attach', '-']);
    assert.ok(bracedScript(r.calls[0].stdin).includes(remoteSrc('attach').trim()));
    r = runDeploy(fx, ['--dry-run', '--attach']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.calls.length, 0);
    assert.match(r.stdout, /\[dry-run\] attach/);
    r = runDeploy(fx, ['--attach'], { FAKE_TS_FAIL_AT: '0', FAKE_TS_EXIT: '1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /did not succeed, or could not be followed/);
    for (const bad of [['--attach', 'HEAD'], ['--attach', '--rollback', fx.sha]]) {
      r = runDeploy(fx, bad);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /--attach follows the latest activation/);
      assert.equal(r.calls.length, 0);
    }
  } finally { cleanFx(fx); }
});

test('deploy.sh: a lost connection while following points at --attach; a failed activation says so', () => {
  const fx = fakeRepo();
  try {
    let r = runDeploy(fx, ['HEAD'], { FAKE_TS_FAIL_AT: '3', FAKE_TS_EXIT: '255' });
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.length, 4);
    assert.match(r.stderr, /ssh exited 255: the connection to vm1-test was lost .* carries on by itself\. Follow it to its result: VM1_HOST=vm1-test .*deploy\.sh --attach/);
    r = runDeploy(fx, ['HEAD'], { FAKE_TS_FAIL_AT: '3', FAKE_TS_EXIT: '1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /the activation did not succeed on vm1-test \(exit 1\).* --attach/);
    r = runDeploy(fx, ['HEAD'], { FAKE_TS_FAIL_AT: '2' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /staging the activation on vm1-test failed; nothing was restarted/);
    assert.equal(r.calls.length, 3, 'no launch after a failed stage');
  } finally { cleanFx(fx); }
});

test('deploy.sh stops at the first failing remote step, needs VM1_HOST, and rejects unsafe host names', () => {
  const fx = fakeRepo();
  try {
    let r = runDeploy(fx, ['HEAD'], { FAKE_TS_FAIL_AT: '0' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /preflight failed on vm1-test/);
    assert.equal(r.calls.length, 1, 'nothing after a failed preflight');
    r = runDeploy(fx, ['HEAD'], { VM1_HOST: '' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /VM1_HOST/);
    r = runDeploy(fx, ['HEAD'], { VM1_HOST: 'vm1;touch /tmp/x' });
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.length, 0);
  } finally { cleanFx(fx); }
});

test('deploy.sh --help prints its whole header and nothing past it', () => {
  const fx = fakeRepo();
  try {
    const r = runDeploy(fx, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Ship a git ref of CLICS to vm1/);
    assert.match(r.stdout, /--attach/);
    assert.match(r.stdout, /touch Railway, Vercel or DNS\.\n$/);
    assert.ok(!r.stdout.includes('set -euo pipefail'));
  } finally { cleanFx(fx); }
});
