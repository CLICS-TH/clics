// The scripts deploy.sh runs ON vm1 (deploy/vm1/remote/{preflight,activate,launch,attach}.sh), exercised
// against stub commands: docker, ss, curl, flock, id, stat, uname, mv, readlink, systemd-run and systemctl
// are replaced on PATH, so no container starts, no unit is created and nothing outside a temp dir is
// touched. Runs on macOS and Linux alike.
//
// What this pins: the ORDER on vm1 (rimpl, then the token gate, then the backend, so the evaluation drain
// never starts against a rimpl that would 401 it), on a deploy AND on every restore; that restore never
// runs `down` or a service-less `up`, stops the backend when the token is not proven, and starts it when
// the token is proven and rimpl is only degraded (gate exit 2); that /opt/clics/current only moves after
// both gates pass; that preflight and activate refuse bad env files without printing a value, and a
// second deploy while the lock is held; that a detached activation survives losing its follower; and that
// one stopped by a signal records a failure, never success.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, readlinkSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REMOTE = path.join(ROOT, 'deploy', 'vm1', 'remote');
const SHA = 'a'.repeat(40);
const PREV = 'b'.repeat(40);
const RUN = `20261021T000000Z-${SHA.slice(0, 12)}-deploy`;
// Distinctive token values, so a test can prove none of them is ever printed.
const TOKEN = 'tok-SAME-1f2e3d';
const TOKEN_B = 'tok-BACKEND-9a8b7c';
const TOKEN_R = 'tok-RIMPL-6d5e4f';

const STUBS = {
  // Logs every call with the directory and release it ran under; fails any call matching STUB_FAIL;
  // sleeps on STUB_SLOW; deletes STUB_RM when a call matches STUB_RM_ON (a release vanishing mid-run);
  // makes gate 1 exit STUB_GATE_RIMPL, printing what health-gate.cjs prints for 2 and 3.
  docker: `#!/usr/bin/env bash
echo "docker[\${PWD##*/releases/}|\${CLICS_RELEASE:-}] $*" >> "$STUB_LOG"
case "$*" in
  "compose version") echo "Docker Compose version stub"; exit 0 ;;
  "--version") echo "Docker version stub"; exit 0 ;;
  "ps -q "*"service=backend"*) printf '%s' "\${STUB_PS_BACKEND:-}"; exit 0 ;;
  "ps "*) printf '%s' "\${STUB_PS:-}"; exit 0 ;;
  "image inspect"*) [ "\${STUB_IMAGES:-0}" = 1 ]; exit $? ;;
  "inspect -f"*) printf '%s' "\${STUB_BACKEND_ENV:-}"; exit 0 ;;
esac
if [ -n "\${STUB_GATE_RIMPL:-}" ]; then
  case "$*" in *"node /gate.cjs rimpl"*)
    case "$STUB_GATE_RIMPL" in
      2) echo "[gate] INTERNAL_TOKEN matches: rimpl accepted it on GET /manifest"
         echo "[gate] rimpl is DEGRADED: /health/deep HTTP 503, service=rimpl, status=degraded; down: anthropic_serving=down, supabase=down" >&2 ;;
      3) echo "[gate] INTERNAL_TOKEN in backend.env does not match the one rimpl runs with (rimpl answered 401)." >&2 ;;
    esac
    exit "$STUB_GATE_RIMPL" ;;
  esac
fi
if [ -n "\${STUB_RM_ON:-}" ]; then case "$*" in *"$STUB_RM_ON"*) rm -rf "$STUB_RM" ;; esac; fi
if [ -n "\${STUB_SLOW:-}" ]; then case "$*" in *"$STUB_SLOW"*) sleep "\${STUB_SLOW_S:-3}" ;; esac; fi
if [ -n "\${STUB_FAIL:-}" ]; then
  while IFS= read -r pat; do
    [ -n "$pat" ] && case "$*" in *"$pat"*) echo "stub docker: failing '$pat'" >&2; exit 1 ;; esac
  done <<< "$STUB_FAIL"
fi
exit 0
`,
  ss: `#!/usr/bin/env bash
printf '%s' "\${STUB_SS:-}"
`,
  curl: `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"; exit "\${STUB_CURL_EXIT:-0}"
`,
  // STUB_FLOCK_BUSY=1: another deploy holds /opt/clics/.deploy.lock.
  flock: `#!/usr/bin/env bash
echo "flock $*" >> "$STUB_LOG"
[ "\${STUB_FLOCK_BUSY:-0}" = 1 ] && exit 1
exit 0
`,
  id: `#!/usr/bin/env bash
if [ "$2" = clics ]; then [ "\${STUB_NO_CLICS:-0}" = 1 ] && exit 1; echo 10001; exit 0; fi
exec /usr/bin/id "$@"
`,
  stat: `#!/usr/bin/env bash
# stat -c %a|%U FILE
case "$2" in
  %a) python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$3" ;;
  %U) echo "\${STUB_OWNER:-clics}" ;;
  *) exit 2 ;;
esac
`,
  uname: `#!/usr/bin/env bash
echo "\${STUB_ARCH:-x86_64}"
`,
  // GNU mv -T (rename onto a path even if it is a symlink to a directory); plain mv otherwise.
  mv: `#!/usr/bin/env bash
case "$1" in -T|-Tf|-fT) exec python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$2" "$3" ;; esac
exec /bin/mv "$@"
`,
  readlink: `#!/usr/bin/env bash
[ "$1" = -f ] && exec python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$2"
exec /usr/bin/readlink "$@"
`,
  // systemd-run [--opt...] CMD ARG...: CMD runs in a NEW SESSION in the background, as a transient unit
  // runs outside the SSH session. (A real unit starts with systemd's environment; this child inherits the
  // caller's, STUB_* included, which is what lets the stubs work inside it.)
  'systemd-run': `#!/usr/bin/env bash
unit=""
while [ $# -gt 0 ]; do
  case "$1" in --unit=*) unit=\${1#--unit=}; shift ;; --*) shift ;; *) break ;; esac
done
echo "systemd-run unit=$unit $*" >> "$STUB_LOG"
[ "\${STUB_SYSTEMD_RUN_FAIL:-0}" = 1 ] && exit 1
mkdir -p "$STUB_UNITS"
python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@" </dev/null >/dev/null 2>&1 &
echo $! > "$STUB_UNITS/$unit.pid"
exit 0
`,
  // systemctl is-active --quiet UNIT: is the stub unit's process alive?
  systemctl: `#!/usr/bin/env bash
[ "$1" = is-active ] || exit 2
for unit; do :; done
pid=$(cat "$STUB_UNITS/$unit.pid" 2>/dev/null) || exit 3
kill -0 "$pid" 2>/dev/null
`,
};
// The real sha256sum where there is one (Linux; macOS 15+ has /sbin/sha256sum), a python one otherwise.
if (spawnSync('sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).status !== 0) {
  STUBS.sha256sum = `#!/usr/bin/env bash
exec python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest() + "  -")'
`;
}

const BACKEND_NAMES = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'GUEST_TOKEN_SECRET',
  'IDENTITY_ENC_KEY', 'ALLOWED_ORIGINS', 'SITE_URL', 'LICENSE_VERIFIER_ADAPTER'];
