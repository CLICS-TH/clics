#!/usr/bin/env node
// Batch-3 blind panel (2026-10-02): Sonnet + Opus, 7 episodes J01–J07. The 3 TUNING anchors of batch 3
// (first write), the single §7.4 REWRITES of anc-027 and anc-064 (batch 1: +18, +21), and 2 UNCHANGED
// pilot decoys (anc-005, anc-018) as a stability check. For every non-decoy this is the deciding round
// of its current text (AUTHORING.md §7 amendment item 6): a first write beyond ±15 uses its one rewrite;
// a rewrite still beyond ±15 is excluded and replaced from the design (§7.4). Held-out batch-3 anchors
// are not in the packet (`anchor-split.mjs --check-scorable` passed all 7 ids before it was built).
//
//   node scripts/calibration/anchors/pilot/batch-3/analyse-b3.mjs
//
// Inputs: this folder's KEY-do-not-share.json (withheld from the raters while they scored),
// rater-sonnet.json, rater-opus.json; ../panel-2..4 and ../batch-1 for earlier ratings;
// ../../design.json. Package-free; no network. n = 5 rated texts, so no ICC is computed.
//
// Evidence level: screening-synthetic (AI-authored, AI-scored) — not a decisive gate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compositeOf } from '../../../../probe/agreement-stats.mjs';

const S = path.dirname(fileURLToPath(import.meta.url));
const R = path.resolve(S, '../..');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const design = read(path.join(R, 'design.json'));
const KS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const sgn = (v, d = 0) => (v >= 0 ? '+' : '') + v.toFixed(d);
const rated = (dir) => {
  const D = path.join(S, dir);
  const key = read(path.join(D, 'KEY-do-not-share.json'));
  const So = read(path.join(D, 'rater-sonnet.json')).scores;
  const Op = read(path.join(D, 'rater-opus.json')).scores;
  return Object.fromEntries(Object.entries(key).map(([l, id]) => [id, { l, S: So[l], O: Op[l], s: compositeOf(So[l]), o: compositeOf(Op[l]) }]));
};

const now = rated('.');
const before = { 'panel-2': rated('../panel-2'), 'panel-3': rated('../panel-3'), 'panel-4': rated('../panel-4'), 'batch-1': rated('../batch-1') };
const REWRITES = new Set(['anc-027', 'anc-064']);
console.log('evidence level: screening-synthetic (AI-authored, AI-scored) — not a decisive gate\n');

console.log('TUNING — first writes and rewrites (deciding round)');
console.log('id        target sonnet  opus  panel     Δ');
const overByLevel = {};
let outside = 0, sumD = 0, n = 0;
for (const [id, x] of Object.entries(now).sort(([a], [b]) => a.localeCompare(b))) {
  const a = design.anchors.find((d) => d.id === id);
  if (a.pilot) continue;
  const p = (x.s + x.o) / 2, d = p - a.target_composite;
  n++; sumD += d;
  if (Math.abs(d) > 15) outside++;
  console.log(id.padEnd(9), String(a.target_composite).padStart(5), x.s.toFixed(0).padStart(6), x.o.toFixed(0).padStart(5),
    p.toFixed(0).padStart(6), sgn(d).padStart(5),
    REWRITES.has(id) ? `  rewrite (batch-1 Δ ${sgn((before['batch-1'][id].s + before['batch-1'][id].o) / 2 - a.target_composite)})${Math.abs(d) > 15 ? ': still > 15 — exclude and replace (§7.4)' : ': within ±15 — stays'}`
      : Math.abs(d) > 15 ? '  > 15: one rewrite (§7.4)' : '');
  console.log(`          target [${KS.map((k) => a.targets[k])}] | sonnet [${KS.map((k) => x.S[k])}] | opus [${KS.map((k) => x.O[k])}]`);
  for (const k of KS) (overByLevel[a.targets[k]] ??= []).push((x.S[k] + x.O[k]) / 2 - a.targets[k]);
}
console.log(`  ${outside} of ${n} beyond ±15; mean Δ ${sgn(sumD / n, 1)}`);

console.log('\nPER-DOMAIN OVERSHOOT by target level (panel mean − target, tuning anchors pooled):');
for (const [t, ds] of Object.entries(overByLevel)) console.log(`  target ${t}: ${sgn(ds.reduce((a, v) => a + v, 0) / ds.length, 2)}  (n = ${ds.length} domain ratings)`);

console.log('\nDECOYS (identical text; a stability check, never a trigger):');
for (const [id, x] of Object.entries(now)) {
  if (!design.anchors.find((d) => d.id === id).pilot) continue;
  const prev = Object.entries(before).filter(([, r]) => r[id] && r[id].S).map(([k, r]) => `${k} ${r[id].s.toFixed(0)}/${r[id].o.toFixed(0)}`);
  console.log(`  ${id}: now ${x.s.toFixed(0)}/${x.o.toFixed(0)} (sonnet/opus) — ${prev.join(', ')}`);
}
