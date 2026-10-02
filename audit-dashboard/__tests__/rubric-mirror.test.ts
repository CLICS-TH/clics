// The PIS-7 rubric a HUMAN rater scores against (lib/pis7-rubric.ts) must be the rubric the AI scores
// against (rimpl/src/lib/prompts.js, PIS7_EVALUATOR_PROMPT). If the two drift, an AI-vs-human ICC
// measures the gap between two rubrics rather than between two raters — and nothing else notices,
// because prompts.js is hashed into prompt_version while this file is hashed into nothing.
//
// Checked against the source text, not a hand-written copy (the reason backend-mirrors.test.ts exists):
//   - the 0–5 behavioural scale, line for line
//   - every domain's 0 → 3 → 5 anchor triplet
//   - every domain's English name and weight, and the weights in all three places they are kept
//     (rimpl versions.js, backend ple-gate.js, lib/labels.ts)
// criterion/floor are deliberately NOT compared: they are an operational gloss whose wording differs
// between the two on purpose (the prompt shouts THIS and COMMITS at the model), and comparing them
// would only teach people to edit both sides blindly.
import fs from 'fs';
import path from 'path';
import { PIS7_SCALE, PIS7_RUBRIC } from '@/lib/pis7-rubric';
import { WEIGHTS } from '@/lib/labels';

const REPO = path.join(__dirname, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

// The evaluator prompt is one template literal in prompts.js; take it verbatim.
function evaluatorPrompt(): string {
  const src = read('rimpl', 'src', 'lib', 'prompts.js');
  const m = /const PIS7_EVALUATOR_PROMPT = `([\s\S]*?)`;/.exec(src);
  if (!m) throw new Error('PIS7_EVALUATOR_PROMPT not found in prompts.js — did the declaration change shape?');
  return m[1];
}

// `const WEIGHTS = { d1: 0.15, ... };` — both back-end copies use exactly this shape.
function weightsIn(src: string, file: string): Record<string, number> {
  const m = /const WEIGHTS = \{([^}]*)\}/.exec(src);
  if (!m) throw new Error(`WEIGHTS not found in ${file} — did the declaration change shape?`);
  return Object.fromEntries([...m[1].matchAll(/(d[1-7])\s*:\s*([0-9.]+)/g)].map((x) => [x[1], Number(x[2])]));
}

describe('the human rubric is the AI rubric', () => {
  const prompt = evaluatorPrompt();

  it('reads the prompt at all', () => {
    // A silent read failure would make every assertion below vacuous.
    expect(prompt).toContain('PER-DOMAIN ANCHORS');
  });

  it('the 0–5 behavioural scale matches, line for line', () => {
    for (const s of PIS7_SCALE) expect(prompt).toContain(`\n${s.level} = ${s.en}\n`);
  });

  it('every domain carries the same 0 → 3 → 5 anchors', () => {
    expect(PIS7_RUBRIC.map((d) => d.key)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    for (const d of PIS7_RUBRIC) {
      // The dashboard prefixes each anchor with its level ("0 no assessable question"); the prompt
      // writes the triplet as one line.
      const [a0, a3, a5] = d.anchors.en.map((a) => a.replace(/^[035] /, ''));
      expect(prompt).toContain(`\n${d.key}: ${a0} → ${a3} → ${a5}\n`);
    }
  });

  it('every domain has the same name and weight in the prompt', () => {
    PIS7_RUBRIC.forEach((d, i) => {
      const pct = Math.round(WEIGHTS[d.key] * 100);
      expect(prompt).toContain(`\n${i + 1}. ${d.en} (${pct}%)`);
    });
  });

  it('the weights agree in all three places they are kept', () => {
    const rimpl = weightsIn(read('rimpl', 'src', 'lib', 'versions.js'), 'rimpl versions.js');
    const backend = weightsIn(read('backend', 'src', 'services', 'ple-gate.js'), 'backend ple-gate.js');
    expect(rimpl).toEqual(backend);
    expect(WEIGHTS).toEqual(rimpl);
  });
});
