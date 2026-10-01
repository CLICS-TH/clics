#!/usr/bin/env node
/*
 * Line up the SAME fixture's local-arm scores across separate probe sessions.
 *
 * WHY. repeat-consistency.mjs measures spread WITHIN one process, back to back. That turned out to
 * understate the variance that matters: across sessions the whole 7-domain vector was observed to
 * translate by ±1 while staying rigid inside a session. Production is the across-session case — a
 * PLE is scored once, on some day, under whatever server state exists — so this is the number that
 * bears on Model Lock (CREC082 §10.2) and on whether a credit decision is reproducible.
 *
 * A UNIFORM shift on all seven domains is the signature to look for. Random sampling noise scatters
 * individual domains; it does not translate the vector.
 *
 * Each row's score is production's WEIGHTED composite of that row's vector (agreement-stats.mjs), the
 * number a credit decision is made on. Until 2026-10 it was the unweighted d1..d7 sum (0–35), which
 * can even move the other way: [3,5,3,3,3,1,1] → [3,1,3,3,3,4,5] sums 19 → 22 but is credited 60 → 58.
 * Σ|Δ| stays the unweighted per-domain count, as everywhere in the probes.
 *
 * ============================================================================================
 * IT PRINTS NO TRANSCRIPT TEXT. Scores, deltas and fixture ids only.
 * ============================================================================================
 *
 *   node scripts/probe/compare-sessions.mjs s1=/tmp/agreement.json s2=/tmp/noise-local.json ...
 *
 * Accepts either shape: an agreement report ({rows:[{id,local,cloud}]}) or a repeat-consistency
 * report ({results:[{fixture,arm,runs:[...]}]}).
 */
import { readFile } from 'node:fs/promises';
import { bold, dim, red, green, yellow, hr, fail } from './lib.mjs';
import { compositeOf } from './agreement-stats.mjs';

const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const args = process.argv.slice(2).filter((a) => a.includes('='));
if (!args.length) fail('usage: compare-sessions.mjs label=/path/report.json [label=... ...]');

const mode = (xs) => { const c = {}; let best = xs[0]; for (const x of xs) { c[x] = (c[x] || 0) + 1; if (c[x] > (c[best] || 0)) best = x; } return best; };
// Weighted composite of a d1..d7 vector; null, never NaN, when a domain is missing.
const weighted = (vec) => (vec.every(Number.isFinite) ? compositeOf(Object.fromEntries(DOMAINS.map((d, i) => [d, vec[i]]))) : null);
const show = (v) => (v == null ? '—' : String(v));
// Rounded to compositeOf's 2 dp: a difference of two 2-dp values can carry float noise.
const signedDiff = (a, b) => {
  if (a == null || b == null) return '—';
  const d = Math.round((a - b) * 100) / 100;
  return `${d > 0 ? '+' : ''}${d}`;
};

// label -> fixture -> {vec, runs, n}
const sessions = [];
for (const a of args) {
  const i = a.indexOf('=');
  const label = a.slice(0, i);
  const p = a.slice(i + 1);
  let j;
  try { j = JSON.parse(await readFile(p, 'utf8')); }
  catch (e) { fail(`cannot read ${p}: ${e.message}`); }
  const byFix = new Map();
  if (Array.isArray(j.rows)) {
    for (const r of j.rows) if (r.local) byFix.set(r.id, { vec: DOMAINS.map((d) => r.local[d]), n: 1 });
  } else if (Array.isArray(j.results)) {
    for (const r of j.results) {
      if (r.arm !== 'local' || !r.runs?.length) continue;
      byFix.set(r.fixture, { vec: DOMAINS.map((d) => mode(r.runs.map((s) => s[d]))), n: r.runs.length,
        spread: DOMAINS.reduce((a, d) => { const v = r.runs.map((s) => s[d]); return a + (Math.max(...v) - Math.min(...v)); }, 0) });
    }
  } else fail(`${p}: unrecognised report shape (no rows[] or results[])`);
  if (!byFix.size) fail(`${p}: no local-arm data found`);
  sessions.push({ label, path: p, byFix });
}

