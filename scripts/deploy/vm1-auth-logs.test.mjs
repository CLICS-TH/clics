// What vm1's sign-in stack writes to disk, and how hard its public credential endpoints can be hit (#427 gate
// on PR #460, findings 2-6). Package-free: `node --test scripts/deploy/*.test.mjs`.
// R5: no PII at rest on vm1, and a one-time sign-in token is a credential. The static tests read the files; the
// docker tests run both nginx configs and look at what they actually log and answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VM1 = path.join(ROOT, 'deploy', 'vm1');
const read = (...p) => readFileSync(path.join(VM1, ...p), 'utf8');
const meaningful = (text) => text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
const NGINX = read('nginx', 'clics.ccme.or.th.conf');
const GW = read('supabase-gw.conf');
const AUTH = read('docker-compose.auth.yml');
const REHEARSAL = read('rehearsal', 'docker-compose.rehearsal.yml');

// Variables that put a query string, a whole request line or a Referer into a log line.
const LEAKY = /\$(request|request_uri|args|query_string|is_args|http_referer|arg_[a-z0-9_]+)\b/;

test('host nginx: every access log uses a format without the query string or Referer, and errors log at crit', () => {
  const fmt = /log_format\s+clics_noquery\s+((?:'[^']*'\s*)+);/.exec(NGINX);
  assert.ok(fmt, 'defines log_format clics_noquery');
  assert.ok(!LEAKY.test(fmt[1]), `clics_noquery must not log ${LEAKY.exec(fmt[1])?.[0]}`);
  assert.match(fmt[1], /\$uri\b/, 'the path is logged as $uri');
  const access = meaningful(NGINX).filter((l) => /^\s*access_log\s/.test(l)).map((l) => l.trim());
  assert.ok(access.length > 0);
  for (const l of access) assert.match(l, /^access_log \S+ clics_noquery;$|^access_log off;$/, `"${l}" names the clics_noquery format`);
  const errors = meaningful(NGINX).filter((l) => /^\s*error_log\s/.test(l)).map((l) => l.trim());
  assert.ok(errors.length > 0);
  for (const l of errors) assert.match(l, /\s(crit|alert|emerg);$/, `"${l}": an upstream error carries the request line`);
});

test('host nginx: /auth/v1/token and /verify are rate-limited per client address, other GoTrue paths are not', () => {
  const map = /map \$uri \$clics_auth_limit_key \{([^}]*)\}/.exec(NGINX);
  assert.ok(map, 'a map keys the limit on the path');
  assert.match(map[1], /~\*\^\/auth\/v1\/\(token\|verify\)\/\?\$\s+\$binary_remote_addr;/);
  assert.match(map[1], /default\s+"";/, 'every other path gets an empty key, which nginx does not count');
  assert.match(NGINX, /limit_req_zone \$clics_auth_limit_key zone=clics_auth:\d+m rate=10r\/m;/);
  assert.match(NGINX, /location \/auth\/v1\/ \{[^}]*limit_req zone=clics_auth burst=\d+ nodelay;[^}]*limit_req_status 429;[^}]*\}/);
});

test('supabase-gw: no access log, and errors at crit', () => {
  const server = meaningful(GW).map((l) => l.trim());
  assert.ok(server.includes('access_log off;'), 'supabase-gw writes no access log');
  const errors = server.filter((l) => l.startsWith('error_log '));
  assert.deepEqual(errors, ['error_log /dev/stderr crit;']);
});

test('GoTrue logs start-up failures only and keys its own rate limits on the client address nginx sets', () => {
  const pins = meaningful(AUTH).map((l) => l.trim());
  assert.ok(pins.includes('GOTRUE_LOG_LEVEL: fatal'), 'GOTRUE_LOG_LEVEL is fatal: error lines name the mail recipient');
  assert.ok(pins.includes('GOTRUE_RATE_LIMIT_HEADER: X-Real-IP'), 'GoTrue limits per client address');
  assert.match(NGINX, /proxy_set_header X-Real-IP \$remote_addr;/, 'nginx overwrites X-Real-IP, so a client cannot choose its own key');
});

test('the rehearsal database cannot swap: mem_limit equals memswap_limit, and run.sh checks the kernel enforces it', () => {
  const db = /\n {2}db:\n((?: {4}.*\n|\s*\n)+)/.exec(REHEARSAL)[1];
  const mem = /^ {4}mem_limit: (\S+)$/m.exec(db);
  const swap = /^ {4}memswap_limit: (\S+)$/m.exec(db);
  assert.ok(mem && swap, 'db sets mem_limit and memswap_limit');
  assert.equal(swap[1], mem[1], 'memswap_limit equal to mem_limit leaves no swap');
  const run = read('rehearsal', 'run.sh');
  assert.match(run, /memory\.swap\.max/, 'run.sh reads the db container\'s swap limit');
  assert.match(run, /up_db\(\) \{[^}]*assert_no_swap/, 'up_db checks it before any data is loaded');
});

