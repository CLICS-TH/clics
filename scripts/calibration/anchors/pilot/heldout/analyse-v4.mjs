// Item 25: the v4 addendum (item 24 winner) scored ONCE on the 60 held-out anchors, against the
// designed target, the AI consensus (mean of the blind Sonnet, Opus and GPT ratings) and the shipping
// prompt's held-out run. Screening-synthetic. Composite per anchor = compositeOf of the per-domain
// MEDIAN over its runs (the known-groups.mjs method). ICC(A,1) = backend icc.js via agreement-stats.
//   node scripts/calibration/anchors/pilot/heldout/analyse-v4.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compositeOf, iccTwoRater, DOMAINS } from '../../../../probe/agreement-stats.mjs';

const H = path.dirname(fileURLToPath(import.meta.url));
const A = path.resolve(H, '../..');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const key = read(path.join(H, 'KEY-do-not-share.json'));
const design = Object.fromEntries(read(path.join(A, 'design.json')).anchors.map((a) => [a.id, a]));
const comp = (s) => compositeOf(Object.fromEntries(DOMAINS.map((d) => [d, s[d]])));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };

const loadRaters = (name, dir) => {
  const m = {};
  for (let n = 1; n <= 6; n++) {
    const f = path.join(dir, `rater-${name}-${n}.json`);
    if (!fs.existsSync(f)) continue;
    Object.assign(m, JSON.parse(fs.readFileSync(f, 'utf8').trim().replace(/^```(json)?/, '').replace(/```$/, '')).scores);
  }
  return Object.fromEntries(Object.entries(m).map(([x, s]) => [key[x], comp(s)]));
};
const gpt = loadRaters('gpt', H), opus = loadRaters('opus', H), sonnet = loadRaters('sonnet', H);

const loadRun = (f) => {
  const by = {}, runs = {};
  for (const r of read(f).rows) {
    if (!r.scores) continue;
    (by[r.id] ||= []).push(r.scores);
    (runs[r.id] ||= {})[r.run] = comp(r.scores);
  }
  const c = Object.fromEntries(Object.entries(by).map(([id, ss]) => [id, comp(Object.fromEntries(DOMAINS.map((d) => [d, median(ss.map((s) => s[d]))])))]));
  return { c, runs };
};
const ship = loadRun(path.join(A, 'runs/heldout-local-2026-10-02-merged.json'));
const v4 = loadRun(path.join(A, 'runs/heldout-local-v4-2026-10-03-merged.json'));

const ids = Object.values(key);
const rows = ids.map((id) => ({
  id, target: design[id].target_composite,
  ship: ship.c[id], v4: v4.c[id],
  consensus: (gpt[id] + opus[id] + sonnet[id]) / 3,
}));
const tcrit = (df) => (df >= 30 ? 2.0 : ({ 9: 2.26, 14: 2.14, 16: 2.12, 19: 2.09, 20: 2.09, 21: 2.08, 22: 2.08, 25: 2.06 })[df] ?? 2.1);
const ci = (ds) => { const m = mean(ds), h = tcrit(ds.length - 1) * sd(ds) / Math.sqrt(ds.length); return `${m >= 0 ? '+' : ''}${m.toFixed(1)} [${(m - h).toFixed(1)}, ${(m + h).toFixed(1)}] (n ${ds.length})`; };
const icc = (a, b) => { const r = iccTwoRater(rows.map((x) => ({ a: x[a], b: x[b] }))); const c = r.ci || r.ci95 || [r.lower, r.upper]; return `${r.icc.toFixed(3)} [${c[0].toFixed(3)}, ${c[1].toFixed(3)}]`; };
const band = (lo, hi) => rows.filter((r) => r.target >= lo && r.target < hi);

console.log(`held-out anchors: ${rows.length} · screening-synthetic (AI-authored, AI-scored) — not a decisive gate\n`);
console.log('ICC(A,1) [95% CI]');
for (const [a, b] of [['ship', 'target'], ['v4', 'target'], ['consensus', 'target'], ['ship', 'consensus'], ['v4', 'consensus']]) console.log(`  ${a} vs ${b}: ${icc(a, b)}`);
console.log(`\nSD of composite: target ${sd(rows.map((r) => r.target)).toFixed(1)} · ship ${sd(rows.map((r) => r.ship)).toFixed(1)} · v4 ${sd(rows.map((r) => r.v4)).toFixed(1)} · consensus ${sd(rows.map((r) => r.consensus)).toFixed(1)}`);
console.log(`SD ratio vs target: ship ${(sd(rows.map((r) => r.ship)) / sd(rows.map((r) => r.target))).toFixed(2)} · v4 ${(sd(rows.map((r) => r.v4)) / sd(rows.map((r) => r.target))).toFixed(2)}`);
console.log('\nBias vs target, t 95% CI');
for (const k of ['ship', 'v4', 'consensus'])
  console.log(`  ${k.padEnd(9)} all ${ci(rows.map((r) => r[k] - r.target))} · <40 ${ci(band(0, 40).map((r) => r[k] - r.target))} · 40-69 ${ci(band(40, 70).map((r) => r[k] - r.target))} · >=70 ${ci(band(70, 101).map((r) => r[k] - r.target))}`);
console.log('\nPaired, v4 minus shipping (same 60 anchors)');
console.log(`  |error vs target|  ${ci(rows.map((r) => Math.abs(r.v4 - r.target) - Math.abs(r.ship - r.target)))}`);
console.log(`  score, <40 band    ${ci(band(0, 40).map((r) => r.v4 - r.ship))}`);
console.log(`  |error vs consensus| ${ci(rows.map((r) => Math.abs(r.v4 - r.consensus) - Math.abs(r.ship - r.consensus)))}`);
// Test–retest: ICC(A,1) run 1 vs run 2, and run 1 vs run 3.
const rr = (run, a, b) => { const p = ids.filter((id) => run.runs[id]?.[a] != null && run.runs[id]?.[b] != null).map((id) => ({ a: run.runs[id][a], b: run.runs[id][b] })); const r = iccTwoRater(p); return `${r.icc.toFixed(2)} (n ${p.length})`; };
console.log(`\nTest–retest ICC(A,1): ship r1-r2 ${rr(ship, 1, 2)}, r1-r3 ${rr(ship, 1, 3)} · v4 r1-r2 ${rr(v4, 1, 2)}, r1-r3 ${rr(v4, 1, 3)}`);
