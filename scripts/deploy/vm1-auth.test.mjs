// Guards for self-hosted sign-in on vm1 (#427, ADR 0012, ADR 0007): deploy/vm1/docker-compose.auth.yml, the
// internal gateway and the host nginx site. Package-free: `node --test scripts/deploy/*.test.mjs`.
// PostgREST must never be reachable from outside the compose network (no host port, no nginx location), and
// GoTrue only through nginx at /auth/v1. Where docker is installed, the merged compose file is also checked as
// docker renders it; deploy/vm1/rehearsal/run.sh hermetic checks the running containers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeDummyEnv } from './vm1-ci-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VM1 = path.join(ROOT, 'deploy', 'vm1');
const read = (...p) => readFileSync(path.join(VM1, ...p), 'utf8');
const AUTH = read('docker-compose.auth.yml');
const MAIN = read('docker-compose.yml');
const NGINX = read('nginx', 'clics.ccme.or.th.conf');
const GW = read('supabase-gw.conf');
const meaningful = (text) => text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));

function block(text, header, indent) { // the lines under `header`, indented deeper than `indent` spaces
  const lines = meaningful(text);
  const i = lines.findIndex((l) => l === header || l.startsWith(`${header} &`));
  assert.ok(i >= 0, `has ${header}`);
  const out = [];
  for (const l of lines.slice(i + 1)) { if (!l.startsWith(' '.repeat(indent + 1))) break; out.push(l); }
  return out;
}
const service = (name) => block(AUTH, `  ${name}:`, 2);
const SERVICES = ['gotrue', 'postgrest', 'supabase-gw'];

test('the auth file carries the same x-hardened block as docker-compose.yml, and every service merges it', () => {
  assert.deepEqual(block(AUTH, 'x-hardened:', 0), block(MAIN, 'x-hardened:', 0), 'x-hardened differs between the two files');
  for (const svc of SERVICES) {
    assert.ok(service(svc).includes('    <<: *hardened'), `${svc} merges x-hardened`);
    assert.ok(!service(svc).some((l) => /^ {4}(user|read_only|security_opt|cap_drop|cap_add|mem_limit|memswap_limit|cpus|pids_limit|logging|tmpfs|privileged|network_mode):/.test(l)),
      `${svc} must not override or loosen a hardening key`);
  }
  assert.deepEqual(
    block(AUTH, 'services:', 0).filter((l) => /^ {2}[a-z][a-z0-9-]*:$/.test(l)).map((l) => l.trim().slice(0, -1)),
    SERVICES, 'the auth file defines exactly gotrue, postgrest and supabase-gw',
  );
});

