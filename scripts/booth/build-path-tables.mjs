#!/usr/bin/env node
/*
 * Builds each booth case's path score table (#373, ADR 0009): for every one of the 27 tier paths, 3 sample
 * transcripts walked with a random question variant and random same-tier options, the case's sample replies as the
 * AI's (scripts/booth/sample-replies), scored by the locked PIS-7 evaluator through rimpl on the Anthropic API. Each
 * table entry is the median per domain. A case gets a table only when its tree is byte-identical to the tree its
 * safety review read (from git history) and every path is fully scored; the table is written into the case file with
 * its version bumped. The report re-runs ADR 0005's difficulty check on the samples.
 *
 *   node scripts/booth/build-path-tables.mjs              # checks trees and replies, prints the estimate, spends nothing
 *   node --env-file=rimpl/.env scripts/booth/build-path-tables.mjs --go
 *
 *   --cases <dir>     case folder (default backend/src/booth-cases/NFCME-2026)
 *   --case <id>       only this case (repeatable)
 *   --cap <usd>       the build's cap: stop before a call could take its spend, over every run, past this (default and
 *                     most 25)
 *   --samples n       samples per tier path (default 3, odd)
 *   --concurrency n   calls at once (default 3)
 *   --out <dir>       where the JSON report and summary go (default scripts/booth/path-table-runs)
 *   --go              spend: without it the script stops after the estimate
 *   --from <jsonl>    build the tables from an earlier run's saved samples, spending nothing
 *
 * Every scored sample is appended to <out>/<run_id>.samples.jsonl as it lands, before anything is checked or written,
 * so a run that stops for any reason keeps what it paid for; --from finishes it, refusing a sample scored on another
 * tree. A build is the case folder: every run of it is charged in <out>/spend.json, and the cap counts all of them.
 * Each call is charged its reported tokens plus the worst case of every attempt rimpl retried, and a failed call its
 * worst case for every attempt it may have made.
 * Env: RIMPL_URL (default http://localhost:3003) and INTERNAL_TOKEN for rimpl. Its only call is rimpl's /evaluate
 * (shadow off), and it refuses to run with a database client loaded. One probe call runs first: unless it was scored by
 * the locked evaluator (rimpl's model manifest: provider, model, prompt and decoding), the build stops there, and no
 * table is written from a sample that was not.
 * Exit 0 when every case got a table and passes the re-check, 1 otherwise, 2 on a bad argument or setup.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewedTree, medianDomains, recheck, summaryMarkdown } from './path-table.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const { TIER_PATHS, LOCKED, replyProblems, readReplies, jobsFor, lockProblems, failedUsd, scoreSample } = require('./path-table-sample.js');
const { PATHS, runPlays, rimplCalls } = require('./sandbox-play.js');
const { CaseTreeSchema, caseTreeProblems } = require(path.join(ROOT, 'backend', 'src', 'booth-cases', 'tree-schema'));
const { compositeScore } = require(path.join(ROOT, 'backend', 'src', 'services', 'ple-gate'));
const { costUsd } = require(path.join(ROOT, 'backend', 'src', 'lib', 'pricing'));

const CAP_MAX = 25;
// What an evaluate call cost on average in #264's sandbox runs (sandbox-play.js TYPICAL_TOKENS).
const TYPICAL_EVALUATE = [4000, 405];

const fail = (msg) => { console.error(msg); process.exit(2); };

const DB_CLIENT = /[\\/](@supabase|pg|postgres)[\\/]|[\\/]lib[\\/]supabase\.js$/;
const dbModules = Object.keys(require.cache).filter((m) => DB_CLIENT.test(m));
if (dbModules.length) fail(`the build refuses to run with a database client loaded: ${dbModules[0]}`);

function parseArgs(argv) {
  const opts = { cases: path.join(ROOT, 'backend', 'src', 'booth-cases', 'NFCME-2026'), only: [], cap: CAP_MAX, samples: 3,
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
    else if (flag === '--cap') opts.cap = number(flag, v, 0.01, CAP_MAX);
    else if (flag === '--samples') opts.samples = Math.floor(number(flag, v, 1));
    else if (flag === '--concurrency') opts.concurrency = Math.floor(number(flag, v, 1));
    else if (flag === '--out') opts.out = path.resolve(v);
    else if (flag === '--from') opts.from = path.resolve(v);
    else fail(`unknown argument ${flag}`);
  }
  if (opts.samples % 2 === 0) fail('--samples must be odd, so each median is a whole score');
  return opts;
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The case file at each commit that touched it, oldest first. A file with uncommitted changes has no history to
 *  trust, so it is refused. */
