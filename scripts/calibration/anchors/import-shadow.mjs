#!/usr/bin/env node
/*
 * Attach the local evaluator's anchor scores to the imported SANDBOX PLEs as shadow_evaluations
 * rows (plan item 2.7), so three-way.js can measure local-vs-auditor on the anchors.
 *
 * WHY shadow_evaluations AND NOT ai_evaluations. ai_evaluations is the SERVED score: the auditor UI
 * reveals it after scoring, the physician's credit reads it, and its presence changes what
 * /reevaluate and the dashboards do. shadow_evaluations is RLS deny-all and never shown to anyone
 * (db/migration-shadow-evaluations.sql) — exactly the blinding a calibration comparator needs.
 *
 * DRY-RUN BY DEFAULT: reads the run file + the import manifest, prints every row it would write,
 * and contacts nothing. Under --confirm it writes with the service role (backend/.env), only to PLEs
 * that are SANDBOX anchor imports (is_test, provider_used 'anchor-synthetic', SANDBOX council), and
 * skips any (ple_id, provider, model_version) that already has a row — idempotent, never overwrites.
 * No AI is called: the scores already exist in the run file.
 *
 * Per anchor, one row:
 *   d1..d7          per-domain MEDIAN of the K runs (integers; K must be odd and every run scored —
 *                   otherwise the anchor is skipped and listed, never padded or averaged)
 *   composite_score rimpl/src/lib/composite.js compositeOf(medians)
 *   provider        'local'
 *   model_version   modelVersion(served model) — production's shadow-row format (rimpl shadow.js)
 *   prompt_version  run.prompt_version_used       rubric_version  run.rubric_version
 *   domain_rationale provenance: the K per-run score vectors, run file + its sha256
 *   evaluated_at    run.finished_at ?? run.started_at
 * An anchor whose run scored different fixture bytes than were imported is refused.
 *
 *   node scripts/calibration/anchors/import-shadow.mjs \
 *     scripts/calibration/anchors/runs/heldout-local-2026-10-02-merged.json \
 *     --manifest scripts/calibration/anchors/imports/sandbox-heldout.json          # dry run
 *   … --confirm [--env backend/.env]                                              # writes
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../probe/lib.mjs';
import { planShadow, readImportManifest, DOMAINS } from './sandbox-import-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const die = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(1); };
const { flags, positional } = parseArgs();
const CONFIRM = flags.confirm === true;
if (flags.confirm !== undefined && flags.confirm !== true) die('--confirm takes no value');

const runPath = typeof flags.run === 'string' ? flags.run : positional[0];
if (!runPath) die('usage: import-shadow.mjs <score-local run.json> --manifest <import manifest> [--confirm]');
if (typeof flags.manifest !== 'string') die('--manifest <import manifest> is required (written by import-sandbox.mjs --confirm)');

let runBuf, run, doc, anchors;
try { runBuf = await readFile(runPath); run = JSON.parse(runBuf.toString('utf8')); } catch (e) { die(`cannot read run ${runPath}: ${e.message}`); }
try { doc = JSON.parse(await readFile(flags.manifest, 'utf8')); anchors = readImportManifest(doc); } catch (e) { die(e.message); }

// The imported bytes must still be the validated bytes: a fixture changed after import would mean
// the auditor reads one transcript and the score (if re-run) describes another.
const validated = JSON.parse(await readFile(path.join(HERE, 'manifest.json'), 'utf8'));
const importedShas = Object.fromEntries(Object.entries(doc.anchors).map(([id, v]) => [id, v.sha256]));
const drifted = Object.entries(importedShas).filter(([id, sha]) => validated.fixtures?.[id]?.sha256 !== sha).map(([id]) => id);
if (drifted.length) die(`fixture(s) changed since import (manifest.json ≠ import manifest): ${drifted.join(', ')}`);

const runSha = createHash('sha256').update(runBuf).digest('hex');
const runRel = path.relative(REPO, path.resolve(runPath));
let plan;
try { plan = planShadow({ run, manifestAnchors: anchors, fixtureShas: importedShas, runFile: runRel, runSha }); } catch (e) { die(e.message); }

console.log(`\nshadow import plan  (${runRel}, sha ${runSha.slice(0, 12)})`);
console.log(`  candidate   provider local · ${plan.model_version}`);
console.log(`  provenance  prompt ${run.prompt_version_used ?? '(none)'} · rubric ${run.rubric_version ?? '(none)'} · consistency ${run.consistency ?? '?'} · K=${run.repeats ?? '?'}`);
console.log(`  manifest    ${flags.manifest} (${anchors.length} anchors, council ${doc.council_id})\n`);
const idOf = new Map(anchors.map((a) => [a.ple_id, a.id]));
for (const r of plan.rows) {
  console.log(`  ${idOf.get(r.ple_id)}  ${r.ple_id}  ${DOMAINS.map((d) => r[d]).join(' ')}  composite ${r.composite_score}`
    + `   runs ${r.domain_rationale.runs.map((v) => v.join('')).join('/')}`);
}
console.log(`\n  ${plan.rows.length} shadow_evaluations row(s) · ${plan.skipped.length} skipped`);
for (const s of plan.skipped) console.log(`    skipped ${s.id}: ${s.reason}`);

if (!CONFIRM) {
  console.log(`\nDRY RUN — nothing written, no database contacted. Re-run with --confirm to insert.\n`);
  process.exit(0);
}

const { connect, fetchSandboxCouncil, assertAnchorPles, selectIn, must } = await import('./sandbox-db.mjs');
try {
  const { db, host } = connect({ envFile: typeof flags.env === 'string' ? flags.env : undefined });
  console.log(`\n** --confirm: WRITING shadow_evaluations on ${host} **`);
  await fetchSandboxCouncil(db, doc.council_id);
  const ids = plan.rows.map((r) => r.ple_id);
  const present = await assertAnchorPles(db, ids, doc.council_id);
  const missing = ids.filter((id) => !present.some((p) => p.id === id));
  if (missing.length) die(`${missing.length} PLE(s) are not imported yet (run import-sandbox.mjs --confirm first): ${missing.slice(0, 5).map((id) => idOf.get(id)).join(', ')}`);
  const have = new Set((await selectIn(db, 'shadow_evaluations', 'ple_id, provider, model_version', 'ple_id', ids))
    .filter((r) => r.provider === 'local' && r.model_version === plan.model_version).map((r) => r.ple_id));
  let created = 0;
  for (const r of plan.rows) {
    if (have.has(r.ple_id)) { console.log(`  · ${idOf.get(r.ple_id)} already has a ${plan.model_version} row — skipped`); continue; }
    must(await db.from('shadow_evaluations').insert(r), `${idOf.get(r.ple_id)}: insert shadow_evaluations`);
    created++;
  }
  console.log(`\n  ${created} created, ${have.size} already present.\n`);
} catch (e) { die(e.message); }