// ---- docker: run the two nginx configs and read what they log ----
const hasDocker = spawnSync('docker', ['version'], { encoding: 'utf8' }).status === 0;
const SKIP = !hasDocker && 'docker is not installed';
const TOKEN = 'TOKEN427probe';
const NAME = 'Somchai427probe';
const REF = 'REF427probe';
// One status code per line, from busybox wget (it prints the status line for an error status too).
const PROBE_FN = `code() { wget -S -O /dev/null "$@" 2>&1 | grep -o 'HTTP/1.[01] [0-9]*' | tail -1 | cut -d' ' -f2; }`;

function docker(args, input) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 240_000, input });
  assert.equal(r.status, 0, `docker ${args.slice(0, 3).join(' ')}: ${r.stderr}`);
  return r.stdout + r.stderr;
}
const statuses = (out, tag) => [...out.matchAll(new RegExp(`^${tag} (\\d*)$`, 'gm'))].map((m) => m[1]);

test('host nginx, run: the logs hold no token, name or Referer, and /token and /verify answer 429 past the burst', { skip: SKIP }, () => {
  // vm1's nginx is 1.18. TLS is dropped (the placeholders hold no certificate): the probe is about logs and limits.
  // The config goes in on stdin, not a bind mount, so it works where docker cannot see the temp directory.
  const site = NGINX.replace(/listen 443 ssl;/, 'listen 8443;').replace(/^\s*ssl_certificate(_key)?\s.*$/gm, '');
  const script = `${PROBE_FN}
    cat > /etc/nginx/nginx.conf && nginx || exit 1
    B=http://127.0.0.1:8443
    for i in $(seq 1 25); do echo "verify $(code --header 'Referer: https://x/login?token=${REF}' "$B/auth/v1/verify?token=${TOKEN}&type=recovery")"; done
    for i in $(seq 1 5); do echo "token $(code "$B/auth/v1/token?grant_type=password")"; done
    for i in $(seq 1 25); do echo "user $(code "$B/auth/v1/user")"; done
    echo "search $(code "$B/admin/professionals?q=${NAME}")"
    echo ---LOGS---; cat /var/log/nginx/clics.access.log /var/log/nginx/clics.error.log`;
  const out = docker(['run', '--rm', '-i', '--entrypoint', 'sh', 'nginx:1.18.0-alpine', '-c', script],
    `pid /tmp/nginx.pid;\nevents {}\nhttp {\n${site}\n}\n`);
  const verify = statuses(out, 'verify');
  assert.equal(verify.length, 25, out);
  assert.equal(verify[0], '502', 'the first /verify reaches the (absent) GoTrue: the control');
  assert.ok(verify.includes('429'), `/verify is limited past the burst: ${verify.join(' ')}`);
  assert.ok(statuses(out, 'token').every((s) => s === '429'), 'the bucket is per address and shared with /token');
  assert.ok(statuses(out, 'user').every((s) => s === '502'), '/user is not limited');
  assert.deepEqual(statuses(out, 'search'), ['502']);
    const logs = out.split('---LOGS---')[1];
    assert.match(logs, /GET \/auth\/v1\/verify HTTP\/1\.1" 502/, 'the access log has the request, path only: the control');
  for (const secret of [TOKEN, NAME, REF]) assert.ok(!logs.includes(secret), `the host nginx logs hold ${secret}:\n${logs}`);
});

test('supabase-gw, run: a PostgREST filter and a GoTrue token never reach its log', { skip: SKIP }, () => {
  const script = `${PROBE_FN}
    cat > /etc/nginx/conf.d/default.conf && nginx || exit 1
    echo "rest $(code "http://127.0.0.1:8080/rest/v1/professionals?full_name=ilike.*${NAME}*")"
    echo "verify $(code "http://127.0.0.1:8080/auth/v1/verify?token=${TOKEN}&type=recovery")"
    sleep 0.2`;
  // gotrue and postgrest resolve to the container itself, where nothing listens: every request is an upstream error.
  // The config goes in on stdin (root, to write it), not a bind mount, so it works where docker cannot see the checkout.
  const out = docker(['run', '--rm', '-i', '-u', '0', '--add-host', 'gotrue:127.0.0.1', '--add-host', 'postgrest:127.0.0.1',
    '--entrypoint', 'sh', 'nginxinc/nginx-unprivileged:1.28.0-alpine', '-c', script], GW);
  assert.deepEqual(statuses(out, 'rest'), ['502'], out);
  assert.deepEqual(statuses(out, 'verify'), ['502'], out);
  const logged = out.split('\n').filter((l) => !/^(rest|verify) /.test(l)).join('\n');
  for (const secret of [TOKEN, NAME]) assert.ok(!logged.includes(secret), `supabase-gw logged ${secret}:\n${logged}`);
});
