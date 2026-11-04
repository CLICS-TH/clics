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
 *   --cap <usd>       stop before a call could take the spend past this (default and most 25)
 *   --samples n       samples per tier path (default 3, odd)
 *   --concurrency n   calls at once (default 3)
 *   --out <dir>       where the JSON report and summary go (default scripts/booth/path-table-runs)
 *   --go              spend: without it the script stops after the estimate
 *
 * Env: RIMPL_URL (default http://localhost:3003) and INTERNAL_TOKEN for rimpl. Its only call is rimpl's /evaluate
 * (shadow off), and it refuses to run with a database client loaded. One probe call runs first: a provider other than
 * anthropic, or a prompt other than this checkout's, stops the build before the rest is spent.
 * Exit 0 when every case got a table and passes the re-check, 1 otherwise, 2 on a bad argument or setup.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewedTree, medianDomains, recheck, summaryMarkdown } from './path-table.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const { TIER_PATHS, replyProblems, readReplies, jobsFor, scoreSample } = require('./path-table-sample.js');
const { PATHS, runPlays, rimplCalls, worstCall } = require('./sandbox-play.js');
const { CaseTreeSchema, caseTreeProblems } = require(path.join(ROOT, 'backend', 'src', 'booth-cases', 'tree-schema'));
const { compositeScore } = require(path.join(ROOT, 'backend', 'src', 'services', 'ple-gate'));
const { costUsd } = require(path.join(ROOT, 'backend', 'src', 'lib', 'pricing'));
const { pis7PromptFor } = require(path.join(ROOT, 'rimpl', 'src', 'lib', 'prompts'));
const { promptVersionFor } = require(path.join(ROOT, 'rimpl', 'src', 'lib', 'versions'));

const CAP_MAX = 25;
// What an evaluate call cost on average in #264's sandbox runs (sandbox-play.js TYPICAL_TOKENS).
const TYPICAL_EVALUATE = [4000, 405];

const fail = (msg) => { console.error(msg); process.exit(2); };

const DB_CLIENT = /[\\/](@supabase|pg|postgres)[\\/]|[\\/]lib[\\/]supabase\.js$/;
const dbModules = Object.keys(require.cache).filter((m) => DB_CLIENT.test(m));
if (dbModules.length) fail(`the build refuses to run with a database client loaded: ${dbModules[0]}`);