const RIMPL_NAMES = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

// A fake /opt/clics. `releases` are unpacked; `current` (a sha or null) is where /opt/clics/current
// points, whether or not that release is present. `reconcile: null` leaves the line out.
function host({
  releases = [SHA], current = null, envMode = 0o600, backendToken = `INTERNAL_TOKEN=${TOKEN}`,
  rimplToken = `INTERNAL_TOKEN=${TOKEN}`, reconcile = 'RECONCILE_INTERVAL_MS=0', rimplExtra = '', backendExtra = '',
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clics-vm1-remote-'));
  const stubs = path.join(dir, 'stubs');
  mkdirSync(stubs);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(path.join(stubs, name), body);
    chmodSync(path.join(stubs, name), 0o755);
  }
  const base = path.join(dir, 'opt-clics');
  mkdirSync(path.join(base, 'releases'), { recursive: true });
  for (const sha of releases) {
    const rel = path.join(base, 'releases', sha, 'deploy', 'vm1');
    mkdirSync(rel, { recursive: true });
    writeFileSync(path.join(rel, 'docker-compose.yml'), '# stub\n');
    writeFileSync(path.join(rel, 'health-gate.cjs'), '// stub\n');
  }
  if (current) symlinkSync(`releases/${current}`, path.join(base, 'current'));
  mkdirSync(path.join(base, 'env'));
  const lines = (names, extra) => [...names.map((n) => `${n}=x`), ...extra.filter((l) => l !== null)].join('\n');
  writeFileSync(path.join(base, 'env', 'backend.env'), `${lines(BACKEND_NAMES, [backendToken, reconcile])}\n${backendExtra}`);
  writeFileSync(path.join(base, 'env', 'rimpl.env'), `${lines(RIMPL_NAMES, [rimplToken])}\n${rimplExtra}`);
  chmodSync(path.join(base, 'env', 'backend.env'), envMode);
  chmodSync(path.join(base, 'env', 'rimpl.env'), 0o600);
  return { dir, stubs, base, log: path.join(dir, 'calls.log'), units: path.join(dir, 'units') };
}
const cleanup = (h) => rmSync(h.dir, { recursive: true, force: true });

// A step exactly as deploy.sh composes it: lib.sh + <step>.sh in one brace group, stdin closed.
const stepScript = (step) => `{\n${readFileSync(path.join(REMOTE, 'lib.sh'), 'utf8')}${readFileSync(path.join(REMOTE, `${step}.sh`), 'utf8')}\n} </dev/null\n`;
const stepEnv = (h, env) => ({ PATH: `${h.stubs}:${process.env.PATH}`, HOME: h.dir, STUB_LOG: h.log, STUB_UNITS: h.units, ...env });
const readCalls = (h) => (existsSync(h.log) ? readFileSync(h.log, 'utf8').trim().split('\n') : []);

function remote(h, step, mode = 'deploy', env = {}, { sha = SHA, run } = {}) {
  const args = ['-s', '--', h.base, 'clics', '3101', sha, mode, ...(run ? [run] : [])];
  const r = spawnSync('bash', args, { input: stepScript(step), encoding: 'utf8', timeout: 60000, env: stepEnv(h, env) });
  return { ...r, out: r.stdout + r.stderr, calls: readCalls(h) };
}
const current = (h) => { try { return readlinkSync(path.join(h.base, 'current')); } catch { return null; } };
const order = (calls, needles) => needles.map((n) => calls.findIndex((c) => c.includes(n)));
const lastLine = (out) => out.trim().split('\n').at(-1);

