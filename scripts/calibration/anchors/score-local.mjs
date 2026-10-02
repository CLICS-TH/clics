#!/usr/bin/env node
/*
 * Score the anchor fixtures with the LOCAL evaluator — no cloud arm, no Anthropic key read.
 *
 * WHY NOT model-agreement.mjs / repeat-consistency.mjs. Both read scripts/probe/fixtures only, apply
 * the probe SPLIT.json, and model-agreement refuses to start without ANTHROPIC_API_KEY (it is a paired
 * local-vs-cloud design). The anchors need neither: a different fixture set, a local-only arm, and K
 * runs per anchor as AUTHORING.md §7 pre-registers. This is that, built from the same parts:
 *   lib.mjs          readConfig / chatCompletion (raw OpenAI-compatible call: no retry hiding, no queue)
 *   rimpl prompts    pis7PromptFor('local')  — base rubric + the local addendum, exactly as production
 *   rimpl versions   promptVersionFor('local'), RUBRIC_VERSION — stamped on every row
 *   rimpl transcript flattenForPrompt + deriveHintTokens — the PII strip + defang evaluate.js applies
 *   rimpl parse      parseJsonObject; d1..d7 must be integers 0-5 (evaluate.js's bar)
 * with evaluate.js's decoding (temperature 0, max_tokens 4096) and user envelope ("TRANSCRIPT:\n…").
 *
 * Every fixture's sha256 is checked against manifest.json before anything is sent, so a fixture edited
 * after validation cannot be scored under its old id.
 *
 *   node scripts/calibration/anchors/score-local.mjs --dry-run                 # sends nothing
 *   LOCAL_AI_BASE_URL=… LOCAL_AI_MODEL=… [LOCAL_AI_API_KEY=…] \
 *     node scripts/calibration/anchors/score-local.mjs --pilot --repeats 3 --concurrency 2 \
 *       --out scripts/calibration/anchors/runs/pilot-local.json
 *
 *   --pilot             only the 20 pilot anchors (design.json pilot:true)
 *   --only a,b          only these ids          --limit n     first n after filtering
 *   --repeats K         runs per anchor (default 3 — AUTHORING.md §7)
 *   --concurrency n     default 2, never above LOCAL_MAX_CONCURRENCY when that is set
 *   --consistency m     off (default: one call per run, as pre-registered) | adaptive (rimpl's rule;
 *                       needs rimpl/node_modules for zod)
 *   --attempts n        transport retries per run (default 3, backoff --retry-base-ms 15000 doubling).
 *                       Only TRANSPORT failures retry: an unparseable reply is a measurement.
 *   --rationale         keep the model's rationale in the report (synthetic text, safe; off by default)
 *   --fixtures dir      default scripts/calibration/anchors/fixtures
 *   PROBE_TIMEOUT_MS    per-call timeout (lib.mjs; default 180000)
 *
 * The report (--out) is written after EVERY completed run, so an interrupted run keeps what it has.
 * Feed it to known-groups.mjs.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readConfig, chatCompletion, parseArgs, intArg, fail, hr, dim, green, red, yellow, bold } from '../../probe/lib.mjs';

import { pis7PromptFor } from '../../../rimpl/src/lib/prompts.js';
import { promptVersionFor, RUBRIC_VERSION } from '../../../rimpl/src/lib/versions.js';
import { flattenForPrompt } from '../../../rimpl/src/lib/transcript.js';
import { deriveHintTokens } from '../../../rimpl/src/services/pii-filter.js';
import { parseJsonObject } from '../../../rimpl/src/lib/parse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const EVAL = { temperature: 0, maxTokens: 4096 };          // rimpl/src/routes/evaluate.js EVAL_DECODING
export const SECONDS_PER_EVAL_ESTIMATE = 90;
export const EVIDENCE_LEVEL = 'screening-synthetic (AI-authored, AI-scored) — not a decisive gate';

const { flags } = parseArgs();
const dryRun = Boolean(flags['dry-run']);
const fixturesDir = path.resolve(typeof flags.fixtures === 'string' ? flags.fixtures : path.join(HERE, 'fixtures'));
const repeats = Math.max(1, intArg(flags, 'repeats', 3));
const envCap = parseInt(process.env.LOCAL_MAX_CONCURRENCY || '', 10);
const concurrency = Math.max(1, Math.min(intArg(flags, 'concurrency', 2), Number.isFinite(envCap) && envCap > 0 ? envCap : Infinity));
const attempts = Math.max(1, intArg(flags, 'attempts', 3));
const retryBaseMs = Math.max(0, intArg(flags, 'retry-base-ms', 15000));
const consistency = typeof flags.consistency === 'string' ? flags.consistency : 'off';
if (!['off', 'adaptive'].includes(consistency)) fail(`--consistency must be off or adaptive (got ${consistency})`);
const keepRationale = Boolean(flags.rationale);
const outPath = typeof flags.out === 'string' ? path.resolve(flags.out) : null;

/* ---------------------------------------------------------------- fixtures */

