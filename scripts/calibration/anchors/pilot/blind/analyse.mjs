#!/usr/bin/env node
// Pilot analysis: local evaluator vs designed targets vs two blind AI raters (2026-10-02).
//
//   node scripts/calibration/anchors/pilot/blind/analyse.mjs
//
// Inputs, all committed beside this file or in the anchor directory:
//   KEY-do-not-share.json   shuffled label (B01..B20) → anchor id. It only maps labels; it was withheld
//                           from the raters while they scored, which is what made them blind.
//   rater-a.json, rater-b.json   the two blind ratings (same model, same rubric.txt + episodes.txt packet)
//   ../../design.json       designed targets
//   ../../runs/pilot-local-strict-2026-10-02.json   the local evaluator run (3 runs per anchor)
// The local score per anchor here is the MEAN of its runs' composites (known-groups.mjs uses the
// per-domain median; the two differ by at most a few points on this run).
//
// Estimator: backend icc.js iccTwoRater, ICC(A,1) with the McGraw–Wong F-based 95% CI, through
// scripts/probe/agreement-stats.mjs. Package-free; no network.
//
// Evidence level: screening-synthetic (AI-authored, AI-scored) — not a decisive gate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compositeOf, iccTwoRater, DOMAINS } from '../../../../probe/agreement-stats.mjs';

const S = path.dirname(fileURLToPath(import.meta.url));
const R = path.resolve(S, '../..');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const key = read(path.join(S, 'KEY-do-not-share.json'));
const A = read(path.join(S, 'rater-a.json')).scores;
const B = read(path.join(S, 'rater-b.json')).scores;
const design = read(path.join(R, 'design.json')).anchors.filter((a) => a.pilot);
const run = read(path.join(R, 'runs/pilot-local-strict-2026-10-02.json')).rows.filter((r) => r.scores);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const rows = [];
for (const [b, id] of Object.entries(key)) {
  const d = design.find((x) => x.id === id);
  const mine = run.filter((r) => r.id === id);
  rows.push({
    id, target: compositeOf(d.targets), local: mean(mine.map((r) => compositeOf(r.scores))),
    a: compositeOf(A[b]), b: compositeOf(B[b]), t: d.targets, A: A[b], B: B[b],
    L: Object.fromEntries(DOMAINS.map((k) => [k, mean(mine.map((r) => r.scores[k]))])),
  });
}
rows.sort((x, y) => x.target - y.target);
const f = (v) => v.toFixed(0).padStart(4);
console.log('evidence level: screening-synthetic (AI-authored, AI-scored) — not a decisive gate\n');
console.log('id        target local  raterA raterB  (A+B)/2');
for (const r of rows) console.log(r.id.padEnd(9), f(r.target), f(r.local), f(r.a), f(r.b), f((r.a + r.b) / 2));

const icc = (x, y) => {
  const o = iccTwoRater(rows.map((r) => ({ a: x(r), b: y(r) })));
  return `${o.icc.toFixed(3)} [${o.lower?.toFixed(3)}, ${o.upper?.toFixed(3)}]`;
};
const bias = (x, y) => mean(rows.map((r) => x(r) - y(r))).toFixed(1);
const pairs = [
  ['raterA', 'target', (r) => r.a, (r) => r.target],
  ['raterB', 'target', (r) => r.b, (r) => r.target],
  ['A vs B', '', (r) => r.a, (r) => r.b],
  ['local', 'target', (r) => r.local, (r) => r.target],
  ['local', 'raterA', (r) => r.local, (r) => r.a],
  ['local', 'raterB', (r) => r.local, (r) => r.b],
  ['local', 'mean(A,B)', (r) => r.local, (r) => (r.a + r.b) / 2],
  ['mean(A,B)', 'target', (r) => (r.a + r.b) / 2, (r) => r.target],
];
console.log('\ncomposite ICC(A,1) [95% CI]   bias(first−second)');
for (const [n1, n2, x, y] of pairs) console.log(`${(n1 + ' vs ' + n2).padEnd(24)} ${icc(x, y)}  ${bias(x, y)}`);

// The seven anchors the local run flagged under the pre-registered §7 rule (|local − target| > 15).
const flagged = rows.filter((r) => Math.abs(r.local - r.target) > 15).map((r) => r.id);
const sub = rows.filter((r) => flagged.includes(r.id));
console.log(`\nlocal-flagged (${flagged.length}): ${flagged.join(' ')}`);
console.log('  mean target', mean(sub.map((r) => r.target)).toFixed(1), ' local', mean(sub.map((r) => r.local)).toFixed(1),
  ' raterA', mean(sub.map((r) => r.a)).toFixed(1), ' raterB', mean(sub.map((r) => r.b)).toFixed(1));

// The blind-panel rewrite rule (AUTHORING.md amendment of 2026-10-02): |mean blind − target| > 15.
const blindOver = rows.filter((r) => Math.abs((r.a + r.b) / 2 - r.target) > 15);
console.log(`\nblind mean beyond ±15 of target (${blindOver.length}): `
  + blindOver.map((r) => `${r.id} (${((r.a + r.b) / 2 - r.target) >= 0 ? '+' : ''}${((r.a + r.b) / 2 - r.target).toFixed(0)})`).join(' '));

console.log('\ndomain ICC(A,1): blind mean(A,B) vs target | local vs target | local vs mean(A,B)   A−B bias');
for (const k of DOMAINS) {
  const ic = (x, y) => {
    const o = iccTwoRater(rows.map((r) => ({ a: x(r), b: y(r) })));
    return (o.icc == null ? '—' : o.icc.toFixed(2)).padStart(6);
  };
  console.log(k, ic((r) => (r.A[k] + r.B[k]) / 2, (r) => r.t[k]), ic((r) => r.L[k], (r) => r.t[k]),
    ic((r) => r.L[k], (r) => (r.A[k] + r.B[k]) / 2), '  ', mean(rows.map((r) => r.A[k] - r.B[k])).toFixed(2));
}