// compose calls that start something
const UP = 'up -d --no-deps --wait --wait-timeout 180';
const serviceLessUp = (calls) => calls.filter((c) => / compose .* up( |$)/.test(c) && !/ up .* (rimpl|backend)$/.test(c));
const backendUp = (calls) => calls.filter((c) => / compose .* up .* backend$/.test(c));
const neverDown = (calls) => assert.ok(!calls.some((c) => / down( |$)/.test(c)), `restore never runs down:\n${calls.join('\n')}`);
const noTokenPrinted = (text) => {
  for (const t of [TOKEN, TOKEN_B, TOKEN_R]) assert.ok(!text.includes(t), `a token value leaked:\n${text}`);
};

// ---- activate --------------------------------------------------------------------------------------
test('activate: build, rimpl, token gate, backend, backend gate, THEN current flips', () => {
  const h = host();
  try {
    const r = remote(h, 'activate');
    assert.equal(r.status, 0, r.out);
    const idx = order(r.calls, ['build --pull', `${UP} rimpl`, 'node /gate.cjs rimpl', `${UP} backend`, 'curl -fsS', 'node /gate.cjs backend']);
    assert.ok(idx.every((i) => i >= 0), `every step ran: ${JSON.stringify(idx)}\n${r.calls.join('\n')}`);
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'in that order');
    for (const c of r.calls.filter((x) => / compose /.test(x))) {
      assert.ok(c.startsWith(`docker[${SHA}/deploy/vm1|${SHA}]`), `ran in the release dir: ${c}`);
    }
    assert.ok(r.calls.some((c) => c.includes('-p clics -f docker-compose.yml')));
    assert.deepEqual(serviceLessUp(r.calls), []);
    assert.equal(current(h), `releases/${SHA}`);
    assert.match(readFileSync(path.join(h.base, 'deploys.log'), 'utf8'), new RegExp(`deploy ${SHA} prev=none`));
  } finally { cleanup(h); }
});

test('activate: a failed token gate on a first deploy never starts the backend, and stops (never removes) CLICS', () => {
  const h = host();
  try {
    const r = remote(h, 'activate', 'deploy', { STUB_FAIL: 'node /gate.cjs rimpl' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(backendUp(r.calls), [], 'backend never brought up');
    assert.deepEqual(serviceLessUp(r.calls), []);
    assert.ok(r.calls.some((c) => c.endsWith('stop backend rimpl')), `stops what it started:\n${r.calls.join('\n')}`);
    neverDown(r.calls);
    assert.match(lastLine(r.out), /gate 1 .* failed for a{40}, before its backend was started\. no release was live on this host before this run, and CLICS's containers are stopped here now/);
    assert.equal(current(h), null);
  } finally { cleanup(h); }
});

test('activate: a failed backend gate restores the live release rimpl -> gate -> backend, from its own dir', () => {
  const h = host({ releases: [SHA, PREV], current: PREV });
  try {
    const r = remote(h, 'activate', 'deploy', { STUB_FAIL: 'node /gate.cjs backend' });
    assert.notEqual(r.status, 0);
    const fromPrev = r.calls.filter((c) => c.startsWith(`docker[${PREV}/deploy/vm1|${PREV}]`));
    const idx = order(fromPrev, [`${UP} rimpl`, 'node /gate.cjs rimpl', `${UP} backend`]);
    assert.ok(idx.every((i) => i >= 0), `restored ${PREV} from its own release dir:\n${r.calls.join('\n')}`);
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'rimpl, then the gate, then the backend');
    assert.deepEqual(serviceLessUp(r.calls), []);
    neverDown(r.calls);
    assert.match(lastLine(r.out), new RegExp(`gate 2 .* failed for a{40}\\. ${PREV}, the release that was live before this run, is running`));
    assert.equal(current(h), `releases/${PREV}`);
  } finally { cleanup(h); }
});

test('activate: a backend published beyond loopback is refused and rolled back', () => {
  const h = host({ releases: [SHA, PREV], current: PREV });
  try {
    const r = remote(h, 'activate', 'deploy', { STUB_SS: 'LISTEN 0 4096 0.0.0.0:3101 0.0.0.0:*\n' });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /listening beyond loopback/);
    assert.equal(current(h), `releases/${PREV}`);
  } finally { cleanup(h); }
});

test('activate --rollback reuses the release images when they exist, and records the previous one', () => {
  const h = host({ releases: [SHA, PREV], current: PREV });
  try {
    const r = remote(h, 'activate', 'rollback', { STUB_IMAGES: '1', STUB_SS: 'LISTEN 0 4096 127.0.0.1:3101 0.0.0.0:*\n' });
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.calls.some((c) => c.includes(' build')), 'no rebuild');
    assert.equal(current(h), `releases/${SHA}`);
    assert.equal(readlinkSync(path.join(h.base, 'previous')), `releases/${PREV}`);
  } finally { cleanup(h); }
});