function fileHistory(file) {
  const rel = path.relative(ROOT, file);
  if (git('status', '--porcelain', '--', rel).trim()) return { why: 'has uncommitted changes' };
  const commits = git('log', '--format=%H', '--reverse', '--', rel).trim().split('\n').filter(Boolean);
  return { history: commits.map((commit) => ({ commit, raw: JSON.parse(git('show', `${commit}:${rel}`)) })) };
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
for (const c of building) {
  let problems;
  try { c.replies = readReplies(c.kase); problems = replyProblems(c.kase, c.replies); } catch (err) { problems = [err.message]; }
  if (problems.length) fail(`${c.kase.case_id}: ${problems.length} sample reply problem(s), first ${problems[0]}`);
}
const jobs = jobsFor(building.map((c) => c.kase), opts.samples)
  .map((job) => ({ ...job, replies: building.find((c) => c.kase === job.kase).replies }));
const typical = costUsd(...TYPICAL_EVALUATE, 'anthropic');
const build = path.basename(opts.cases);
const ledgerPath = path.join(opts.out, 'spend.json');
let ledger = {};
try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') fail(`${ledgerPath} is not a spend ledger`); }
const priorUsd = Math.round((ledger[build] ?? []).reduce((acc, r) => acc + r.usd, 0) * 1e6) / 1e6;
const capLeft = Math.round((opts.cap - priorUsd) * 1e6) / 1e6;
console.log(`${building.length} case(s) to build, ${jobs.length} evaluator calls. Estimated spend $${(jobs.length * typical).toFixed(2)} `
  + `typical. Build ${build} has spent $${priorUsd.toFixed(2)} of its $${opts.cap} cap, $${capLeft.toFixed(2)} left.`);
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
    console.log('Nothing spent. Add --go to run, or --from <samples.jsonl> to finish a saved run.');
    process.exit(0);
  }
  if (!jobs.length) fail('no case can be built');
  if (capLeft < failedUsd()) fail(`build ${build} has spent $${priorUsd.toFixed(2)} of its $${opts.cap} cap: no room for another call`);
  const token = process.env.INTERNAL_TOKEN;
  if (!token) fail('INTERNAL_TOKEN is not set (rimpl refuses calls without it)');
  let rimpl;
  try { rimpl = rimplCalls({ url: process.env.RIMPL_URL || 'http://localhost:3003', token }); } catch (err) { fail(err.message); }

  const runId = `ptb-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${randomBytes(2).toString('hex')}`;
  const header = { run_id: runId, date: new Date().toISOString().slice(0, 10), rimpl_url: process.env.RIMPL_URL || 'http://localhost:3003',
    build, cap_usd: opts.cap, prior_usd: priorUsd, samples: opts.samples };
  mkdirSync(opts.out, { recursive: true });
  const savedPath = path.join(opts.out, `${runId}.samples.jsonl`);
  writeFileSync(savedPath, `${JSON.stringify(header)}\n`);
  console.log(`Samples are saved as they land to ${savedPath}`);
  const charge = { run_id: runId, date: header.date, usd: 0 };
  ledger[build] = [...(ledger[build] ?? []), charge];
  const saveLedger = () => writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  saveLedger();
  let done = 0;
  const go = (batch, capUsd) => runPlays(batch, {
    capUsd,
    concurrency: opts.concurrency,
    worst: () => failedUsd(),
    play: (job) => scoreSample({ kase: job.kase, replies: job.replies, tierPath: job.tierPath, evaluate: rimpl.evaluate }),
    onDone: (job, r) => {
      done += 1;
      appendFileSync(savedPath, `${JSON.stringify({ case_id: job.kase.case_id, tier_path_planned: job.tierPath, sample: job.sample,
        tree_sha256: treeOf[job.kase.case_id], ...r })}\n`);
      charge.usd = Math.round((charge.usd + (r.usd ?? 0)) * 1e6) / 1e6;
      saveLedger();
      console.log(`[${done}] ${job.kase.case_id} ${job.tierPath}#${job.sample} ${r.composite ?? `unscored (${r.error ?? r.skipped})`} $${r.usd ?? 0}`);
    },
  });

  // The probe: one call on its own, so a wrong evaluator costs one call, not the build.
  const probe = await go(jobs.slice(0, 1), capLeft);
  const first = probe.results[0];
  const unlocked = first.domains ? lockProblems(first) : [`unscored (${first.error ?? first.skipped})`];
  if (unlocked.length) fail(`the probe was not scored by the locked evaluator: ${unlocked.join('; ')}; $${probe.spent_usd} spent`);
  const rest = await go(jobs.slice(1), capLeft - probe.spent_usd);
  const results = [first, ...rest.results];
  let spent = probe.spent_usd + rest.spent_usd;
  let { stopped } = rest;
  // One retry of each sample a call failed, while the cap allows.
  const failed = results.map((r, i) => (r.domains || r.skipped ? null : i)).filter((i) => i != null);
  if (failed.length && !stopped) {
    const retry = await go(failed.map((i) => jobs[i]), capLeft - spent);
    failed.forEach((i, k) => { if (!retry.results[k].skipped) results[i] = retry.results[k]; });
    spent += retry.spent_usd;
    stopped = retry.stopped;
  }
  run = { ...header, spent_usd: Math.round(spent * 1e6) / 1e6, stopped, results };
  run.over_cap = run.prior_usd + run.spent_usd > run.cap_usd;
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
  cases: {},
  recheck: null,
};
const composites = Object.fromEntries(building.map((c) => [c.kase.case_id,
  Object.fromEntries(TIER_PATHS.map((p) => [p, samplesOf(c.kase.case_id, p).map((r) => r.composite)]))]));
