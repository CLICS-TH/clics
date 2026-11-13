#!/usr/bin/env node
/*
 * Builds each booth case's path score table (#373, ADR 0009): for every sampled tier path, 3 sample transcripts walked
 * with a random question variant and random same-tier options, the case's sample replies as the AI's
 * (scripts/booth/sample-replies), scored by the locked PIS-7 evaluator through rimpl. A three-step case samples all 27
 * paths and each entry is the median per domain; a five-step case samples a balanced 27 of its 243 and a median (L1)
 * regression of each domain on step × tier fills all 243 (#381, scripts/booth/path-fit.mjs). A run builds cases of
 * one step count. A case gets a table only when its tree is byte-identical to the tree its safety review read (from
 * git history) and every sampled path is fully scored; the table is written into the case file with its version
 * bumped. The report re-runs ADR 0005's difficulty check: on the scripted paths' samples for three steps, on their
 * fitted entries for five.
 *
 * The cap: CAP_USD is the ceiling on all path-table spend on this machine, over every run of every build, ever. It is
 * counted in the machine's spend ledger (scripts/booth/spend-ledger.mjs, ~/.clics/booth-spend/ledger.jsonl, outside
 * every checkout), which `node scripts/booth/spend-ledger.mjs init` creates once, seeded from the committed record
 * (scripts/booth/path-table-runs/spend.jsonl). Each call is reserved there at its worst case (every attempt rimpl's
 * provider may make, from GET /manifest provider_retries) before it starts, under the ledger's lock and against the
 * whole ledger, so runs at once share the cap; it is settled at its reported tokens plus the worst case of every
 * attempt rimpl retried, so a run killed mid-call stays charged its worst case. The first refused reservation stops
 * the run, and a missing or unreadable ledger refuses --go. The owner opens a new budget by raising CAP_USD in a
 * reviewed commit: until then the $30.49 already spent refuses every --go before any call.
 *
 *   node scripts/booth/build-path-tables.mjs                       # checks trees and replies, spends nothing
 *   node --env-file=rimpl/.env scripts/booth/build-path-tables.mjs --go
 *   node scripts/booth/build-path-tables.mjs --from <samples.jsonl> # builds tables from a saved run, spends nothing
 *
 *   --cases <dir>     case folder (default backend/src/booth-cases/NFCME-2026)
 *   --case <id>       only this case (repeatable)
 *   --cap <usd>       a lower cap on the same machine total, for this run (default and most CAP_USD)
 *   --samples n       samples per tier path (default 3, odd)
 *   --concurrency n   calls at once (default 3)
 *   --out <dir>       where the report, summary, samples and the run's charge line go (default
 *                     scripts/booth/path-table-runs); it never moves the ledger
 *   --go              spend: without it the script stops after the checks
 *   --from <jsonl>    build the tables from a saved run's samples, spending nothing
 *   --replies <dir>   the cases' sample replies (default scripts/booth/sample-replies/<event code>)
 *
 * Env for --go: RIMPL_URL (default http://localhost:3003) and INTERNAL_TOKEN for rimpl. Its only calls are rimpl's
 * GET /manifest and POST /evaluate (shadow off). One probe call runs first: unless it was scored by the locked
 * evaluator (rimpl's model manifest: provider, model, prompt and decoding), the build stops there. Every sample is
 * appended to <out>/<run_id>.samples.jsonl as it lands, before its call is settled, so a run that stops for any reason
 * keeps what it paid for and --from finishes it. A run that ends by itself appends its spend to <out>/spend.jsonl as a
 * charge line, the committed record a later init reads.
 *
 * --from refuses a run that went over the cap it ran under (its header's prior spend plus its own), a sample scored on
 * another tree, and a sample not scored by the locked evaluator. The build refuses to run with a database client
 * loaded. Exit 0 when every case got a table and passes the re-check, 1 otherwise, 2 on a bad argument or setup.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewedTree, tablePlan, recheck, summaryMarkdown } from './path-table.mjs';
import { spent, reserve, settle } from './spend-ledger.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const { LOCKED, replyProblems, readReplies, jobsFor, lockProblems, failedUsd, scoreSample } = require('./path-table-sample.js');
const { PATHS_BY_STEPS, rimplCalls } = require('./sandbox-play.js');
const { CaseTreeSchema, caseTreeProblems } = require(path.join(ROOT, 'backend', 'src', 'booth-cases', 'tree-schema'));
const { costUsd } = require(path.join(ROOT, 'backend', 'src', 'lib', 'pricing'));

const CAP_USD = 25;
// What an evaluate call cost on average in #264's sandbox runs (sandbox-play.js TYPICAL_TOKENS).
const TYPICAL_EVALUATE = [4000, 405];

const fail = (msg) => { console.error(msg); process.exit(2); };

const DB_CLIENT = /[\\/](@supabase|pg|postgres)[\\/]|[\\/]lib[\\/]supabase\.js$/;
const dbModules = Object.keys(require.cache).filter((m) => DB_CLIENT.test(m));
if (dbModules.length) fail(`the build refuses to run with a database client loaded: ${dbModules[0]}`);

function parseArgs(argv) {
  const opts = { cases: path.join(ROOT, 'backend', 'src', 'booth-cases', 'NFCME-2026'), only: [], cap: CAP_USD, samples: 3,
    concurrency: 3, out: path.join(HERE, 'path-table-runs'), go: false, from: null };
  const number = (flag, v, min, max = Infinity) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) fail(`${flag} needs a number from ${min} to ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, v] = [argv[i], argv[i + 1]];
    if (flag === '--go') { opts.go = true; continue; }
    if (v === undefined) fail(`${flag} needs a value`);
    i += 1;
    if (flag === '--cases') opts.cases = path.resolve(v);
    else if (flag === '--case') opts.only.push(v);
    else if (flag === '--cap') opts.cap = number(flag, v, 0.01, CAP_USD);
    else if (flag === '--samples') opts.samples = Math.floor(number(flag, v, 1));
    else if (flag === '--concurrency') opts.concurrency = Math.floor(number(flag, v, 1));
    else if (flag === '--out') opts.out = path.resolve(v);
    else if (flag === '--replies') opts.replies = path.resolve(v);
    else if (flag === '--from') opts.from = path.resolve(v);
    else fail(`unknown argument ${flag}`);
  }
  if (opts.samples % 2 === 0) fail('--samples must be odd, so each median is a whole score');
  if (opts.go && opts.from) fail('--go spends and --from builds from a saved run: pass one of them');
  return opts;
}

/** The case file at each commit that touched it, oldest first, from the repository that holds it. A file with
 *  uncommitted changes, or outside any repository, has no history to trust, so it is refused. */