// The reported bug: `deploy.sh --rollback CURRENT_SHA` after an env edit. Gate 1 failed, and restore()
// ran a service-less `up`, which recreated the backend with the bad env and let its drain send the queue
// to manual QA. Now restore re-gates rimpl, and stops the backend when that gate fails too.
test('activate --rollback of the CURRENT release with gate 1 failing never brings the backend up, and stops it', () => {
  const h = host({ releases: [SHA], current: SHA });
  try {
    const r = remote(h, 'activate', 'rollback', {
      STUB_IMAGES: '1', STUB_FAIL: 'node /gate.cjs rimpl', STUB_PS_BACKEND: 'c0ffee\n',
      STUB_BACKEND_ENV: `NODE_ENV=production\nINTERNAL_TOKEN=${TOKEN}\n`,
    });
    assert.notEqual(r.status, 0);
    assert.deepEqual(serviceLessUp(r.calls), [], 'no service-less up');
    assert.deepEqual(backendUp(r.calls), [], 'the backend is never brought up');
    assert.equal(r.calls.filter((c) => c.includes('node /gate.cjs rimpl')).length, 2, 'gated on the deploy and again on the restore');
    assert.ok(r.calls.some((c) => c.endsWith('compose -p clics -f docker-compose.yml stop backend')), `backend stopped:\n${r.calls.join('\n')}`);
    neverDown(r.calls);
    assert.match(r.out, /!!! CLICS's backend on vm1 is STOPPED, because the rimpl of a{40} failed gate 1/);
    assert.match(lastLine(r.out), /failed for a{40}, before its backend was started\. CLICS's backend on vm1 is STOPPED/);
    assert.ok(!/is running: its rimpl|is running again/.test(r.out), 'never claims the old release is running');
    assert.equal(current(h), `releases/${SHA}`);
    noTokenPrinted(r.out);
  } finally { cleanup(h); }
});

// The same re-activation with ONE env file edited: preflight refuses it, and so does activate, before it
// builds, stops or starts anything (the files may change between the two steps).
for (const edited of ['backend.env', 'rimpl.env']) {
  test(`--rollback of the current release with only ${edited} edited to a new INTERNAL_TOKEN changes nothing`, () => {
    const tokens = edited === 'backend.env'
      ? { backendToken: `INTERNAL_TOKEN=${TOKEN_B}` }
      : { rimplToken: `INTERNAL_TOKEN=${TOKEN_R}` };
    const h = host({ releases: [SHA], current: SHA, ...tokens });
    try {
      const env = { STUB_IMAGES: '1', STUB_PS_BACKEND: 'c0ffee\n', STUB_BACKEND_ENV: `INTERNAL_TOKEN=${TOKEN}\n` };
      const pre = remote(h, 'preflight', 'rollback', env);
      assert.notEqual(pre.status, 0);
      assert.match(pre.out, /INTERNAL_TOKEN differs between backend\.env and rimpl\.env/);
      const r = remote(h, 'activate', 'rollback', env);
      assert.notEqual(r.status, 0);
      assert.match(lastLine(r.out), /INTERNAL_TOKEN differs between backend\.env and rimpl\.env .* Nothing was changed\./);
      assert.ok(!r.calls.some((c) => / compose -p /.test(c)), `no compose call on the project at all:\n${r.calls.join('\n')}`);
      assert.equal(current(h), `releases/${SHA}`);
      noTokenPrinted(pre.out + r.out + r.calls.join('\n'));
    } finally { cleanup(h); }
  });
}

test('activate: a token rotation (both files edited) stops the running backend BEFORE rimpl is recreated', () => {
  const h = host({ releases: [SHA], current: SHA, backendToken: `INTERNAL_TOKEN=${TOKEN_R}`, rimplToken: `INTERNAL_TOKEN=${TOKEN_R}` });
  try {
    const r = remote(h, 'activate', 'rollback', {
      STUB_IMAGES: '1', STUB_PS_BACKEND: 'c0ffee\n', STUB_BACKEND_ENV: `INTERNAL_TOKEN=${TOKEN}\n`,
      STUB_SS: 'LISTEN 0 4096 127.0.0.1:3101 0.0.0.0:*\n',
    });
    assert.equal(r.status, 0, r.out);
    const idx = order(r.calls, ['stop backend', `${UP} rimpl`, 'node /gate.cjs rimpl', `${UP} backend`]);
    assert.ok(idx.every((i) => i >= 0), r.calls.join('\n'));
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'stop the backend, then rimpl, gate, backend');
    assert.match(r.out, /INTERNAL_TOKEN is changing/);
    noTokenPrinted(r.out + r.calls.join('\n'));
  } finally { cleanup(h); }
});

test('activate: an unchanged token leaves the running backend alone until it is recreated', () => {
  const h = host({ releases: [SHA, PREV], current: PREV });
  try {
    const r = remote(h, 'activate', 'deploy', { STUB_PS_BACKEND: 'c0ffee\n', STUB_BACKEND_ENV: `INTERNAL_TOKEN=${TOKEN}\n` });
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.calls.some((c) => c.includes(' stop ')), `no stop:\n${r.calls.join('\n')}`);
  } finally { cleanup(h); }
});

test('activate refuses up front when current points at a release that is gone', () => {
  const h = host({ releases: [SHA], current: PREV });
  try {
    const r = remote(h, 'activate');
    assert.notEqual(r.status, 0);
    assert.match(r.out, /current points at 'releases\/b{40}', which is not a release on this host/);
    assert.ok(!r.calls.some((c) => / compose -p /.test(c)), r.calls.join('\n'));
  } finally { cleanup(h); }
});

