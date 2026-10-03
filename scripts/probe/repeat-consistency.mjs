#!/usr/bin/env node
/*
 * Noise floor: how much does ONE model's PIS-7 score move when you ask it the SAME question twice?
 *
 * WHY THIS EXISTS. model-agreement.mjs reports Σ|Δ| between the local model and Sonnet. That number
 * is only interpretable against a baseline: if a single model re-scoring the same transcript already
 * moves by 4 points, then a local-vs-cloud Σ|Δ| of 4 is indistinguishable from noise and means
 * nothing. Observed in the wild: PLE-002 scored Σ|Δ| 3 in a smoke run and Σ|Δ| 10 in the full run,
 * same fixture, temperature 0 on the local arm (the cloud arm sends what production sends: on
 * claude-sonnet-5-5 no temperature at all, because a non-default value is a 400 there).
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

import { pis7PromptFor, PIS7_LOCAL_ADDENDUM } from '../../rimpl/src/lib/prompts.js';
import { PROMPT_VERSION, promptVersionFor } from '../../rimpl/src/lib/versions.js';
// The production self-consistency rule, injected with this script's own model call, so repeatability can
// be measured UNDER each rule (off / adaptive / median3) rather than only for single calls.
import { scoreWithConsistency } from '../../rimpl/src/services/consistency.js';
import { applySplit } from './split.mjs';
import { parseJsonObject } from '../../rimpl/src/lib/parse.js';
import { flattenForPrompt } from '../../rimpl/src/lib/transcript.js';
import { requestShape } from '../../rimpl/src/lib/anthropic-request.js';
import { evalMaxTokensFor } from '../../rimpl/src/lib/eval-decoding.js';
import { deriveHintTokens } from '../../rimpl/src/services/pii-filter.js';
import { compositeSpread } from './agreement-stats.mjs';

const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const argNum = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? Number(process.argv[i + 1]) : d; };
const argStr = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };

const ARM = argStr('arm', 'both');
const REPEATS = argNum('repeats', 5);
const NFIX = argNum('fixtures', 1);
const OUT = argStr('out');
// --consistency off|adaptive|median3: each "repeat" is then one full rule evaluation (2–3 model calls), so the
// spread measures what production would actually emit. --agree-sum N adds Σ|Δ| ≤ N to the pair rule (0 = off).
const CONSISTENCY = argStr('consistency', 'off');
if (!['off', 'adaptive', 'median3'].includes(CONSISTENCY)) fail(`--consistency must be off, adaptive or median3, got ${CONSISTENCY}`);
const AGREE_SUM = argNum('agree-sum', 0);
// --addendum on|off. The local addendum is a module constant, so without this flag a run always
// carries whatever the working tree happens to hold — and the v0 baseline (2026-09-02) was recorded
// BEFORE the addendum existed. Comparing a fresh run against it while the addendum is on changes two
// variables at once and answers neither question. Default stays `on` (what production would send).
const ADDENDUM = argStr('addendum', 'on');
if (!['on', 'off'].includes(ADDENDUM)) fail(`--addendum must be on or off, got ${ADDENDUM}`);
const ADDENDUM_ON = ADDENDUM === 'on';
const LOCAL_PROMPT = pis7PromptFor('local', ADDENDUM_ON ? PIS7_LOCAL_ADDENDUM : '');
const CLOUD_PROMPT = pis7PromptFor('anthropic');
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
  // The MODEL constant itself, not the first claude-* string in the file: the pin's comment names
  // other ids (the previous model, rejected snapshot candidates), and a first-match regex would pick one.
  const m = src.match(/const MODEL = '(claude-[a-z0-9.-]+)'/);
  if (!m) fail(`no MODEL constant found in ${p} — cannot confirm which model production uses.`);
  return m[1];
})();
// The body production's /evaluate sends for that model (thinking mode and effort for the `evaluate`
// purpose; temperature only where the model accepts it) and its max_tokens, from the same modules the
// provider and the route read. claude-sonnet-5-5 400s on temperature 0, so the cloud arm runs at the
// API default, adaptive thinking at effort high, max_tokens 16000. Throws for an undeclared model.
let CLOUD_SHAPE;
try { CLOUD_SHAPE = requestShape(CLOUD_MODEL, { temperature: 0, purpose: 'evaluate' }); } catch (e) { fail(e.message); }
const CLOUD_MAX_TOKENS = evalMaxTokensFor('anthropic');
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
  let parsed;
  try { parsed = parseJsonObject(text); } catch { return null; } // malformed JSON is a measurement, not a crash
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
  const t0 = Date.now();
  const rawCall = async () => chatCompletion(cfg, {
    systemPrompt: LOCAL_PROMPT,
    messages: [{ role: 'user', content: `TRANSCRIPT:\n${fx.flattened}` }],
    maxTokens: 4096, temperature: 0,
  });
  const callOnce = async () => {
    const r = await chatCompletion(cfg, {
      systemPrompt: LOCAL_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${fx.flattened}` }],
      maxTokens: 4096, temperature: 0,
    });
    return { text: r.text ?? '', inputTokens: r.promptTokens ?? 0, outputTokens: r.completionTokens ?? 0 };
  };
  if (CONSISTENCY === 'off') {
    // Keep the TRANSPORT result distinct from the PARSE result: a timeout or HTTP error must never be
    // recorded as "the model returned something unparseable" — that would credit the box's slowness to
    // the model's contract rate. (This cost an hour: three fixtures read 0/5 'unparseable' when they
    // were 600 s timeouts caused by two probe runs sharing one box.)
    const r = await rawCall();
    if (!r.ok) return { scores: null, ms: Date.now() - t0, calls: 1, error: `transport ${r.status || ''}`.trim() };
    return { scores: extractScores(r.text ?? ''), ms: Date.now() - t0, calls: 1, error: r.text ? null : 'empty reply' };
  }
  try {
    const res = await scoreWithConsistency({ callOnce, mode: CONSISTENCY, jsonRetries: 2, agree: { maxDomainDelta: 1, maxSumDelta: AGREE_SUM } });
    const scores = Object.fromEntries(DOMAINS.map((d) => [d, res.scores[d]]));
    return { scores, ms: Date.now() - t0, calls: res.consistency?.calls ?? null, rule: res.consistency?.rule ?? null };
  } catch (e) {
    return { scores: null, ms: Date.now() - t0, calls: null, error: e.code ?? e.name ?? 'error' }; // never a model reply
  }
}

async function cloudArm(fx) {
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLOUD_MODEL, max_tokens: CLOUD_MAX_TOKENS, ...CLOUD_SHAPE.fields,
      system: CLOUD_PROMPT,
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
console.log(`  design  ${fixtures.length} fixture(s) × ${REPEATS} repeats, temperature 0 local / ${CLOUD_SHAPE.sent.temperature ?? 'API default'} cloud, IDENTICAL prompt each time`);
if (ARM !== 'local') console.log(`  cloud   thinking ${CLOUD_SHAPE.sent.thinking ?? 'none'} · effort ${CLOUD_SHAPE.sent.effort ?? 'API default'} · max_tokens ${CLOUD_MAX_TOKENS}`);
console.log(`  rule    local arm consistency = ${CONSISTENCY}${CONSISTENCY !== 'off' ? ` (agree: maxΔ ≤ 1${AGREE_SUM ? `, Σ|Δ| ≤ ${AGREE_SUM}` : ''}) — each repeat is one full rule evaluation` : ' (single calls)'}`);
console.log(`  split   ${split ? `${split.name} (reserved ${split.reserved_at})` : '(none reserved)'}  ·  prompt ${PROMPT_VERSION} (local ${promptVersionFor('local')}${ADDENDUM_ON && PIS7_LOCAL_ADDENDUM ? ', addendum ON' : ', addendum OFF'})`);
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
    const callsUsed = runs.map((r) => r.calls ?? '×');
    const errs = [...new Set(runs.map((r) => r.error).filter(Boolean))];
    console.log(`  ${good.length}/${REPEATS} parsed${CONSISTENCY !== 'off' && arm === 'local' ? `   calls ${callsUsed.join(',')}` : ''}`
      + (errs.length ? `   ${yellow(errs.join(', '))}` : '')
      + (good.length < REPEATS ? dim(`   mean ${Math.round(runs.reduce((a, r) => a + r.ms, 0) / runs.length / 1000)}s`) : ''));
    // `errors` carries the transport/parse distinction into the REPORT, not just the console. Without it
    // a consumer can only compare runs.length against ms.length, which reads every box timeout as a
    // model that broke its JSON contract — the exact mistake the comment in localArm() warns about, and
    // the one screening-verdict.mjs was making (it charged 4 transport failures to parseability, turning
    // a clean 86/86 into a reported 95.4% and inventing a gate blocker).
    results.push({ fixture: fx.id, arm, runs: good.map((r) => r.scores), ms: runs.map((r) => r.ms),
      calls: runs.map((r) => r.calls ?? null), errors: runs.map((r) => r.error ?? null) });
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
  // Production's weighted composite (agreement-stats.mjs), not the d1..d7 sum this row showed until
  // 2026-10. It is on the 0–100 scale, so its range is NOT comparable with the 0–5 domain ranges above.
  const comp = compositeSpread(r.runs);
  console.log(`  ${bold('composite')} ${comp.composites.map((v) => String(v).padStart(2)).join('  ')}   ${String(comp.range).padStart(2)}`
    + `    ${comp.sd == null ? '—' : comp.sd.toFixed(2)}   ${dim('weighted ×20, 0–100')}`);
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
  await writeFile(OUT, JSON.stringify({ split, prompt_version: PROMPT_VERSION, local_prompt_version: promptVersionFor('local'), addendum: ADDENDUM, consistency: CONSISTENCY, agree_sum: AGREE_SUM, cloudModel: CLOUD_MODEL, localModel: cfg?.model ?? null, repeats: REPEATS, results }, null, 2));
  console.log(`  wrote ${OUT}\n`);
}
