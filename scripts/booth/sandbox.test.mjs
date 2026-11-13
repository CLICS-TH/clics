// sandbox.mjs judges one step count per run (#380): three-step and five-step composites sit on different scales, so
// pooling them fails both. The rule is tested package-free; the script runs (without --go, so nothing is spent) only
// where backend's packages are installed, since loading a case needs zod. CI's booth-scripts step installs none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepCountProblem } from './sandbox-verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = path.join(HERE, 'sandbox.mjs');
const FIXTURES = path.join(HERE, '..', '..', 'backend', 'tests', 'fixtures');
const NO_PACKAGES = !existsSync(path.join(HERE, '..', '..', 'backend', 'node_modules', 'zod'))
  && 'backend packages not installed (the script loads cases with zod)';
const THREE = 'booth-case-tree.json';
const FIVE = 'booth-case-tree-5.json';

const caseDir = (...files) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sandbox-test-'));
  for (const f of files) copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  return dir;
};
const run = (...args) => spawnSync(process.execPath, [SANDBOX, '--persona-runs', '0', ...args], { encoding: 'utf8', env: {} });
// A complete earlier run's report, pooled from three cases per scripted group.
const report = (extra) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sandbox-pool-')), 'report.json');
  const groups = { best: 0, mixed: 0, weakest: 0 };
  writeFileSync(file, JSON.stringify({ planned: 9, scored: 9, stopped: false, over_cap: false, ...extra,
    verdict: { gap_min: 1, medians: { best: 48, mixed: 42, weakest: 35 }, pool_n: Object.fromEntries(Object.keys(groups).map((g) => [g, 3])) } }));
  return file;
};

test('stepCountProblem: one step count passes, a mix is refused', () => {
  assert.equal(stepCountProblem([3, 3]), null);
  assert.equal(stepCountProblem([5]), null);
  assert.match(stepCountProblem([5, 3, 5]), /3 and 5 steps/);
});

test('stepCountProblem: a --pool report must have played the same step count; one without steps is three-step', () => {
  assert.equal(stepCountProblem([5], { steps: 5 }), null);
  assert.match(stepCountProblem([5], { steps: 3 }), /played 3-step cases and these have 5/);
  assert.match(stepCountProblem([5], {}), /played 3-step cases/);
  assert.equal(stepCountProblem([3], {}), null);
});

test('one step count plans the run', { skip: NO_PACKAGES }, () => {
  for (const f of [THREE, FIVE]) {
    const r = run('--cases', caseDir(f));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Nothing spent/);
  }
});

test('a run that mixes three-step and five-step cases is refused', { skip: NO_PACKAGES }, () => {
  const r = run('--cases', caseDir(THREE, FIVE));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /3 and 5 steps/);
});

test('--pool from another step count is refused', { skip: NO_PACKAGES }, () => {
  const r = run('--cases', caseDir(FIVE), '--pool', report({ steps: 3 }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /played 3-step cases and these have 5/);
});

test('--pool from a report without steps counts as three-step', { skip: NO_PACKAGES }, () => {
  assert.equal(run('--cases', caseDir(FIVE), '--pool', report()).status, 2);
  assert.equal(run('--cases', caseDir(THREE), '--pool', report()).status, 0);
});

test('--pool from the same step count is accepted', { skip: NO_PACKAGES }, () => {
  const r = run('--cases', caseDir(FIVE), '--pool', report({ steps: 5 }));
  assert.equal(r.status, 0, r.stderr);
});
