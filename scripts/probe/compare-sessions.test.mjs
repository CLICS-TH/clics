// compare-sessions.mjs scores each session's row with production's WEIGHTED composite. Until 2026-10
// it printed the unweighted d1..d7 sum there, a 0–35 number production never computes. The script
// runs here as the CLI it is, on two synthetic reports (seven integers per row, made-up ids, no
// transcript), so a revert to the sum fails. Run with:
//   node --test scripts/probe/*.test.mjs
// It needs no packages: CI's probe job runs on a bare checkout with no npm install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./compare-sessions.mjs', import.meta.url));
const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const S = (...v) => Object.fromEntries(DOMAINS.map((d, i) => [d, v[i]]));

// One agreement-shaped report per session ({rows:[{id, local}]}), then the CLI's stdout.
function compare(sessions) {
  const dir = mkdtempSync(path.join(tmpdir(), 'compare-sessions-'));
  try {
    const args = Object.entries(sessions).map(([label, rows]) => {
      const file = path.join(dir, `${label}.json`);
      writeFileSync(file, JSON.stringify({ rows }));
      return `${label}=${file}`;
    });
    return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('each row carries the weighted composite, and the pairwise line its change', () => {
  // X leans on d2 (0.20), Y on d6/d7 (0.10 each). Summed, Y is the higher (19 → 22). Production credits
  // X the higher (60 → 58), so a sum in this column would point the wrong way.
  const out = compare({
    s1: [{ id: 'fx-1', local: S(3, 5, 3, 3, 3, 1, 1), cloud: null }],
    s2: [{ id: 'fx-1', local: S(3, 1, 3, 3, 3, 4, 5), cloud: null }],
  });
  assert.match(out, /s1 +\[3,5,3,3,3,1,1\] +w-comp +60 /);
  assert.match(out, /s2 +\[3,1,3,3,3,4,5\] +w-comp +58 /);
  assert.match(out, /w-comp Δ -2$/m);
  assert.match(out, /Σ\|Δ\| 11 /, 'Σ|Δ| stays the unweighted per-domain count');
  assert.doesNotMatch(out, /Σ (19|22)\b/, 'the unweighted sum must not come back as the row score');
});

test('a uniform +1 shift moves the weighted composite by exactly 20', () => {
  const out = compare({
    a: [{ id: 'fx-2', local: S(3, 3, 3, 3, 3, 3, 3) }],
    b: [{ id: 'fx-2', local: S(4, 4, 4, 4, 4, 4, 4) }],
  });
  assert.match(out, /UNIFORM SHIFT \+1 on all 7 domains/);
  assert.match(out, /Σ\|Δ\| 7 +w-comp Δ \+20$/m);
});

test('a row missing a domain shows a dash for its composite, never NaN', () => {
  const out = compare({
    a: [{ id: 'fx-3', local: { ...S(3, 3, 3, 3, 3, 3, 3), d7: null } }],
    b: [{ id: 'fx-3', local: S(3, 3, 3, 3, 3, 3, 3) }],
  });
  assert.match(out, /a +\[3,3,3,3,3,3,null\] +w-comp +— /);
  assert.match(out, /w-comp Δ —$/m);
  assert.doesNotMatch(out, /w-comp[^\n]*NaN/);
});