test('GoTrue is published on 127.0.0.1:3102 only; PostgREST and supabase-gw publish nothing', () => {
  const ports = (svc) => {
    const b = service(svc);
    const i = b.indexOf('    ports:');
    if (i < 0) return null;
    const out = [];
    for (const l of b.slice(i + 1)) { if (!l.startsWith('      ')) break; out.push(l.trim().replace(/^- /, '').replace(/^["']|["']$/g, '')); }
    return out;
  };
  assert.deepEqual(ports('gotrue'), ['127.0.0.1:3102:9999']);
  for (const svc of ['postgrest', 'supabase-gw']) {
    assert.equal(ports(svc), null, `${svc} must not publish a port`);
    assert.ok(!service(svc).some((l) => /^ {4}expose:/.test(l)), `${svc} has no expose key`);
  }
  assert.equal(meaningful(AUTH).filter((l) => /^\s*ports:/.test(l)).length, 1, 'the only ports: key is GoTrue\'s');
  for (const forbidden of [/network_mode:/, /privileged:\s*true/, /\bpid:\s*host/, /docker\.sock/, /cap_add:/]) {
    assert.ok(!meaningful(AUTH).some((l) => forbidden.test(l)), `the auth file must not contain ${forbidden}`);
  }
});

test('the auth services keep no state: no volume but the gateway\'s two read-only config binds (R5)', () => {
  const volumeLines = meaningful(AUTH).filter((l) => /^\s+- \.\//.test(l) || /^\s*volumes:/.test(l));
  assert.deepEqual(volumeLines.map((l) => l.trim()), [
    'volumes:',
    '- ./supabase-gw.conf:/etc/nginx/conf.d/default.conf:ro',
    '- ./auth-templates:/srv/auth-templates:ro',
  ]);
  assert.ok(service('supabase-gw').includes('    volumes:'), 'the binds belong to supabase-gw');
});

test('images are pinned to exact releases: GoTrue v2.197.0, PostgREST v14.18', () => {
  const images = meaningful(AUTH).filter((l) => /^ {4}image:/.test(l)).map((l) => l.trim().slice('image: '.length));
  assert.deepEqual(images, ['supabase/gotrue:v2.197.0', 'postgrest/postgrest:v14.18', 'nginxinc/nginx-unprivileged:1.28.0-alpine']);
});

test('the settings the sign-in paths rely on are pinned in compose, not left to the env file', () => {
  const g = service('gotrue').join('\n');
  for (const want of [
    'GOTRUE_DISABLE_SIGNUP: "false"', 'GOTRUE_EXTERNAL_GOOGLE_ENABLED: "true"', 'GOTRUE_EXTERNAL_PHONE_ENABLED: "false"',
    'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false"', 'GOTRUE_MAILER_AUTOCONFIRM: "false"',
    'GOTRUE_SECURITY_MANUAL_LINKING_ENABLED: "false"', 'GOTRUE_JWT_ADMIN_ROLES: service_role', 'GOTRUE_JWT_AUD: authenticated',
    'GOTRUE_LOG_LEVEL: warn', 'GOTRUE_MAILER_URLPATHS_RECOVERY: /auth/v1/verify', 'GOTRUE_MAILER_URLPATHS_CONFIRMATION: /auth/v1/verify',
  ]) assert.ok(g.includes(want), `gotrue pins ${want}`);
  assert.ok(!/SKIP_NONCE_CHECK/.test(AUTH), 'the id_token nonce check stays on (ADR 0008)');
  for (const t of ['confirmation', 'magic_link']) {
    assert.match(read('auth-templates', `${t}.html`), /\{\{ \.Token \}\}/, `${t} mail carries the code the Portal asks for`);
  }
  assert.match(read('auth-templates', 'recovery.html'), /\{\{ \.ConfirmationURL \}\}/);
  const p = service('postgrest').join('\n');
  for (const want of ['PGRST_DB_SCHEMAS: public', 'PGRST_DB_ANON_ROLE: anon', 'PGRST_ADMIN_SERVER_HOST: 127.0.0.1']) {
    assert.ok(p.includes(want), `postgrest pins ${want}`);
  }
});

test('the env examples hold names only, list every name the preflight requires, and no name compose pins', () => {
  const lib = readFileSync(path.join(VM1, 'remote', 'lib.sh'), 'utf8');
  const required = (v) => new RegExp(`^${v}="([^"]+)"`, 'm').exec(lib)[1].split(' ');
  for (const [file, svc, req] of [['gotrue.env.example', 'gotrue', required('AUTH_GOTRUE_REQUIRED')],
    ['postgrest.env.example', 'postgrest', required('AUTH_POSTGREST_REQUIRED')]]) {
    const names = [];
    for (const line of read(file).split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      assert.match(line, /^[A-Z][A-Z0-9_]*=$/, `${file}: "${line}" is not a bare NAME=`);
      names.push(line.slice(0, -1));
    }
    for (const n of req) assert.ok(names.includes(n), `${file} lists ${n}, which the preflight requires`);
    const pinned = service(svc).map((l) => /^ {6}([A-Z][A-Z0-9_]*):/.exec(l)?.[1]).filter(Boolean);
    for (const n of pinned) assert.ok(!names.includes(n), `${file} assigns ${n}, which compose pins over it`);
  }
});

test('nginx: GoTrue at /auth/v1 only (its admin API refused), and no path to PostgREST or supabase-gw', () => {
  assert.match(NGINX, /upstream clics_gotrue \{\s*server 127\.0\.0\.1:3102;/, 'the GoTrue upstream is the compose loopback port');
  const proxied = [...NGINX.matchAll(/^\s*proxy_pass\s+([^;]+);/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(proxied)].sort(), ['http://clics_backend', 'http://clics_gotrue/'], 'nginx proxies to the backend and GoTrue only');
  assert.match(NGINX, /location \/auth\/v1\/ \{[^}]*proxy_pass http:\/\/clics_gotrue\/;[^}]*\}/, 'GoTrue is proxied from /auth/v1/, prefix stripped');
  // A plain prefix, so the regex refusal below is consulted (a ^~ prefix would skip it).
  assert.ok(!/location \^~ \/auth/.test(NGINX), 'no ^~ on an /auth location');
  const refused = /location ~ \^\/auth\/v1\/\(([a-z|]+)\)\(\/\|\$\) \{\s*return 404;\s*\}/.exec(NGINX);
  assert.ok(refused, 'a regex location refuses the backend-only GoTrue endpoints');
  assert.deepEqual(refused[1].split('|').sort(), ['admin', 'invite', 'magiclink', 'otp', 'reauthenticate', 'recover', 'resend', 'signup']);
  assert.equal([...NGINX.matchAll(/clics_gotrue/g)].length, 2, 'clics_gotrue appears in its upstream and its one location only');
  for (const forbidden of [/postgrest/i, /supabase-gw/, /:3000\b/, /:8080\b/, /\/rest\/v1/]) {
    assert.ok(!meaningful(NGINX).some((l) => forbidden.test(l)), `nginx must not reach PostgREST (${forbidden})`);
  }
});

test('supabase-gw routes /auth/v1 to GoTrue and /rest/v1 to PostgREST, and nothing else upstream', () => {
  const proxied = [...GW.matchAll(/^\s*proxy_pass\s+([^;]+);/gm)].map((m) => m[1]);
  assert.deepEqual(proxied, ['http://gotrue:9999/', 'http://postgrest:3000/']);
  assert.match(GW, /location \/ \{\s*return 404;\s*\}/);
  assert.match(GW, /listen 8080;/);
});

test('the rehearsal never takes the live backend\'s port and keeps its database in memory', () => {
  const r = read('rehearsal', 'docker-compose.rehearsal.yml');
  assert.match(r, /backend:\n {4}ports: !reset \[\]/);
  assert.match(r, /tmpfs:\n {6}- \/var\/lib\/postgresql\/data:/);
  assert.ok(!/^\s+volumes:/m.test(r), 'no volume in the rehearsal');
  assert.match(read('rehearsal', 'run.sh'), /^PROJECT=clics-rehearsal$/m, 'its own compose project, never clics');
});

// docker's own rendering of the merged files, when docker is installed (CI, or a Mac with colima).
const hasDocker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
test('docker renders the merged files with GoTrue on 127.0.0.1:3102 and no port for PostgREST or supabase-gw', { skip: !hasDocker && 'docker is not installed' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clics-vm1-auth-'));
  try {
    writeDummyEnv(dir);
    for (const f of ['gotrue.env', 'postgrest.env']) { writeFileSync(path.join(dir, f), ''); chmodSync(path.join(dir, f), 0o600); }
    const r = spawnSync('docker', ['compose', '-p', 'clics', '-f', 'docker-compose.yml', '-f', 'docker-compose.auth.yml', 'config', '--format', 'json'], {
      cwd: VM1, encoding: 'utf8',
      env: { ...process.env, CLICS_RELEASE: 'ci', CLICS_UID: '10001', CLICS_GID: '10001', CLICS_ENV_DIR: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(r.stdout);
    const published = (svc) => (cfg.services[svc].ports || []).map((p) => `${p.host_ip}:${p.published}:${p.target}`);
    assert.deepEqual(published('gotrue'), ['127.0.0.1:3102:9999']);
    assert.deepEqual(published('postgrest'), []);
    assert.deepEqual(published('supabase-gw'), []);
    assert.deepEqual(published('backend'), ['127.0.0.1:3101:3001'], 'the auth file leaves the backend as it was');
    for (const svc of SERVICES) {
      const s = cfg.services[svc];
      assert.equal(s.user, '10001:10001');
      assert.equal(s.read_only, true);
      assert.deepEqual(s.cap_drop, ['ALL']);
      assert.deepEqual(Object.keys(s.networks), ['clics']);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
