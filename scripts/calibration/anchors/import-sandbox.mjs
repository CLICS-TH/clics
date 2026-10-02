#!/usr/bin/env node
/*
 * Import anchor fixtures into the SANDBOX council as auditable PLEs (plan item 2.7).
 *
 * WHAT. The human-anchored arm of the anchor study needs the auditors to score the anchors through
 * the REAL auditor UI — same queue, same transcript view, same reflection rendering, same form —
 * not through a side channel. So each anchor becomes one `ples` row + its `messages` + (when the
 * fixture has one) a `ple_reflections` row, in the isolated SANDBOX council, owned by one SANDBOX
 * physician account. Nothing else.
 *
 * DRY-RUN BY DEFAULT. Without --confirm it reads only local files, prints the full plan and counts,
 * and writes nothing — no DB connection, no .env read. It is the additive/--confirm discipline of
 * scripts/provision/provision-test-cohort.js.
 *
 * IT NEVER:
 *   - calls any AI, or writes `ai_evaluations` (the anchors' AI scores live in shadow_evaluations,
 *     via import-shadow.mjs — the auditors' comparator stays blind);
 *   - touches a council other than SANDBOX — under --confirm the --council-id is resolved against
 *     the live `councils` row and refused unless its code is SANDBOX, and the physician must belong
 *     to that council;
 *   - clears privacy review. Every row lands privacy_review_status='pending'. Clearing it (POST
 *     /admin/ples/:id/privacy-review), assigning auditors, and setting calibration_reveal_locked=1
 *     are human superadmin steps (AUTHORING.md §8).
 *
 * Rows written per anchor (ids deterministic, so a re-run is idempotent: an existing PLE is skipped
 * only if its stored messages + reflection are byte-identical to the plan; any difference refuses
 * the whole run before a row is written — roll back first):
 *   ples              id = uuidv5(anchor id, ANCHOR_NAMESPACE); physician/council from the flags;
 *                     specialty NULL; is_test true; status 'evaluated'; started/ended from a seeded
 *                     shuffle over every designed id (queue order ≠ anchor order); turn_count =
 *                     physician turns; token_count 0; ple_code NULL; provider_used 'anchor-synthetic';
 *                     privacy_review_status 'pending'; privacy_concern_open false
 *   messages          physician/assistant turns only, fixture order, strictly increasing created_at
 *   ple_reflections   only when the fixture's reflection turn round-trips EXACTLY through production's
 *                     rendering (sandbox-import-lib.mjs splitReflection); the rest are LISTED
 *
 * Every selected fixture's sha256 is checked against manifest.json, and a held-out fixture's against
 * HELDOUT-LOCK.json, before anything is planned.
 *
 *   node scripts/calibration/anchors/import-sandbox.mjs --physician-id <uuid> --council-id <uuid>
 *        [--split heldout|tuning|all] [--only anc-021,anc-022]                  # dry run (default)
 *   … --confirm [--manifest-out <path>] [--env backend/.env]                     # writes
 *   node scripts/calibration/anchors/import-sandbox.mjs --rollback <manifest>    # dry run
 *   … --rollback <manifest> --confirm [--force-export-first]                     # deletes
 *
 *   --split          default heldout. `all` = every active fixture (held-out still lock-checked).
 *   --manifest-out   default scripts/calibration/anchors/imports/sandbox-<split>.json (gitignored).
 *                    Its `ple_ids` makes it a valid three-way.js --manifest (with --include-test).
 *   --rollback       deletes EXACTLY the manifest's ples rows (messages, reflections, shadow rows,
 *                    assignments cascade). Refused if any audit_scores / audit_discussions exist for
 *                    them, unless --force-export-first, which writes them to a local file first.
 *   --fixtures dir   default scripts/calibration/anchors/fixtures (tests point it elsewhere)
 *
 * RE-EVALUATE IS A HARMLESS NO-OP HERE, not a spend risk. POST /admin/ples/:id/reevaluate accepts an
 * 'evaluated' PLE with no ai_evaluations row, but enqueueEvaluation (backend/src/services/
 * ple-finalize.js) only stamps the eval_* columns; claim_ple_evaluations claims status='ple_pass'
 * rows only and eval-drain returns early on any other status. So pressing it sets eval_enqueued_at,
 * writes a 'ple.reevaluate' audit-log row and answers "queued" — and nothing ever claims the row: no
 * AI call, no spend. Still, don't press it: the audit-log row is noise in the study record.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAnchorSplit, splitFilter, loadHeldOutLock, assertHeldOutScorable } from './anchor-split.mjs';
import { parseArgs } from '../../probe/lib.mjs';
import {
  planImport, importManifest, mergeImportManifests, readImportManifest, verifyFixtureBytes, diffExisting, SCHEDULE_SEED, BASE_TIME,
  ANCHOR_NAMESPACE, PROVIDER_USED,
} from './sandbox-import-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPORTS_DIR = path.join(HERE, 'imports');

const die = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(1); };
const { flags } = parseArgs();
const CONFIRM = flags.confirm === true;
if (flags.confirm !== undefined && flags.confirm !== true) die('--confirm takes no value');

/* ------------------------------------------------------------- rollback */

