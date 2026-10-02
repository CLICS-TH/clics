// Surface-cue check: does anything SHALLOW in the physician's text track the designed target?
//
// WHY. An anchor is supposed to express its level through behaviour. If the authors (an AI, writing
// to a rubric) let a surface feature drift with the level — longer turns for higher targets, more
// "ok ครับ" acknowledgements for low ones, more numerals, more bullet lists, or the rubric's own words
// recited back (the d5 level-5 triad ข้อเท็จจริง / ไม่แน่นอน / ข้อจำกัด) — then a scorer can recover the
// target from the surface without reading any reasoning, and an AI-vs-target ICC on this cohort would
// measure the cue, not the evaluator. The pilot's first draft already showed one: physician length vs
// target composite came in at r = 0.45-0.60.
//
// WHAT. Per fixture, from physician-authored text only (physician turns + the reflection body, with
// production's fixed reflection headings removed — those headings are the same for every reflection):
//   length        physician-turn characters
//   acks          acknowledgement tokens per physician turn (ok, okay, โอเค, noted, got it, รับทราบ …)
//   numbers       numerals per physician turn
//   list_lines    lines that open with a bullet or "1." / "1)"
//   rubric_echo   hits of rubric-descriptor phrases (RUBRIC_ECHO below — AUTHORING.md §5 and the CREC
//                 0→3→5 anchors in rimpl/src/lib/prompts.js)
// Each feature is correlated (Pearson, Fisher-z 95% CI) with the target composite and every domain
// target. The full matrix is reported; the GATE applies to the pairs in CUE_RELEVANT, where a cue
// would plausibly stand in for the behaviour that domain names.
//
// THE GATE (CUE_RULE), one rule at every n: a gated pair FAILS only when its 95% CI shows a cue
// beyond ±0.1 — lower > 0.1 or upper < −0.1. The data must SHOW a cue; noise alone must not fail.
//
// Why not the rule this replaced (2026-10-02, before any non-pilot fixture existed). It was
// "|r| > 0.4 below n = 50; from n = 50 fail unless the CI excludes ±0.4" — an equivalence test above
// n = 50 that the data had to pass to prove the cue absent. Simulated on the real design targets
// with NO cue (r = 0), the whole check false-failed 60% at n = 21, 7% at n = 49, then 99% at n = 50,
// 27% at n = 100: a cliff at 50, and CI red on noise. The rule above false-fails about 17% at n = 30,
// 10% at 50, 4% at 100 across all 15 gated pairs, with no cliff; anchors.test.mjs pins that with a
// seeded simulation.
//
// Package-free and pure: text in, numbers out.