test('restore: if the live release vanishes mid-run it stops the backend, and never runs down', () => {
  const h = host({ releases: [SHA, PREV], current: PREV });
  try {
    const r = remote(h, 'activate', 'deploy', {
      STUB_FAIL: 'node /gate.cjs backend', STUB_RM_ON: 'node /gate.cjs backend', STUB_RM: path.join(h.base, 'releases', PREV),
    });
    assert.notEqual(r.status, 0);
    neverDown(r.calls);
    assert.ok(r.calls.some((c) => c.endsWith('stop backend')), r.calls.join('\n'));
    assert.match(lastLine(r.out), /CLICS's backend on vm1 is STOPPED, because b{40}, the release that was live, is not on this host any more/);
  } finally { cleanup(h); }
});

// The reported bug: an operator edits ALLOWED_ORIGINS while Anthropic's balance is exhausted and runs
// `deploy.sh --rollback CURRENT_SHA`. rimpl's /health/deep is 503, the token is fine. Gate 1 used to
// exit 2 before it asked the token, restore() read that as unsafe, and stopped a working API.
const indexes = (calls, pred) => calls.flatMap((c, i) => (pred(c) ? [i] : []));
test('restore: gate 1 exit 2 (token accepted, rimpl degraded) starts the live backend again and never stops it', () => {
  const h = host({ releases: [SHA], current: SHA });
  try {
    const r = remote(h, 'activate', 'rollback', {
      STUB_IMAGES: '1', STUB_GATE_RIMPL: '2', STUB_PS_BACKEND: 'c0ffee\n', STUB_BACKEND_ENV: `INTERNAL_TOKEN=${TOKEN}\n`,
    });
    assert.notEqual(r.status, 0, 'a degraded rimpl still fails the activation');
    const gates = indexes(r.calls, (c) => c.includes('node /gate.cjs rimpl'));
    assert.equal(gates.length, 2, `gated on the activation and again on the restore:\n${r.calls.join('\n')}`);
    const ups = indexes(r.calls, (c) => / compose .* up .* backend$/.test(c));
    assert.equal(ups.length, 1, `the backend is started once, by the restore:\n${r.calls.join('\n')}`);
    assert.ok(ups[0] > gates[1], 'after the restore\'s own gate 1');
    assert.ok(!r.calls.some((c) => / stop( |$)/.test(c)), `nothing is stopped:\n${r.calls.join('\n')}`);
    assert.ok(!r.calls.some((c) => c.includes('node /gate.cjs backend')), 'the activation itself stopped at gate 1');
    assert.deepEqual(serviceLessUp(r.calls), []);
    neverDown(r.calls);
    assert.match(lastLine(r.out), /gate 1 failed for a{40}: its rimpl accepted INTERNAL_TOKEN but is DEGRADED \(down: anthropic_serving=down, supabase=down\), .* a{40} restored; rimpl degraded: anthropic_serving=down, supabase=down\./);
    assert.ok(!/STOPPED/.test(r.out), r.out);
    assert.equal(current(h), `releases/${SHA}`);
    noTokenPrinted(r.out + r.calls.join('\n'));
  } finally { cleanup(h); }
});

test('activate: gate 1 exit 2 still refuses a deploy (current never moves onto a degraded rimpl); restore puts the live release back', () => {
  const h = host({ releases: [SHA, PREV], current: PREV });
  try {
    const r = remote(h, 'activate', 'deploy', { STUB_GATE_RIMPL: '2' });
    assert.notEqual(r.status, 0);
    const fromSha = r.calls.filter((c) => c.startsWith(`docker[${SHA}/deploy/vm1|${SHA}]`));
    assert.deepEqual(backendUp(fromSha), [], `the new release's backend never starts:\n${r.calls.join('\n')}`);
    const fromPrev = r.calls.filter((c) => c.startsWith(`docker[${PREV}/deploy/vm1|${PREV}]`));
    const idx = order(fromPrev, [`${UP} rimpl`, 'node /gate.cjs rimpl', `${UP} backend`]);
    assert.ok(idx.every((i) => i >= 0), `restored ${PREV}:\n${r.calls.join('\n')}`);
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'rimpl, then the gate, then the backend');
    assert.equal(current(h), `releases/${PREV}`);
    assert.ok(!existsSync(path.join(h.base, 'deploys.log')), 'no successful activation recorded');
    assert.match(lastLine(r.out), new RegExp(`${PREV} restored; rimpl degraded: anthropic_serving=down, supabase=down`));
  } finally { cleanup(h); }
});

