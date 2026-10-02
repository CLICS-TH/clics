#!/usr/bin/env node
// Round-2 blind panel on the pilot AFTER the rewrites (2026-10-02): Sonnet + Opus, new shuffle E01–E20.
//
//   node scripts/calibration/anchors/pilot/panel-2/analyse2.mjs
//
// Inputs: KEY-do-not-share.json (label → id; withheld from the raters while they scored),
// rater-sonnet.json, rater-opus.json, ../../design.json; and, for the like-for-like before/after,
// round 1's two Sonnet ratings in ../blind/ (rater-a, rater-b, under their own key).
//
// Estimator: backend icc.js iccTwoRater, ICC(A,1) with the McGraw–Wong F-based 95% CI.
// Package-free; no network.
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
const So = read(path.join(S, 'rater-sonnet.json')).scores;
const Op = read(path.join(S, 'rater-opus.json')).scores;
const design = read(path.join(R, 'design.json')).anchors.filter((a) => a.pilot);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const REWRITTEN = ['anc-005', 'anc-006', 'anc-014', 'anc-015', 'anc-019'];
const REWORDED = ['anc-007', 'anc-010', 'anc-013', 'anc-016'];

const rows = Object.entries(key).map(([e, id]) => {
  const d = design.find((x) => x.id === id);
  return { id, target: compositeOf(d.targets), s: compositeOf(So[e]), o: compositeOf(Op[e]), t: d.targets, S: So[e], O: Op[e] };
}).sort((x, y) => x.target - y.target);

console.log('evidence level: screening-synthetic (AI-authored, AI-scored) — not a decisive gate\n');
console.log('id        target sonnet  opus  panel  Δpanel');
for (const r of rows) {
  const p = (r.s + r.o) / 2, dl = p - r.target;
  const tag = REWRITTEN.includes(r.id) ? ' (rewritten)' : REWORDED.includes(r.id) ? ' (reworded)' : '';
  console.log(r.id.padEnd(9), r.target.toFixed(0).padStart(5), r.s.toFixed(0).padStart(6), r.o.toFixed(0).padStart(5),
    p.toFixed(0).padStart(6), ((dl >= 0 ? '+' : '') + dl.toFixed(0)).padStart(6), Math.abs(dl) > 15 ? '  OVER ±15' : '', tag);
}

const icc = (x, y) => {
  const o = iccTwoRater(rows.map((r) => ({ a: x(r), b: y(r) })));
  return `${o.icc.toFixed(3)} [${o.lower.toFixed(3)}, ${o.upper.toFixed(3)}]`;
};
const bias = (x, y) => mean(rows.map((r) => x(r) - y(r))).toFixed(1);
console.log('\ncomposite ICC(A,1) [95% CI]   bias(first−second)');
for (const [n, x, y] of [
  ['sonnet vs opus', (r) => r.s, (r) => r.o],
  ['sonnet vs target', (r) => r.s, (r) => r.target],
  ['opus vs target', (r) => r.o, (r) => r.target],
  ['panel vs target', (r) => (r.s + r.o) / 2, (r) => r.target],
]) console.log(n.padEnd(18), icc(x, y), ' bias', bias(x, y));

console.log('\ndomain ICC(A,1): sonnet-vs-opus | panel-vs-target');
for (const k of DOMAINS) {
  const ic = (x, y) => iccTwoRater(rows.map((r) => ({ a: x(r), b: y(r) }))).icc.toFixed(2).padStart(6);
  console.log(k, ic((r) => r.S[k], (r) => r.O[k]), ic((r) => (r.S[k] + r.O[k]) / 2, (r) => r.t[k]));
}

// Like-for-like before/after: SONNET ONLY. Round 1's raters were two Sonnets (mean of A and B);
// round 2's Sonnet is one rater. The panel-mean change mixes the rewrite with the change of panel.
const B1 = path.join(S, '../blind');
const key1 = read(path.join(B1, 'KEY-do-not-share.json'));
const A1 = read(path.join(B1, 'rater-a.json')).scores;
const Bb1 = read(path.join(B1, 'rater-b.json')).scores;
const label1 = Object.fromEntries(Object.entries(key1).map(([l, id]) => [id, l]));
console.log('\nSonnet-only before → after, rewritten anchors (Δ = Sonnet composite − target)');
console.log('id        target  round1 Sonnet (A,B mean)  Δ      round2 Sonnet  Δ');
for (const id of [...REWRITTEN, ...REWORDED]) {
  const r = rows.find((x) => x.id === id);
  const l = label1[id];
  const before = (compositeOf(A1[l]) + compositeOf(Bb1[l])) / 2;
  const sgn = (v) => (v >= 0 ? '+' : '') + v.toFixed(0);
  console.log(id.padEnd(9), r.target.toFixed(0).padStart(5), before.toFixed(0).padStart(14), sgn(before - r.target).padStart(13),
    r.s.toFixed(0).padStart(13), sgn(r.s - r.target).padStart(5), REWORDED.includes(id) ? '  (reworded only)' : '');
}

// Same model, same unchanged text, two sessions: how far does Sonnet move on its own? Without this,
// a rewritten anchor's before/after change cannot be told apart from rater re-run noise.
const unchanged = rows.filter((r) => !REWRITTEN.includes(r.id) && !REWORDED.includes(r.id));
const deltas = unchanged.map((r) => { const l = label1[r.id]; return r.s - (compositeOf(A1[l]) + compositeOf(Bb1[l])) / 2; });
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1)); };
console.log(`\nSonnet re-rating of the ${unchanged.length} UNCHANGED anchors (round 2 − round 1 mean): mean ${mean(deltas).toFixed(1)}, `
  + `SD ${sd(deltas).toFixed(1)}, range ${Math.min(...deltas).toFixed(0)} to +${Math.max(...deltas).toFixed(0)}`);
console.log('  ' + unchanged.map((r, i) => `${r.id} ${(deltas[i] >= 0 ? '+' : '') + deltas[i].toFixed(0)}`).join('  '));