function fileHistory(file) {
  const git = (...args) => execFileSync('git', args,
    { cwd: path.dirname(file), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const name = `./${path.basename(file)}`;
  try {
    if (git('status', '--porcelain', '--', name).trim()) return { why: 'has uncommitted changes' };
    const commits = git('log', '--format=%H', '--reverse', '--', name).trim().split('\n').filter(Boolean);
    return { history: commits.map((commit) => ({ commit, raw: JSON.parse(git('show', `${commit}:${name}`)) })) };
  } catch { return { why: 'is not in a git repository' }; }
}

function loadCases(dir, only) {
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { fail(`no case folder at ${dir}`); }
  const cases = files.flatMap((f) => {
    const file = path.join(dir, f);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (only.length && !only.includes(raw.case_id)) return [];
    const problems = caseTreeProblems(raw);
    if (problems.length) fail(`${f}: ${problems[0]}`);
    const { history, why } = fileHistory(file);
    const tree = why ? { why } : reviewedTree(history, raw);
    return [{ file, raw, kase: CaseTreeSchema.parse(raw), tree }];
  });
  const missing = only.filter((id) => !cases.some((c) => c.kase.case_id === id));
  if (missing.length) fail(`no case ${missing.join(', ')} in ${dir}`);
  if (!cases.length) fail(`no case in ${dir}`);
  return cases;
}

const opts = parseArgs(process.argv.slice(2));
const cases = loadCases(opts.cases, opts.only);
for (const c of cases) {
  console.log(`${c.kase.case_id}@${c.kase.version}: ${c.tree.why ? `refused, it ${c.tree.why}` : `tree ${c.tree.tree_sha256.slice(0, 12)} as reviewed in ${c.tree.reviewed_commit.slice(0, 8)}`}`);
}
const building = cases.filter((c) => !c.tree.why);
const stepsOf = (c) => Object.keys(c.kase.banks).length;
// The re-check pools the cases of a run, so like must be compared with like.
const stepCounts = [...new Set(building.map(stepsOf))];
if (stepCounts.length > 1) fail(`the cases to build have ${stepCounts.join(' and ')} steps: a run builds one step count, so pick its cases with --case`);
const steps = stepCounts[0] ?? stepsOf(cases[0]);
const scripted = PATHS_BY_STEPS[steps];
let plan;
try { plan = tablePlan(steps, scripted); } catch (err) { fail(err.message); }
for (const c of building) {
  let problems;
  try { c.replies = readReplies(c.kase, opts.replies); problems = replyProblems(c.kase, c.replies); } catch (err) { problems = [err.message]; }
  if (problems.length) fail(`${c.kase.case_id}: ${problems.length} sample reply problem(s), first ${problems[0]}`);
}
const jobs = jobsFor(building.map((c) => c.kase), opts.samples, () => plan.sampled)
  .map((job) => ({ ...job, replies: building.find((c) => c.kase === job.kase).replies }));
console.log(`${building.length} case(s) to build, ${jobs.length} evaluator calls, about `
  + `$${(jobs.length * costUsd(...TYPICAL_EVALUATE, 'anthropic')).toFixed(2)} typical.`);
const treeOf = Object.fromEntries(building.map((c) => [c.kase.case_id, c.tree.tree_sha256]));
const keyOf = (caseId, tierPath, sample) => `${caseId} ${tierPath} ${sample}`;

/** A run's header and samples from its .samples.jsonl: the first line is the header, each other line one sample. */
function readSaved(file) {
  let lines;
  try { lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { fail(`--from ${file} is not a samples file`); }
  const [header, ...samples] = lines;
  if (!header?.run_id) fail(`--from ${file} has no header line`);
  return { header, samples };
}

let run;
if (opts.from) {
  const { header, samples } = readSaved(opts.from);
  if (header.samples !== opts.samples) fail(`--from ${opts.from} has ${header.samples} samples per path, not ${opts.samples}`);
  // The spend before the run plus the run's own, against the cap it ran under.
  if (!Number.isFinite(header.prior_usd) || !Number.isFinite(header.cap_usd)) fail(`--from ${opts.from} records no prior spend and cap`);
  const runUsd = Math.round(samples.reduce((acc, r) => acc + (r.usd ?? 0), 0) * 1e6) / 1e6;
  if (header.prior_usd + runUsd > header.cap_usd) {
    fail(`--from ${opts.from} went over its cap: $${header.prior_usd.toFixed(2)} before it and $${runUsd.toFixed(2)} in it, over $${header.cap_usd}`);
  }
  const stale = samples.filter((r) => r.case_id in treeOf && r.tree_sha256 !== treeOf[r.case_id]);
  if (stale.length) {
    fail(`--from ${opts.from}: ${stale.length} sample(s) were not scored on the current tree, first ${stale[0].case_id} `
      + `${stale[0].tier_path_planned}#${stale[0].sample} on ${stale[0].tree_sha256 ?? 'no recorded tree'}`);
  }
  const byKey = new Map(samples.map((r) => [keyOf(r.case_id, r.tier_path_planned, r.sample), r]));
  run = {
    ...header,
    spent_usd: Math.round(samples.reduce((acc, r) => acc + (r.usd ?? 0), 0) * 1e6) / 1e6,
    results: jobs.map((j) => byKey.get(keyOf(j.kase.case_id, j.tierPath, j.sample)) ?? { domains: null, error: 'not in the saved run' }),
  };
} else {
  if (!opts.go) {
    console.log('Nothing spent. Add --go to spend, or --from <samples.jsonl> to build from a saved run.');
    process.exit(0);
  }
  if (!jobs.length) fail('no case can be built');
  const build = [...new Set(building.map((c) => c.kase.event_code))].join('+');
  let priorUsd;
  try { priorUsd = spent(); } catch (err) { fail(err.message); }
  const roomFor = (worst) => {
    if (priorUsd + worst <= opts.cap) return;
    fail(`path-table builds on this machine have spent $${priorUsd.toFixed(2)} of the $${opts.cap} cap: no room for a call's `
      + `worst case of $${worst.toFixed(2)}. The owner opens a new budget by raising CAP_USD in a reviewed commit.`);
  };
  // A call's worst case is at least one attempt's, so a spent cap is refused before rimpl is asked anything.
  roomFor(failedUsd(0));
  const rimplUrl = process.env.RIMPL_URL || 'http://localhost:3003';
  const token = process.env.INTERNAL_TOKEN;
  if (!token) fail('INTERNAL_TOKEN is not set (rimpl refuses calls without it)');
  let rimpl;
  try { rimpl = rimplCalls({ url: rimplUrl, token }); } catch (err) { fail(err.message); }
  // The retries rimpl's provider makes after a failed attempt, each possibly billed: they set every call's worst case.
  let retries;
  try {
    const res = await fetch(new URL('/manifest', rimplUrl), { headers: { 'x-internal-token': token }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) fail(`rimpl's GET /manifest answered ${res.status}`);
    retries = (await res.json())?.provider_retries?.anthropic;
  } catch (err) { fail(`rimpl's GET /manifest failed: ${err.message}`); }
  if (!Number.isInteger(retries) || retries < 0) fail(`rimpl's GET /manifest reports no provider_retries.anthropic (got ${retries})`);
  const worst = failedUsd(retries);
  roomFor(worst);

  const date = new Date().toISOString().slice(0, 10);
  const runId = `ptb-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${randomBytes(2).toString('hex')}`;
  const header = { run_id: runId, date, rimpl_url: rimplUrl, build, cap_usd: opts.cap, prior_usd: priorUsd,
    provider_retries: retries, samples: opts.samples };
  mkdirSync(opts.out, { recursive: true });
  const savedPath = path.join(opts.out, `${runId}.samples.jsonl`);
  const recordPath = path.join(opts.out, 'spend.jsonl');
  writeFileSync(savedPath, `${JSON.stringify(header)}\n`);
  console.log(`$${priorUsd.toFixed(2)} of the $${opts.cap} cap spent before this run. Samples are saved as they land to ${savedPath}`);

  let stopped = false;
  let halted = null;
  let done = 0;
  /** Scores `batch`, `concurrency` calls at a time, each reserved in the ledger at its worst case first. The first
   *  refused reservation stops the run, and a ledger that fails halts it: that job and every later one stay unplayed. */
  const scoreAll = async (batch, concurrency = opts.concurrency) => {
    const results = batch.map(() => ({ skipped: 'cap' }));
    let next = 0;
    const worker = async () => {
      while (next < batch.length && !stopped && !halted) {
        const i = next;
        next += 1;
        const job = batch[i];
        let id;
        try { id = reserve({ runId, build, usd: worst, cap: opts.cap }); } catch (err) { halted = err.message; return; }
        if (!id) { stopped = true; return; }
        let r;
        try {
          r = await scoreSample({ kase: job.kase, replies: job.replies, tierPath: job.tierPath, evaluate: rimpl.evaluate, retries });
        } catch (err) { r = { tier_path: job.tierPath, domains: null, error: err.message, usd: worst }; }
        appendFileSync(savedPath, `${JSON.stringify({ case_id: job.kase.case_id, tier_path_planned: job.tierPath, sample: job.sample,
          tree_sha256: treeOf[job.kase.case_id], ...r })}\n`);
        results[i] = r;
        done += 1;
        console.log(`[${done}] ${job.kase.case_id} ${job.tierPath}#${job.sample} ${r.composite ?? `unscored (${r.error})`} $${r.usd}`);
        // The sample is saved before it is settled: a settle that fails leaves the call at its worst case, never unpaid.
        try { settle(id, r.usd); } catch (err) { halted = `${err.message}; that call stays reserved at its worst case`; }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
  };
  /** Appends the run's spend, as the ledger holds it, to the committed record. */
  const charge = () => {
    const usd = spent(runId);
    appendFileSync(recordPath, `${JSON.stringify({ kind: 'charge', run_id: runId, usd, date, build })}\n`);
    return usd;
  };
  const halt = () => {
    let note;
    try { note = `$${charge().toFixed(2)} of it is charged in ${recordPath}`; } catch (err) { note = `its spend is not in ${recordPath}: ${err.message}`; }
    fail(`the build stopped on its spend ledger: ${halted}. Its samples are in ${savedPath}; ${note}`);
  };

  // The probe: one call on its own, so a wrong evaluator costs one call, not the build.
  const [first] = await scoreAll(jobs.slice(0, 1), 1);
  if (halted) halt();
  if (first.skipped) fail(`path-table builds on this machine left no room under the $${opts.cap} cap for the probe call`);
  const unlocked = first.domains ? lockProblems(first) : [`unscored (${first.error})`];
  if (unlocked.length) {
    let usd;
    try { usd = charge(); } catch (err) { fail(err.message); }
    fail(`the probe was not scored by the locked evaluator: ${unlocked.join('; ')}; $${usd} spent`);
  }
  const results = [first, ...await scoreAll(jobs.slice(1))];
  if (halted) halt();
  // One retry of each sample a call failed, while the cap allows.
  const failed = results.map((r, i) => (r.domains || r.skipped ? null : i)).filter((i) => i != null);
  if (failed.length && !stopped) {
    const retry = await scoreAll(failed.map((i) => jobs[i]));
    failed.forEach((i, k) => { if (!retry[k].skipped) results[i] = retry[k]; });
    if (halted) halt();
  }
  let runUsd;
  let total;
  try { runUsd = charge(); total = spent(); } catch (err) { fail(err.message); }
  run = { ...header, spent_usd: runUsd, stopped, over_cap: total > opts.cap, results };
}

const { results, run_id: runId, date } = run;
const overCap = Boolean(run.over_cap);
const scored = results.filter((r) => r.domains);
// Every table must come from the locked evaluator, in one configuration.
const configs = new Set(scored.map((r) => JSON.stringify([r.provider, r.model, r.prompt_version, r.config_fingerprint])));
const unlockedSample = scored.find((r) => lockProblems(r).length);
const first = scored[0] ?? {};
const oneConfig = configs.size === 1 && !unlockedSample;
if (!oneConfig) {
  console.error(`samples came from ${configs.size} evaluator configuration(s)${unlockedSample ? `, one not the locked evaluator: ${lockProblems(unlockedSample).join('; ')}` : ''}: no table is written`);
}

const samplesOf = (id, p) => results.filter((r, i) => r.domains && jobs[i].kase.case_id === id && jobs[i].tierPath === p);
const report = {
  run_id: runId, date, rimpl_url: run.rimpl_url, cap_usd: run.cap_usd, spent_usd: run.spent_usd,
  stopped: Boolean(run.stopped), over_cap: overCap, samples: opts.samples, planned: jobs.length, scored: scored.length,
  ...(opts.from ? { finished_from: path.relative(ROOT, opts.from) } : {}),
  evaluator: { provider: first.provider, model: first.model, prompt_version: first.prompt_version, prompt_sha256: LOCKED.prompt_sha256, decoding: first.decoding },
  method: plan.method, scripted, sampled: plan.sampled,
  cases: {},
  recheck: null,
};
const built = Object.fromEntries(building.map((c) => {
  const id = c.kase.case_id;
  const complete = plan.sampled.every((p) => samplesOf(id, p).length === opts.samples);
  return [id, {
    composites: Object.fromEntries(plan.sampled.map((p) => [p, samplesOf(id, p).map((r) => r.composite)])),
    table: complete ? plan.build((p) => samplesOf(id, p).map((r) => r.domains)) : null,
  }];
}));
report.recheck = recheck(plan, built, {
  samples: opts.samples,
  incomplete: run.stopped || overCap ? `${scored.length} of ${jobs.length} samples scored${run.stopped ? ', stopped at the cap' : ''}${overCap ? ', over the cap' : ''}` : undefined,
});
for (const c of cases) {
  const id = c.kase.case_id;
  if (c.tree.why) { report.cases[id] = { version: c.kase.version, why: c.tree.why, table: false }; continue; }
  const { table } = built[id];
  const paths = table?.paths ?? null;
  let why = !paths ? 'not every path is fully scored' : !oneConfig ? 'not one locked evaluator configuration'
    : overCap ? 'the build went over its cap' : !/^\d+$/.test(c.kase.version) ? `version ${c.kase.version} is not a whole number` : null;
  const version = why ? c.kase.version : String(Number(c.kase.version) + 1);
  if (!why) {
    // A pass admits the table (ADR 0005); a fail leaves the case out until the owner waives it against this run.
    const passed = report.recheck.cases[id]?.pass;
    const admission = { ...c.raw.admission, ...(passed ? { table_check: { run_id: runId, date } } : {}) };
    const next = { ...c.raw, version, admission, path_score_table: {
      provenance: {
        evaluator_model: first.model, prompt_sha256: LOCKED.prompt_sha256,
        decoding: { temperature: first.decoding.temperature, max_tokens: first.decoding.max_tokens },
        samples_per_path: opts.samples, method: plan.method, run_id: runId, date, tree_sha256: c.tree.tree_sha256,
      },
      paths,
    } };
    const problems = caseTreeProblems(next);
    if (problems.length) why = `the built table is invalid: ${problems[0]}`;
    else writeFileSync(c.file, `${JSON.stringify(next, null, 2)}\n`);
  }
  report.cases[id] = {
    version: why ? c.kase.version : version, tree_sha256: c.tree.tree_sha256, reviewed_commit: c.tree.reviewed_commit, table: !why,
    ...(why ? { why } : {}),
    composites: table?.composites ?? null,
    ...(table?.mislabels ? { mislabels: table.mislabels } : {}),
  };
}
mkdirSync(opts.out, { recursive: true });
const jsonPath = path.join(opts.out, `${runId}.json`);
const mdPath = path.join(opts.out, `${runId}.md`);
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
const summary = summaryMarkdown(report);
writeFileSync(mdPath, summary);
console.log(`\n${summary}\nReport ${jsonPath}\nSummary ${mdPath}`);
const ok = Object.values(report.cases).every((c) => c.table) && Object.values(report.recheck.cases).every((v) => v.pass);
process.exit(ok ? 0 : 1);
