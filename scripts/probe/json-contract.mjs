#!/usr/bin/env node
// json-contract.mjs — THE GATE 0 TEST.
//
// PIS-7 scoring is the highest-risk call site in CLICS: it drives CME credit and is ICC-gated. It
// is also the one call that depends on the model holding a strict output contract — a JSON object
// whose d1..d7 are integers 0-5. A model that is fluent but cannot hold that contract is unusable
// for `evaluate` no matter how good its prose is.
//
// So this script applies the EXACT pipeline routes/evaluate.js applies, importing every piece
// rather than reimplementing it:
//     lib/prompts.js        PIS7_EVALUATOR_PROMPT   (system prompt — single-source, never copied)
//     lib/transcript.js     flattenForPrompt        (the "[ROLE]: content" envelope + injection defang)
//     services/pii-filter   deriveHintTokens        (known patient identifiers → scrub tokens)
//     lib/parse.js          parseJsonObject         (first {...} in the reply)
//     zod (from rimpl)      d1..d7 int 0-5          (mirrors evaluate.js DomainScoresSchema)
// with the same max_tokens (4096) and the same user-message envelope ("TRANSCRIPT:\n…").
//
//   🚦 GATE: parse-and-validate success rate ≥ 95%.
//
// PII — READ THIS BEFORE ADDING FIXTURES
// -------------------------------------
// Fixtures are transcripts. They MUST already be de-identified, and fixtures/ is gitignored
// (scripts/probe/.gitignore) so a slip cannot reach git history. As a second line of defence every
// fixture is pushed through rimpl's own flattenForPrompt/deriveHintTokens before a single byte
// leaves this machine — the same strip the production route performs. That is a safety net, not a
// licence to drop raw PLE exports in the directory. Use `--dry-run` to inspect exactly what would
// be sent, with no network call at all.
//
// Usage:
//   LOCAL_AI_BASE_URL=… LOCAL_AI_MODEL=… node scripts/probe/json-contract.mjs
//     --fixtures <dir>    default: scripts/probe/fixtures
//     --repeat <n>        run every fixture n times (default 1) — reveals run-to-run flakiness
//     --concurrency <n>   default 1; keep at 1 for clean latency numbers
//     --max-tokens <n>    default 4096 (what evaluate.js sends)
//     --temperature <t>   default: unset, i.e. the server's own default (what evaluate.js sends)
//     --dry-run           flatten fixtures and report, send nothing
//     --show-failures     print the offending reply text for each failure
//     --out <file>        write a JSON report

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  readConfig, printTarget, chatCompletion, hr, table, parseArgs, writeReport, fail,
  bold, dim, green, red, yellow, percentile, mean, distribution, ms, pct,
  FINISH_REASON, PROBE_DIR, RIMPL_DIR,
} from './lib.mjs';

// --- single-source imports from rimpl (never copy these) --------------------
import { PIS7_EVALUATOR_PROMPT } from '../../rimpl/src/lib/prompts.js';
import { parseJsonObject } from '../../rimpl/src/lib/parse.js';
import { flattenForPrompt } from '../../rimpl/src/lib/transcript.js';
import { deriveHintTokens } from '../../rimpl/src/services/pii-filter.js';

// zod lives in rimpl/node_modules, not the repo root (this is not an npm workspace). Resolve it from
// rimpl so the probe validates with the SAME zod version evaluate.js runs.
const rimplRequire = createRequire(path.join(RIMPL_DIR, 'package.json'));
let z;
try {
  ({ z } = rimplRequire('zod'));
} catch {
  fail('zod is not installed in rimpl/. Run:  npm --prefix rimpl install');
}

// MIRRORS rimpl/src/routes/evaluate.js (DOMAIN_KEYS / DomainScoresSchema). Duplicated here only
// because the route does not export it; keep the two in step. `.passthrough()` matters — the real
// evaluator also returns a `rationale` object, and a strict schema would reject a valid reply.
const DOMAIN_KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const DomainScoresSchema = z.object(
  Object.fromEntries(DOMAIN_KEYS.map((k) => [k, z.number().int().min(0).max(5)])),
).passthrough();

