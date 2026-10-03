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
 *   rimpl consistency scoreWithConsistency → pis7 scoreFromText — PRODUCTION's contract, in every mode:
 *                    DomainScoresSchema .strict() (no extra keys; rationale must be an object). Off mode
 *                    runs it as evaluate.js does: { mode: 'off', jsonRetries: 0 }. A reply production
 *                    would answer 502 to (invalid_json / invalid_scores) is recorded unscored here too.
 * with evaluate.js's decoding (temperature 0, max_tokens 4096) and user envelope ("TRANSCRIPT:\n…").
 *
 * EVERY RAW REPLY IS SAVED (rows[].replies[].text — synthetic transcripts, so the text is safe), in call
 * order, so a past run can be re-checked offline against a newer contract: revalidate.mjs replays the
 * saved replies through production's scoreWithConsistency without calling any model.
 * consistency.js needs zod (rimpl/node_modules); it is imported only for a live run, so --dry-run and
 * CI's `node --check` stay package-free.
 *
 * Every fixture's sha256 is checked against manifest.json before anything is sent, so a fixture edited
 * after validation cannot be scored under its old id.
 *
 *   node scripts/calibration/anchors/score-local.mjs --dry-run                 # sends nothing
 *   LOCAL_AI_BASE_URL=… LOCAL_AI_MODEL=… [LOCAL_AI_API_KEY=…] \
 *     node scripts/calibration/anchors/score-local.mjs --pilot --repeats 3 --concurrency 2 \
 *       --out scripts/calibration/anchors/runs/pilot-local.json
 *
 *   --pilot             only the 20 active pilot anchors (design.json pilot:true, not excluded)
 *   --split tuning|heldout   only that half of SPLIT-anchors.json (anchor-split.mjs splitFilter).
 *                       Any held-out id is REFUSED until HELDOUT-LOCK.json covers every held-out
 *                       anchor (AUTHORING.md §9); a held-out anchor is never rewritten after it.
 *   --only a,b          only these ids          --limit n     first n after filtering
 *   --repeats K         runs per anchor (default 3 — AUTHORING.md §7)
 *   --concurrency n     default 2, never above LOCAL_MAX_CONCURRENCY when that is set
 *   --consistency m     off (default: one call per run, as pre-registered) | adaptive (rimpl's rule;
 *                       needs rimpl/node_modules for zod)
 *   --attempts n        transport retries per run (default 3, backoff --retry-base-ms 15000 doubling).
 *                       Only TRANSPORT failures retry: an unparseable reply is a measurement.
 *   --fixtures dir      default scripts/calibration/anchors/fixtures
 *   --addendum-file f   score a CANDIDATE local addendum instead of the shipping PIS7_LOCAL_ADDENDUM
 *                       (plan 2.6, AUTHORING.md §7 item 21). rimpl is not edited: the file's text goes
 *                       through the same pis7PromptFor/promptVersionFor, so the report's
 *                       prompt_version_used carries the candidate's own +local-<sha> suffix.
 *   PROBE_TIMEOUT_MS    per-call timeout (lib.mjs; default 180000)
 *
 * The report (--out) is written after EVERY completed run, so an interrupted run keeps what it has.
 * Feed it to known-groups.mjs.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadAnchorSplit, splitFilter, loadHeldOutLock, assertHeldOutScorable } from './anchor-split.mjs';
import { readConfig, chatCompletion, parseArgs, intArg, fail, hr, dim, green, red, yellow, bold } from '../../probe/lib.mjs';

import { pis7PromptFor } from '../../../rimpl/src/lib/prompts.js';
import { promptVersionFor, RUBRIC_VERSION } from '../../../rimpl/src/lib/versions.js';
import { flattenForPrompt } from '../../../rimpl/src/lib/transcript.js';
import { deriveHintTokens } from '../../../rimpl/src/services/pii-filter.js';

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
const outPath = typeof flags.out === 'string' ? path.resolve(flags.out) : null;

/* ---------------------------------------------------------------- fixtures */

const design = JSON.parse(await readFile(path.join(HERE, 'design.json'), 'utf8'));
let manifest;
try { manifest = JSON.parse(await readFile(path.join(HERE, 'manifest.json'), 'utf8')); }
catch { fail('manifest.json missing — run scripts/calibration/anchors/validate.mjs first.'); }