test('restore: gate 1 exit 3 (INTERNAL_TOKEN refused) stops the backend and never starts it', () => {
  const h = host({ releases: [SHA], current: SHA });
  try {
    const r = remote(h, 'activate', 'rollback', {
      STUB_IMAGES: '1', STUB_GATE_RIMPL: '3', STUB_PS_BACKEND: 'c0ffee\n', STUB_BACKEND_ENV: `INTERNAL_TOKEN=${TOKEN}\n`,
    });
    assert.notEqual(r.status, 0);
    assert.deepEqual(backendUp(r.calls), [], `the backend is never brought up:\n${r.calls.join('\n')}`);
    assert.ok(r.calls.some((c) => c.endsWith('compose -p clics -f docker-compose.yml stop backend')), r.calls.join('\n'));
    neverDown(r.calls);
    assert.match(lastLine(r.out), /CLICS's backend on vm1 is STOPPED, because the rimpl of a{40} failed gate 1 \(exit 3: INTERNAL_TOKEN not proven\)/);
    assert.equal(current(h), `releases/${SHA}`);
  } finally { cleanup(h); }
});

test('activate and launch refuse while another deploy holds the lock, before touching compose or systemd', () => {
  const h = host({ releases: [SHA, PREV], current: PREV });
  try {
    const r = remote(h, 'activate', 'deploy', { STUB_FLOCK_BUSY: '1' });
    assert.notEqual(r.status, 0);
    assert.ok(r.calls.includes('flock -n 9'), r.calls.join('\n'));
    assert.match(lastLine(r.out), /another deploy is running on this host/);
    assert.deepEqual(r.calls.filter((c) => c.startsWith('docker')), [], `no docker call at all:\n${r.calls.join('\n')}`);
    assert.equal(current(h), `releases/${PREV}`);

    stage(h);
    const l = remote(h, 'launch', 'deploy', { STUB_FLOCK_BUSY: '1' }, { run: RUN });
    assert.notEqual(l.status, 0);
    assert.match(l.out, /another activation holds .*\.deploy\.lock.*Nothing was started/);
    assert.ok(!l.calls.some((c) => c.startsWith('systemd-run') || c.startsWith('docker')), l.calls.join('\n'));
    assert.ok(!existsSync(path.join(h.base, 'runs', RUN, 'log')), 'no run was created');
    assert.ok(!existsSync(path.join(h.base, 'runs', 'latest')));
  } finally { cleanup(h); }
});

// ---- preflight -------------------------------------------------------------------------------------
test('preflight passes on a well-formed host and refuses the things that must stop a deploy', () => {
  let h = host();
  try {
    const ok = remote(h, 'preflight');
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /reconcile sweep OFF/);
    assert.match(ok.out, /preflight ok/);
  } finally { cleanup(h); }

  const refusals = [
    [{ envMode: 0o644 }, {}, /must be mode 600/],
    [{}, { STUB_OWNER: 'root' }, /must be owned by clics/],
    [{ rimplExtra: 'TS_AUTHKEY=tskey-x\n' }, {}, /rimpl\.env sets TS_AUTHKEY/],
    [{ rimplExtra: 'LOCAL_AI_HTTP_PROXY=http://127.0.0.1:1055\n' }, {}, /rimpl\.env sets LOCAL_AI_HTTP_PROXY/],
    [{}, { STUB_SS: 'LISTEN 0 4096 127.0.0.1:3101 0.0.0.0:*\n' }, /in use by something that is not CLICS/],
    [{}, { STUB_PS: '/srv/other-team/compose\n' }, /already runs from \/srv\/other-team/],
    [{}, { STUB_ARCH: 'aarch64' }, /amd64/],
    [{}, { STUB_NO_CLICS: '1' }, /user clics does not exist/],
    [{ releases: [SHA], current: PREV }, {}, /current points at .* not a release on this host/],
  ];
  for (const [hostOpts, env, want] of refusals) {
    h = host(hostOpts);
    try {
      const r = remote(h, 'preflight', 'deploy', env);
      assert.notEqual(r.status, 0, `expected a refusal for ${want}`);
      assert.match(r.out, want);
      assert.ok(!r.out.includes('tskey-x'), 'never prints an env value');
    } finally { cleanup(h); }
  }

  h = host();
  try {
    writeFileSync(path.join(h.base, 'env', 'backend.env'), readFileSync(path.join(h.base, 'env', 'backend.env'), 'utf8').replace('SITE_URL=x', 'SITE_URL='));
    chmodSync(path.join(h.base, 'env', 'backend.env'), 0o600);
    const r = remote(h, 'preflight');
    assert.notEqual(r.status, 0);
    assert.match(r.out, /backend\.env: SITE_URL has no value/);
  } finally { cleanup(h); }

  h = host();
  try {
    const r = remote(h, 'preflight', 'rollback');
    assert.equal(r.status, 0, r.out); // the release exists in the fixture
    rmSync(path.join(h.base, 'releases', SHA), { recursive: true });
    const gone = remote(h, 'preflight', 'rollback');
    assert.notEqual(gone.status, 0);
    assert.match(gone.out, /is not on this host/);
  } finally { cleanup(h); }
});

test('preflight refuses mismatched or duplicated INTERNAL_TOKEN lines, and never prints a token', () => {
  const cases = [
    [{ backendToken: `INTERNAL_TOKEN=${TOKEN_B}` }, /INTERNAL_TOKEN differs between backend\.env and rimpl\.env/],
    [{ rimplToken: `INTERNAL_TOKEN=${TOKEN_R}` }, /INTERNAL_TOKEN differs/],
    [{ rimplToken: `INTERNAL_TOKEN='${TOKEN}'` }, /INTERNAL_TOKEN differs/], // same value, other quoting
    [{ rimplToken: `INTERNAL_TOKEN=${TOKEN} ` }, /INTERNAL_TOKEN differs/], // trailing space
    [{ backendExtra: `INTERNAL_TOKEN=${TOKEN_B}\n` }, /backend\.env assigns INTERNAL_TOKEN 2 times/],
    [{ rimplExtra: `INTERNAL_TOKEN=${TOKEN}\n` }, /rimpl\.env assigns INTERNAL_TOKEN 2 times/], // even equal
    [{ rimplExtra: `export INTERNAL_TOKEN=${TOKEN_R}\n` }, /rimpl\.env assigns INTERNAL_TOKEN 2 times/],
    // Indented: compose may still read it, so it is refused rather than compared.
    [{ backendToken: `  INTERNAL_TOKEN=${TOKEN}` }, /backend\.env: (INTERNAL_TOKEN has no value|write it as INTERNAL_TOKEN=value)/],
  ];
  for (const [opts, want] of cases) {
    const h = host(opts);
    try {
      const r = remote(h, 'preflight');
      assert.notEqual(r.status, 0, `expected a refusal for ${JSON.stringify(opts)}`);
      assert.match(r.out, want);
      // Neither the output nor any stubbed command line carries a token.
      noTokenPrinted(r.out + r.calls.join('\n'));
    } finally { cleanup(h); }
  }
});

