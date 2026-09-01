#!/usr/bin/env node
/*
 * Concurrency ceiling for the REAL PIS-7 workload — not a toy prompt.
 *
 * WHY A SECOND RAMP. throughput.mjs found a knee at concurrency 16, but it sent a 150-char prompt
 * with max_tokens 512: ~550 tokens of KV cache per sequence. A PIS-7 evaluation sends a whole
 * transcript (p50 ~2,435 input tokens, max ~7,346) and generates ~595, so it holds ~5.5x more cache
 * per request. KV cache is consumed per TOKEN HELD, not per request, so the PIS-7 knee must be far
 * lower. Sizing rimpl's LOCAL_MAX_CONCURRENCY off the toy number would overcommit the GPU and push
 * every request past the timeout at once.
 *
 * IT ALSO TESTS max_tokens. Nothing in 26 real calls exceeded 920 output tokens and finish_reason was
 * 'stop' 26/26, so the configured 4096 is ~4.5x oversized. Whether trimming it buys concurrency is
 * server-dependent (a scheduler that reserves worst-case KV benefits; one that pages on demand does
 * not), so it is measured rather than assumed.
 *
 * TIMEOUT IS THE REAL LIMIT, NOT THE KNEE. rimpl gives up at LOCAL_AI_TIMEOUT_MS (85s) and the
 * backend at RIMPL_EVAL_TIMEOUT_MS (100s). A concurrency level whose p95 exceeds those is useless in
 * production however good its aggregate throughput looks, so both lines are drawn on the output.
 *
 * ============================================================================================
 * IT PRINTS NO TRANSCRIPT TEXT. Latencies, token counts and fixture ids only.
 * ============================================================================================
 *
 *   node scripts/probe/pis7-concurrency.mjs
 *   node scripts/probe/pis7-concurrency.mjs --levels 1,2,4 --max-tokens 1024
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { PROBE_DIR, REPO_ROOT, bold, dim, red, green, yellow, hr, fail, readConfig, chatCompletion, percentile } from './lib.mjs';
import { PIS7_EVALUATOR_PROMPT } from '../../rimpl/src/lib/prompts.js';
import { parseJsonObject } from '../../rimpl/src/lib/parse.js';
import { flattenForPrompt } from '../../rimpl/src/lib/transcript.js';
import { deriveHintTokens } from '../../rimpl/src/services/pii-filter.js';

const DOMAINS = ['d1','d2','d3','d4','d5','d6','d7'];
const argStr = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i+1] : d; };
const LEVELS = (argStr('levels', '1,2,4,8')).split(',').map(Number).filter((n) => n > 0);
const MAXTOK = Number(argStr('max-tokens', '4096'));
const ABORT_P95_MS = Number(argStr('abort-p95', '300000'));

// rimpl's real budgets — the lines that decide whether a level is usable at all.
// READ FROM THE SOURCE, never hardcoded: an earlier version pinned 85s/100s, which were the values
// BEFORE providers/local.js raised its ceiling, and every "exceeds the timeout" verdict it printed
// was wrong by 65s. Defaults here mirror local.js:36 and rimpl-client.js:15.
const intFrom = (src, name, dflt) => {
  const m = src.match(new RegExp(`${name}['"]?\\s*,\\s*(\\d+)`)) || src.match(new RegExp(`${name}\\s*\\|\\|\\s*'(\\d+)'`));
  return m ? Number(m[1]) : dflt;
};
const localSrc = readFileSync(path.join(REPO_ROOT, 'rimpl/src/services/providers/local.js'), 'utf8');
const beSrc = readFileSync(path.join(REPO_ROOT, 'backend/src/services/rimpl-client.js'), 'utf8');
const LOCAL_AI_TIMEOUT_MS = Number(process.env.LOCAL_AI_TIMEOUT_MS) || intFrom(localSrc, 'LOCAL_AI_TIMEOUT_MS', 150000);
const RIMPL_EVAL_TIMEOUT_MS = Number(process.env.RIMPL_EVAL_TIMEOUT_MS) || intFrom(beSrc, 'RIMPL_EVAL_TIMEOUT_MS', 180000);

const cfg = readConfig();
const FIX = path.join(PROBE_DIR, 'fixtures');
const files = (await readdir(FIX).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
if (!files.length) fail(`no fixtures in ${FIX}`);
const fixtures = [];
for (const f of files) {
  const raw = JSON.parse(await readFile(path.join(FIX, f), 'utf8'));
  fixtures.push({
    id: raw.ple_id || f.replace(/\.json$/, ''),
    flattened: flattenForPrompt(Array.isArray(raw) ? raw : raw.transcript, deriveHintTokens(raw.patient_ref ?? null)),
  });
}

function validScores(text) {
  const p = parseJsonObject(text);
  if (!p) return false;
  return DOMAINS.every((d) => Number.isInteger(p[d]) && p[d] >= 0 && p[d] <= 5);
}

async function one(fx) {
  const r = await chatCompletion(cfg, {
    systemPrompt: PIS7_EVALUATOR_PROMPT,
    messages: [{ role: 'user', content: `TRANSCRIPT:\n${fx.flattened}` }],
    maxTokens: MAXTOK, temperature: 0,
  });
  return { ok: r.ok !== false && validScores(r.text ?? ''), ms: r.ms,
           out: r.completionTokens || 0, inTok: r.promptTokens || 0, err: r.error || null };
}

hr('PIS-7 concurrency ceiling (real transcripts, real prompt)');
console.log(`  model       ${cfg.model} @ ${cfg.baseUrl}`);
console.log(`  max_tokens  ${MAXTOK}${MAXTOK === 4096 ? dim('   (production default; measured max reply was 920)') : ''}`);
console.log(`  levels      ${LEVELS.join(', ')}`);
console.log(`  payload     ${fixtures.length} real fixtures, cycled`);
console.log(`  probe timeout ${cfg.timeoutMs} ms ${dim('(a recorded latency ABOVE this means the abort did not fire — treat as suspect)')}`);
console.log(`\n  ${dim(`rimpl LOCAL_AI_TIMEOUT_MS ${LOCAL_AI_TIMEOUT_MS/1000}s · backend RIMPL_EVAL_TIMEOUT_MS ${RIMPL_EVAL_TIMEOUT_MS/1000}s`)}`);
console.log(`  ${dim('warm-up call first (discarded — first call pays load/priming)')}\n`);

await one(fixtures[0]);

const results = [];
for (const conc of LEVELS) {
  const n = Math.max(conc * 2, 4);
  const batch = Array.from({ length: n }, (_, i) => fixtures[i % fixtures.length]);
  const t0 = Date.now();
  const out = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (cursor < batch.length) { const fx = batch[cursor++]; out.push(await one(fx)); }
  }));
  const wall = Date.now() - t0;
  const ok = out.filter((r) => r.ok);
  // Print every failure. An earlier version swallowed r.err, which made a 956s outlier and two
  // failures undiagnosable — the exact information needed to tell "GPU busy" from "our bug" apart.
  for (const r of out.filter((x) => !x.ok)) {
    console.log(`      ${red('fail')} ${(r.ms/1000).toFixed(0)}s  ${r.err ? String(r.err).slice(0,140) : 'parsed but scores invalid/incomplete'}`);
  }
  const slow = out.filter((r) => r.ok && r.ms > LOCAL_AI_TIMEOUT_MS);
  for (const r of slow) console.log(`      ${yellow('slow')} ${(r.ms/1000).toFixed(0)}s  ok but past rimpl's ${LOCAL_AI_TIMEOUT_MS/1000}s budget`);
  const lat = out.map((r) => r.ms);
  const p50 = percentile(lat, 50), p95 = percentile(lat, 95);
  const agg = ok.reduce((a, r) => a + r.out, 0) / (wall / 1000);
  results.push({ conc, n, ok: ok.length, fail: out.length - ok.length, p50, p95, agg });
  const usable = p95 <= LOCAL_AI_TIMEOUT_MS;
  console.log(`  conc ${String(conc).padStart(2)}  n=${String(n).padStart(2)}  ok ${String(ok.length).padStart(2)}/${n}`
    + `  p50 ${String(Math.round(p50/1000)).padStart(3)}s  p95 ${String(Math.round(p95/1000)).padStart(3)}s`
    + `  agg ${agg.toFixed(1).padStart(5)} tok/s   `
    + (usable ? green('within rimpl timeout') : red(`p95 EXCEEDS ${LOCAL_AI_TIMEOUT_MS/1000}s timeout`)));
  if (p95 > ABORT_P95_MS || ok.length === 0) { console.log(`  ${yellow('stopping ramp — higher levels would measure the failure mode, not capacity')}`); break; }
}

hr('where does it saturate?');
for (let i = 1; i < results.length; i++) {
  const a = results[i-1], b = results[i];
  const d = (b.agg - a.agg) / a.agg;
  console.log(`  ${String(a.conc).padStart(2)} → ${String(b.conc).padStart(2)}   agg ${(d*100>=0?'+':'')}${(d*100).toFixed(0)}%   p95 ${((b.p95-a.p95)/a.p95*100).toFixed(0)}%   ${d < 0.15 ? bold('◀ flat') : '· scaling'}`);
}
const usableLevels = results.filter((r) => r.p95 <= LOCAL_AI_TIMEOUT_MS && r.fail === 0);
hr('what to put in rimpl');
if (!usableLevels.length) {
  console.log(`  ${red('NO tested concurrency keeps p95 inside rimpl\'s 85s timeout.')}`);
  console.log('  Even serial PIS-7 calls are slower than the configured budget. LOCAL_AI_TIMEOUT_MS and');
  console.log('  RIMPL_EVAL_TIMEOUT_MS must both rise before any local evaluation can complete — raising');
  console.log('  only one makes the outer timeout fire first and hides the cause.\n');
} else {
  const best = usableLevels[usableLevels.length - 1];
  console.log(`  LOCAL_MAX_CONCURRENCY=${best.conc}   ${dim(`(highest level with p95 ${Math.round(best.p95/1000)}s inside the 85s budget and 0 failures)`)}`);
  console.log(`  ${dim('providers/local.js defaults to 24 — a placeholder, not a measurement.')}\n`);
}
