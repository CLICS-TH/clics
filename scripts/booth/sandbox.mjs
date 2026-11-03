#!/usr/bin/env node
/*
 * Physician sandbox (#252, ADR 0005): plays every candidate booth case through rimpl, booth chat then the unchanged
 * evaluator, and reports whether the cases score alike. Per case: the scripted best, mixed and weakest paths once,
 * and the strong, average and weak GP personas 3 times each; personas tap, and type at about one step in four.
 *
 *   node scripts/booth/sandbox.mjs                       # prints the plan and its estimated spend, spends nothing
 *   node --env-file=backend/.env --env-file=rimpl/.env scripts/booth/sandbox.mjs --go --cap 30
 *
 *   --cases <dir>     case folder (default backend/src/booth-cases/NFCME-2026); admission is not required
 *   --case <id>       only this case (repeatable)
 *   --cap <usd>       stop before a play could take the spend past this (default 30)
 *   --persona-runs n  runs per persona (default 3; 0 plays the scripted paths only)
 *   --concurrency n   plays at once (default 3)
 *   --out <dir>       where the JSON report and summary go (default scripts/booth/sandbox-runs)
 *   --go              spend: without it the script stops after the estimate
 *
 * Env: RIMPL_URL (default http://localhost:3003) and INTERNAL_TOKEN for rimpl; ANTHROPIC_API_KEY for the personas.
 * It writes no database row and never calls the booth API: its only calls are rimpl's /chat and /evaluate (with
 * shadow off) and the persona model, and it refuses to run with a database client loaded.
 * Exit 0 when every case passes, 1 when one fails or the cap stopped the run, 2 on a bad argument or setup.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdicts, summaryMarkdown } from './sandbox-verdict.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const { GROUPS, PATHS, ANTHROPIC_MODEL, tapping, personaChooser, playOnce, jobsFor, estimate, runPlays, rimplCalls, personaCall } = require('./sandbox-play.js');
const { CaseTreeSchema, caseTreeProblems } = require(path.join(ROOT, 'backend', 'src', 'booth-cases', 'tree-schema'));

const fail = (msg) => { console.error(msg); process.exit(2); };

const DB_CLIENT = /[\\/](@supabase|pg|postgres)[\\/]|[\\/]lib[\\/]supabase\.js$/;
const dbModules = Object.keys(require.cache).filter((m) => DB_CLIENT.test(m));
if (dbModules.length) fail(`sandbox refuses to run with a database client loaded: ${dbModules[0]} and ${dbModules.length - 1} more`);

function parseArgs(argv) {
  const opts = { cases: path.join(ROOT, 'backend', 'src', 'booth-cases', 'NFCME-2026'), only: [], cap: 30, personaRuns: 3,
    concurrency: 3, out: path.join(HERE, 'sandbox-runs'), go: false };
  const number = (flag, v, min) => { const n = Number(v); if (!Number.isFinite(n) || n < min) fail(`${flag} needs a number >= ${min}`); return n; };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, v] = [argv[i], argv[i + 1]];
    if (flag === '--go') { opts.go = true; continue; }
    if (v === undefined) fail(`${flag} needs a value`);
    i += 1;
    if (flag === '--cases') opts.cases = path.resolve(v);
    else if (flag === '--case') opts.only.push(v);
    else if (flag === '--cap') opts.cap = number(flag, v, 0.01);
    else if (flag === '--persona-runs') opts.personaRuns = Math.floor(number(flag, v, 0));
    else if (flag === '--concurrency') opts.concurrency = Math.floor(number(flag, v, 1));
    else if (flag === '--out') opts.out = path.resolve(v);
    else fail(`unknown argument ${flag}`);
  }
  return opts;
}

function loadCases(dir, only) {
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { fail(`no case folder at ${dir}`); }
  const cases = files.flatMap((f) => {
    let raw;
    try { raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { console.warn(`skip ${f}: not readable JSON`); return []; }
    const problems = caseTreeProblems(raw);
    if (problems.length) { console.warn(`skip ${f}: ${problems[0]}`); return []; }
    return [CaseTreeSchema.parse(raw)];
  }).filter((k) => !only.length || only.includes(k.case_id));
  const missing = only.filter((id) => !cases.some((k) => k.case_id === id));
  if (missing.length) fail(`no playable case ${missing.join(', ')} in ${dir}`);
  if (!cases.length) fail(`no playable case in ${dir}`);
  return cases;
}

const opts = parseArgs(process.argv.slice(2));
const cases = loadCases(opts.cases, opts.only);
const jobs = jobsFor(cases, { personaRuns: opts.personaRuns });
const est = estimate(jobs);
console.log(`${cases.length} case(s): ${cases.map((k) => `${k.case_id}@${k.version}`).join(', ')}`);
console.log(`${est.plays} plays. Estimated spend $${est.typical_usd} typical, $${est.worst_usd} if every call bills its worst case. Cap $${opts.cap}.`);
if (!opts.go) {
  console.log('Nothing spent. Add --go to run.');
  process.exit(0);
}

const token = process.env.INTERNAL_TOKEN;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!token) fail('INTERNAL_TOKEN is not set (rimpl refuses calls without it)');
if (opts.personaRuns > 0 && !apiKey) fail('ANTHROPIC_API_KEY is not set (the personas need it; --persona-runs 0 skips them)');
let rimpl;
try { rimpl = rimplCalls({ url: process.env.RIMPL_URL || 'http://localhost:3003', token }); } catch (err) { fail(err.message); }
const ai = { ...rimpl, ...(apiKey ? { persona: personaCall({ apiKey }) } : {}) };

const runId = `sbx-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${randomBytes(2).toString('hex')}`;
let done = 0;
const { results, spent_usd, stopped } = await runPlays(jobs, {
  capUsd: opts.cap,
  concurrency: opts.concurrency,
  play: (job) => playOnce({ kase: job.kase, ai, choose: job.persona ? personaChooser(job.group) : tapping(PATHS[job.group]) }),
  onDone: (job, r) => {
    done += 1;
    console.log(`[${done}/${jobs.length}] ${job.kase.case_id} ${job.group}#${job.run} ${r.tier_path ?? ''} `
      + `${r.composite ?? `unscored${r.error ? ` (${r.error})` : ''}`} $${r.usd}`);
  },
});

const plays = jobs.map(({ kase, group, run }, i) => ({ case_id: kase.case_id, group, run, ...results[i] }));
const table = Object.fromEntries(cases.map((k) => [k.case_id, Object.fromEntries(GROUPS.map((g) => [g,
  plays.filter((p) => p.case_id === k.case_id && p.group === g && p.composite != null).map((p) => p.composite)]))]));
const report = {
  run_id: runId,
  date: new Date().toISOString().slice(0, 10),
  rimpl_url: process.env.RIMPL_URL || 'http://localhost:3003',
  persona_model: ANTHROPIC_MODEL,
  persona_runs: opts.personaRuns,
  cap_usd: opts.cap,
  spent_usd,
  stopped,
  planned: jobs.length,
  scored: plays.filter((p) => p.composite != null).length,
  providers: [...new Set(plays.flatMap((p) => (p.calls ?? []).filter((c) => c.kind === 'evaluate' && c.provider).map((c) => c.provider)))],
  cases: Object.fromEntries(cases.map((k) => [k.case_id, { version: k.version }])),
  verdict: verdicts(table, GROUPS),
  plays,
};
mkdirSync(opts.out, { recursive: true });
const jsonPath = path.join(opts.out, `${runId}.json`);
const mdPath = path.join(opts.out, `${runId}.md`);
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
const summary = summaryMarkdown(report, GROUPS);
writeFileSync(mdPath, summary);
console.log(`\n${summary}\nReport ${jsonPath}\nSummary ${mdPath}`);
process.exit(!stopped && Object.values(report.verdict.cases).every((c) => c.pass) ? 0 : 1);