// evaluate.js:38 — 4096, after two undersized guesses truncated long transcripts mid-rationale.
// Probe with the production value: a parse rate measured at a different ceiling is not the number
// the gate is about.
const EVAL_MAX_TOKENS = 4096;
const GATE_PARSE_RATE = 0.95;

const { flags } = parseArgs();
const fixturesDir = path.resolve(flags.fixtures && flags.fixtures !== true ? String(flags.fixtures) : path.join(PROBE_DIR, 'fixtures'));
const repeat = Math.max(1, Number(flags.repeat) || 1);
const concurrency = Math.max(1, Number(flags.concurrency) || 1);
const maxTokens = Math.max(256, Number(flags['max-tokens']) || EVAL_MAX_TOKENS);
const temperature = flags.temperature !== undefined && flags.temperature !== true ? Number(flags.temperature) : undefined;
const dryRun = Boolean(flags['dry-run']);

// Config is validated FIRST (before touching fixtures) so an unconfigured run says so plainly
// instead of complaining about an empty directory. --dry-run is the exception: it sends nothing, so
// it must work with no endpoint configured at all.
const cfg = dryRun ? null : readConfig({ needModel: true });

/* ---------------------------------------------------------------- fixtures */

const FORMAT_HELP = `
A fixture is one .json file per transcript, in either shape:

  [ { "role": "physician", "content": "…" }, { "role": "assistant", "content": "…" } ]

or, matching the body routes/evaluate.js receives:

  { "ple_id": "PLE-001",
    "patient_ref": null,
    "transcript": [ { "role": "physician", "content": "…" }, … ] }

"patient_ref" is the on-prem patient identifier: when present it is turned into scrub hints by
deriveHintTokens() exactly as the production route does, so the probe exercises the real strip.

The transcripts MUST already be de-identified. fixtures/ is gitignored; keep it that way.
Ten fixtures is the roadmap's minimum — but note that at n=10 a ≥95% gate means 10/10, so a single
bad reply fails the gate. Twenty or more gives a rate you can actually reason about.`;

async function loadFixtures(dir) {
  let names;
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    fail(`cannot read the fixtures directory ${dir}\n  ${e.message}\n${FORMAT_HELP}`);
  }
  if (!names.length) {
    fail(`no .json fixtures in ${dir}\n${FORMAT_HELP}`);
  }
  const out = [];
  for (const name of names) {
    let doc;
    try {
      doc = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    } catch (e) {
      fail(`${name} is not valid JSON: ${e.message}\n${FORMAT_HELP}`);
    }
    const transcript = Array.isArray(doc) ? doc : doc?.transcript;
    if (!Array.isArray(transcript) || !transcript.length) {
      fail(`${name} has no transcript array.\n${FORMAT_HELP}`);
    }
    const bad = transcript.find((t) => typeof t?.role !== 'string' || typeof t?.content !== 'string');
    if (bad) fail(`${name}: every transcript turn needs string "role" and string "content".\n${FORMAT_HELP}`);
    out.push({
      name,
      pleId: Array.isArray(doc) ? null : (doc.ple_id ?? null),
      patientRef: Array.isArray(doc) ? null : (doc.patient_ref ?? null),
      transcript,
    });
  }
  return out;
}

const fixtures = await loadFixtures(fixturesDir);

// The exact prompt evaluate.js builds: PII-stripped + role-marker-defanged, then wrapped.
for (const f of fixtures) {
  f.flattened = flattenForPrompt(f.transcript, deriveHintTokens(f.patientRef));
  f.userMessage = `TRANSCRIPT:\n${f.flattened}`;
}

/* ---------------------------------------------------------------- dry run */

