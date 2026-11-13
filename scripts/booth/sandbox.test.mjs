// sandbox.mjs judges one step count per run (#380): three-step and five-step composites sit on different scales, so
// pooling them fails both. These run the script without --go, so nothing is spent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = path.join(HERE, 'sandbox.mjs');
const FIXTURES = path.join(HERE, '..', '..', 'backend', 'tests', 'fixtures');
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

test('one step count plans the run', () => {
  for (const f of [THREE, FIVE]) {
    const r = run('--cases', caseDir(f));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Nothing spent/);
  }
});

test('a run that mixes three-step and five-step cases is refused', () => {
  const r = run('--cases', caseDir(THREE, FIVE));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /3 and 5 steps/);
});

test('--pool from another step count is refused', () => {
  const r = run('--cases', caseDir(FIVE), '--pool', report({ steps: 3 }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /played 3-step cases and these have 5/);
});

test('--pool from a report without steps counts as three-step', () => {
  assert.equal(run('--cases', caseDir(FIVE), '--pool', report()).status, 2);
  assert.equal(run('--cases', caseDir(THREE), '--pool', report()).status, 0);
});

test('--pool from the same step count is accepted', () => {
  const r = run('--cases', caseDir(FIVE), '--pool', report({ steps: 5 }));
  assert.equal(r.status, 0, r.stderr);
});
