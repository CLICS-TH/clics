#!/usr/bin/env node
/*
 * Noise floor: how much does ONE model's PIS-7 score move when you ask it the SAME question twice?
 *
 * WHY THIS EXISTS. model-agreement.mjs reports Σ|Δ| between the local model and Sonnet. That number
 * is only interpretable against a baseline: if a single model re-scoring the same transcript already
 * moves by 4 points, then a local-vs-cloud Σ|Δ| of 4 is indistinguishable from noise and means
 * nothing. Observed in the wild: PLE-002 scored Σ|Δ| 3 in a smoke run and Σ|Δ| 10 in the full run,
 * same fixture, temperature 0 on both arms.
 *
 * WHY IT TESTS EACH ARM SEPARATELY. Σ|Δ| is a DIFFERENCE. A change in it proves something moved,
 * not which side. Both arms are suspect:
 *   · local — batched GPU inference reorders floating-point accumulation depending on what else is
 *     in the batch, so temperature 0 is deterministic in the sampler but not end-to-end.
 *   · cloud — Anthropic does not guarantee bitwise determinism at temperature 0 either.
 * So each arm is run K times against the same fixture, and the two noise floors are reported apart.
 *
 * CONTENTION WARNING. Run the local arm ALONE. A concurrent job changes GPU batch composition, which
 * is the suspected mechanism for the non-determinism — measuring under contention measures a
 * different quantity than the one that applies to a serial run.
 *
 * ============================================================================================
 * IT PRINTS NO TRANSCRIPT TEXT. Output is scores, spreads and fixture ids.
 * ============================================================================================
 *
 *   node scripts/probe/repeat-consistency.mjs --arm cloud --repeats 5
 *   node scripts/probe/repeat-consistency.mjs --arm local --repeats 5
 *   node scripts/probe/repeat-consistency.mjs --arm both  --fixtures 2 --out noise.json
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { PROBE_DIR, RIMPL_DIR, bold, dim, red, green, yellow, hr, fail, readConfig, chatCompletion } from './lib.mjs';

import { PIS7_EVALUATOR_PROMPT } from '../../rimpl/src/lib/prompts.js';
import { PROMPT_VERSION } from '../../rimpl/src/lib/versions.js';
import { applySplit } from './split.mjs';
import { parseJsonObject } from '../../rimpl/src/lib/parse.js';
import { flattenForPrompt } from '../../rimpl/src/lib/transcript.js';
import { deriveHintTokens } from '../../rimpl/src/services/pii-filter.js';

const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const argNum = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? Number(process.argv[i + 1]) : d; };
const argStr = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };

const ARM = argStr('arm', 'both');
const REPEATS = argNum('repeats', 5);
const NFIX = argNum('fixtures', 1);
const OUT = argStr('out');
if (!['local', 'cloud', 'both'].includes(ARM)) fail(`--arm must be local | cloud | both (got ${ARM})`);
if (REPEATS < 2) fail('--repeats must be at least 2 — one run measures no spread.');

const env = Object.fromEntries(
  (await readFile(path.join(RIMPL_DIR, '.env'), 'utf8').catch(() => ''))
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
// Read the model id out of the provider module rather than hardcoding it, so this cannot drift into
// comparing against a model production does not use. NOTE: this MUST use an imported readFileSync —
// a bare require() throws ReferenceError in ESM, and an earlier version silently swallowed that in a
// catch and fell through to a hardcoded default, making the anti-drift guard decorative. If the read
// fails now, that is fatal: a silent fallback is exactly the failure this guard exists to prevent.
const CLOUD_MODEL = process.env.CLOUD_MODEL || (() => {
  const p = path.join(RIMPL_DIR, 'src/services/providers/anthropic.js');
  let src;
  try { src = readFileSync(p, 'utf8'); }
  catch (e) { fail(`cannot read ${p} to determine the production model: ${e.message}`); }
  const m = src.match(/claude-[a-z0-9.-]+/);
  if (!m) fail(`no claude-* model id found in ${p} — cannot confirm which model production uses.`);
  return m[0];
})();
if (ARM !== 'local' && !ANTHROPIC_KEY) fail('No ANTHROPIC_API_KEY (checked env and rimpl/.env).');

const cfg = ARM === 'cloud' ? null : readConfig();

const FIX = path.join(PROBE_DIR, 'fixtures');
// --only PLE-002,PLE-051 selects specific fixtures; otherwise take the first --fixtures N.
const ONLY = (argStr('only') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
let files = (await readdir(FIX).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
// The split is applied FIRST: --only and --fixtures then choose within it, so a held-out id cannot be
// pulled into a tuning-time noise measurement by naming it.
const { files: splitFiles, split } = await applySplit(files, argStr('split'), { fixturesDir: FIX });
files = splitFiles;
if (ONLY.length) {
  // Preserve the ORDER the caller gave, not readdir's sort — request order is a variable under test
  // (a server holding cross-request state would make position in the sequence matter).
  const missing = ONLY.filter((o) => !files.some((f) => f.toLowerCase().includes(o)));
  if (missing.length) fail(`--only named fixture(s) with no file: ${missing.join(', ')}`);
  files = ONLY.map((o) => files.find((f) => f.toLowerCase().includes(o)));
} else {
  files = files.slice(0, NFIX);
}
if (!files.length) fail(`no .json fixtures in ${FIX} — run scripts/probe/build-fixtures.mjs first`);

const fixtures = [];
for (const f of files) {
  const raw = JSON.parse(await readFile(path.join(FIX, f), 'utf8'));
  const transcript = Array.isArray(raw) ? raw : raw.transcript;
  fixtures.push({
    id: raw.ple_id || f.replace(/\.json$/, ''),
    flattened: flattenForPrompt(transcript, deriveHintTokens(raw.patient_ref ?? null)),
  });
}

function extractScores(text) {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const out = {};
  for (const d of DOMAINS) {
    const v = parsed[d];
    if (!Number.isInteger(v) || v < 0 || v > 5) return null;
    out[d] = v;
  }
  return out;
}

async function localArm(fx) {
  const r = await chatCompletion(cfg, {
    systemPrompt: PIS7_EVALUATOR_PROMPT,
    messages: [{ role: 'user', content: `TRANSCRIPT:\n${fx.flattened}` }],
    maxTokens: 4096, temperature: 0,
  });
  return { scores: extractScores(r.text ?? ''), ms: r.ms };
}

async function cloudArm(fx) {
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLOUD_MODEL, max_tokens: 4096, temperature: 0,
      system: PIS7_EVALUATOR_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${fx.flattened}` }],
    }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { scores: null, ms, error: `${res.status} ${(await res.text()).slice(0, 120)}` };
  const j = await res.json();
  return { scores: extractScores(j.content?.map((c) => c.text).join('') ?? ''), ms };
}

const sd = (a) => {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

hr('repeat consistency — the noise floor under any agreement number');
if (ARM !== 'cloud') console.log(`  local   ${cfg.model}  @ ${cfg.baseUrl}`);
if (ARM !== 'local') console.log(`  cloud   ${CLOUD_MODEL}  @ api.anthropic.com`);
console.log(`  arms    ${ARM}`);
console.log(`  design  ${fixtures.length} fixture(s) × ${REPEATS} repeats, temperature 0, IDENTICAL prompt each time`);
console.log(`  split   ${split ? `${split.name} (reserved ${split.reserved_at})` : '(none reserved)'}  ·  prompt ${PROMPT_VERSION}`);
console.log(`\n  ${dim('Any spread below is the model disagreeing with ITSELF. An agreement Σ|Δ| at or')}`);
console.log(`  ${dim('below this level carries no signal.')}\n`);

const results = [];
for (const fx of fixtures) {
  for (const arm of (ARM === 'both' ? ['cloud', 'local'] : [ARM])) {
    const runs = [];
    process.stdout.write(`  ${fx.id} · ${arm.padEnd(5)} `);
    for (let i = 0; i < REPEATS; i++) {
      const r = arm === 'local' ? await localArm(fx) : await cloudArm(fx);
      runs.push(r);
      process.stdout.write(r.scores ? green('•') : red('×'));
    }
    const good = runs.filter((r) => r.scores);
    console.log(`  ${good.length}/${REPEATS} parsed`);
    results.push({ fixture: fx.id, arm, runs: good.map((r) => r.scores), ms: runs.map((r) => r.ms) });
  }
}

for (const r of results) {
  hr(`${r.fixture} · ${r.arm}`);
  if (r.runs.length < 2) { console.log(`  ${red('too few parsed runs to measure spread')}`); continue; }
  console.log(`  domain   ${Array.from({ length: r.runs.length }, (_, i) => `r${i + 1}`).join('  ')}   range   sd`);
  console.log(`  ──────   ${r.runs.map(() => '──').join('  ')}   ─────   ────`);
  let identical = true;
  for (const d of DOMAINS) {
    const vals = r.runs.map((s) => s[d]);
    const range = Math.max(...vals) - Math.min(...vals);
    if (range > 0) identical = false;
    const mark = range === 0 ? green(' 0') : (range >= 2 ? red(String(range).padStart(2)) : yellow(String(range).padStart(2)));
    console.log(`  ${d}       ${vals.map((v) => String(v).padStart(2)).join('  ')}   ${mark}    ${sd(vals).toFixed(2)}`);
  }
  const comps = r.runs.map((s) => DOMAINS.reduce((a, d) => a + s[d], 0));
  const compRange = Math.max(...comps) - Math.min(...comps);
  console.log(`  ${bold('composite')} ${comps.map((v) => String(v).padStart(2)).join('  ')}   ${String(compRange).padStart(2)}    ${sd(comps).toFixed(2)}`);
  // Worst-case Σ|Δ| attributable to this arm alone: sum of per-domain ranges.
  const sigma = DOMAINS.reduce((a, d) => { const v = r.runs.map((s) => s[d]); return a + (Math.max(...v) - Math.min(...v)); }, 0);
  console.log(`\n  ${identical ? green('identical across all repeats — this arm contributes no noise')
    : `${bold(`noise floor Σ|Δ| = ${sigma}`)} ${dim('(sum of per-domain ranges: the largest Σ|Δ| this arm alone can produce)')}`}`);
  const avg = r.ms.reduce((a, b) => a + b, 0) / r.ms.length / 1000;
  console.log(`  ${dim(`mean latency ${avg.toFixed(1)}s`)}`);
}

hr('how to read this');
console.log('  An agreement run reports Σ|Δ| between local and cloud. The two arms\' noise floors add:');
console.log('  a Σ|Δ| below (local floor + cloud floor) is consistent with both models being stable');
console.log('  and telling you nothing. Only Σ|Δ| clearly ABOVE that sum is evidence of real');
console.log('  divergence between the two models.\n');
console.log(`  ${dim('This measures repeatability, not correctness. A model can be perfectly repeatable')}`);
console.log(`  ${dim('and consistently wrong; that is Gate 0.5, which needs human raters.')}\n`);

if (OUT) {
  await writeFile(OUT, JSON.stringify({ split, prompt_version: PROMPT_VERSION, cloudModel: CLOUD_MODEL, localModel: cfg?.model ?? null, repeats: REPEATS, results }, null, 2));
  console.log(`  wrote ${OUT}\n`);
}
