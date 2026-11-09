#!/usr/bin/env node
/*
 * Builds each booth case's path score table (#373, ADR 0009) from a saved run's samples: for every one of the 27 tier
 * paths, 3 sample transcripts walked with a random question variant and random same-tier options, the case's sample
 * replies as the AI's (scripts/booth/sample-replies), scored by the locked PIS-7 evaluator. Each table entry is the
 * median per domain. A case gets a table only when its tree is byte-identical to the tree its safety review read (from
 * git history) and every path is fully scored; the table is written into the case file with its version bumped. The
 * report re-runs ADR 0005's difficulty check on the samples.
 *
 * LIVE BUILDS ARE OFF until #408 gives the build a spend cap that holds. This script sends no evaluator request: --go
 * is refused before anything else runs, and the only build is --from, from a saved run's samples, which spends nothing.
 * The samples of the runs already made (scripts/booth/path-table-runs/) and their spend record (spend.jsonl, $30.49)
 * stay as they are.
 *
 *   node scripts/booth/build-path-tables.mjs                       # checks trees and replies, spends nothing
 *   node scripts/booth/build-path-tables.mjs --from <samples.jsonl> # builds tables from a saved run, spends nothing
 *
 *   --cases <dir>     case folder (default backend/src/booth-cases/NFCME-2026)
 *   --case <id>       only this case (repeatable)
 *   --samples n       samples per tier path (default 3, odd)
 *   --out <dir>       where the JSON report and summary go (default scripts/booth/path-table-runs)
 *   --from <jsonl>    build the tables from a saved run's samples
 *   --replies <dir>   the cases' sample replies (default scripts/booth/sample-replies/<event code>)
 *
 * --from refuses a run that went over the cap it ran under (its header's prior spend plus its own), a sample scored on
 * another tree, and a sample not scored by the locked evaluator (rimpl's model manifest: provider, model, prompt and
 * decoding). It refuses to run with a database client loaded.
 * Exit 0 when every case got a table and passes the re-check, 1 otherwise, 2 on a bad argument or setup.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewedTree, medianDomains, recheck, summaryMarkdown } from './path-table.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const { TIER_PATHS, LOCKED, replyProblems, readReplies, jobsFor, lockProblems } = require('./path-table-sample.js');
const { PATHS } = require('./sandbox-play.js');
const { CaseTreeSchema, caseTreeProblems } = require(path.join(ROOT, 'backend', 'src', 'booth-cases', 'tree-schema'));
const { compositeScore } = require(path.join(ROOT, 'backend', 'src', 'services', 'ple-gate'));

const fail = (msg) => { console.error(msg); process.exit(2); };
const LIVE_OFF = 'Live table builds are off until #408 gives the build a spend cap that holds: --go is refused and no evaluator '
  + 'request was sent. --from <samples.jsonl> builds tables from a saved run, spending nothing.';

// Refused before anything else runs, whatever else is passed: the build never reaches rimpl.
if (process.argv.slice(2).includes('--go')) fail(LIVE_OFF);

const DB_CLIENT = /[\\/](@supabase|pg|postgres)[\\/]|[\\/]lib[\\/]supabase\.js$/;
const dbModules = Object.keys(require.cache).filter((m) => DB_CLIENT.test(m));
if (dbModules.length) fail(`the build refuses to run with a database client loaded: ${dbModules[0]}`);

function parseArgs(argv) {
  const opts = { cases: path.join(ROOT, 'backend', 'src', 'booth-cases', 'NFCME-2026'), only: [], samples: 3,
    out: path.join(HERE, 'path-table-runs'), from: null };
  const number = (flag, v, min, max = Infinity) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) fail(`${flag} needs a number from ${min} to ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, v] = [argv[i], argv[i + 1]];
    if (v === undefined) fail(`${flag} needs a value`);
    i += 1;
    if (flag === '--cases') opts.cases = path.resolve(v);
    else if (flag === '--case') opts.only.push(v);
    else if (flag === '--samples') opts.samples = Math.floor(number(flag, v, 1));
    else if (flag === '--out') opts.out = path.resolve(v);
    else if (flag === '--replies') opts.replies = path.resolve(v);
    else if (flag === '--from') opts.from = path.resolve(v);
    else fail(`unknown argument ${flag}`);
  }
  if (opts.samples % 2 === 0) fail('--samples must be odd, so each median is a whole score');
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
for (const c of building) {
  let problems;
  try { c.replies = readReplies(c.kase, opts.replies); problems = replyProblems(c.kase, c.replies); } catch (err) { problems = [err.message]; }
  if (problems.length) fail(`${c.kase.case_id}: ${problems.length} sample reply problem(s), first ${problems[0]}`);
}
const jobs = jobsFor(building.map((c) => c.kase), opts.samples)
  .map((job) => ({ ...job, replies: building.find((c) => c.kase === job.kase).replies }));
console.log(`${building.length} case(s) to build, ${jobs.length} samples to read.`);
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

if (!opts.from) {
  console.log(`Nothing spent. ${LIVE_OFF}`);
  process.exit(0);
}
let run;
{
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
}

const { results, run_id: runId, date } = run;
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
  samples: opts.samples, planned: jobs.length, scored: scored.length, finished_from: path.relative(ROOT, opts.from),
  evaluator: { provider: first.provider, model: first.model, prompt_version: first.prompt_version, prompt_sha256: LOCKED.prompt_sha256, decoding: first.decoding },
  cases: {},
  recheck: null,
};
const composites = Object.fromEntries(building.map((c) => [c.kase.case_id,
  Object.fromEntries(TIER_PATHS.map((p) => [p, samplesOf(c.kase.case_id, p).map((r) => r.composite)]))]));
report.recheck = recheck(composites, PATHS, {
  samples: opts.samples,
});
for (const c of cases) {
  const id = c.kase.case_id;
  if (c.tree.why) { report.cases[id] = { version: c.kase.version, why: c.tree.why, table: false }; continue; }
  const complete = TIER_PATHS.every((p) => samplesOf(id, p).length === opts.samples);
  const paths = complete ? Object.fromEntries(TIER_PATHS.map((p) => [p, medianDomains(samplesOf(id, p).map((r) => r.domains))])) : null;
  let why = !paths ? 'not every path is fully scored' : !oneConfig ? 'not one locked evaluator configuration'
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