function parseArgs(argv) {
  const opts = { cases: path.join(ROOT, 'backend', 'src', 'booth-cases', 'NFCME-2026'), only: [], cap: CAP_MAX, samples: 3,
    concurrency: 3, out: path.join(HERE, 'path-table-runs'), go: false };
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
const worst = worstCall('evaluate');
const typical = costUsd(...TYPICAL_EVALUATE, 'anthropic');
console.log(`${building.length} case(s) to build, ${jobs.length} evaluator calls. Estimated spend $${(jobs.length * typical).toFixed(2)} `
  + `typical, $${(jobs.length * worst).toFixed(2)} if every call bills its worst case. Cap $${opts.cap}.`);
if (!opts.go) {
  console.log('Nothing spent. Add --go to run.');
  process.exit(0);
}
if (!jobs.length) fail('no case can be built');

const token = process.env.INTERNAL_TOKEN;
if (!token) fail('INTERNAL_TOKEN is not set (rimpl refuses calls without it)');
let rimpl;
try { rimpl = rimplCalls({ url: process.env.RIMPL_URL || 'http://localhost:3003', token }); } catch (err) { fail(err.message); }

const runId = `ptb-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${randomBytes(2).toString('hex')}`;
const expected = { provider: 'anthropic', prompt_version: promptVersionFor('anthropic') };
const promptSha = createHash('sha256').update(pis7PromptFor('anthropic')).digest('hex');
let done = 0;
const run = (batch, capUsd) => runPlays(batch, {
  capUsd,
  concurrency: opts.concurrency,
  worst: () => worst,
  play: (job) => scoreSample({ kase: job.kase, replies: job.replies, tierPath: job.tierPath, evaluate: rimpl.evaluate }),
  onDone: (job, r) => {
    done += 1;
    console.log(`[${done}] ${job.kase.case_id} ${job.tierPath}#${job.sample} ${r.composite ?? `unscored (${r.error ?? r.skipped})`} $${r.usd ?? 0}`);
  },
});

// The probe: one call on its own, so a wrong provider or prompt costs one call, not the build.
const probe = await run(jobs.slice(0, 1), opts.cap);
const first = probe.results[0];
if (first.provider !== expected.provider || first.prompt_version !== expected.prompt_version) {
  fail(`probe scored by ${first.provider ?? 'nothing'} with ${first.prompt_version ?? 'no prompt'} (${first.error ?? 'ok'}), `
    + `expected ${expected.provider} with ${expected.prompt_version}; $${probe.spent_usd} spent`);
}
const rest = await run(jobs.slice(1), opts.cap - probe.spent_usd);
let results = [first, ...rest.results];
let spent = probe.spent_usd + rest.spent_usd;
let { stopped } = rest;
// One retry of each sample a call failed, while the cap allows.
const failed = results.map((r, i) => (r.domains || r.skipped ? null : i)).filter((i) => i != null);
if (failed.length && !stopped) {
  const retry = await run(failed.map((i) => jobs[i]), opts.cap - spent);
  failed.forEach((i, k) => { if (retry.results[k].domains || !retry.results[k].skipped) results[i] = retry.results[k]; });
  spent += retry.spent_usd;
  stopped = retry.stopped;
}
spent = Math.round(spent * 1e6) / 1e6;
const overCap = spent > opts.cap;

// Every table must come from one evaluator configuration: the one the probe checked.
const scored = results.filter((r) => r.domains);
const configs = new Set(scored.map((r) => JSON.stringify([r.provider, r.model, r.prompt_version, r.config_fingerprint])));
const oneConfig = configs.size === 1;
if (!oneConfig) console.error(`samples came from ${configs.size} evaluator configurations: no table is written`);

const date = new Date().toISOString().slice(0, 10);
const samplesOf = (id, p) => results.filter((r, i) => r.domains && jobs[i].kase.case_id === id && jobs[i].tierPath === p);
const report = {
  run_id: runId, date, rimpl_url: process.env.RIMPL_URL || 'http://localhost:3003', cap_usd: opts.cap, spent_usd: spent,
  stopped, over_cap: overCap, samples: opts.samples, planned: jobs.length, scored: scored.length,
  evaluator: { provider: first.provider, model: first.model, prompt_version: first.prompt_version, prompt_sha256: promptSha, decoding: first.decoding },
  cases: {},
  recheck: null,
  samples_scored: results.map((r, i) => ({ case_id: jobs[i].kase.case_id, tier_path: jobs[i].tierPath, sample: jobs[i].sample, ...r })),
};
for (const c of cases) {
  const id = c.kase.case_id;
  if (c.tree.why) { report.cases[id] = { version: c.kase.version, why: c.tree.why, table: false }; continue; }
  const complete = TIER_PATHS.every((p) => samplesOf(id, p).length === opts.samples);
  const paths = complete ? Object.fromEntries(TIER_PATHS.map((p) => [p, medianDomains(samplesOf(id, p).map((r) => r.domains))])) : null;
  const write = paths && oneConfig && !overCap && /^\d+$/.test(c.kase.version);
  const version = write ? String(Number(c.kase.version) + 1) : c.kase.version;
  if (write) {
    const table = {
      provenance: {
        evaluator_model: first.model, prompt_sha256: promptSha,
        decoding: { temperature: first.decoding.temperature, max_tokens: first.decoding.max_tokens },
        samples_per_path: opts.samples, method: 'median', run_id: runId, date, tree_sha256: c.tree.tree_sha256,
      },
      paths,
    };
    const next = { ...c.raw, version, path_score_table: table };
    const problems = caseTreeProblems(next);
    if (problems.length) fail(`${id}: the built table is invalid, first ${problems[0]}`);
    writeFileSync(c.file, `${JSON.stringify(next, null, 2)}\n`);
  }
  report.cases[id] = {
    version, tree_sha256: c.tree.tree_sha256, reviewed_commit: c.tree.reviewed_commit, table: Boolean(write),
    composites: paths ? Object.fromEntries(TIER_PATHS.map((p) => [p, compositeScore(paths[p])])) : null,
  };
}
const composites = Object.fromEntries(building.map((c) => [c.kase.case_id,
  Object.fromEntries(TIER_PATHS.map((p) => [p, samplesOf(c.kase.case_id, p).map((r) => r.composite)]))]));
report.recheck = recheck(composites, PATHS, {
  samples: opts.samples,
  incomplete: stopped || overCap ? `${scored.length} of ${jobs.length} samples scored${stopped ? ', stopped at the cap' : ''}${overCap ? ', over the cap' : ''}` : undefined,
});
mkdirSync(opts.out, { recursive: true });
const jsonPath = path.join(opts.out, `${runId}.json`);
const mdPath = path.join(opts.out, `${runId}.md`);
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
const summary = summaryMarkdown(report);
writeFileSync(mdPath, summary);
console.log(`\n${summary}\nReport ${jsonPath}\nSummary ${mdPath}`);
const ok = Object.values(report.cases).every((c) => c.table) && Object.values(report.recheck.cases).every((v) => v.pass);
process.exit(ok ? 0 : 1);