if (flags.rollback !== undefined) {
  if (typeof flags.rollback !== 'string') die('--rollback needs a manifest path');
  let doc;
  try { doc = JSON.parse(await readFile(flags.rollback, 'utf8')); } catch (e) { die(`cannot read ${flags.rollback}: ${e.message}`); }
  let anchors;
  try { anchors = readImportManifest(doc); } catch (e) { die(e.message); }
  const councilId = doc.council_id;
  if (typeof flags['council-id'] === 'string' && flags['council-id'] !== councilId) die(`--council-id ${flags['council-id']} ≠ the manifest's council ${councilId}`);
  const ids = anchors.map((a) => a.ple_id);
  console.log(`\nrollback — ${anchors.length} anchor PLE(s) from ${flags.rollback}  (council ${councilId})`);
  for (const a of anchors) console.log(`  ${a.id}  ${a.ple_id}`);
  if (!CONFIRM) {
    console.log(`\nDRY RUN — nothing deleted. With --confirm: verifies every id is a SANDBOX anchor import`);
    console.log(`(is_test, provider_used='${PROVIDER_USED}', council ${councilId}), refuses if audit_scores or`);
    console.log(`audit_discussions exist unless --force-export-first, then deletes exactly these ples rows.\n`);
    process.exit(0);
  }
  const { connect, fetchSandboxCouncil, assertAnchorPles, selectIn, must } = await import('./sandbox-db.mjs');
  try {
    const { db, host } = connect({ envFile: typeof flags.env === 'string' ? flags.env : undefined });
    console.log(`\n** --confirm: DELETING on ${host} **`);
    await fetchSandboxCouncil(db, councilId);
    const present = await assertAnchorPles(db, ids, councilId);
    const presentIds = present.map((r) => r.id);
    if (!presentIds.length) { console.log('  none of these PLEs exist — nothing to delete.\n'); process.exit(0); }
    const scores = await selectIn(db, 'audit_scores', '*', 'ple_id', presentIds);
    const discussions = await selectIn(db, 'audit_discussions', '*', 'ple_id', presentIds);
    if (scores.length || discussions.length) {
      if (!flags['force-export-first']) die(`${scores.length} audit_scores and ${discussions.length} audit_discussions rows exist for these PLEs — human work would be destroyed. Refusing. Re-run with --force-export-first to write them to a local file first.`);
      await mkdir(IMPORTS_DIR, { recursive: true });
      const out = path.join(IMPORTS_DIR, `rollback-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await writeFile(out, JSON.stringify({ exported_at: new Date().toISOString(), manifest: flags.rollback, audit_scores: scores, audit_discussions: discussions }, null, 2) + '\n');
      console.log(`  exported ${scores.length} audit_scores + ${discussions.length} audit_discussions → ${path.relative(process.cwd(), out)} (gitignored)`);
    }
    let deleted = 0;
    for (let i = 0; i < presentIds.length; i += 100) {
      const chunk = presentIds.slice(i, i + 100);
      const rows = must(await db.from('ples').delete().in('id', chunk)
        .eq('is_test', true).eq('provider_used', PROVIDER_USED).eq('council_id', councilId).select('id'), 'delete ples');
      deleted += rows.length;
    }
    console.log(`  deleted ${deleted} of ${presentIds.length} PLE(s) (${ids.length - presentIds.length} were already absent).\n`);
    process.exit(deleted === presentIds.length ? 0 : 1);
  } catch (e) { die(e.message); }
}

/* ---------------------------------------------------------------- select */

const splitName = typeof flags.split === 'string' ? flags.split : 'heldout';
if (!['heldout', 'tuning', 'all'].includes(splitName)) die(`--split must be heldout|tuning|all (got ${flags.split})`);
const physicianId = flags['physician-id'];
const councilId = flags['council-id'];
if (typeof physicianId !== 'string') die('--physician-id <uuid> is required (the SANDBOX physician account that owns the imported PLEs)');
if (typeof councilId !== 'string') die('--council-id <uuid> is required (must be the SANDBOX council)');
const fixturesDir = path.resolve(typeof flags.fixtures === 'string' ? flags.fixtures : path.join(HERE, 'fixtures'));

const design = JSON.parse(await readFile(path.join(HERE, 'design.json'), 'utf8'));
let manifest;
try { manifest = JSON.parse(await readFile(path.join(HERE, 'manifest.json'), 'utf8')); } catch { die('manifest.json missing — run validate.mjs first'); }
const split = await loadAnchorSplit();
const lock = await loadHeldOutLock();
let heldSet;
try { heldSet = splitFilter(design, split, 'heldout') ?? new Set(); } catch (e) { die(e.message); }

let ids = (await readdir(fixturesDir).catch(() => [])).filter((f) => /^anc-\d{3}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
ids = ids.filter((id) => !design.anchors.find((a) => a.id === id)?.excluded);
if (splitName !== 'all') {
  let allowed;
  try { allowed = splitFilter(design, split, splitName); } catch (e) { die(e.message); }
  ids = ids.filter((id) => allowed.has(id));
}
if (typeof flags.only === 'string') {
  const only = flags.only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const missing = only.filter((id) => !ids.includes(id));
  if (missing.length) die(`--only: not in the selected split's fixtures: ${missing.join(', ')}`);
  ids = ids.filter((id) => only.includes(id));
}
if (!ids.length) die(`no anchor fixtures selected in ${fixturesDir}`);

const fixtures = [];
try {
  for (const id of ids) {
    const buf = await readFile(path.join(fixturesDir, `${id}.json`));
    const sha256 = verifyFixtureBytes(id, buf, { manifest, lock, heldOut: heldSet.has(id) });
    fixtures.push({ id, sha256, doc: JSON.parse(buf.toString('utf8')) });
  }
  // D13: no held-out anchor goes to any rater before every held-out anchor is authored and locked.
  assertHeldOutScorable(ids, { split, lock, fixtureShas: Object.fromEntries(fixtures.map((f) => [f.id, f.sha256])) });
} catch (e) { die(e.message); }

/* ------------------------------------------------------------------ plan */

let council;
let dbCtx = null;
if (CONFIRM) {
  // The SANDBOX check needs the live row, so it happens here and only here; the planner re-asserts it.
  const dbm = await import('./sandbox-db.mjs');
  try {
    const { db, host } = dbm.connect({ envFile: typeof flags.env === 'string' ? flags.env : undefined });
    console.log(`\n** --confirm: WRITING to ${host} **`);
    council = await dbm.fetchSandboxCouncil(db, councilId);
    await dbm.assertSandboxPhysician(db, physicianId, councilId);
    dbCtx = { db, ...dbm };
  } catch (e) { die(e.message); }
}

let plan;
try { plan = planImport({ fixtures, designIds: design.anchors.map((a) => a.id), physicianId, councilId, council }); }
catch (e) { die(e.message); }

const line = (a) => `  ${a.id}  ${a.ple_id}  ${a.ple.started_at.slice(0, 16)}→${a.ple.ended_at.slice(11, 16)}  `
  + `phys ${String(a.ple.turn_count).padStart(2)}  msgs ${String(a.messages.length).padStart(2)}  `
  + `reflection ${a.reflection ? 'yes' : `no (${a.reflection_status.reason})`}`;
console.log(`\nanchor → SANDBOX import plan  (split ${splitName}, ${plan.anchors.length} anchors)`);
console.log(`  physician ${physicianId}   council ${councilId}${council ? ` = ${council.code}` : ' (SANDBOX verified only under --confirm)'}`);
console.log(`  namespace ${ANCHOR_NAMESPACE}   schedule seed ${SCHEDULE_SEED}   base ${BASE_TIME}`);
console.log(`  fixtures  every sha256 verified against manifest.json${[...heldSet].some((id) => ids.includes(id)) ? ' + HELDOUT-LOCK.json' : ''}\n`);
for (const a of plan.anchors) console.log(line(a));
console.log(`\n  queue order (ended_at asc): ${plan.queue_order.join(' ')}`);
console.log(`\n  counts: ${plan.counts.ples} ples · ${plan.counts.messages} messages (${plan.counts.physician_messages} physician) · ${plan.counts.reflections} ple_reflections`);
console.log(`  no reflection row (${plan.no_reflection.length}):`);
const byReason = {};
const designMode = (id) => design.anchors.find((a) => a.id === id)?.reflection;
for (const r of plan.no_reflection) (byReason[`${r.reason} (design: ${designMode(r.id)})`] ??= []).push(r.id);
for (const [reason, list] of Object.entries(byReason)) console.log(`    ${reason}: ${list.join(' ')}`);
console.log(`  never written: ai_evaluations · privacy_review_status stays 'pending' · no audit_assignments`);

const manifestOut = path.resolve(typeof flags['manifest-out'] === 'string' ? flags['manifest-out'] : path.join(IMPORTS_DIR, `sandbox-${splitName}.json`));
if (!CONFIRM) {
  console.log(`\nDRY RUN — nothing written, no database contacted. Re-run with --confirm to insert`);
  console.log(`(manifest would go to ${path.relative(process.cwd(), manifestOut)}).\n`);
  process.exit(0);
}

/* ----------------------------------------------------------------- write */

const { db, selectIn, assertAnchorPles, must } = dbCtx;
try {
  const planned = plan.anchors.map((a) => a.ple_id);
  const existing = new Set((await selectIn(db, 'ples', 'id', 'id', planned)).map((r) => r.id));
  if (existing.size) await assertAnchorPles(db, [...existing], councilId);
  // An existing PLE is skipped only if its stored transcript and reflection are BYTE-IDENTICAL to the
  // plan (sandbox-import-lib.mjs diffExisting). A half-written PLE, or one written from different
  // fixture bytes, refuses the whole run before anything is written.
  if (existing.size) {
    const msgs = await selectIn(db, 'messages', 'ple_id, role, content, created_at', 'ple_id', [...existing]);
    const refl = await selectIn(db, 'ple_reflections', 'ple_id, learned, uncertainty, application, skipped', 'ple_id', [...existing]);
    const bad = [];
    for (const a of plan.anchors.filter((x) => existing.has(x.ple_id))) {
      const diffs = diffExisting(a, { messages: msgs.filter((m) => m.ple_id === a.ple_id), reflection: refl.find((r) => r.ple_id === a.ple_id) ?? null });
      if (diffs.length) bad.push(`${a.id}: content differs from fixture ${a.sha256.slice(0, 12)} — roll back first (${diffs.join('; ')})`);
    }
    if (bad.length) die(`${bad.length} existing PLE(s) do not match this import:\n  ${bad.join('\n  ')}\n  Nothing was written. Clean up with --rollback <manifest> --confirm, then re-import.`);
  }
  // Manifest FIRST: if an insert fails part-way, --rollback still has the exact id list to clean up.
  // Merged into an existing file, never overwritten by a smaller one (an --only top-up).
  await mkdir(path.dirname(manifestOut), { recursive: true });
  let prev = null;
  try { prev = JSON.parse(await readFile(manifestOut, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const merged = mergeImportManifests(prev, importManifest(plan, { split: splitName, physicianId, councilId }));
  await writeFile(manifestOut, JSON.stringify(merged, null, 2) + '\n');
  console.log(`  manifest → ${path.relative(process.cwd(), manifestOut)}`);
  let created = 0;
  for (const a of plan.anchors) {
    if (existing.has(a.ple_id)) { console.log(`  · ${a.id} exists — skipped`); continue; }
    must(await db.from('ples').insert(a.ple), `${a.id}: insert ples`);
    must(await db.from('messages').insert(a.messages), `${a.id}: insert messages`);
    if (a.reflection) must(await db.from('ple_reflections').insert(a.reflection), `${a.id}: insert ple_reflections`);
    created++;
    console.log(`  ✓ ${a.id} → ${a.ple_id}`);
  }
  console.log(`\n  ${created} created, ${existing.size} already present (verified identical)`);
  console.log(`  next (human, superadmin): privacy review each PLE, assign auditors, set calibration_reveal_locked=1.\n`);
  process.exit(0);
} catch (e) { die(`${e.message}\n  (rows inserted before this point stay. A re-run skips identical PLEs and refuses a half-written one; clean up with --rollback ${path.relative(process.cwd(), manifestOut)} --confirm, then re-import)`); }
