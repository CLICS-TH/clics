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
import { pis7PromptFor, PIS7_LOCAL_ADDENDUM } from '../../rimpl/src/lib/prompts.js';
import { PROMPT_VERSION, promptVersionFor } from '../../rimpl/src/lib/versions.js';
// The production self-consistency rule, injected with this script's own model call — so a tuning run
// measures exactly what rimpl's /evaluate would do, not a re-implementation of it.
import { scoreWithConsistency, MODES } from '../../rimpl/src/services/consistency.js';
import { applySplit } from './split.mjs';
import { parseJsonObject } from '../../rimpl/src/lib/parse.js';
import { flattenForPrompt } from '../../rimpl/src/lib/transcript.js';
import { requestShape } from '../../rimpl/src/lib/anthropic-request.js';
import { deriveHintTokens } from '../../rimpl/src/services/pii-filter.js';
// Production's weighted composite and ICC(A,1) estimator — see agreement-stats.mjs for why they are shared.
import { compositeAgreement, domainAgreement } from './agreement-stats.mjs';

const rimplRequire = createRequire(path.join(RIMPL_DIR, 'package.json'));
const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

const argNum = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? Number(process.argv[i + 1]) : d; };
const argStr = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const LIMIT = argNum('limit', Infinity);
// --consistency off|adaptive: 'adaptive' runs the local arm through rimpl's scoreWithConsistency (2 calls,
// a 3rd + per-domain median when any domain differs by >1). The cloud arm is always a single call — it
// is the incumbent as production runs it.
const CONSISTENCY = argStr('consistency') ?? 'off';
// A transport failure costs a fixture, and fixtures are not lost at random (see withRetry).
const ARM_ATTEMPTS = Math.max(1, argNum('attempts', 3));
const RETRY_BASE_MS = Math.max(0, argNum('retry-base-ms', 15000));
if (!MODES.includes(CONSISTENCY)) fail(`--consistency must be one of ${MODES.join(', ')}, got ${CONSISTENCY}`);
const LOCAL_PROMPT = pis7PromptFor('local');   // base prompt + the local addendum once E2 fills it in
const CLOUD_PROMPT = pis7PromptFor('anthropic');

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
  // The MODEL constant itself, not the first claude-* string in the file: the pin's comment names
  // other ids (the previous model, rejected snapshot candidates), and a first-match regex would pick one.
  const m = src.match(/const MODEL = '(claude-[a-z0-9.-]+)'/);
  if (!m) fail(`no MODEL constant found in ${p} — cannot confirm which model production uses.`);
  return m[1];
})();
// The body production sends for that model (thinking mode; temperature only where the model accepts
// it), from the same module the provider reads. claude-sonnet-5-5 400s on temperature 0, so the cloud
// arm runs at the API default, as rimpl's /evaluate now does. Throws for a model with no declared shape.
let CLOUD_SHAPE;
try { CLOUD_SHAPE = requestShape(CLOUD_MODEL, { temperature: 0 }); } catch (e) { fail(e.message); }
if (!ANTHROPIC_KEY) fail('No ANTHROPIC_API_KEY (checked env and rimpl/.env). The cloud arm cannot run.');

const cfg = readConfig();

