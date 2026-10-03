// GPT (non-Claude) blind rater on the 60 held-out anchors vs target, Claude panel and DeepSeek.
// Screening-synthetic. ICC(A,1) = backend icc.js iccTwoRater via scripts/probe/agreement-stats.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compositeOf, iccTwoRater, DOMAINS } from '../../../../probe/agreement-stats.mjs';

const A = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const H = path.join(A, 'pilot/heldout');
const OUT = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const key = read(path.join(H, 'KEY-do-not-share.json'));
const design = Object.fromEntries(read(path.join(A, 'design.json')).anchors.map((a) => [a.id, a]));

const load = (prefix) => {
  const m = {};
  for (let n = 1; n <= 6; n++) {
    const f = prefix(n);
    if (!fs.existsSync(f)) continue;
    let raw = fs.readFileSync(f, 'utf8').trim().replace(/^```(json)?/, '').replace(/```$/, '');
    Object.assign(m, JSON.parse(raw).scores);
  }
  return m;
};
const gpt = load((n) => path.join(OUT, `rater-gpt-${n}.json`));
const opus = load((n) => path.join(H, `rater-opus-${n}.json`));
const sonnet = load((n) => path.join(H, `rater-sonnet-${n}.json`));
const comp = (s) => compositeOf(Object.fromEntries(DOMAINS.map((d) => [d, s[d]])));

const local = {};
for (const r of read(path.join(A, 'runs/heldout-local-2026-10-02-merged.json')).rows) {
  if (r.error || !r.scores) continue;
  (local[r.id] ||= []).push(comp(r.scores));
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const rows = [];
for (const [x, id] of Object.entries(key)) {
  if (!gpt[x]) continue;
  const bad = DOMAINS.find((d) => !Number.isInteger(gpt[x][d]) || gpt[x][d] < 0 || gpt[x][d] > 5);
  if (bad) throw new Error(`${x} ${bad} invalid: ${gpt[x][bad]}`);
  rows.push({
    x, id,
    target: design[id].target_composite,
    gpt: comp(gpt[x]),
    panel: (comp(opus[x]) + comp(sonnet[x])) / 2,
    opus: comp(opus[x]), sonnet: comp(sonnet[x]),
    local: local[id] ? mean(local[id]) : null,
    dissociated: design[id].dissociated_domains || [],
    gptDom: gpt[x], tgtDom: design[id].targets,
  });
}

const tcrit = (df) => ({ 1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23, 12: 2.18, 15: 2.13, 20: 2.09, 25: 2.06, 30: 2.04 })[df] ?? (df > 30 ? 2.0 : 2.1);
const biasCI = (ds) => {
  const n = ds.length, m = mean(ds);
  const sd = Math.sqrt(ds.reduce((a, d) => a + (d - m) ** 2, 0) / (n - 1));
  const h = tcrit(n - 1) * sd / Math.sqrt(n);
  return `${m >= 0 ? '+' : ''}${m.toFixed(1)} [${(m - h).toFixed(1)}, ${(m + h).toFixed(1)}] (n ${n})`;
};
const icc = (k1, k2, rs = rows) => {
  const r = iccTwoRater(rs.filter((x) => x[k1] != null && x[k2] != null).map((x) => ({ a: x[k1], b: x[k2] })));
  const ci = r.ci || r.ci95 || [r.lower, r.upper];
  return `${r.icc.toFixed(3)} [${ci[0]?.toFixed(3)}, ${ci[1]?.toFixed(3)}]`;
};
const band = (lo, hi) => rows.filter((r) => r.target >= lo && r.target < hi);

console.log(`GPT rated ${rows.length}/60 held-out anchors\n`);
console.log('ICC(A,1) [95% CI]');
for (const [a, b] of [['gpt', 'target'], ['panel', 'target'], ['local', 'target'], ['gpt', 'panel'], ['gpt', 'opus'], ['gpt', 'sonnet'], ['local', 'gpt'], ['local', 'panel']])
  console.log(`  ${a} vs ${b}: ${icc(a, b)}`);
console.log('\nBias vs target, t 95% CI');
for (const k of ['gpt', 'panel', 'local']) {
  console.log(`  ${k}: all ${biasCI(rows.map((r) => r[k] - r.target))}`);
  console.log(`     <40 ${biasCI(band(0, 40).map((r) => r[k] - r.target))} · 40-69 ${biasCI(band(40, 70).map((r) => r[k] - r.target))} · >=70 ${biasCI(band(70, 101).map((r) => r[k] - r.target))}`);
}
console.log('\nPaired low-band (<40): DeepSeek minus GPT', biasCI(band(0, 40).map((r) => r.local - r.gpt)));
console.log('Paired low-band (<40): panel minus GPT  ', biasCI(band(0, 40).map((r) => r.panel - r.gpt)));

// Low dissociated domains: designed target <= 1 on a dissociated domain; how far does GPT lift it?
const lifts = [];
for (const r of rows) for (const d of r.dissociated) if (r.tgtDom?.[d] != null && r.tgtDom[d] <= 1) lifts.push(r.gptDom[d] - r.tgtDom[d]);
if (lifts.length) console.log(`\nLow dissociated domains (target <=1): GPT lifted ${lifts.filter((v) => v > 0).length}/${lifts.length}, mean ${mean(lifts) >= 0 ? '+' : ''}${mean(lifts).toFixed(2)} levels`);

