#!/usr/bin/env node
/*
 * Keeps a study snapshot of every admitted booth case version (#389): backend/src/booth-cases/<EVENT>/versions/
 * <case_id>@<version>.json, the case's id, event, version, teaser, vignette and banks. The auditor queue rebuilds a
 * play's transcript from the snapshot of the version it was played on, so a play stays auditable after its case file
 * moves to a new version. Snapshots are append-only: this script writes a missing one and never rewrites one.
 *
 *   node scripts/booth/snapshot-case-versions.mjs                     # each admitted case file's current version
 *   node scripts/booth/snapshot-case-versions.mjs --from-git          # every version in git history admitted when committed
 *   node scripts/booth/snapshot-case-versions.mjs [--from-git] --check  # writes nothing
 *
 * --from-git recovers the versions admitted before snapshots were kept (the visitor plays of 3-4 Nov 2026 ran on
 * them). It takes every committed version of an event's case file that had a safety review and a sandbox pass or
 * owner waiver, the least any admission rule has asked for (#359), so it may also keep a version never dealt: a
 * snapshot no play names is harmless.
 *
 * Exit 1 naming each version with no snapshot (--check), a snapshot that differs from its case file (the case changed
 * without a new version), or two committed texts under one version; 2 on a bad argument or a version that cannot name
 * a file.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CASES = fileURLToPath(new URL('../../backend/src/booth-cases', import.meta.url));
const { CaseTreeSchema, caseTreeProblems, isAdmitted } = require(path.join(CASES, 'tree-schema'));
const { snapshotOf, snapshotState, snapshotProblem } = require(path.join(CASES, 'study-snapshot'));

const FLAGS = ['--check', '--from-git'];
const args = process.argv.slice(2);
const unknown = args.find((a) => !FLAGS.includes(a));
if (unknown) {
  console.error(`unknown argument ${unknown}; usage: snapshot-case-versions.mjs [--from-git] [--check]`);
  process.exit(2);
}
const check = args.includes('--check');
const EVENT_CODE = /^[A-Z0-9][A-Z0-9-]{0,31}$/;
const events = () => readdirSync(CASES, { withFileTypes: true }).filter((d) => d.isDirectory() && EVENT_CODE.test(d.name)).map((d) => d.name);
const namedFor = (kase, code, file) => kase.case_id === path.basename(file, '.json') && kase.event_code === code;

// The loader's rule (backend/src/services/booth.js readCase): no problem, named after its case_id in its event's
// folder, and isAdmitted.
function currentCases() {
  return events().flatMap((code) => readdirSync(path.join(CASES, code)).filter((f) => f.endsWith('.json')).sort().flatMap((f) => {
    const raw = JSON.parse(readFileSync(path.join(CASES, code, f), 'utf8'));
    if (caseTreeProblems(raw).length) return [];
    const kase = CaseTreeSchema.parse(raw);
    return namedFor(kase, code, f) && isAdmitted(kase) ? [kase] : [];
  }));
}

const TOP = fileURLToPath(new URL('../..', import.meta.url));
const git = (...a) => execFileSync('git', a, { cwd: TOP, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const everAdmitted = ({ admission: a }) => Boolean(a?.safety_review && (a.sandbox || a.owner_waiver));

function committedCases() {
  return events().flatMap((code) => {
    const dir = path.relative(TOP, path.join(CASES, code));
    const files = [...new Set(git('log', '--format=', '--name-only', '--', dir).split('\n'))]
      .filter((f) => path.dirname(f) === dir && f.endsWith('.json')).sort();
    return files.flatMap((file) => git('log', '--format=%H', '--', file).trim().split('\n').flatMap((commit) => {
      let raw;
      try { raw = JSON.parse(git('show', `${commit}:${file}`)); } catch { return []; }
      const parsed = CaseTreeSchema.safeParse(raw);
      return parsed.success && namedFor(parsed.data, code, file) && everAdmitted(parsed.data) ? [{ kase: parsed.data, at: commit.slice(0, 8) }] : [];
    }));
  });
}

const problems = [];
const versions = new Map();
for (const { kase, at } of args.includes('--from-git') ? committedCases() : currentCases().map((kase) => ({ kase }))) {
  const id = `${kase.event_code}/${kase.case_id}@${kase.version}`;
  const seen = versions.get(id);
  if (!seen) versions.set(id, { kase, at });
  else if (!isDeepStrictEqual(snapshotOf(seen.kase), snapshotOf(kase))) {
    problems.push(`${id} has two committed texts (${seen.at}, ${at}): a play on it cannot be rebuilt with certainty`);
  }
}

let written = 0;
for (const { kase } of versions.values()) {
  let found;
  try { found = snapshotState(CASES, kase); } catch (err) { console.error(`${kase.event_code}/${kase.case_id}: ${err.message}`); process.exit(2); }
  if (found.state === 'differs' || (found.state === 'missing' && check)) {
    problems.push(snapshotProblem(kase, found.state));
  } else if (found.state === 'missing') {
    mkdirSync(path.dirname(found.file), { recursive: true });
    writeFileSync(found.file, `${JSON.stringify(snapshotOf(kase), null, 2)}\n`, { flag: 'wx' });
    written += 1;
    console.log(`wrote ${path.relative(process.cwd(), found.file)}`);
  }
}
for (const p of [...new Set(problems)]) console.error(p);
console.log(`${versions.size} version(s) checked${check ? '' : `, ${written} snapshot(s) written`}`);
process.exit(problems.length ? 1 : 0);