if (dryRun) {
  hr('dry run — nothing will be sent');
  console.log(`  fixtures dir  ${fixturesDir}`);
  table(
    ['fixture', 'turns', 'chars sent', 'ple_id', 'patient_ref'],
    fixtures.map((f) => [f.name, f.transcript.length, f.userMessage.length, f.pleId ?? dim('—'), f.patientRef ? dim('set') : dim('—')]),
    ['l', 'r', 'r', 'l', 'l'],
  );
  hr('what would be sent for ' + fixtures[0].name);
  console.log(dim('  (post-strip, post-defang — read it and confirm no identifier survived)'));
  console.log('\n' + fixtures[0].userMessage.slice(0, 1200).split('\n').map((l) => '  ' + l).join('\n'));
  if (fixtures[0].userMessage.length > 1200) console.log(dim(`  …[${fixtures[0].userMessage.length - 1200} more chars]`));
  console.log(`\n  ${bold('system prompt:')} PIS7_EVALUATOR_PROMPT, ${PIS7_EVALUATOR_PROMPT.length} chars ${dim('(imported from rimpl/src/lib/prompts.js)')}`);
  process.exit(0);
}

/* -------------------------------------------------------------------- run */

printTarget(cfg, {
  fixtures: `${fixtures.length} × ${repeat} run(s) = ${fixtures.length * repeat} calls`,
  max_tokens: String(maxTokens),
  temperature: temperature === undefined ? 'server default (as evaluate.js)' : String(temperature),
  concurrency: String(concurrency),
});

const jobs = [];
for (let r = 0; r < repeat; r++) for (const f of fixtures) jobs.push({ fixture: f, run: r + 1 });

console.log(`\n  ${dim(`running ${jobs.length} evaluation${jobs.length === 1 ? '' : 's'}…`)}\n`);

/**
 * Classify one reply exactly the way evaluate.js would.
 *  ok            → parseJsonObject succeeded AND the zod check passed (this is what the gate counts)
 *  no_json       → the reply contained no {...} at all; parseJsonObject's no-match fallback returns
 *                  {} and the schema then reports every domain missing. Distinguished here because
 *                  the remedy differs from malformed JSON.
 *  invalid_json  → a {...} was found but JSON.parse threw → evaluate.js returns 502
 *  schema        → parsed fine but a domain was missing / non-integer / outside 0-5 → 502
 */
function classify(text) {
  // Same regex parse.js uses — for DIAGNOSIS only; parseJsonObject below is still the authority.
  const hasObject = /\{[\s\S]*\}/.test(text);
  let parsed;
  try {
    parsed = parseJsonObject(text);
  } catch (e) {
    return { status: 'invalid_json', detail: e.message, parsed: null };
  }
  if (!hasObject) return { status: 'no_json', detail: 'no JSON object in reply', parsed };
  const checked = DomainScoresSchema.safeParse(parsed);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { status: 'schema', detail: issues.slice(0, 7).join('; '), parsed, issues };
  }
  return { status: 'ok', detail: null, parsed: checked.data };
}

async function runJob(job) {
  const r = await chatCompletion(cfg, {
    systemPrompt: PIS7_EVALUATOR_PROMPT,
    messages: [{ role: 'user', content: job.fixture.userMessage }],
    maxTokens,
    temperature,
  });
  if (!r.ok) return { ...job, ...r, status: 'transport', detail: r.error };
  if (r.reasoningOnly) return { ...job, ...r, status: 'reasoning_only', detail: 'message.content empty; reasoning_content present' };
  const verdict = classify(r.text);
  return { ...job, ...r, ...verdict };
}

const results = [];
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const res = await runJob(job);
    results.push(res);
    const mark = res.status === 'ok' ? green('✔') : red('✘');
    const tps = res.ok && res.ms > 0 ? `${(res.completionTokens / (res.ms / 1000)).toFixed(1)} tok/s` : '';
    console.log(`  ${mark} ${job.fixture.name}${repeat > 1 ? dim(` #${job.run}`) : ''} ` +
      `${dim(`${Math.round(res.ms)}ms ${res.completionTokens ?? 0} out ${tps}`)}` +
      (res.status === 'ok' ? '' : `  ${red(res.status)} ${dim(String(res.detail).slice(0, 110))}`));
  }
}));

// Restore fixture order (concurrency scrambles it) so the report reads deterministically.
results.sort((a, b) => (a.run - b.run) || a.fixture.name.localeCompare(b.fixture.name));

/* ----------------------------------------------------------------- report */

const total = results.length;
const okRuns = results.filter((r) => r.status === 'ok');
const rate = total ? okRuns.length / total : 0;
const answered = results.filter((r) => r.ok);