report.recheck = recheck(composites, PATHS, {
  samples: opts.samples,
  incomplete: run.stopped || overCap ? `${scored.length} of ${jobs.length} samples scored${run.stopped ? ', stopped at the cap' : ''}${overCap ? ', over the cap' : ''}` : undefined,
});
for (const c of cases) {
  const id = c.kase.case_id;
  if (c.tree.why) { report.cases[id] = { version: c.kase.version, why: c.tree.why, table: false }; continue; }
  const complete = TIER_PATHS.every((p) => samplesOf(id, p).length === opts.samples);
  const paths = complete ? Object.fromEntries(TIER_PATHS.map((p) => [p, medianDomains(samplesOf(id, p).map((r) => r.domains))])) : null;
  let why = !paths ? 'not every path is fully scored' : !oneConfig ? 'not one locked evaluator configuration' : overCap ? 'the build went over its cap'
    : !/^\d+$/.test(c.kase.version) ? `version ${c.kase.version} is not a whole number` : null;
  const version = why ? c.kase.version : String(Number(c.kase.version) + 1);
  if (!why) {
    // A pass admits the table (ADR 0005); a fail leaves the case out until the owner waives it against this run.
    const passed = report.recheck.cases[id]?.pass;
    const admission = { ...c.raw.admission, ...(passed ? { table_check: { run_id: runId, date } } : {}) };
    const next = { ...c.raw, version, admission, path_score_table: {
      provenance: {
        evaluator_model: first.model, prompt_sha256: LOCKED.prompt_sha256,
        decoding: { temperature: first.decoding.temperature, max_tokens: first.decoding.max_tokens },
        samples_per_path: opts.samples, method: 'median', run_id: runId, date, tree_sha256: c.tree.tree_sha256,
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
    composites: paths ? Object.fromEntries(TIER_PATHS.map((p) => [p, compositeScore(paths[p])])) : null,
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
