// Which Claude model the probes' cloud arm compares against (model-agreement.mjs, repeat-consistency.mjs).
//
// Until 2026-10-15 both regex-scraped the first `claude-*` string out of rimpl/src/services/providers/
// anthropic.js — which, once the pinned id moved to lib/provider-policy.js, a COMMENT in that file still
// satisfied. They now import lib/provider-policy.js ANTHROPIC_MODEL through ./lib.mjs. These tests hold
// that: the value is the policy constant, a bump of the constant is what the probes see, and nothing is
// scraped from the provider's text any more. Package-free and hermetic, like the rest of this job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PRODUCTION_CLOUD_MODEL } from './lib.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = require.resolve('../../rimpl/src/lib/provider-policy.js');
const ANTHROPIC = require.resolve('../../rimpl/src/services/providers/anthropic.js');

test('the probes\' cloud model IS lib/provider-policy.js ANTHROPIC_MODEL', () => {
  assert.equal(PRODUCTION_CLOUD_MODEL, require(POLICY).ANTHROPIC_MODEL);
  assert.match(PRODUCTION_CLOUD_MODEL, /^claude-[a-z0-9.-]+$/);
});

test('a model bump in provider-policy.js is what the probes see (the policy module stubbed in a child process)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'probe-model-'));
  try {
    const stub = path.join(dir, 'bump.cjs');
    writeFileSync(stub, [
      "const Module = require('node:module');",
      `const file = ${JSON.stringify(POLICY)};`,
      'const m = new Module(file); m.filename = file; m.loaded = true;',
      "m.exports = { ANTHROPIC_MODEL: 'claude-bumped-test-9-9' };",
      'require.cache[file] = m;',
    ].join('\n'));
    const lib = pathToFileURL(path.join(HERE, 'lib.mjs')).href;
    const r = spawnSync(process.execPath, ['--require', stub, '--input-type=module', '-e',
      `const m = await import(${JSON.stringify(lib)}); process.stdout.write(m.PRODUCTION_CLOUD_MODEL);`],
    { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'claude-bumped-test-9-9');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('both probe scripts take it from lib.mjs, and neither scrapes providers/anthropic.js any more', () => {
  for (const f of ['model-agreement.mjs', 'repeat-consistency.mjs']) {
    const src = readFileSync(path.join(HERE, f), 'utf8');
    assert.ok(src.includes('const CLOUD_MODEL = process.env.CLOUD_MODEL || PRODUCTION_CLOUD_MODEL;'), `${f}: CLOUD_MODEL is not the imported constant`);
    assert.ok(!src.includes("'src/services/providers/anthropic.js'"), `${f}: still builds the path to providers/anthropic.js`);
    assert.doesNotMatch(src, /readFileSync\(/, `${f}: still reads a file synchronously (the old scrape)`);
    assert.doesNotMatch(src, /claude-\[a-z0-9/, `${f}: still regex-scrapes a claude-* id`);
  }
});

test('providers/anthropic.js holds no model id to scrape — its MODEL is the policy constant', () => {
  const src = readFileSync(ANTHROPIC, 'utf8');
  assert.doesNotMatch(src, /claude-[a-z0-9]/, 'a claude-* literal is back in providers/anthropic.js');
  assert.ok(src.includes('const MODEL = ANTHROPIC_MODEL;'));
});