hr('outcome');
table(
  ['outcome', 'n', 'share', 'meaning'],
  distribution(results.map((r) => r.status)).map(([k, n]) => [
    k === 'ok' ? green(k) : red(k), n, pct(n, total),
    dim({
      ok: 'parsed + all d1..d7 valid — counts toward the gate',
      transport: 'the call never returned — network / server error, not a model verdict',
      reasoning_only: 'empty content with reasoning_content — rimpl would see an EMPTY reply',
      no_json: 'no JSON object anywhere in the reply',
      invalid_json: 'malformed JSON → evaluate.js 502',
      schema: 'JSON parsed but d1..d7 missing / non-integer / outside 0-5 → evaluate.js 502',
    }[k] || ''),
  ]),
  ['l', 'r', 'r', 'l'],
);

hr('finish_reason');
table(
  ['raw', 'mapped (what evaluate.js sees)', 'n', 'share'],
  distribution(answered.map((r) => r.finishReason)).map(([k, n]) => {
    const mapped = FINISH_REASON[k] ?? k;
    return [k, mapped === 'max_tokens' ? yellow(mapped) : mapped, n, pct(n, answered.length)];
  }),
  ['l', 'l', 'r', 'r'],
);
const truncated = answered.filter((r) => r.stopReason === 'max_tokens');
if (truncated.length) {
  const truncFailures = truncated.filter((r) => r.status !== 'ok').length;
  console.log(`\n  ${yellow(`${truncated.length} repl${truncated.length === 1 ? 'y' : 'ies'} hit the ${maxTokens}-token ceiling`)}` +
    ` — ${truncFailures} of them failed to parse.`);
  console.log(`  ${dim('Truncation is the FIXABLE failure: raise max_tokens and re-run. Failures with')}`);
  console.log(`  ${dim('finish_reason=stop are a contract-compliance problem a bigger ceiling cannot fix.')}`);
}

hr('output tokens');
const outTokens = answered.map((r) => r.completionTokens).filter((n) => Number.isFinite(n));
if (!outTokens.length || outTokens.every((n) => n === 0)) {
  console.log(`  ${yellow('the server reported no completion_tokens.')}`);
  console.log(`  ${dim('rimpl meters spend and enforces the per-user $0.50 cap on usage.completion_tokens;')}`);
  console.log(`  ${dim('all-zero usage would silently disable the budget. Fix before Phase 2.')}`);
} else {
  table(
    ['min', 'p50', 'p95', 'max', 'mean', 'ceiling'],
    [[Math.min(...outTokens), percentile(outTokens, 50), percentile(outTokens, 95), Math.max(...outTokens),
      Math.round(mean(outTokens)), maxTokens]],
    ['r', 'r', 'r', 'r', 'r', 'r'],
  );
  const headroom = maxTokens - Math.max(...outTokens);
  console.log(`  ${dim(`headroom at the longest reply: ${headroom} tokens.`)}` +
    (headroom < maxTokens * 0.1 ? ` ${yellow('thin — expect truncation on longer transcripts.')}` : ''));
}

hr('speed');
const latencies = answered.map((r) => r.ms);
const tpsAll = answered.filter((r) => r.ms > 0 && r.completionTokens > 0).map((r) => r.completionTokens / (r.ms / 1000));
table(
  ['latency p50', 'latency p95', 'latency max', 'tok/s p50', 'tok/s mean'],
  [[ms(percentile(latencies, 50)), ms(percentile(latencies, 95)), ms(Math.max(...latencies, 0)),
    tpsAll.length ? percentile(tpsAll, 50).toFixed(1) : '—',
    tpsAll.length ? mean(tpsAll).toFixed(1) : '—']],
  ['r', 'r', 'r', 'r', 'r'],
);
console.log(`  ${dim(`single-stream at concurrency ${concurrency}. This is NOT a capacity number —`)}`);
console.log(`  ${dim('run throughput.mjs for that.')}`);

