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

test('images are pinned to exact releases: GoTrue v2.198.0, PostgREST v14.18', () => {
  const images = meaningful(AUTH).filter((l) => /^ {4}image:/.test(l)).map((l) => l.trim().slice('image: '.length));
  assert.deepEqual(images, ['supabase/gotrue:v2.198.0', 'postgrest/postgrest:v14.18', 'nginxinc/nginx-unprivileged:1.28.0-alpine']);
});

test('the settings the sign-in paths rely on are pinned in compose, not left to the env file', () => {
  const g = service('gotrue').join('\n');
  for (const want of [
    'GOTRUE_DISABLE_SIGNUP: "false"', 'GOTRUE_EXTERNAL_GOOGLE_ENABLED: "true"', 'GOTRUE_EXTERNAL_PHONE_ENABLED: "false"',
    'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false"', 'GOTRUE_MAILER_AUTOCONFIRM: "false"',
    'GOTRUE_SECURITY_MANUAL_LINKING_ENABLED: "false"', 'GOTRUE_JWT_ADMIN_ROLES: service_role', 'GOTRUE_JWT_AUD: authenticated',
    'GOTRUE_LOG_LEVEL: fatal', 'GOTRUE_MAILER_URLPATHS_RECOVERY: /auth/v1/verify', 'GOTRUE_MAILER_URLPATHS_CONFIRMATION: /auth/v1/verify',
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
  assert.deepEqual([...new Set(proxied)].sort(),
    ['http://clics_backend', 'http://clics_backend/', 'http://clics_dashboard', 'http://clics_gotrue/', 'http://clics_portal'],
    'nginx proxies to the backend (/api), GoTrue (/auth/v1), the dashboard (/audit) and the Portal (/) only');
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

// Docker keeps a database container's log on vm1's disk. Both rehearsal databases log as the data host does:
// no query ERROR (its DETAIL, STATEMENT or COPY CONTEXT quotes values) and no statement text (an ALTER ROLE's
// password). The data host's own settings are the reference.
const DATA_HOST_LOG = (() => {
  const conf = readFileSync(path.join(ROOT, 'deploy', 'data-host', 'postgresql.conf'), 'utf8');
  return ['log_min_messages', 'log_min_error_statement', 'log_error_verbosity', 'log_statement'].map((k) => {
    const v = new RegExp(`^${k} = '([a-z]+)'$`, 'm').exec(conf)?.[1];
    assert.ok(v, `the data host sets ${k}`);
    return [k, v];
  });
})();

test('the sign-in rehearsal\'s database logs no value and no password, as the data host does', () => {
  const db = block(read('rehearsal', 'docker-compose.rehearsal.yml'), '  db:', 2).join('\n');
  const cmd = /^ {4}command: (\[[^\]]*\])/m.exec(db)?.[1];
  assert.ok(cmd, 'the rehearsal db sets its command');
  const args = JSON.parse(cmd);
  assert.deepEqual(args.slice(0, 3), ['postgres', '-D', '/etc/postgresql'], 'the supabase/postgres image\'s own command first');
  const set = new Map();
  for (let i = 3; i < args.length; i += 2) {
    assert.equal(args[i], '-c');
    const [k, v] = args[i + 1].split('=');
    set.set(k, v);
  }
  for (const [k, v] of DATA_HOST_LOG) assert.equal(set.get(k), v, `the rehearsal db sets ${k}=${v}, as the data host does`);
  assert.equal(set.get('auto_explain.log_min_duration'), '-1', 'auto_explain, which the image preloads, logs no plan');
  assert.match(read('rehearsal', 'run.sh'), /dc logs --no-log-prefix gotrue postgrest supabase-gw db /,
    'the hermetic run checks the db\'s log too');
});

// The data host's PostgreSQL in the rehearsal (#432): a nightly backup of the PostgreSQL 18 data host restores
// into that same PostgreSQL, never an older one, and the hermetic sign-in replay runs against it as well as
// against the supabase/postgres image, in a database that lives in memory like the rehearsal's.
test('the data host\'s PostgreSQL runs in memory, for vm1-drill and hermetic-data-host only', () => {
  const drill = read('rehearsal', 'docker-compose.data-host.yml');
  const dataHost = readFileSync(path.join(ROOT, 'deploy', 'data-host', 'docker-compose.yml'), 'utf8');
  const image = /^ {4}image: (clics-data-pg:\S+)$/m.exec(dataHost)?.[1];
  assert.ok(image, 'the data host names its image');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(drill, new RegExp(`^ {4}image: ${esc(image)}$`, 'm'), 'the drill runs the data host\'s image');
  assert.match(drill, /^ {6}context: \.\.\/data-host$/m, 'built from the data host\'s Dockerfile');
  assert.match(drill, /^ {6}PGDATA: \/var\/lib\/postgresql\/data$/m, 'its data in the rehearsal\'s tmpfs');
  assert.match(drill, /tmpfs:\n {6}- \/var\/lib\/postgresql:rw,/, 'the image\'s volume path is a tmpfs too');
  assert.ok(!/mem_limit|memswap_limit|volumes:/.test(meaningful(drill).join('\n')), 'the memory cap and the no-volume rule stay the rehearsal\'s');
  for (const [k, v] of DATA_HOST_LOG) {
    assert.match(drill, new RegExp(`"-c", "${k}=${v}"`), `the drill sets ${k}=${v}, as the data host does`);
  }
  const run = read('rehearsal', 'run.sh');
  const branchOf = (name) => {
    const start = run.indexOf(`\n  ${name})\n`);
    assert.ok(start >= 0, `run.sh has a ${name} command`);
    return run.slice(start, run.indexOf('\n    ;;\n', start));
  };
  assert.match(run, /^DATA_HOST=$/m, 'a DATA_HOST inherited from the caller is dropped');
  assert.equal(run.match(/DATA_HOST=1$/gm)?.length, 2, 'DATA_HOST=1 is set in two places');
  const drillBranch = branchOf('vm1-drill');
  assert.match(drillBranch, /^ {4}DATA_HOST=1$/m, 'one is vm1-drill');
  assert.match(branchOf('hermetic|hermetic-data-host'), /^ {4}\[ "\$1" = hermetic \] \|\| DATA_HOST=1$/m,
    'the other is hermetic-data-host, never plain hermetic');
  assert.ok(!/DATA_HOST/.test(branchOf('vm1-up')), 'vm1-up restores Supabase into the supabase/postgres image only');
  assert.match(drillBranch, /^ {4}exec 3<&0 <\/dev\/null$/m, 'the backup stream is kept from every exec before the drill');
  assert.match(drillBranch, /exec bash \/tmp\/move\.sh drill' <&3$/m, 'and handed to the drill alone');
  assert.match(run, /up_db\(\) \{[^}]*assert_in_memory/, 'up_db checks the data is in memory before any is loaded');
  // schema.sql stands in for the move, which brings production's default privileges to the data host.
  assert.match(run, /\[ -z "\$DATA_HOST" \] \|\| printf 'alter default privileges for role postgres in schema public grant all on %s to service_role;\\n'/,
    'the data host\'s schema load gets service_role\'s default privileges, as the move brings them');
  assert.match(readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
    /run: SKIP_BUILD=1 deploy\/vm1\/rehearsal\/run\.sh hermetic-data-host$/m, 'CI replays sign-in against the data host\'s PostgreSQL');
  assert.match(read('deploy.sh'), /release_paths\+=\(deploy\/data-host\)/, 'the release carries the data host\'s Dockerfile');
});

// PostgREST loads no schema cache while a schema on its search path is missing, so every request fails: the
// data host's plain PostgreSQL must have each one (the supabase/postgres image does), and the move checks it.
test('every schema PostgREST searches exists on the data host and is checked before the move', () => {
  const path_ = /^ {6}PGRST_DB_EXTRA_SEARCH_PATH: (\S+)$/m.exec(service('postgrest').join('\n'))?.[1];
  assert.ok(path_, 'postgrest pins its search path');
  const prepare = read('db-move', 'prepare-plain-pg.sql');
  const move = read('db-move', 'move.sh');
  for (const s of path_.split(',').filter((x) => x !== 'public')) {
    assert.match(prepare, new RegExp(`^create schema if not exists ${s};$`, 'm'), `prepare-plain-pg.sql creates ${s}`);
    assert.match(prepare, new RegExp(`^grant usage on schema ${s} to anon, authenticated, service_role;$`, 'm'), `and PostgREST's roles may use it`);
    assert.match(move, new RegExp(`to_regnamespace\\('${s}'\\) is null`), `move.sh preflight stops on a target without ${s}`);
  }
});

// The Google and Resend stand-ins replace the real services, so a vm1 rehearsal must never load them: there
// GoTrue has to reach the real Google and the real relay with the system's trust store.
test('the Google and SMTP stand-ins load only in the hermetic run, never on vm1', () => {
  const run = read('rehearsal', 'run.sh');
  const overlay = read('rehearsal', 'docker-compose.hermetic.yml');
  assert.equal(run.match(/^\s*HERMETIC=1$/gm)?.length, 1, 'HERMETIC=1 is set in one place');
  assert.match(run, /^ {2}hermetic\|hermetic-data-host\)\n {4}HERMETIC=1$/m, 'and that place is the hermetic commands');
  assert.match(run, /^HERMETIC=$/m, 'a HERMETIC inherited from the caller is dropped');
  assert.match(run, /\[ -z "\$HERMETIC" \] \|\| files\+=\(-f rehearsal\/docker-compose\.hermetic\.yml\)/, 'dc() adds the overlay only under HERMETIC');
  assert.equal(run.match(/-f rehearsal\/docker-compose\.hermetic\.yml/g)?.length, 1, 'no other line loads the overlay');
  assert.match(run, /^ {4}hermetic_env "\$2"$/m, 'vm1-env writes the vm1 mail settings, not the stand-in relay');
  assert.match(overlay, /aliases: \[accounts\.google\.com\]/);
  assert.match(overlay, /aliases: \[smtp\.resend\.com\]/);
  assert.match(overlay, /SSL_CERT_FILE: \/pki\/ca\.crt\n {6}SSL_CERT_DIR: \/nonexistent\n/, 'GoTrue trusts the rehearsal CA and nothing from /etc/ssl/certs');
  assert.match(overlay, /^networks:\n {2}clics:\n {4}internal: true$/m, 'a stopped stand-in cannot hand its name to the real host');
  for (const f of [['docker-compose.auth.yml'], ['docker-compose.yml'], ['rehearsal', 'docker-compose.rehearsal.yml']]) {
    const config = read(...f).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.ok(!/SSL_CERT_FILE|accounts\.google\.com|smtp\.resend\.com|fake-google/.test(config), `${f.join('/')} configures no stand-in`);
  }
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
