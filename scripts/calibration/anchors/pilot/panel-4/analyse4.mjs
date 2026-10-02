#!/usr/bin/env node
// Round-4 blind panel (2026-10-02): Sonnet + Opus, 6 episodes G01–G06 — anc-101 after its single §7.4
// rewrite, plus 5 UNCHANGED decoys (003, 008, 013, 016, 017). Then the whole pilot, pooled.
//
//   node scripts/calibration/anchors/pilot/panel-4/analyse4.mjs
//
// Inputs: this folder's KEY-do-not-share.json (withheld from the raters while they scored),
// rater-sonnet.json, rater-opus.json; ../panel-2 and ../panel-3 (same layout); ../../design.json.
// Package-free; no network. n = 6 this round, so no ICC is computed.
//
// POOLING. Rounds 2–4 used the same two models (Sonnet + Opus) and the same rubric text. For each active
// pilot anchor, every round that rated its CURRENT text is pooled (mean of the per-round panel means).
// The DECIDING round — the first panel rating of the current text (AUTHORING.md §7 amendment item 6) —
// is what the rule used; the pooled Δ is reported beside it and changes no decision. Round 1 (two
// Sonnets) is not pooled: a different panel.
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
const active = design.anchors.filter((a) => a.pilot && !a.excluded);
const sgn = (v) => (v >= 0 ? '+' : '') + v.toFixed(0);

// Rounds 2–4, each label → {id, sonnet composite, opus composite}.
const ROUNDS = { 2: '../panel-2', 3: '../panel-3', 4: '.' };
const ratings = {};
for (const [round, dir] of Object.entries(ROUNDS)) {
  const D = path.join(S, dir);
  const key = read(path.join(D, 'KEY-do-not-share.json'));
  const So = read(path.join(D, 'rater-sonnet.json')).scores;
  const Op = read(path.join(D, 'rater-opus.json')).scores;
  ratings[round] = Object.fromEntries(Object.entries(key).map(([l, id]) => [id, { l, s: compositeOf(So[l]), o: compositeOf(Op[l]), S: So[l], O: Op[l] }]));
}

// The round from which each anchor's CURRENT text was rated. Default: round 2 rated the texts of
// 2627c9b, which are still current for every pilot anchor except these two. (anc-014's later change is
// tutor-text only — a citation year — and the raters score the physician; it is treated as unchanged.)
const CURRENT_SINCE = { 'anc-012': 3, 'anc-101': 4 };
const since = (id) => CURRENT_SINCE[id] ?? 2;

console.log('evidence level: screening-synthetic (AI-authored, AI-scored) — not a decisive gate\n');

// 1. This round.
const r4 = ratings[4];
console.log('ROUND 4');
console.log('id        target sonnet  opus  panel     Δ   round 2 (S/O)');
for (const [id, x] of Object.entries(r4).sort(([a], [b]) => (a === 'anc-101' ? -1 : b === 'anc-101' ? 1 : a.localeCompare(b)))) {
  const t = design.anchors.find((a) => a.id === id).target_composite;
  const p = (x.s + x.o) / 2;
  const r2 = ratings[2][id];
  console.log(id.padEnd(9), String(t).padStart(5), x.s.toFixed(0).padStart(6), x.o.toFixed(0).padStart(5), p.toFixed(0).padStart(6),
    sgn(p - t).padStart(5), '  ', id === 'anc-101' ? '—' : `${r2.s.toFixed(0)}/${r2.o.toFixed(0)}`,
    since(id) === 4 ? '  (deciding round)' : Math.abs(p - t) > 15 ? '  >15 on a re-rating: not a trigger (item 6)' : '');
}
const f = (o) => ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map((k) => o[k]).join(',');
const a101 = design.anchors.find((a) => a.id === 'anc-101');
console.log(`  anc-101 per domain: target [${f(a101.targets)}] | sonnet [${f(r4['anc-101'].S)}] | opus [${f(r4['anc-101'].O)}]`);

// 2. Drift on identical text: every re-rating of a decoy in rounds 3–4 against its round-2 rating.
const drift = { s: [], o: [] };
const lines = [];
for (const round of [3, 4]) {
  for (const [id, x] of Object.entries(ratings[round])) {
    if (since(id) >= round) continue;                     // not a re-rating of the same text
    const base = ratings[2][id];
    drift.s.push(x.s - base.s); drift.o.push(x.o - base.o);
    lines.push(`${id} r${round} ${sgn(x.s - base.s)}/${sgn(x.o - base.o)}`);
  }
}
const rng = (xs) => `${sgn(Math.min(...xs))} to ${sgn(Math.max(...xs))} (mean |Δ| ${(xs.reduce((a, v) => a + Math.abs(v), 0) / xs.length).toFixed(1)}, n = ${xs.length})`;
console.log('\nDRIFT on identical text, rounds 3–4 minus round 2 (sonnet/opus composite points):');
console.log(`  sonnet ${rng(drift.s)}`);
console.log(`  opus   ${rng(drift.o)}`);
console.log('  ' + lines.join('  '));
// Signed mean per round: a shift shared by every decoy in a round is a round-level offset, and it also
// applies to the anchor that round decided.
for (const round of [3, 4]) {
  const ids = Object.keys(ratings[round]).filter((id) => since(id) < round);
  const m = (k) => ids.reduce((acc, id) => acc + ratings[round][id][k] - ratings[2][id][k], 0) / ids.length;
  console.log(`  round ${round} decoys, signed mean: sonnet ${sgn(m('s'))}, opus ${sgn(m('o'))} (n = ${ids.length})`);
}

// 3. The pilot, pooled.
console.log('\nPILOT (20 active anchors): deciding-round Δ vs pooled Δ over every round 2–4 rating of the current text');
console.log('id        target  deciding (round)  pooled  ratings');
let overDeciding = 0, overPooled = 0;
for (const a of [...active].sort((x, y) => x.target_composite - y.target_composite)) {
  const rs = [2, 3, 4].filter((r) => r >= since(a.id) && ratings[r][a.id]);
  const panel = (r) => (ratings[r][a.id].s + ratings[r][a.id].o) / 2;
  const dDec = panel(rs[0]) - a.target_composite;
  const dPool = rs.reduce((acc, r) => acc + panel(r), 0) / rs.length - a.target_composite;
  if (Math.abs(dDec) > 15) overDeciding++;
  if (Math.abs(dPool) > 15) overPooled++;
  console.log(a.id.padEnd(9), String(a.target_composite).padStart(5), sgn(dDec).padStart(9), `(r${rs[0]})`.padStart(7),
    sgn(dPool).padStart(8), `  ${rs.map((r) => `r${r}`).join('+')}`, Math.abs(dPool) > 15 && Math.abs(dDec) <= 15 ? '  pooled >15 (reported; decision stands)' : '');
}
console.log(`\n  beyond ±15 on the deciding round: ${overDeciding}/${active.length}   pooled: ${overPooled}/${active.length}   (§7.6 allowance: 4)`);
console.log('  Panel: Claude-authored anchors screened by a Claude panel (Sonnet + Opus) — not independent raters.');