// --- fixtures ---------------------------------------------------------------------------------
const FIX = path.join(PROBE_DIR, 'fixtures');
// --only ple-001[,ple-002]: restrict to named fixtures WITHIN the chosen split. A held-out sample
// cannot be replaced, so a canary proves the box on an already-spent tuning fixture first; the same
// flag re-runs a single fixture that a transport failure cost. It can only narrow a split, never
// cross one — the split filter still applies.
const ONLY = (argStr('only') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const SPLIT_NAME = argStr('split');
let files = (await readdir(FIX).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
const { files: splitFiles, split } = await applySplit(files, SPLIT_NAME, { fixturesDir: FIX });
// --only narrows WITHIN the split; it can never widen it, so a canary cannot reach held-out fixtures
// by accident. An id that is not in the chosen split is a hard error rather than a silent no-op.
let selected = splitFiles;
if (ONLY.length) {
  const inSplit = new Set(splitFiles.map((f) => f.replace(/\.json$/i, '').toLowerCase()));
  const missing = ONLY.filter((id) => !inSplit.has(id));
  if (missing.length) fail(`--only: ${missing.join(', ')} not in the ${SPLIT_NAME ?? 'full'} split`);
  selected = splitFiles.filter((f) => ONLY.includes(f.replace(/\.json$/i, '').toLowerCase()));
}
files = selected.slice(0, LIMIT);
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
  // parseJsonObject THROWS on malformed JSON (an unescaped quote inside a rationale did it once, from the
  // cloud arm). Unparseable is a measurement — it counts against that arm's contract rate — never a crash.
  let parsed;
  try { parsed = parseJsonObject(text); } catch { return null; }
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
  const t0 = Date.now();
  // chatCompletion NEVER throws: a timeout comes back as { ok:false, text:'' }. Pass that through and the
  // empty string parses to {}, fails the schema, and surfaces as Pis7ScoreError — indistinguishable from
  // the model emitting garbage. Mark it HERE, where ok is still visible, or the distinction is lost for good.
  let transport = null;
  const callOnce = async () => {
    const r = await chatCompletion(cfg, {
      systemPrompt: LOCAL_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${fx.flattened}` }],
      maxTokens: 4096, temperature: 0,
    });
    if (!r.ok) { transport = `transport ${r.status || ''}`.trim(); throw new Error(transport); }
    return { text: r.text ?? '', inputTokens: r.promptTokens ?? 0, outputTokens: r.completionTokens ?? 0 };
  };
  if (CONSISTENCY === 'off') {
    try {
      const r = await callOnce();
      const scores = extractScores(r.text);
      return { scores, ms: Date.now() - t0, consistency: null, error: scores ? null : 'unparseable' };
    } catch {
      return { scores: null, ms: Date.now() - t0, consistency: null, error: transport ?? 'unparseable' };
    }
  }
  try {
    // mode: CONSISTENCY — NOT a hardcoded 'adaptive'. It was hardcoded from a79f4d3 until 2026-09-04, so
    // every run before that stamped its --consistency flag into the report while actually running adaptive;
    // the "median3" run of 2026-09-04 was adaptive, and its ICC delta is re-run variance, not a rule effect.
    const res = await scoreWithConsistency({ callOnce, mode: CONSISTENCY, jsonRetries: 2 });
    const scores = Object.fromEntries(DOMAINS.map((d) => [d, res.scores[d]]));
    return { scores, ms: Date.now() - t0, consistency: res.consistency };
  } catch (e) {
    // Never echo a model reply here — only the error class.
    return { scores: null, ms: Date.now() - t0, error: transport ?? (e.code ?? e.name ?? 'error'), consistency: null };
  }
}

async function cloudArm(fx) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CLOUD_MODEL, max_tokens: 4096, ...CLOUD_SHAPE.fields,
        system: CLOUD_PROMPT,
        messages: [{ role: 'user', content: `TRANSCRIPT:\n${fx.flattened}` }],
      }),
    });
  } catch (e) {
    // Node's fetch throws a bare `TypeError: fetch failed` and puts the real reason in e.cause. The
    // previous handler dropped the cause AND reported ms:0, so six lost fixtures read "cloud TypeError
    // at 0.0s" — un-diagnosable, and not obviously retryable. Keep both.
    const why = e.cause?.code ?? e.cause?.message ?? e.code ?? e.name ?? 'error';
    return { scores: null, ms: Date.now() - t0, error: `transport ${why}`, retryable: true };
  }
  const ms = Date.now() - t0;
  if (!res.ok) {
    const body = (await res.text()).slice(0, 120);
    // 429 and 5xx are the API asking us to come back; 4xx otherwise is our request and will not improve.
    const retryable = res.status === 429 || res.status >= 500;
    return { scores: null, ms, error: `${retryable ? 'transport ' : ''}${res.status} ${body}`, retryable };
  }
  const j = await res.json();
  return { scores: extractScores(j.content?.map((c) => c.text).join('') ?? ''), ms, usage: j.usage };
}

// --- ICC(A,1): two-way, absolute agreement, single measure -------------------------------------
// The statistic CREC082 §8.2 names for AI-vs-reference. No private copy lives here any more. One was
// written out at this spot (and again in e2-compare.mjs) over the UNWEIGHTED d1..d7 sum, while the
// verdict tool used production's weighted composite and icc.js, so the same run read 0.726 here and
// 0.735 there, and only one of them had an interval. The parseability accounting already taught this
// lesson: re-implemented in three places, it gave three answers about one run. The probes now share
// production's estimator, through agreement-stats.mjs.

// --- run --------------------------------------------------------------------------------------
hr('paired PIS-7 agreement');
console.log(`  local   ${cfg.model}  @ ${cfg.baseUrl}`);
console.log(`  cloud   ${CLOUD_MODEL}  @ api.anthropic.com`);
console.log(`  prompt  pis7PromptFor: local ${LOCAL_PROMPT.length} chars (addendum ${PIS7_LOCAL_ADDENDUM ? 'ON' : 'empty'}) · cloud ${CLOUD_PROMPT.length} chars — imported from rimpl`);
console.log(`  rule    local arm consistency = ${CONSISTENCY}${CONSISTENCY === 'adaptive' ? ' (2 calls; 3rd + per-domain median when any domain differs by >1)' : ''}; cloud arm single call`);
console.log(`  n       ${fixtures.length} fixture(s), temperature 0 local / ${CLOUD_SHAPE.sent.temperature ?? 'API default'} cloud${CLOUD_SHAPE.sent.thinking ? `, cloud thinking ${CLOUD_SHAPE.sent.thinking}` : ''}`);
console.log(`  retry   up to ${ARM_ATTEMPTS} attempts per arm on transport failures, ${RETRY_BASE_MS / 1000}s backoff doubling`
  + `${ARM_ATTEMPTS === 1 ? red('  — OFF: lost fixtures bias ICC upward, see withRetry') : ''}`);
console.log(`  split   ${split ? `${split.name} (reserved ${split.reserved_at})` : '(none reserved)'}  ·  prompt ${PROMPT_VERSION} (local ${promptVersionFor('local')})\n`);
console.log(`  ${dim('NOT Gate 4 — no human baseline exists yet. See the header of this file.')}\n`);

const rows = [];
for (const fx of fixtures) {
  // Cloud first: it is fast and cheap, so a schema/auth problem surfaces before a 70s local call.
  // One bad fixture (transport error, malformed reply) must never end a one-hour run: it is a row, not a crash.
  // WHY THIS RETRIES. Infrastructure failures are not random across fixtures: a harder transcript is a
  // longer one, so it spends more time exposed to a flaky box and a rate-limited API, and it is also
  // the transcript the two models are most likely to disagree about. Dropping failed fixtures therefore
  // drops the DISAGREEING ones — measured 2026-09-04: the six fixtures lost in one run averaged
  // Σ|Δ| 5.2 against 3.6 for those that survived, and losing them moved composite ICC from 0.619 to
  // 0.803 on the same prompt and config. Without a retry the metric improves when the box gets worse.
  // (Those two are this file's old unweighted-sum figures; on the weighted composite it prints now, the
  // same two runs read 0.611 and 0.795 — the survivorship effect is the same size.)
  //
  // Only transport-class failures retry. A reply the model could not make valid must still count
  // against it — see scripts/probe/parseability.mjs.
  const withRetry = async (arm, label) => {
    let last;
    for (let attempt = 1; attempt <= ARM_ATTEMPTS; attempt++) {
      const t0 = Date.now();
      // Both arms catch internally now, so this is a backstop — but it must still report the elapsed
      // time it actually took. A hardcoded 0 is what made six lost fixtures read "0.0s" and look like
      // an instant code fault rather than a network one.
      last = await arm(fx).catch((e) => ({ scores: null, ms: Date.now() - t0, error: `transport ${e.cause?.code ?? e.code ?? e.name ?? 'error'}`, retryable: true, consistency: null }));
      last.attempts = attempt;
      if (last.scores || !(last.retryable ?? /^transport\b/i.test(String(last.error ?? '')))) return last;
      if (attempt < ARM_ATTEMPTS) {
        const wait = RETRY_BASE_MS * 2 ** (attempt - 1);
        console.log(`    ${yellow('retry')} ${fx.id} ${label} attempt ${attempt} failed (${last.error}) — waiting ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    return last;
  };
  const cloud = await withRetry(cloudArm, 'cloud');
  const local = await withRetry(localArm, 'local');
  const ok = cloud.scores && local.scores;
  // localError/cloudError name the arm that failed and how. A row without `local` is NOT evidence that
  // the local model broke its JSON contract — it may have timed out, or the CLOUD arm may be the one
  // that failed while local scored fine. screening-verdict.mjs needs that difference to compute
  // parseability honestly.
  rows.push({ id: fx.id, local: local.scores, cloud: cloud.scores, localMs: local.ms, cloudMs: cloud.ms,
    consistency: local.consistency,
    localError: local.scores ? null : (local.error ?? 'unparseable'),
    // calls actually made and replies that failed the schema — parseability must be counted over CALLS,
    // not over fixtures: one adaptive row is 2-3 model calls plus re-asks, not one attempt.
    localAttempts: local.attempts ?? 1,
    cloudAttempts: cloud.attempts ?? 1,
    localCalls: local.consistency?.calls ?? (local.scores || local.error === 'unparseable' ? 1 : 0),
    localJsonRetries: local.consistency?.json_retries ?? 0,
    cloudError: cloud.scores ? null : (cloud.error ?? 'unparseable') });
  const delta = ok
    ? DOMAINS.reduce((a, d) => a + Math.abs(local.scores[d] - cloud.scores[d]), 0)
    : null;
  console.log(`  ${ok ? green('✔') : red('✘')} ${fx.id.padEnd(10)}`
    + `  local ${(local.ms / 1000).toFixed(1)}s  cloud ${(cloud.ms / 1000).toFixed(1)}s`
    + (ok ? `  Σ|Δ| ${delta}` : `  ${red(cloud.scores ? `local ${local.error || 'unparseable'}` : (cloud.error || 'cloud unparseable'))}`)
    + (local.consistency ? dim(`  calls ${local.consistency.calls}${local.consistency.json_retries ? `+${local.consistency.json_retries} re-ask` : ''} (${local.consistency.rule}, maxΔ ${local.consistency.max_delta ?? '—'})`) : ''));
}

const paired = rows.filter((r) => r.local && r.cloud);
// A run where every fixture failed has no pairs. Print dashes then, never the NaN a mean of nothing gives.
const f2 = (v) => (v == null ? '—' : v.toFixed(2));
const f3 = (v) => (v == null ? '—' : v.toFixed(3));
hr('per-domain');
console.log('  domain   local mean   cloud mean      Δ mean   |Δ| mean   exact   within 1   ICC(A,1)');
console.log('  ──────   ──────────   ──────────   ─────────   ────────   ─────   ────────   ────────');
const perDomain = domainAgreement(paired);
for (const d of DOMAINS) {
  const s = perDomain[d];
  console.log(`  ${d.padEnd(8)} ${f2(s.local_mean).padStart(10)} ${f2(s.cloud_mean).padStart(12)}`
    + ` ${f2(s.mean_delta).padStart(11)} ${f2(s.mean_abs_delta).padStart(10)}`
    + ` ${String(s.exact).padStart(5)}`
    + ` ${String(s.within_1).padStart(10)}`
    + ` ${f3(s.icc?.icc).padStart(10)}`);
}

// The composite a physician is actually told: rimpl's weighted one, not the d1..d7 sum this section
// printed until 2026-10. The Σ|Δ| per row above stays the unweighted per-domain count by design.
const comp = compositeAgreement(paired);
hr('weighted composite (×20, 0–100)');
console.log(`  local  mean ${f2(comp.local_mean)}   cloud mean ${f2(comp.cloud_mean)}   ${dim('rimpl/src/lib/composite.js compositeOf')}`);
console.log(`  bias   ${comp.bias != null && comp.bias >= 0 ? '+' : ''}${f2(comp.bias)} (local − cloud)`);
console.log(`  Bland–Altman limits of agreement  ${comp.limits ? `${f2(comp.limits.lower)} … ${f2(comp.limits.upper)}` : '—'}`);
// Each bound is formatted on its own: the F-based interval can be null while the estimate is not.
console.log(`  ICC(A,1) composite  ${f3(comp.icc?.icc)}  95% CI ${comp.icc?.icc == null ? '—' : `${f3(comp.icc.lower)}–${f3(comp.icc.upper)}`}`
  + `  n=${comp.n}${comp.icc?.interpretation ? dim(`  ${comp.icc.interpretation}`) : ''}`);

hr('latency');
console.log(`  local  p50 ${(percentile(rows.map((r) => r.localMs), 50) / 1000).toFixed(1)}s`
  + `   cloud p50 ${(percentile(rows.map((r) => r.cloudMs), 50) / 1000).toFixed(1)}s`);

hr('how to read this');
console.log(`  ${dim('ICC near 1  = the two models score the same PLEs the same way; a swap moves little.')}`);
console.log(`  ${dim('ICC near 0  = they rank PLEs differently; the cutover changes what physicians are told.')}`);
console.log(`  ${dim('bias        = a systematic offset. A constant offset is re-calibratable; scatter is not.')}`);
console.log(`  ${dim('composite   = production\'s weighted PIS-7 composite; ICC and its 95% CI are backend icc.js,')}`);
console.log(`  ${dim('              the same code as GET /oversight/icc. Σ|Δ| stays the unweighted per-domain count.')}`);
console.log(`  ${dim('NEITHER tells you which model is closer to a human auditor. That is Gate 0.5, and it')}`);
console.log(`  ${dim('needs 3 blinded raters per PLE — production currently has 0 PLEs at that bar.')}\n`);

const outFile = argStr('out');
if (outFile) {
  await (await import('node:fs/promises')).writeFile(outFile, JSON.stringify({
    split, prompt_version: PROMPT_VERSION, local_prompt_version: promptVersionFor('local'), consistency: CONSISTENCY,
    arm_attempts: ARM_ATTEMPTS,
    localModel: cfg.model, cloudModel: CLOUD_MODEL, n: paired.length, rows,
  }, null, 2));
  console.log(`  report → ${outFile}\n`);
}
