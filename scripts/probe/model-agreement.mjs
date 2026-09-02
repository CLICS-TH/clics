#!/usr/bin/env node
/*
 * Paired PIS-7 agreement: the on-prem model vs Claude Sonnet, on the SAME transcripts.
 *
 * WHAT THIS IS NOT. It is not Gate 4. Gate 4 asks whether the local model agrees with REAL HUMAN
 * AUDITORS, and that number cannot be computed yet: production has 14 human scores from 4 auditors
 * across 12 PLEs, and ZERO PLEs carry the three blinded raters CREC082 §6.5 requires. Until Gate 0.5
 * establishes the human baseline, two models agreeing with each other says nothing about either one
 * being right — they can agree perfectly and both be wrong. LOCAL-MODEL-ROADMAP.md is explicit:
 * "If Claude misses, the credit gate fails for the incumbent and 'local vs Claude' was never the
 * interesting question."
 *
 * WHAT IT IS. The engineering question underneath the research one: *if we swapped the evaluator,
 * would the scores move?* A large per-domain shift means the cutover changes what a physician is
 * told, independent of which model is closer to the truth. That is worth knowing before anyone
 * signs a Model Lock, and it is answerable today with the access we have.
 *
 * WHY NOW. DGX reachability currently runs through a personal session token on a machine the project
 * does not control. Measure while the door is open.
 *
 * ============================================================================================
 * IT PRINTS NO TRANSCRIPT TEXT. Fixtures are de-identified PLEs, but de-identified is not public.
 * Output is scores, deltas and fixture ids.
 * ============================================================================================
 *
 *   node scripts/probe/model-agreement.mjs                 # both arms
 *   node scripts/probe/model-agreement.mjs --limit 5       # cheap smoke
 *   node scripts/probe/model-agreement.mjs --out cmp.json
 *
 * Local arm reads LOCAL_AI_* exactly as the other probes do. Cloud arm reads ANTHROPIC_API_KEY from
 * rimpl/.env (gitignored) and calls the SAME model rimpl calls, so this compares the two providers
 * as configured, not two hypothetical ones.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PROBE_DIR, REPO_ROOT, RIMPL_DIR, bold, dim, red, green, yellow, cyan, hr, fail,
  readConfig, chatCompletion, percentile } from './lib.mjs';

// Single-source from rimpl — never copied. Same imports json-contract.mjs uses.
import { PIS7_EVALUATOR_PROMPT } from '../../rimpl/src/lib/prompts.js';
import { PROMPT_VERSION } from '../../rimpl/src/lib/versions.js';
import { applySplit } from './split.mjs';
import { parseJsonObject } from '../../rimpl/src/lib/parse.js';
import { flattenForPrompt } from '../../rimpl/src/lib/transcript.js';
import { deriveHintTokens } from '../../rimpl/src/services/pii-filter.js';

const rimplRequire = createRequire(path.join(RIMPL_DIR, 'package.json'));
const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

const argNum = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? Number(process.argv[i + 1]) : d; };
const argStr = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const LIMIT = argNum('limit', Infinity);

// --- cloud arm config -------------------------------------------------------------------------
const env = Object.fromEntries(
  (await readFile(path.join(RIMPL_DIR, '.env'), 'utf8').catch(() => ''))
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
// The model rimpl actually runs. Read from the provider module rather than hardcoded, so this cannot
// drift into comparing against a model production does not use.
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
if (!ANTHROPIC_KEY) fail('No ANTHROPIC_API_KEY (checked env and rimpl/.env). The cloud arm cannot run.');

const cfg = readConfig();

// --- fixtures ---------------------------------------------------------------------------------
const FIX = path.join(PROBE_DIR, 'fixtures');
const SPLIT_NAME = argStr('split');
let files = (await readdir(FIX).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
const { files: splitFiles, split } = await applySplit(files, SPLIT_NAME, { fixturesDir: FIX });
files = splitFiles.slice(0, LIMIT);
if (!files.length) fail(`no .json fixtures in ${FIX} — run scripts/probe/build-fixtures.mjs first`);

const fixtures = [];
for (const f of files) {
  const raw = JSON.parse(await readFile(path.join(FIX, f), 'utf8'));
  const transcript = Array.isArray(raw) ? raw : raw.transcript;
  fixtures.push({
    id: (raw.ple_id || f.replace(/\.json$/, '')),
    flattened: flattenForPrompt(transcript, deriveHintTokens(raw.patient_ref ?? null)),
  });
}

// --- the two arms -----------------------------------------------------------------------------
function extractScores(text) {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const out = {};
  for (const d of DOMAINS) {
    const v = parsed[d];
    if (!Number.isInteger(v) || v < 0 || v > 5) return null;   // same bar evaluate.js applies
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
  return { scores: extractScores(j.content?.map((c) => c.text).join('') ?? ''), ms, usage: j.usage };
}

// --- ICC(A,1): two-way mixed, absolute agreement, single measure -------------------------------
// The statistic CREC082 §8.2 names for AI-vs-reference. Two raters here (the two models), n targets.
// Written out rather than pulled from a library so the formula is auditable next to the number.
function iccA1(pairs) {
  const n = pairs.length; if (n < 2) return null;
  const k = 2;
  const grand = pairs.flat().reduce((a, b) => a + b, 0) / (n * k);
  const rowMeans = pairs.map((p) => (p[0] + p[1]) / 2);
  const colMeans = [0, 1].map((j) => pairs.reduce((a, p) => a + p[j], 0) / n);
  const MSR = (k * rowMeans.reduce((a, m) => a + (m - grand) ** 2, 0)) / (n - 1);
  const MSC = (n * colMeans.reduce((a, m) => a + (m - grand) ** 2, 0)) / (k - 1);
  let sse = 0;
  pairs.forEach((p, i) => p.forEach((v, j) => { sse += (v - rowMeans[i] - colMeans[j] + grand) ** 2; }));
  const MSE = sse / ((n - 1) * (k - 1));
  const denom = MSR + (k - 1) * MSE + (k * (MSC - MSE)) / n;
  return denom === 0 ? null : (MSR - MSE) / denom;
}

// --- run --------------------------------------------------------------------------------------
hr('paired PIS-7 agreement');
console.log(`  local   ${cfg.model}  @ ${cfg.baseUrl}`);
console.log(`  cloud   ${CLOUD_MODEL}  @ api.anthropic.com`);
console.log(`  prompt  PIS7_EVALUATOR_PROMPT (${PIS7_EVALUATOR_PROMPT.length} chars, imported from rimpl)`);
console.log(`  n       ${fixtures.length} fixture(s), temperature 0 both arms`);
console.log(`  split   ${split ? `${split.name} (reserved ${split.reserved_at})` : '(none reserved)'}  ·  prompt ${PROMPT_VERSION}\n`);
console.log(`  ${dim('NOT Gate 4 — no human baseline exists yet. See the header of this file.')}\n`);

const rows = [];
for (const fx of fixtures) {
  // Cloud first: it is fast and cheap, so a schema/auth problem surfaces before a 70s local call.
  const cloud = await cloudArm(fx);
  const local = await localArm(fx);
  const ok = cloud.scores && local.scores;
  rows.push({ id: fx.id, local: local.scores, cloud: cloud.scores, localMs: local.ms, cloudMs: cloud.ms });
  const delta = ok
    ? DOMAINS.reduce((a, d) => a + Math.abs(local.scores[d] - cloud.scores[d]), 0)
    : null;
  console.log(`  ${ok ? green('✔') : red('✘')} ${fx.id.padEnd(10)}`
    + `  local ${(local.ms / 1000).toFixed(1)}s  cloud ${(cloud.ms / 1000).toFixed(1)}s`
    + (ok ? `  Σ|Δ| ${delta}` : `  ${red(cloud.scores ? 'local unparseable' : (cloud.error || 'cloud unparseable'))}`));
}

const paired = rows.filter((r) => r.local && r.cloud);
hr('per-domain');
console.log('  domain   local mean   cloud mean      Δ mean   |Δ| mean   exact   within 1   ICC(A,1)');
console.log('  ──────   ──────────   ──────────   ─────────   ────────   ─────   ────────   ────────');
for (const d of DOMAINS) {
  const L = paired.map((r) => r.local[d]), C = paired.map((r) => r.cloud[d]);
  const diffs = L.map((v, i) => v - C[i]);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const icc = iccA1(paired.map((r) => [r.local[d], r.cloud[d]]));
  console.log(`  ${d.padEnd(8)} ${mean(L).toFixed(2).padStart(10)} ${mean(C).toFixed(2).padStart(12)}`
    + ` ${mean(diffs).toFixed(2).padStart(11)} ${mean(diffs.map(Math.abs)).toFixed(2).padStart(10)}`
    + ` ${String(diffs.filter((x) => x === 0).length).padStart(5)}`
    + ` ${String(diffs.filter((x) => Math.abs(x) <= 1).length).padStart(10)}`
    + ` ${(icc === null ? '—' : icc.toFixed(3)).padStart(10)}`);
}

const compL = paired.map((r) => DOMAINS.reduce((a, d) => a + r.local[d], 0));
const compC = paired.map((r) => DOMAINS.reduce((a, d) => a + r.cloud[d], 0));
const compDiff = compL.map((v, i) => v - compC[i]);
const iccComp = iccA1(paired.map((_, i) => [compL[i], compC[i]]));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => Math.sqrt(a.reduce((s, v) => s + (v - mean(a)) ** 2, 0) / (a.length - 1));

hr('composite (sum of d1..d7, unweighted)');
console.log(`  local  mean ${mean(compL).toFixed(2)}   cloud mean ${mean(compC).toFixed(2)}`);
console.log(`  bias   ${mean(compDiff) >= 0 ? '+' : ''}${mean(compDiff).toFixed(2)} (local − cloud)`);
console.log(`  Bland–Altman limits of agreement  ${(mean(compDiff) - 1.96 * sd(compDiff)).toFixed(2)}`
  + ` … ${(mean(compDiff) + 1.96 * sd(compDiff)).toFixed(2)}`);
console.log(`  ICC(A,1) composite  ${iccComp === null ? '—' : iccComp.toFixed(3)}`);

hr('latency');
console.log(`  local  p50 ${(percentile(rows.map((r) => r.localMs), 50) / 1000).toFixed(1)}s`
  + `   cloud p50 ${(percentile(rows.map((r) => r.cloudMs), 50) / 1000).toFixed(1)}s`);

hr('how to read this');
console.log(`  ${dim('ICC near 1  = the two models score the same PLEs the same way; a swap moves little.')}`);
console.log(`  ${dim('ICC near 0  = they rank PLEs differently; the cutover changes what physicians are told.')}`);
console.log(`  ${dim('bias        = a systematic offset. A constant offset is re-calibratable; scatter is not.')}`);
console.log(`  ${dim('NEITHER tells you which model is closer to a human auditor. That is Gate 0.5, and it')}`);
console.log(`  ${dim('needs 3 blinded raters per PLE — production currently has 0 PLEs at that bar.')}\n`);

const outFile = argStr('out');
if (outFile) {
  await (await import('node:fs/promises')).writeFile(outFile, JSON.stringify({
    split, prompt_version: PROMPT_VERSION,
    localModel: cfg.model, cloudModel: CLOUD_MODEL, n: paired.length, rows,
  }, null, 2));
  console.log(`  report → ${outFile}\n`);
}