export const CUE_MIN_R = 0.1;
export const CUE_RULE = `a gated pair fails when its 95% CI lies beyond ±${CUE_MIN_R} (lower > ${CUE_MIN_R} or upper < −${CUE_MIN_R}), at every n`;
export const TARGETS = ['composite', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
export const FEATURES = ['length', 'acks', 'numbers', 'list_lines', 'rubric_echo'];

// Where a surface feature could stand in for a domain's behaviour. Everything else is reported only.
export const CUE_RELEVANT = {
  length: ['composite'],
  acks: ['composite', 'd4', 'd5'],               // "ok ครับ" ≈ accepting / not following up
  numbers: ['composite', 'd2', 'd3'],            // numerals ≈ thresholds / patient specifics
  list_lines: ['composite', 'd1', 'd7'],         // lists ≈ templated prompts
  rubric_echo: ['composite', 'd2', 'd5', 'd6', 'd7'],
};

// Rubric-descriptor phrases. Sources: the CREC per-domain anchors in rimpl/src/lib/prompts.js
// (d5 "separates fact, uncertainty and limitation", d6 "names the next learning or action",
// d2 "links mechanism, evidence and limits", d7 "critical use, aware of the limits") and the
// AUTHORING.md §5 descriptors (d2 committed thresholds / pre-test probability, d5 4-5 appraisal,
// d6 "what changed", d7 "argue against my plan", ownership, verification).
export const RUBRIC_ECHO = [
  { re: /ข้อเท็จจริง/g, src: 'd5 (5): fact' },
  { re: /ไม่แน่นอน/g, src: 'd5 (5) / d6: uncertainty' },
  { re: /ข้อจำกัด/g, src: 'd5 (5), d2 (5), d3 (5), d7 (5): limitation' },
  { re: /\bfacts?\b/gi, src: 'd5 (5): fact' },
  { re: /\buncertain(ty|ties)?\b/gi, src: 'd5 (5) / d6: uncertainty' },
  { re: /\blimitations?\b/gi, src: 'd5 (5): limitation' },
  { re: /กลไก|\bmechanism/gi, src: 'd2 (5): mechanism' },
  { re: /pre-?test/gi, src: 'd2 (5): pre-test probability' },
  { re: /threshold|เกณฑ์ตัดสิน/gi, src: 'd2 (5): committed threshold' },
  { re: /argue against|ช่วยแย้ง|ลองแย้ง|\bแย้ง/gi, src: 'd7 (5): argue against my plan' },
  { re: /รับผิดชอบเอง|ตัดสินใจเอง|my call|\bI own\b|ownership/gi, src: 'd7 (4-5): ownership' },
  { re: /AI ไม่รู้|AI ไม่ได้เห็น|can'?t know|cannot know/gi, src: 'd7 (5): aware of the limits of the tool' },
  { re: /what changed|สิ่งที่เปลี่ยน/gi, src: 'd6 (4-5): what changed' },
  { re: /next learning|next step|จะไปทำต่อ/gi, src: 'd6 (5): next learning or action' },
];

const REFLECTION_HEADINGS = [
  'เรียนรู้อะไร / What I learned:',
  'ความไม่แน่นอน / What remains uncertain:',
  'จะตรวจสอบ/นำไปใช้อย่างไร / How I will verify or apply it:',
];

// An acknowledgement token standing on its own (Thai has no word boundaries, so delimit by hand).
const ACK_RE = /(?:^|[\s(,"'“])(ok|okay|โอเค|noted|got it|รับทราบ|เข้าใจแล้ว)(?=$|[\s,.!?)"'”]|ครับ|ค่ะ|คะ)/gi;
const NUM_RE = /\d+(?:[.,]\d+)?/g;
const LIST_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

export function cueFeatures(doc) {
  const t = Array.isArray(doc?.transcript) ? doc.transcript : [];
  const phys = t.filter((x) => x?.role === 'physician').map((x) => String(x.content));
  const refl = t.filter((x) => x?.role === 'reflection')
    .map((x) => REFLECTION_HEADINGS.reduce((s, h) => s.split(h).join(''), String(x.content)));
  const physText = phys.join('\n');
  const authored = [physText, ...refl].join('\n');
  const turns = Math.max(1, phys.length);
  const echoHits = {};
  let echo = 0;
  for (const { re, src } of RUBRIC_ECHO) {
    const k = (authored.match(re) ?? []).length;
    if (k) { echoHits[src] = (echoHits[src] ?? 0) + k; echo += k; }
  }
  return {
    length: physText.length,
    acks: (physText.match(ACK_RE) ?? []).length / turns,
    numbers: (physText.match(NUM_RE) ?? []).length / turns,
    list_lines: authored.split('\n').filter((l) => LIST_RE.test(l)).length,
    rubric_echo: echo,
    echo_hits: echoHits,
  };
}

function pearsonCI(xs, ys) {
  const n = xs.length;
  if (n < 3) return { r: null, lower: null, upper: null, n };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, sx = 0, sy = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); sx += (x - mx) ** 2; sy += (ys[i] - my) ** 2; });
  if (!sx || !sy) return { r: null, lower: null, upper: null, n, note: 'no variance' };
  const r = num / Math.sqrt(sx * sy);
  if (Math.abs(r) >= 1 - 1e-12) return { r, lower: r, upper: r, n };     // a perfect cue is the clearest cue of all
  if (n < 4) return { r, lower: null, upper: null, n };
  const z = Math.atanh(r), se = 1 / Math.sqrt(n - 3);
  return { r, lower: Math.tanh(z - 1.96 * se), upper: Math.tanh(z + 1.96 * se), n };
}

/** Does this correlation fail the gate? */
export function cueFails(c) {
  if (c?.r == null || c.lower == null || c.upper == null) return false;
  return c.lower > CUE_MIN_R || c.upper < -CUE_MIN_R;
}

/**
 * @param {{id, features, row}[]} entries   one per fixture that has a design row
 * @returns {{n, rule, matrix, failures:{feature,target,r,lower,upper}[]}}
 */
export function cueCheck(entries) {
  const n = entries.length;
  const targetOf = (row, k) => (k === 'composite' ? row.target_composite : row.targets[k]);
  const matrix = {};
  const failures = [];
  for (const f of FEATURES) {
    matrix[f] = {};
    for (const k of TARGETS) {
      const c = pearsonCI(entries.map((e) => e.features[f]), entries.map((e) => targetOf(e.row, k)));
      const gated = CUE_RELEVANT[f].includes(k);
      const fails = gated && cueFails(c);
      matrix[f][k] = { ...c, gated, fails };
      if (fails) failures.push({ feature: f, target: k, r: c.r, lower: c.lower, upper: c.upper });
    }
  }
  return { n, rule: CUE_RULE, matrix, failures };
}

// STATUS (2026-10-02): LAPSED. Nine pilot anchors were edited after the blind diagnosis (AUTHORING.md
// §7 amendment), so freezeApplies() is false and every gated pair counts; the cohort passes the gate
// on its own. The record below is kept because known-groups.mjs uses PILOT_FREEZE.fixtures to tell a
// run scored on the ORIGINAL pilot texts (which carries the d5 rubric-echo caveat) from a later one.
//
// THE PILOT FREEZE. The 20 pilot anchors were written before this check existed and are being scored
// as they stand, so they cannot be rewritten until the scores are back (PR #111 review). On the pilot
// alone the check finds exactly these failing pairs; they are reported as KNOWN, not counted. Anything
// else fails at once. The freeze lapses automatically the moment any fixture is added or changed: from
// then on every gated pair counts over the whole cohort, so the remaining anchors must be written to
// counterbalance these cues (or the pilot rewritten) before validate.mjs passes again.
//
// The freeze is keyed to the EXACT pilot fixtures (their manifest sha256s at 359df39), not to pair
// names: it applies only while the fixture set is precisely these 20 files, byte for byte. Rewrite one
// pilot anchor (new sha256) or add any other fixture and the freeze is off — every gated pair counts.
// Each frozen pair is also CAPPED at the r recorded here: a pair that gets stronger is a failure, even
// inside the freeze.
export const PILOT_FREEZE = {
  reason: 'pilot anchors written before the cue check; frozen during the pilot scoring run (PR #111)',
  fixtures: {
    'anc-001': '8f4b3118e41a86ba3223baae7488318cfc824ce1b51360efc7bac45acbb6a261',
    'anc-002': '8b67be949eef4b7fb22fd7e1b99d4186cde112e0a326c54b70b3d3e3e97fefe5',
    'anc-003': '32fe1266316a3be994b131f5872a2cbff414abbd3ea832cbcdf5187a5f5ad37b',
    'anc-004': 'b1e820e7298d7565e8d56d015a3eb94fee4f260f23c8e686f4f8036f13c1228a',
    'anc-005': 'ff6b1620717190c5e04fc07964bb5bfa40bde59d3b2b5f096607882a8889418e',
    'anc-006': '43c97d0aa570f53bc0581d57186c55e3155911060db523c82457cd60689a9bd4',
    'anc-007': 'b88685dd26124a3e707d43f6f28a91d8eee48940e801cab0691cb835ad6157aa',
    'anc-008': '0a7bad96476e11753dcfe2ea628ab82fc00be26d137efd87e0e82e532a308a6b',
    'anc-009': '549a0091dfc019ec4c651b0a911f7032f82792782ec2b9630135322b84ad3bc6',
    'anc-010': '0ca79c3ca828cee809bd5fecd4cf9b0cbbf16a72fb5f731a4a5b2fc132752e1b',
    'anc-011': '6d9a331c1c3ea7a38e70c1de44b8e5b62fa6bcc5560faa60366e0a2316948974',
    'anc-012': '695edebd37039aa83d85abffa5ca60777b8fb98af1c1784f46880420bedb38e3',
    'anc-013': '7c8a1e667506846f15062a45001eaaeaeb54efdc3c6308c0acf39fbecb158e60',
    'anc-014': 'c9cf13f1a8d794551c074d09cce72e1729cfd4a8fbf4ce14593704dc15b2a8e5',
    'anc-015': '24ec14023884ffe457e3180792e906d7e984600459b13b529e6b67f0e2319255',
    'anc-016': 'b46171bcc22ff6e27000f3feeb8fd19ff4cdb40884cc7152e307856b96e0df18',
    'anc-017': '3e01fc0b4241941df740f9df97dc3b580669bfeba635fdb16ae24954ceb30702',
    'anc-018': '8441dc2b7ba0d5635b534dd6193665db3fc416bb544666829f246b66c7759827',
    'anc-019': 'a2bb3395e6029de16624e5b6639af9fe1572f2860791251f2f990ef3b6f747d9',
    'anc-020': '88b4cf8ab9c8f2b57f4735b82b83c8de359002ca7e7f4a41e858449e6ab9dd38',
  },
  // feature:target → the r recorded on those fixtures. Only these pairs fail CUE_RULE on the pilot.
  pairs: {
    'acks:composite': -0.709498,
    'acks:d5': -0.629880,
    'numbers:composite': 0.578071,
    'numbers:d3': 0.519792,
    'list_lines:composite': -0.529453,
    'rubric_echo:d5': 0.641464,
  },
};

/** True only when `fixtureShas` (id → sha256) is exactly the frozen pilot set, byte for byte. */
export function freezeApplies(fixtureShas, freeze = PILOT_FREEZE) {
  const want = Object.entries(freeze.fixtures);
  const have = Object.entries(fixtureShas ?? {});
  return have.length === want.length && want.every(([id, sha]) => fixtureShas[id] === sha);
}

/**
 * Split failures into those the pilot freeze covers and those that count. A failure is frozen only
 * when the fixture set is exactly the frozen one AND the pair is recorded AND it is no stronger than
 * its recorded r (same sign, |r| not larger).
 */
export function applyPilotFreeze(failures, { fixtureShas }, freeze = PILOT_FREEZE) {
  if (!freezeApplies(fixtureShas, freeze)) return { counted: failures, frozen: [] };
  const covered = (f) => {
    const cap = freeze.pairs[`${f.feature}:${f.target}`];
    return cap != null && Math.sign(f.r) === Math.sign(cap) && Math.abs(f.r) <= Math.abs(cap) + 1e-6;
  };
  return { counted: failures.filter((f) => !covered(f)), frozen: failures.filter(covered) };
}

export function formatCueMatrix(res) {
  const lines = [`  surface cues vs target (Pearson r; * = gated pair, ✖ = fails)  n=${res.n}`,
    `  rule: ${res.rule}`,
    `    feature      ${TARGETS.map((k) => k.padStart(10)).join('')}`];
  for (const f of FEATURES) {
    lines.push(`    ${f.padEnd(12)} ${TARGETS.map((k) => {
      const c = res.matrix[f][k];
      const v = c.r == null ? '—' : c.r.toFixed(2);
      return `${v}${c.fails ? '✖' : (c.gated ? '*' : ' ')}`.padStart(10);
    }).join('')}`);
  }
  return lines.join('\n');
}