test('preflight: RECONCILE_INTERVAL_MS must be an explicit 0 unless CLICS_CUTOVER_DONE=1', () => {
  const cases = [
    ['RECONCILE_INTERVAL_MS=0', '', false, /reconcile sweep OFF/],
    ['RECONCILE_INTERVAL_MS=', '', true, /must be unquoted digits .* A blank value is not 0/],
    ['RECONCILE_INTERVAL_MS=6h', '', true, /must be unquoted digits/],
    ["RECONCILE_INTERVAL_MS='0'", '', true, /must be unquoted digits/],
    [null, '', true, /turns vm1's reconcile sweep ON .* or missing/],
    ['RECONCILE_INTERVAL_MS=21600000', '', true, /turns vm1's reconcile sweep ON/],
    ['RECONCILE_INTERVAL_MS=21600000', 'CLICS_CUTOVER_DONE=yes\n', true, /turns vm1's reconcile sweep ON/],
    ['RECONCILE_INTERVAL_MS=21600000', 'CLICS_CUTOVER_DONE=1\n', false, /reconcile sweep ON on vm1 \(CLICS_CUTOVER_DONE=1/],
    [null, 'CLICS_CUTOVER_DONE=1\n', false, /reconcile sweep ON on vm1/],
    ['RECONCILE_INTERVAL_MS=0', 'RECONCILE_INTERVAL_MS=21600000\n', true, /assigns RECONCILE_INTERVAL_MS 2 times/],
  ];
  for (const [reconcile, backendExtra, refused, want] of cases) {
    const h = host({ reconcile, backendExtra });
    try {
      const r = remote(h, 'preflight');
      assert.equal(r.status !== 0, refused, `${reconcile} + ${JSON.stringify(backendExtra)}: ${r.out}`);
      assert.match(r.out, want);
    } finally { cleanup(h); }
  }
});

// ---- launch / attach: the detached activation --------------------------------------------------------
function stage(h, script = stepScript('activate'), run = RUN) {
  mkdirSync(path.join(h.base, 'runs', run), { recursive: true });
  writeFileSync(path.join(h.base, 'runs', run, 'activate.sh'), script);
}
function waitFor(cond, ms = 30000) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const poll = () => (cond() ? resolve() : Date.now() > end ? reject(new Error('timed out')) : setTimeout(poll, 100));
    poll();
  });
}
const statusOf = (h) => readFileSync(path.join(h.base, 'runs', RUN, 'status'), 'utf8').trim();

test('launch: starts activate as a detached unit, follows its log, and returns its exit code', () => {
  const h = host();
  try {
    stage(h);
    const r = remote(h, 'launch', 'deploy', {}, { run: RUN });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.calls.some((c) => c === `systemd-run unit=clics-activate-${RUN} /bin/bash ${h.base}/runs/${RUN}/activate.sh ${h.base} clics 3101 ${SHA} deploy ${RUN}`),
      r.calls.join('\n'));
    assert.match(r.out, /started detached, as systemd unit clics-activate-/);
    assert.match(r.out, new RegExp(`active: ${SHA} \\(deploy\\)`), 'the activation log came through');
    assert.match(lastLine(r.out), /activation .* succeeded/);
    assert.equal(statusOf(h), '0');
    assert.equal(readlinkSync(path.join(h.base, 'runs', 'latest')), RUN);
    assert.equal(current(h), `releases/${SHA}`);

    const again = remote(h, 'launch', 'deploy', {}, { run: RUN });
    assert.notEqual(again.status, 0, 'a run is launched once');
    assert.match(again.out, /launched already; follow it with deploy\.sh --attach/);
  } finally { cleanup(h); }
});

test('launch: a failing activation reports its own last line and exit code', () => {
  const h = host();
  try {
    stage(h);
    const r = remote(h, 'launch', 'deploy', { STUB_FAIL: 'node /gate.cjs rimpl' }, { run: RUN });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /before its backend was started\. no release was live/);
    assert.match(lastLine(r.out), /FAILED \(exit 1\)/);
    assert.equal(statusOf(h), '1');
  } finally { cleanup(h); }
});

