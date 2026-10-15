// scripts/manifest/build.mjs and the canonical form it writes (CCME R2). Package-free, like the CI job
// that runs it: nothing here may need `npm install`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from './build.mjs';

const require = createRequire(import.meta.url);
const M = require('../../rimpl/src/lib/manifest.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, 'build.mjs');

// The CI invocation: a scrubbed env, so nothing the runner happens to export can reach the output.
const run = (args, env = {}) => spawnSync(process.execPath, [BUILD, ...args], {
  encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, ...env },
});
const scratch = () => mkdtempSync(path.join(tmpdir(), 'clics-manifest-'));

test('canonical JSON: sorted keys at every depth, arrays in order, LF, one trailing newline', () => {
  const text = M.canonicalJson({ z: [3, 1, 2], a: { y: true, b: null } });
  assert.equal(text, '{\n  "a": {\n    "b": null,\n    "y": true\n  },\n  "z": [\n    3,\n    1,\n    2\n  ]\n}\n');
  assert.equal(M.canonicalJson({ a: { b: null, y: true }, z: [3, 1, 2] }), text);
  assert.ok(!text.includes('\r'));
  assert.throws(() => M.canonicalJson({ a: undefined }), /\$\.a/);
  assert.throws(() => M.canonicalJson({ a: Number.NaN }), /finite/);
});

test('the sha256 excludes itself: strip it, canonicalise, hash — and you get it back', () => {
  const committed = JSON.parse(readFileSync(M.MANIFEST_FILE, 'utf8'));
  const { sha256, ...body } = committed;
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(M.sha256(M.canonicalJson(body)), sha256);
  assert.equal(M.manifestSha256(committed), sha256);
});

test('--check passes on the committed file, in a scrubbed env (the CI invocation)', () => {
  const r = run(['--check']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is current \(sha256 [0-9a-f]{64}\)/);
});

test('the output depends on the code only: every override set, the same bytes', () => {
  const r = run(['--check'], {
    RIMPL_CHAT_MAX_TOKENS: '6000', RIMPL_CHAT_DEEP_MAX_TOKENS: '16000', RIMPL_DISCUSS_MAX_TOKENS: '2000', SHADOW_EVAL_MAX_TOKENS: '8000',
    EVAL_CONSISTENCY: 'median3', EVAL_JSON_RETRIES: '5', SHADOW_EVAL_CONSISTENCY: 'adaptive', LOCAL_AI_NUM_CTX: '32768',
    LOCAL_AI_THINKING_STYLE: 'ollama', AI_PROVIDER: 'local', LOCAL_AI_MODEL: 'something-else', TZ: 'Asia/Bangkok',
  });
  assert.equal(r.status, 0, r.stderr);
});

test('--check fails, and says where, on a file that is behind the code', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'model-manifest.json');
    const m = JSON.parse(readFileSync(M.MANIFEST_FILE, 'utf8'));
    m.expected.code.decoding.evaluate.temperature = 0.7;
    m.sha256 = M.manifestSha256(m);                  // even a self-consistent edit is not what the code says
    writeFileSync(file, M.canonicalJson(m));
    const r = run(['--check', '--out', file]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is NOT what the code generates/);
    assert.match(r.stderr, /first difference at line \d+/);
    assert.match(r.stderr, /0\.7/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--check fails on a missing file, and on a re-ordered (non-canonical) one', () => {
  const dir = scratch();
  try {
    const missing = run(['--check', '--out', path.join(dir, 'nope.json')]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /is missing/);
    const compact = path.join(dir, 'compact.json');
    writeFileSync(compact, `${JSON.stringify(JSON.parse(readFileSync(M.MANIFEST_FILE, 'utf8')))}\n`);
    assert.equal(run(['--check', '--out', compact]).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('write mode reproduces the committed bytes, and a declared address is refused before anything is written', () => {
  const dir = scratch();
  try {
    const out = path.join(dir, 'model-manifest.json');
    const w = run(['--out', out]);
    assert.equal(w.status, 0, w.stderr);
    assert.equal(readFileSync(out, 'utf8'), readFileSync(M.MANIFEST_FILE, 'utf8'));

    const declared = path.join(dir, 'declared.json');
    const d = JSON.parse(readFileSync(M.DECLARED_FILE, 'utf8'));
    d.local.source = 'measured at http://100.64.12.34:8888/v1';
    writeFileSync(declared, JSON.stringify(d));
    copyFileSync(M.MANIFEST_FILE, path.join(dir, 'untouched.json'));
    const r = run(['--declared', declared, '--out', path.join(dir, 'untouched.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /declared\.local\.source: looks like an address/);
    assert.equal(readFileSync(path.join(dir, 'untouched.json'), 'utf8'), readFileSync(M.MANIFEST_FILE, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generate() is what --check compares against, and carries no timestamp, node version or env value', () => {
  const { text, manifest } = generate();
  assert.equal(text, readFileSync(M.MANIFEST_FILE, 'utf8'));
  assert.ok(!text.includes(process.version), 'node version');
  assert.doesNotMatch(text, /20\d\d-\d\d-\d\dT\d\d:\d\d/, 'an ISO timestamp');
  assert.equal(manifest.schema, 'clics-model-manifest/v1');
  assert.deepEqual(Object.keys(manifest.expected).sort(), ['code', 'declared']);
});

test('loads without a single package — the CI job has no npm install', () => {
  const closure = (file, seen = new Set()) => {
    if (!seen.has(file)) {
      seen.add(file);
      for (const child of require.cache[file]?.children ?? []) closure(child.filename, seen);
    }
    return seen;
  };
  const deps = [...closure(require.resolve('../../rimpl/src/lib/manifest.js'))];
  assert.ok(deps.length > 5);
  assert.deepEqual(deps.filter((f) => f.includes(`${path.sep}node_modules${path.sep}`)), []);
});
