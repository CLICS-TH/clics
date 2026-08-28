#!/usr/bin/env node
// Adversarial audit sandbox: attack every guard and demand a test notice.
//
// A green suite proves the tests pass. It does not prove they would fail if the thing they guard
// were removed — and this repo has now shipped three defects that a green suite watched go by. So
// this runs the other direction: break the protection on purpose, one at a time, and record whether
// anything went red.
//
//   KILLED    the suite caught it. The guard is real.
//   SURVIVED  the suite stayed green with the protection gone. A FINDING.
//   STALE     the mutation no longer matches the source. The table is out of date, which is also a
//             finding — a mutation nobody can apply is a guard nobody is checking.
//
// SAFETY. Every edit is reverted in a finally block, and the run refuses to start against a file
// with uncommitted changes, so a crash can never leave a mutation behind. The tree is verified
// clean again before exit; if it is not, that is reported loudly rather than left for `git status`.
//
// Usage:
//   node scripts/audit-sandbox/run.mjs                 # everything
//   node scripts/audit-sandbox/run.mjs rescue privacy  # only ids containing these substrings
//   node scripts/audit-sandbox/run.mjs --list

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MUTATIONS } from './mutations.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const LIST_ONLY = args.includes('--list');
const filters = args.filter((a) => !a.startsWith('--'));
const selected = filters.length
  ? MUTATIONS.filter((m) => filters.some((f) => m.id.includes(f)))
  : MUTATIONS;

const C = { reset: '[0m', red: '[31m', green: '[32m', yellow: '[33m', dim: '[2m', bold: '[1m' };

if (LIST_ONLY) {
  for (const m of selected) console.log(`${m.id}\n  ${C.dim}${m.why}${C.reset}`);
  process.exit(0);
}
if (!selected.length) {
  console.error(`No mutation matches ${filters.join(', ')}. Try --list.`);
  process.exit(2);
}

// --- the tree must be clean where we are about to write -------------------------------------
const targets = [...new Set(selected.map((m) => m.file))];
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...targets], { cwd: REPO, encoding: 'utf8' }).trim();
if (dirty) {
  console.error(`${C.red}Refusing to run: uncommitted changes in a file this run will edit.${C.reset}\n${dirty}\n`);
  console.error('Commit or stash first — otherwise a crash mid-run is indistinguishable from your own edit.');
  process.exit(2);
}

function runSuite({ dir, suite }) {
  const r = spawnSync('npx', ['jest', suite, '--silent'], {
    cwd: path.join(REPO, dir), encoding: 'utf8', env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
  });
  return r.status ?? 1;
}

console.log(`${C.bold}Adversarial audit sandbox${C.reset} — ${selected.length} mutation(s)\n`);

const results = [];
for (const m of selected) {
  const abs = path.join(REPO, m.file);
  const original = readFileSync(abs, 'utf8');
  const hits = original.split(m.find).length - 1;

  // A mutation that matches zero times, or several, is not testing what it says it is.
  if (hits !== 1) {
    console.log(`${C.yellow}STALE   ${C.reset}${m.id}  ${C.dim}(pattern matched ${hits}×, expected 1)${C.reset}`);
    results.push({ ...m, verdict: 'STALE', detail: `pattern matched ${hits}×` });
    continue;
  }

  let verdict;
  try {
    writeFileSync(abs, original.replace(m.find, m.replace));
    const code = runSuite(m);
    verdict = code === 0 ? 'SURVIVED' : 'KILLED';
  } finally {
    writeFileSync(abs, original);           // always, including on throw
  }

  const mark = verdict === 'KILLED' ? `${C.green}KILLED  ${C.reset}` : `${C.red}SURVIVED${C.reset}`;
  console.log(`${mark}${m.id}  ${C.dim}${m.dir}/${m.suite}${C.reset}`);
  if (verdict === 'SURVIVED') console.log(`         ${C.red}${m.why}${C.reset}`);
  results.push({ ...m, verdict });
}

// --- prove we put everything back -------------------------------------------------------------
const after = execFileSync('git', ['status', '--porcelain', '--', ...targets], { cwd: REPO, encoding: 'utf8' }).trim();
if (after) {
  console.error(`\n${C.red}The tree was NOT restored. Run \`git checkout --\` on:${C.reset}\n${after}`);
  process.exit(3);
}

const survived = results.filter((r) => r.verdict === 'SURVIVED');
const stale = results.filter((r) => r.verdict === 'STALE');
const killed = results.length - survived.length - stale.length;

console.log(`\n${killed} killed · ${survived.length} survived · ${stale.length} stale · tree restored clean`);

if (survived.length) {
  console.log(`\n${C.red}${C.bold}Unguarded:${C.reset}`);
  for (const r of survived) console.log(`  ${r.file}\n    ${r.why}`);
}
if (stale.length) {
  console.log(`\n${C.yellow}${C.bold}Mutations that no longer apply — the table has drifted from the source:${C.reset}`);
  for (const r of stale) console.log(`  ${r.id}  (${r.detail})`);
}

process.exit(survived.length || stale.length ? 1 : 0);
