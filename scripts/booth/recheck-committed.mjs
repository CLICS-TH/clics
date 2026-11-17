#!/usr/bin/env node
/**
 * ADR 0005's difficulty re-check, re-run on the committed tables alone (#511). It spends nothing: it reads each
 * five-step case file of an event, pools every table bound to its case's current tree, and re-checks each of them
 * against that pool, as a build's re-check does. A build only re-checks the cases it builds, so a later build that
 * moves the pool medians can leave an admitted case outside its band unseen; this catches that.
 *
 *   node scripts/booth/recheck-committed.mjs [--cases <event folder>]   # prints the re-check as JSON
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tablePlan, recheck, committedPool, treeSha } from './path-table.mjs';

const require = createRequire(import.meta.url);
const { PATHS_BY_STEPS } = require('./sandbox-play.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEPS = 5;

/** The re-check of every committed five-step table bound to its case's current tree, against the pool of them all. */
export function recheckCommitted(raws) {
  const fiveStep = raws.filter((r) => Object.keys(r.banks).length === STEPS);
  const bound = fiveStep.filter((r) => r.path_score_table && r.path_score_table.provenance.tree_sha256 === treeSha(r));
  if (!bound.length) return { cases: {}, unbound: fiveStep.map((r) => r.case_id) };
  const plan = tablePlan(STEPS, PATHS_BY_STEPS[STEPS]);
  const pool = committedPool(plan, bound);
  if (pool.why) throw new Error(pool.why);
  // The bands and the gap depend on the samples per path, so one re-check holds only tables built with the same count.
  const counts = [...new Set(bound.map((r) => r.path_score_table.provenance.samples_per_path))];
  if (counts.length > 1) {
    throw new Error(`the committed tables mix ${counts.join(' and ')} samples per path: `
      + bound.map((r) => `${r.case_id} ${r.path_score_table.provenance.samples_per_path}`).join(', '));
  }
  const [samples] = counts;
  const result = recheck(plan, pool.cases, { samples });
  return { ...result, runs: pool.runs, unbound: fiveStep.filter((r) => !bound.includes(r)).map((r) => r.case_id) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--cases');
  const dir = at > -1 ? path.resolve(process.argv[at + 1]) : path.join(HERE, '..', '..', 'backend', 'src', 'booth-cases', 'NFCME-2026');
  const raws = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
  console.log(JSON.stringify(recheckCommitted(raws), null, 2));
}