const fixtures = [...new Set(sessions.flatMap((s) => [...s.byFix.keys()]))]
  .filter((f) => sessions.filter((s) => s.byFix.has(f)).length >= 2).sort();
if (!fixtures.length) fail('no fixture appears in two or more of the given sessions — nothing to compare.');

hr('local-arm scores across sessions');
console.log(`  ${sessions.length} session(s), ${fixtures.length} fixture(s) present in ≥2 of them\n`);
for (const s of sessions) console.log(`  ${bold(s.label.padEnd(4))} ${dim(s.path)}`);
console.log(dim('  w-comp = production\'s weighted PIS-7 composite (×20, 0–100); Σ|Δ| = the unweighted per-domain count'));
console.log();

let uniform = 0, scattered = 0, stable = 0;
for (const f of fixtures) {
  hr(f);
  const present = sessions.filter((s) => s.byFix.has(f));
  for (const s of present) {
    const e = s.byFix.get(f);
    console.log(`  ${s.label.padEnd(4)} ${JSON.stringify(e.vec).padEnd(24)} w-comp ${show(weighted(e.vec)).padStart(3)}`
      + (e.n > 1 ? dim(`   (mode of ${e.n} runs, within-session Σ|Δ| ${e.spread})`) : dim('   (single run)')));
  }
  // pairwise deltas against the first session that has it
  const base = present[0];
  for (const s of present.slice(1)) {
    const a = s.byFix.get(f).vec, b = base.byFix.get(f).vec;
    const delta = a.map((v, i) => v - b[i]);
    const nz = delta.filter((d) => d !== 0);
    const isUniform = nz.length === DOMAINS.length && new Set(delta).size === 1;
    const allZero = nz.length === 0;
    if (allZero) stable++; else if (isUniform) uniform++; else scattered++;
    const tag = allZero ? green('identical')
      : isUniform ? red(`UNIFORM SHIFT ${delta[0] > 0 ? '+' : ''}${delta[0]} on all 7 domains`)
      : yellow(`scattered (${nz.length}/7 domains moved)`);
    console.log(`  ${dim(`${s.label} − ${base.label}`)}  ${JSON.stringify(delta).padEnd(24)} ${tag}   Σ|Δ| ${delta.reduce((x, d) => x + Math.abs(d), 0)}`
      + `   w-comp Δ ${signedDiff(weighted(a), weighted(b))}`);
  }
}

hr('verdict');
console.log(`  identical across sessions   ${stable}`);
console.log(`  UNIFORM whole-vector shift  ${uniform}`);
console.log(`  scattered / mixed           ${scattered}\n`);
if (uniform) {
  console.log(`  ${bold('Read a uniform shift with care.')} It is consistent with the model re-picking an`);
  console.log('  overall severity per run, but it is NOT proof of a stable per-session offset: each row');
  console.log('  above is a MODE, and when within-session spread is large the mode itself is a noisy');
  console.log('  estimate, so ordinary jitter can masquerade as a clean shift. Trust a shift only when');
  console.log('  it replicates across sessions AND the within-session spread is small relative to it.\n');
  console.log('  Measured here: pooled, ~59% of run-to-run variance is a shared level term (range 14-82%');
  console.log('  by fixture). So the seven domains move together more often than not, which means the');
  console.log('  composite does not average the error away — it largely multiplies it.\n');
  console.log(`  ${dim('It also cannot be ruled out by pinning the model NAME: the endpoint exposes no')}`);
  console.log(`  ${dim('digest or modified-at, so identical weights across sessions is unverified.')}\n`);
} else if (!scattered) {
  console.log(`  ${green('No cross-session drift observed in this sample.')} Note the sample is small;`);
  console.log('  absence here is weak evidence, not a guarantee of stability.\n');
}
