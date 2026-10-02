#!/usr/bin/env node
// Round-3 blind panel (2026-10-02): Sonnet + Opus, 8 episodes F01–F08 — anc-101 (first write, the
// §7.4 replacement for anc-015), anc-012 (its one rewrite), and 6 UNCHANGED decoys (002, 004, 009,
// 011, 018, 020) so the raters cannot tell which texts are new, and so the panel's stability on
// identical text can be read against round 2.
//
//   node scripts/calibration/anchors/pilot/panel-3/analyse3.mjs
//
// Inputs: KEY-do-not-share.json (label → id; withheld from the raters while they scored),
// rater-sonnet.json, rater-opus.json, ../../design.json, and round 2's ratings in ../panel-2/ for the
// decoys' re-rating. Package-free; no network. n = 8, so no ICC is computed: it would be meaningless.
//
// The texts rated are the bytes in episodes.txt. anc-101 was rewritten AFTER this round (its single
// §7.4 rewrite), so its rated text is NOT the current fixture; RATED_SHA records which bytes were rated.
//
// Evidence level: screening-synthetic (AI-authored, AI-scored) — not a decisive gate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compositeOf } from '../../../../probe/agreement-stats.mjs';

const S = path.dirname(fileURLToPath(import.meta.url));
const R = path.resolve(S, '../..');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const key = read(path.join(S, 'KEY-do-not-share.json'));
const So = read(path.join(S, 'rater-sonnet.json')).scores;
const Op = read(path.join(S, 'rater-opus.json')).scores;
const design = read(path.join(R, 'design.json')).anchors;

// manifest sha256 of the texts rated in this round (commit 335050d).
export const RATED_SHA = {
  'anc-101': 'b7dd555bec17cac3e6d6a33ff78a96c43eb44b555ca73b48a60c1ff3307445a5',
  'anc-012': '2c0fa94adcf00be58b8331dc2bb4f3cdb8d077be15523a9a007131bc7c556132',
};
const CHANGED = ['anc-101', 'anc-012'];

// Round 2 (panel-2) composites of the same unchanged decoy texts.
const S2 = path.join(S, '../panel-2');
const key2 = read(path.join(S2, 'KEY-do-not-share.json'));
const label2 = Object.fromEntries(Object.entries(key2).map(([l, id]) => [id, l]));
const So2 = read(path.join(S2, 'rater-sonnet.json')).scores;
const Op2 = read(path.join(S2, 'rater-opus.json')).scores;

const sgn = (v) => (v >= 0 ? '+' : '') + v.toFixed(0);
const rows = Object.entries(key).map(([l, id]) => {
  const d = design.find((x) => x.id === id);
  const s = compositeOf(So[l]), o = compositeOf(Op[l]);
  return { id, l, target: d.target_composite, s, o, p: (s + o) / 2 };
});
const order = (r) => (CHANGED.includes(r.id) ? CHANGED.indexOf(r.id) - 10 : Number(r.id.slice(4)));
rows.sort((a, b) => order(a) - order(b));

console.log('evidence level: screening-synthetic (AI-authored, AI-scored) — not a decisive gate\n');
console.log('id        label target sonnet  opus  panel     Δ   round 2 (sonnet/opus)');
for (const r of rows) {
  const l2 = label2[r.id];
  const was = CHANGED.includes(r.id) ? (r.id === 'anc-012' ? 'old text, see panel-2' : '— (new anchor)')
    : `${compositeOf(So2[l2]).toFixed(0)}/${compositeOf(Op2[l2]).toFixed(0)}`;
  console.log(r.id.padEnd(9), r.l.padEnd(5), String(r.target).padStart(5), r.s.toFixed(0).padStart(6), r.o.toFixed(0).padStart(5),
    r.p.toFixed(0).padStart(6), sgn(r.p - r.target).padStart(5),
    Math.abs(r.p - r.target) > 15 ? (CHANGED.includes(r.id) ? ' OVER ±15' : ' >15 (n.t.)') : '           ', ` ${was}`,
    CHANGED.includes(r.id) ? `  (rated sha ${RATED_SHA[r.id].slice(0, 8)}…)` : '');
}

// Panel stability on identical text: decoys round 3 − round 2, per rater.
const decoys = rows.filter((r) => !CHANGED.includes(r.id));
const ds = decoys.map((r) => r.s - compositeOf(So2[label2[r.id]]));
const dO = decoys.map((r) => r.o - compositeOf(Op2[label2[r.id]]));
const span = (xs) => `${sgn(Math.min(...xs))} to ${sgn(Math.max(...xs))}, mean |Δ| ${(xs.reduce((a, v) => a + Math.abs(v), 0) / xs.length).toFixed(1)}`;
console.log(`\nunchanged decoys, round 3 − round 2 on identical text: sonnet ${span(ds)}; opus ${span(dO)}`);
console.log('  ' + decoys.map((r, i) => `${r.id} ${sgn(ds[i])}/${sgn(dO[i])}`).join('  '));

// A decoy's text is unchanged and was first panel-rated in round 2; rule decisions use the round in
// which a text was FIRST panel-rated, so a decoy crossing the line here is panel noise, not a trigger.
console.log('  (n.t.) = unchanged decoy beyond ±15 this round: recorded, NOT a rewrite trigger (rule uses the first panel rating of a text)');

console.log('\nper-domain, changed anchors (target | sonnet | opus)');
for (const id of CHANGED) {
  const r = rows.find((x) => x.id === id);
  const t = design.find((x) => x.id === id).targets;
  const f = (o) => ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map((k) => o[k]).join(',');
  console.log(`  ${id}  [${f(t)}] | [${f(So[r.l])}] | [${f(Op[r.l])}]`);
}