const design = JSON.parse(await readFile(path.join(HERE, 'design.json'), 'utf8'));
let manifest;
try { manifest = JSON.parse(await readFile(path.join(HERE, 'manifest.json'), 'utf8')); }
catch { fail('manifest.json missing — run scripts/calibration/anchors/validate.mjs first.'); }

let ids = (await readdir(fixturesDir).catch(() => [])).filter((f) => /^anc-\d{3}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
if (flags.pilot) ids = ids.filter((id) => design.anchors.find((a) => a.id === id)?.pilot);
if (typeof flags.only === 'string') {
  const only = flags.only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const missing = only.filter((id) => !ids.includes(id));
  if (missing.length) fail(`--only: no fixture for ${missing.join(', ')}`);
  ids = ids.filter((id) => only.includes(id));
}
if (flags.limit !== undefined) ids = ids.slice(0, intArg(flags, 'limit', ids.length));
if (!ids.length) fail(`no anchor fixtures selected in ${fixturesDir}`);

const fixtures = [];
for (const id of ids) {
  const buf = await readFile(path.join(fixturesDir, `${id}.json`));
  const want = manifest.fixtures?.[id]?.sha256;
  const got = createHash('sha256').update(buf).digest('hex');
  if (!want) fail(`${id} is not in manifest.json — validate it first (validate.mjs).`);
  if (want !== got) fail(`${id} changed since validation (sha256 mismatch) — re-run validate.mjs, and if it was rewritten after scoring began, record why.`);
  const doc = JSON.parse(buf.toString('utf8'));
  const flattened = flattenForPrompt(doc.transcript, deriveHintTokens(doc.patient_ref ?? null));
  fixtures.push({ id, sha256: got, userMessage: `TRANSCRIPT:\n${flattened}` });
}

const SYSTEM = pis7PromptFor('local');
const PROMPT_VERSION_USED = promptVersionFor('local');
const jobs = [];
for (let run = 1; run <= repeats; run++) for (const f of fixtures) jobs.push({ fixture: f, run });
const estMin = Math.ceil(jobs.length / concurrency) * SECONDS_PER_EVAL_ESTIMATE * (consistency === 'adaptive' ? 2.3 : 1) / 60;

/* ---------------------------------------------------------------- dry run */

if (dryRun) {
  hr('dry run — nothing will be sent');
  console.log(`  fixtures     ${fixtures.length} (${fixturesDir})`);
  console.log(`  runs         ${repeats} per anchor → ${jobs.length} evaluations, consistency ${consistency}`);
  console.log(`  concurrency  ${concurrency}${Number.isFinite(envCap) ? ` (LOCAL_MAX_CONCURRENCY=${envCap})` : ''}`);
  console.log(`  estimate     ~${Math.round(estMin)} min at ~${SECONDS_PER_EVAL_ESTIMATE} s/eval${consistency === 'adaptive' ? ' (adaptive ≈ 2.3 calls/run)' : ''}`);
  console.log(`  prompt       pis7PromptFor('local') ${SYSTEM.length} chars · ${PROMPT_VERSION_USED} · ${RUBRIC_VERSION}`);
  console.log(`  decoding     temperature ${EVAL.temperature}, max_tokens ${EVAL.maxTokens} (evaluate.js)`);
  console.log(`  manifest     every sha256 verified`);
  console.log(`  ids          ${ids.join(' ')}`);
  console.log(`  chars sent   ${fixtures.map((f) => f.userMessage.length).join(' ')}`);
  hr(`what would be sent for ${fixtures[0].id}`);
  console.log(fixtures[0].userMessage.slice(0, 700).split('\n').map((l) => '  ' + l).join('\n'));
  if (fixtures[0].userMessage.length > 700) console.log(dim(`  …[${fixtures[0].userMessage.length - 700} more chars]`));
  console.log(`\n  ${dim(EVIDENCE_LEVEL)}\n`);
  process.exit(0);
}

/* -------------------------------------------------------------------- run */

const cfg = readConfig({ needModel: true });
let scoreWithConsistency = null;
if (consistency !== 'off') ({ scoreWithConsistency } = await import('../../../rimpl/src/services/consistency.js'));

function extract(text) {
  let parsed;
  try { parsed = parseJsonObject(text); } catch { return { scores: null, rationale: null }; }
  if (!parsed || typeof parsed !== 'object') return { scores: null, rationale: null };
  const scores = {};
  for (const d of DOMAINS) {
    const v = parsed[d];
    if (!Number.isInteger(v) || v < 0 || v > 5) return { scores: null, rationale: null };
    scores[d] = v;
  }
  return { scores, rationale: parsed.rationale ?? null };
}

async function once(f) {
  const r = await chatCompletion(cfg, {
    systemPrompt: SYSTEM,
    messages: [{ role: 'user', content: f.userMessage }],
    maxTokens: EVAL.maxTokens, temperature: EVAL.temperature,
  });
  return r;
}

async function runJob(job) {
  const t0 = Date.now();
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (consistency === 'off') {
      const r = await once(job.fixture);
      if (r.ok) {
        const { scores, rationale } = extract(r.text);
        return { id: job.fixture.id, run: job.run, scores, error: scores ? null : (r.reasoningOnly ? 'reasoning_only' : 'unparseable'),
          ms: Date.now() - t0, attempts: attempt, finish_reason: r.finishReason, completion_tokens: r.completionTokens,
          model: r.model, ...(keepRationale && rationale ? { rationale } : {}) };
      }
      last = { error: `transport ${r.status ?? ''} ${String(r.error).slice(0, 80)}`.trim() };
    } else {
      let transport = null;
      let model = null;
      try {
        const res = await scoreWithConsistency({
          mode: consistency, jsonRetries: 2,
          callOnce: async () => {
            const r = await once(job.fixture);
            if (!r.ok) { transport = `transport ${r.status ?? ''}`.trim(); throw new Error(transport); }
            model = r.model;
            return { text: r.text ?? '', inputTokens: r.promptTokens ?? 0, outputTokens: r.completionTokens ?? 0 };
          },
        });
        const scores = Object.fromEntries(DOMAINS.map((d) => [d, res.scores[d]]));
        return { id: job.fixture.id, run: job.run, scores, error: null, ms: Date.now() - t0, attempts: attempt,
          model, consistency: res.consistency, ...(keepRationale && res.rationale ? { rationale: res.rationale } : {}) };
      } catch (e) {
        if (!transport) {
          return { id: job.fixture.id, run: job.run, scores: null, error: e.code ?? e.name ?? 'error', ms: Date.now() - t0, attempts: attempt, model };
        }
        last = { error: transport };
      }
    }
    if (attempt < attempts) {
      const wait = retryBaseMs * 2 ** (attempt - 1);
      console.log(`    ${yellow('retry')} ${job.fixture.id} #${job.run} (${last.error}) — waiting ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return { id: job.fixture.id, run: job.run, scores: null, error: last?.error ?? 'transport', ms: Date.now() - t0, attempts };
}

const report = {
  probe: 'anchors-score-local',
  evidence_level: EVIDENCE_LEVEL,
  started_at: new Date().toISOString(),
  model: cfg.model,
  base_url_origin: cfg.origin,
  prompt_version_used: PROMPT_VERSION_USED,
  rubric_version: RUBRIC_VERSION,
  decoding: EVAL,
  consistency,
  repeats,
  concurrency,
  design_seed: design.seed,
  fixtures: Object.fromEntries(fixtures.map((f) => [f.id, f.sha256])),
  rows: [],
};
const save = async () => {
  if (!outPath) return;
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
};

hr('anchor scoring — local evaluator');
console.log(`  model        ${cfg.model} @ ${cfg.baseUrl}`);
console.log(`  prompt       ${PROMPT_VERSION_USED} · ${RUBRIC_VERSION} · temperature 0 · max_tokens 4096`);
console.log(`  jobs         ${fixtures.length} anchors × ${repeats} = ${jobs.length}, concurrency ${concurrency}, consistency ${consistency}`);
console.log(`  estimate     ~${Math.round(estMin)} min at ~${SECONDS_PER_EVAL_ESTIMATE} s/eval`);
console.log(`  out          ${outPath ?? red('(none — pass --out or the scores are lost)')}\n`);

let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const row = await runJob(job);
    report.rows.push(row);
    await save();
    console.log(`  ${row.scores ? green('✔') : red('✘')} ${row.id} #${row.run}  ${(row.ms / 1000).toFixed(1)}s`
      + (row.scores ? `  ${DOMAINS.map((d) => row.scores[d]).join(' ')}` : `  ${red(row.error)}`)
      + dim(`  (${report.rows.length}/${jobs.length})`));
  }
}));

report.rows.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);
report.finished_at = new Date().toISOString();
await save();
const ok = report.rows.filter((r) => r.scores).length;
hr('done');
console.log(`  ${bold(`${ok}/${report.rows.length}`)} runs scored`);
console.log(`  next: node scripts/calibration/anchors/known-groups.mjs ${outPath ? path.relative(process.cwd(), outPath) : '<report.json>'} --pilot`);
console.log(`  ${dim(EVIDENCE_LEVEL)}\n`);
process.exit(ok === report.rows.length ? 0 : 1);