test('launch: losing the follower (the SSH session) does not stop the activation, and attach picks it up', async () => {
  const h = host({ releases: [SHA, PREV], current: PREV });
  try {
    stage(h);
    const env = stepEnv(h, { STUB_SLOW: 'node /gate.cjs backend', STUB_SLOW_S: '3', STUB_SS: 'LISTEN 0 4096 127.0.0.1:3101 0.0.0.0:*\n' });
    const child = spawn('bash', ['-s', '--', h.base, 'clics', '3101', SHA, 'deploy', RUN], { env, detached: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const closed = new Promise((resolve) => child.on('close', resolve));
    child.stdin.end(stepScript('launch'));
    await waitFor(() => out.includes('gate 2:'));
    process.kill(-child.pid, 'SIGKILL'); // the whole SSH-side process group goes, as when the session drops
    await closed;
    assert.ok(!existsSync(path.join(h.base, 'runs', RUN, 'status')), 'the follower died before the activation finished');

    await waitFor(() => existsSync(path.join(h.base, 'runs', RUN, 'status')));
    assert.equal(statusOf(h), '0');
    assert.equal(current(h), `releases/${SHA}`, 'the activation finished on its own');

    const a = remote(h, 'attach', 'attach', {}, { sha: '-', run: '-' });
    assert.equal(a.status, 0, a.out);
    assert.match(a.out, new RegExp(`following activation ${RUN}`));
    assert.match(a.out, /activation .*: deploy a{40}, started/, 'from the first line');
    assert.match(a.out, new RegExp(`active: ${SHA} \\(deploy\\)`));
    assert.match(lastLine(a.out), /succeeded/);
  } finally { cleanup(h); }
});

// `systemctl stop clics-activate-<run>`, or a host shutting down: systemd signals every process in the
// unit. bash ran the EXIT trap with $? = 0 (the last log line), so the run recorded success. It must
// record a failure, say "interrupted by signal", and not restore (systemd would cut a restore short).
for (const [sig, code] of [['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`launch: an activation stopped by ${sig} mid-run records exit ${code}, never success, and does not restore`, async () => {
    const h = host({ releases: [SHA, PREV], current: PREV });
    try {
      stage(h);
      const env = stepEnv(h, { STUB_SLOW: `${UP} rimpl`, STUB_SLOW_S: '30' });
      const child = spawn('bash', ['-s', '--', h.base, 'clics', '3101', SHA, 'deploy', RUN], { env });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const closed = new Promise((resolve) => child.on('close', resolve));
      child.stdin.end(stepScript('launch'));
      await waitFor(() => readCalls(h).some((c) => c.endsWith(`${UP} rimpl`)));
      const pid = Number(readFileSync(path.join(h.units, `clics-activate-${RUN}.pid`), 'utf8'));
      process.kill(-pid, sig); // the unit's whole process group, the slow `docker compose up` included
      assert.equal(await closed, code, `the follower exits with the run's code:\n${out}`);

      const [rc, why] = readFileSync(path.join(h.base, 'runs', RUN, 'status'), 'utf8').trim().split('\n');
      assert.equal(rc, String(code));
      assert.equal(why, `interrupted by signal ${sig.slice(3)}`);
      assert.match(lastLine(out), new RegExp(`activation ${RUN} FAILED \\(exit ${code}, interrupted by signal ${sig.slice(3)}\\)`));
      const log = readFileSync(path.join(h.base, 'runs', RUN, 'log'), 'utf8');
      assert.match(log, /was interrupted by signal [A-Z]+ .* restore\(\) was NOT attempted\. .*current -> releases\/b{40}\./);
      assert.ok(!/restoring|succeeded|active: /.test(log), `no restore, no success:\n${log}`);
      const calls = readCalls(h);
      const upRimpl = calls.findIndex((c) => c.endsWith(`${UP} rimpl`));
      assert.deepEqual(calls.slice(upRimpl + 1).filter((c) => c.startsWith('docker')), [], `nothing ran after the signal:\n${calls.join('\n')}`);
      assert.equal(current(h), `releases/${PREV}`);

      const a = remote(h, 'attach', 'attach', {}, { sha: '-', run: '-' });
      assert.equal(a.status, code, a.out);
      assert.match(lastLine(a.out), /FAILED \(exit \d+, interrupted by signal/);
    } finally { cleanup(h); }
  });
}

test('launch: an activation that ends with 0 before its last step is recorded as a failure', () => {
  const h = host();
  try {
    const script = stepScript('activate').replace('log "starting rimpl"\n', 'exit 0\n');
    assert.notEqual(script, stepScript('activate'), 'the early exit was injected');
    stage(h, script);
    const r = remote(h, 'launch', 'deploy', {}, { run: RUN });
    assert.equal(r.status, 1, r.out);
    assert.equal(statusOf(h), '1');
    assert.match(r.out, /ended before its last step without reporting an error/);
    assert.match(lastLine(r.out), /FAILED \(exit 1\)/);
    assert.equal(current(h), null);
  } finally { cleanup(h); }
});

test('follow: an activation that dies without a status is reported, not waited on forever', () => {
  const h = host();
  try {
    stage(h, 'echo "[vm1] about to be killed" >> "$1/runs/$6/log"; kill -9 $$\n');
    const r = remote(h, 'launch', 'deploy', {}, { run: RUN });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /about to be killed/);
    assert.match(r.out, /is no longer running and wrote no status/);
  } finally { cleanup(h); }
});

test('launch and attach refuse when there is nothing to start or follow', () => {
  const h = host();
  try {
    let r = remote(h, 'launch', 'deploy', {}, { run: RUN });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /was not staged/);
    assert.ok(!r.calls.some((c) => c.startsWith('systemd-run')));
    r = remote(h, 'attach', 'attach', {}, { sha: '-', run: '-' });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /no activation has been launched on this host/);
    stage(h);
    symlinkSync('an-older-run', path.join(h.base, 'runs', 'latest'));
    r = remote(h, 'launch', 'deploy', { STUB_SYSTEMD_RUN_FAIL: '1' }, { run: RUN });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /systemd-run could not start clics-activate-.*; nothing was started/);
    assert.equal(readlinkSync(path.join(h.base, 'runs', 'latest')), 'an-older-run', '--attach never follows a run that did not start');
  } finally { cleanup(h); }
});