if (flags['show-failures']) {
  const failures = results.filter((r) => r.status !== 'ok');
  if (failures.length) {
    hr('failure detail');
    for (const f of failures) {
      console.log(`\n  ${red(f.status)} ${bold(f.fixture.name)}${repeat > 1 ? ` #${f.run}` : ''} — ${f.detail}`);
      const t = f.text || '';
      console.log(dim('  reply: ' + JSON.stringify(t.length > 900 ? t.slice(0, 500) + ' …[snip]… ' + t.slice(-400) : t)));
    }
  }
}

/* ------------------------------------------------------------------- gate */

hr('🚦 GATE 0 — JSON contract');
const passed = rate >= GATE_PARSE_RATE;
console.log(`  parse + validate rate  ${bold(`${okRuns.length}/${total}`)} = ${bold(pct(okRuns.length, total))}` +
  `   threshold ${(GATE_PARSE_RATE * 100).toFixed(0)}%`);
console.log(`  verdict                ${passed ? green('PASS') : red('FAIL')}`);

if (total < 20) {
  console.log(`\n  ${yellow(`⚠ only ${total} runs.`)} ${dim(`At n=${total}, ${(GATE_PARSE_RATE * 100).toFixed(0)}% means ` +
    `${Math.ceil(GATE_PARSE_RATE * total)}/${total} — a single bad reply flips the verdict.`)}`);
  console.log(`  ${dim('Use ≥20 fixtures, or --repeat, before treating this rate as real.')}`);
}
if (results.some((r) => r.status === 'transport')) {
  console.log(`\n  ${yellow('⚠ some calls never returned.')} ${dim('Transport failures are counted as gate')}`);
  console.log(`  ${dim('failures on purpose — an unreachable box scores nothing — but fix the network')}`);
  console.log(`  ${dim('first and re-run before concluding anything about the MODEL.')}`);
}
if (!passed) {
  console.log(`\n  ${dim('Before declaring the model unusable, in this order:')}`);
  console.log(`  ${dim('  1. truncation?  raise --max-tokens and re-run.')}`);
  console.log(`  ${dim('  2. near-miss JSON (prose around it, markdown fences)? many servers support')}`);
  console.log(`  ${dim('     response_format / guided JSON decoding — that is a Phase-2 adapter option.')}`);
  console.log(`  ${dim('  3. still failing on finish_reason=stop → the model cannot hold the contract.')}`);
  console.log(`  ${dim('     Roadmap says stop. A hybrid (chat local, evaluate on Claude) is a valid end')}`);
  console.log(`  ${dim('     state — services/ai.js already supports it via AI_PROVIDER_EVALUATE.')}`);
}
console.log(`\n  ${bold('next:')} node scripts/probe/thai-probe.mjs   ${dim('(the other half of Gate 0)')}`);

await writeReport(flags.out, {
  probe: 'json-contract', at: new Date().toISOString(),
  target: { baseUrl: cfg.baseUrl, model: cfg.model },
  config: { maxTokens, temperature: temperature ?? null, concurrency, repeat, fixturesDir, fixtures: fixtures.length },
  gate: { threshold: GATE_PARSE_RATE, rate, passed, ok: okRuns.length, total },
  outcomes: Object.fromEntries(distribution(results.map((r) => r.status))),
  finishReasons: Object.fromEntries(distribution(answered.map((r) => r.finishReason))),
  outputTokens: outTokens.length ? {
    min: Math.min(...outTokens), p50: percentile(outTokens, 50), p95: percentile(outTokens, 95),
    max: Math.max(...outTokens), mean: mean(outTokens),
  } : null,
  latencyMs: latencies.length ? { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: Math.max(...latencies) } : null,
  tokensPerSec: tpsAll.length ? { p50: percentile(tpsAll, 50), mean: mean(tpsAll) } : null,
  // Deliberately NOT recording reply text or fixture content — a report file must stay safe to paste
  // into an issue.
  runs: results.map((r) => ({
    fixture: r.fixture.name, run: r.run, status: r.status, ms: Math.round(r.ms),
    finishReason: r.finishReason ?? null, stopReason: r.stopReason ?? null,
    promptTokens: r.promptTokens ?? 0, completionTokens: r.completionTokens ?? 0,
    detail: r.status === 'ok' ? null : String(r.detail).slice(0, 300),
  })),
});

process.exit(passed ? 0 : 1);
