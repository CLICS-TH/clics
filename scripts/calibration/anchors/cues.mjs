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
// THE GATE (CUE_RULE):
//   n < 50   fail when |r| > 0.4. The CI is too wide at pilot size to say more.
//   n >= 50  fail unless the 95% CI EXCLUDES ±0.4 — i.e. the data must show the cue is weaker than
//            0.4, not merely fail to show it is stronger. At n = 100 that passes r up to about ±0.22.
//
// Package-free and pure: text in, numbers out.

export const CUE_MAX_R = 0.4;
export const CUE_CI_MIN_N = 50;
export const CUE_RULE = `n < ${CUE_CI_MIN_N}: |r| > ${CUE_MAX_R} fails · n >= ${CUE_CI_MIN_N}: fails unless the 95% CI excludes ±${CUE_MAX_R}`;
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
  if (n < 4 || Math.abs(r) >= 1) return { r, lower: null, upper: null, n };
  const z = Math.atanh(r), se = 1 / Math.sqrt(n - 3);
  return { r, lower: Math.tanh(z - 1.96 * se), upper: Math.tanh(z + 1.96 * se), n };
}

/** Does this correlation fail the gate? */
export function cueFails(c) {
  if (c?.r == null) return false;
  if (c.n < CUE_CI_MIN_N) return Math.abs(c.r) > CUE_MAX_R;
  return !(c.lower > -CUE_MAX_R && c.upper < CUE_MAX_R);
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

// THE PILOT FREEZE. The 20 pilot anchors were written before this check existed and are being scored
// as they stand, so they cannot be rewritten until the scores are back (PR #111 review). On the pilot
// alone the check finds exactly these failing pairs; they are reported as KNOWN, not counted. Anything
// else fails at once. The freeze lapses automatically the moment any non-pilot fixture is added: from
// then on every gated pair counts over the whole cohort, so the remaining anchors must be written to
// counterbalance these cues (or the pilot rewritten) before validate.mjs passes again.
export const PILOT_FREEZE = {
  reason: 'pilot anchors written before the cue check; frozen during the pilot scoring run (PR #111)',
  pairs: [
    'acks:composite', 'acks:d5',
    'numbers:composite', 'numbers:d3',
    'list_lines:composite', 'list_lines:d1',
    'rubric_echo:d5', 'rubric_echo:d7',
  ],
};

/** Split failures into those the pilot freeze covers and those that count. */
export function applyPilotFreeze(failures, { allPilot }) {
  if (!allPilot) return { counted: failures, frozen: [] };
  const known = new Set(PILOT_FREEZE.pairs);
  return {
    counted: failures.filter((f) => !known.has(`${f.feature}:${f.target}`)),
    frozen: failures.filter((f) => known.has(`${f.feature}:${f.target}`)),
  };
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