let ids = (await readdir(fixturesDir).catch(() => [])).filter((f) => /^anc-\d{3}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
// Excluded anchors (§7.4, design.json `excluded`) are never scored; validate.mjs keeps their files out
// of fixtures/, and this guards a stray copy.
ids = ids.filter((id) => !design.anchors.find((a) => a.id === id)?.excluded);
if (flags.pilot) ids = ids.filter((id) => design.anchors.find((a) => a.id === id)?.pilot);
if (typeof flags.split === 'string') {
  let allowed;
  try { allowed = splitFilter(design, await loadAnchorSplit(), flags.split); } catch (e) { fail(e.message); }
  ids = ids.filter((id) => allowed.has(id));
}
if (typeof flags.only === 'string') {
  const only = flags.only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const missing = only.filter((id) => !ids.includes(id));
  if (missing.length) fail(`--only: no fixture for ${missing.join(', ')}`);
  ids = ids.filter((id) => only.includes(id));
}
if (flags.limit !== undefined) ids = ids.slice(0, intArg(flags, 'limit', ids.length));
if (!ids.length) fail(`no anchor fixtures selected in ${fixturesDir}`);
// D13: no held-out anchor is scored until every held-out anchor is authored and locked, and then only
// with its locked bytes (anchor-split.mjs assertHeldOutScorable). --dry-run sends nothing and scores
// nothing, so it is exempt.
if (!dryRun) {
  try {
    assertHeldOutScorable(ids, { split: await loadAnchorSplit(), lock: await loadHeldOutLock(),
      fixtureShas: Object.fromEntries(ids.map((id) => [id, manifest.fixtures?.[id]?.sha256])) });
  } catch (e) { fail(e.message); }
}

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

// Trailing whitespace is dropped so a file saved with a final newline hashes like the same text
// pasted into prompts.js. An empty file is refused: pis7PromptFor would silently fall back to the
// bare base prompt, and the report would not say so.
let addendum;
if (flags['addendum-file'] !== undefined && typeof flags['addendum-file'] !== 'string') fail('--addendum-file needs a path');
if (typeof flags['addendum-file'] === 'string') {
  const file = path.resolve(flags['addendum-file']);
  addendum = { file: path.relative(path.resolve(HERE, '../../..'), file), text: (await readFile(file, 'utf8')).replace(/\s+$/, '') };
  if (!addendum.text) fail(`--addendum-file ${addendum.file} is empty`);
}
const SYSTEM = addendum ? pis7PromptFor('local', addendum.text) : pis7PromptFor('local');
const PROMPT_VERSION_USED = addendum ? promptVersionFor('local', addendum.text) : promptVersionFor('local');
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
  console.log(`  addendum     ${addendum ? `CANDIDATE ${addendum.file}` : 'shipping PIS7_LOCAL_ADDENDUM'}`);
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
// Production's scorer. Dynamic so a dry run (and CI's node --check) never needs zod.
const { scoreWithConsistency } = await import('../../../rimpl/src/services/consistency.js');
// evaluate.js: jsonRetries 0 in off mode, EVAL_JSON_RETRIES (default 2) otherwise.
const JSON_RETRIES = consistency === 'off' ? 0 : (() => {
  const n = parseInt(process.env.EVAL_JSON_RETRIES, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
})();

class TransportError extends Error {}

async function runJob(job) {
  const t0 = Date.now();
  let lastError = 'transport';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const replies = [];   // every model reply this run, in call order — re-asks included
    try {
      const res = await scoreWithConsistency({
        mode: consistency,
        jsonRetries: JSON_RETRIES,
        callOnce: async () => {
          const r = await chatCompletion(cfg, {
            systemPrompt: SYSTEM,
            messages: [{ role: 'user', content: job.fixture.userMessage }],
            maxTokens: EVAL.maxTokens, temperature: EVAL.temperature,
          });
          if (!r.ok) throw new TransportError(`transport ${r.status ?? ''} ${String(r.error).slice(0, 80)}`.trim());
          replies.push({ text: r.text ?? '', finish_reason: r.finishReason, completion_tokens: r.completionTokens,
            model: r.model, ...(r.reasoningOnly ? { reasoning_only: true } : {}) });
          return { text: r.text ?? '', inputTokens: r.promptTokens ?? 0, outputTokens: r.completionTokens ?? 0 };
        },
      });
      return { id: job.fixture.id, run: job.run, scores: Object.fromEntries(DOMAINS.map((d) => [d, res.scores[d]])),
        error: null, ms: Date.now() - t0, attempts: attempt, model: replies.at(-1)?.model ?? null,
        consistency: res.consistency, replies };
    } catch (e) {
      if (!(e instanceof TransportError)) {
        // Pis7ScoreError: production would answer 502. A measurement, never retried.
        return { id: job.fixture.id, run: job.run, scores: null, error: e.kind ?? e.code ?? e.name ?? 'error',
          ms: Date.now() - t0, attempts: attempt, model: replies.at(-1)?.model ?? null, replies };
      }
      lastError = e.message;
    }
    if (attempt < attempts) {
      const wait = retryBaseMs * 2 ** (attempt - 1);
      console.log(`    ${yellow('retry')} ${job.fixture.id} #${job.run} (${lastError}) — waiting ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return { id: job.fixture.id, run: job.run, scores: null, error: lastError, ms: Date.now() - t0, attempts, model: null, replies: [] };
}

const report = {
  probe: 'anchors-score-local',
  evidence_level: EVIDENCE_LEVEL,
  started_at: new Date().toISOString(),
  model: cfg.model,
  base_url_origin: cfg.origin,
  prompt_version_used: PROMPT_VERSION_USED,
  addendum: addendum ? { candidate: addendum.file, sha256: createHash('sha256').update(addendum.text).digest('hex') } : 'shipping',
  rubric_version: RUBRIC_VERSION,
  decoding: EVAL,
  consistency,
  json_retries: JSON_RETRIES,
  contract: 'rimpl scoreWithConsistency → pis7 scoreFromText (DomainScoresSchema .strict())',
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
