// The anchor cohort's held-out split — the rules a future SPLIT-anchors.json must satisfy, and the
// filter every analysis applies once it exists. Same discipline as scripts/probe/split.mjs (roadmap
// D13): reserve held-out BEFORE anything is tuned, and refuse to analyse "everything" afterwards.
//
// THE PILOT IS TUNING-ONLY. The 20 pilot anchors (design.json pilot:true) are being scored, read and
// possibly rewritten (AUTHORING.md §7.4) before any split exists. An anchor whose transcript was
// revised after its AI score was seen can never be held-out evidence, so no pilot anchor may ever
// appear in held_out. checkSplit() enforces it; anchors.test.mjs runs checkSplit on the committed
// SPLIT-anchors.json the moment one is added.
//
// RESERVED BY DESIGN ID, BEFORE ANY NON-PILOT FIXTURE EXISTS (2026-10-02). scripts/probe/reserve-split.mjs
// reserves over fixture files and records their sha256 — here that would mean writing the anchors first,
// and authoring is exactly the step the split must precede. So the reservation is over design.json ids
// (the targets are fixed there, seeded), and records design.json's sha256 instead. Fixture bytes are
// bound at INTAKE: when validate.mjs records a held-out fixture into manifest.json it also writes its
// sha256 into HELDOUT-LOCK.json, and anchors.test.mjs fails if a locked sha ever changes.
//
// NO HELD-OUT SCORE BEFORE THE LOCK IS COMPLETE (AUTHORING.md §9). No rater — the blind panel, the
// local evaluator, Claude — scores a held-out anchor until all of them are authored and locked.
// assertHeldOutScorable() is the gate: score-local.mjs and known-groups.mjs call it, and any panel
// packet builder must (`anchor-split.mjs --check-scorable <ids>` for one built by hand).
//
//   node scripts/calibration/anchors/anchor-split.mjs --reserve --seed 20261005 --held-out 60
//   (60: ~80% power for the two-rater ICC lower bound to clear 0.75 at a true 0.88 — AUTHORING.md §7.5)
//
// Method: the eligible ids (non-pilot, active) are split into language × profile cells; held-out is
// allocated to each cell in proportion to its size (a cell of 2+ keeps at least one tuning anchor);
// within a cell, ids sorted by target composite are cut into consecutive strata and one per stratum is
// drawn with a seeded RNG. So held-out mirrors tuning on language and profile, and spans the whole
// designed range by construction — the probe's held-out spanned only 32–62 against tuning's
// 34–89 (G0.5), and no agreement statistic on a range that narrow can be decisive. Refuses to
// overwrite SPLIT-anchors.json: to change it, delete it in a commit that says why.
//
// Package-free.
import { readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng, DESIGN_PATH } from './design.mjs';

export const SPLIT_ANCHORS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'SPLIT-anchors.json');
export const SPLIT_NAMES = ['tuning', 'heldout'];
export const LOCK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'HELDOUT-LOCK.json');

export async function loadHeldOutLock(p = LOCK_PATH) {
  try { return JSON.parse(await readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Is every held-out anchor locked? (No split → nothing is held out → trivially complete.) */
export function lockComplete(split, lock) {
  if (!split) return true;
  const locked = lock?.locked ?? {};
  return split.held_out.every((id) => typeof locked[id] === 'string');
}

/**
 * Throws unless these ids may be scored now: a held-out id may be scored only once EVERY held-out
 * anchor is authored and locked, and only with its locked bytes (fixtureShas, when given).
 */
export function assertHeldOutScorable(ids, { split, lock, fixtureShas = null }) {
  if (!split) return;
  const held = new Set(split.held_out);
  const asked = ids.filter((id) => held.has(id));
  if (!asked.length) return;
  if (!lockComplete(split, lock)) {
    const n = Object.keys(lock?.locked ?? {}).length;
    throw new Error(`refusing to score held-out anchor(s) ${asked.slice(0, 5).join(', ')}${asked.length > 5 ? ' …' : ''}: only ${n} of ${split.held_out.length} held-out anchors are locked. No rater scores a held-out anchor before all of them are authored and locked (AUTHORING.md §9, D13).`);
  }
  for (const id of asked) {
    if (fixtureShas && fixtureShas[id] !== lock.locked[id]) throw new Error(`${id} is held-out and its fixture no longer has the locked bytes (HELDOUT-LOCK.json) — a held-out anchor is never changed after intake`);
  }
}

export async function loadAnchorSplit(p = SPLIT_ANCHORS_PATH) {
  try { return JSON.parse(await readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Ids a held-out reservation may draw from: every active designed anchor that is NOT pilot. */
export function heldOutEligible(design) {
  return design.anchors.filter((a) => !a.pilot && !a.excluded).map((a) => a.id);
}

/** Problems with a split, as strings; [] means it is acceptable. */
export function checkSplit(design, split) {
  const errs = [];
  const ids = new Set(design.anchors.map((a) => a.id));
  const pilot = new Set(design.anchors.filter((a) => a.pilot).map((a) => a.id));
  const held = split?.held_out ?? [];
  const tuning = split?.tuning ?? [];
  if (!Array.isArray(split?.held_out) || !Array.isArray(split?.tuning)) errs.push('split must have held_out[] and tuning[]');
  for (const id of held) if (pilot.has(id)) errs.push(`${id} is a pilot anchor — the pilot is tuning-only and can never be held out`);
  for (const id of [...held, ...tuning]) if (!ids.has(id)) errs.push(`${id} is not in design.json`);
  const excluded = new Set(design.anchors.filter((a) => a.excluded).map((a) => a.id));
  for (const id of [...held, ...tuning]) if (excluded.has(id)) errs.push(`${id} was excluded under §7.4 — use its replacement`);
  const both = held.filter((id) => tuning.includes(id));
  if (both.length) errs.push(`in both splits: ${both.join(', ')}`);
  return errs;
}

/**
 * Restrict a set of ids to one split. Mirrors scripts/probe/split.mjs applySplit's rules:
 *   - no split file and no name → everything (nothing is reserved yet);
 *   - a name but no file → error;
 *   - a file but no name → error: analysing "all" after the reservation folds held-out into tuning.
 * @returns {Set<string>|null}  the allowed ids, or null for "no restriction"
 */
export function splitFilter(design, split, name) {
  if (!split) {
    if (name) throw new Error(`--split ${name} given but ${path.basename(SPLIT_ANCHORS_PATH)} does not exist yet`);
    return null;
  }
  const errs = checkSplit(design, split);
  if (errs.length) throw new Error(`SPLIT-anchors.json is invalid:\n  - ${errs.join('\n  - ')}`);
  if (!name) throw new Error(`SPLIT-anchors.json exists; name --split ${SPLIT_NAMES.join('|')} (analysing all anchors would fold held-out into tuning)`);
  if (!SPLIT_NAMES.includes(name)) throw new Error(`--split must be ${SPLIT_NAMES.join('|')} (got ${name})`);
  // A §7.4 replacement made after the reservation inherits the split of the anchor it replaces.
  const members = new Set(name === 'heldout' ? split.held_out : split.tuning);
  for (const a of design.anchors) if (a.replaces && members.has(a.replaces)) members.add(a.id);
  return members;
}

/** The stratification cells: language × profile (dissociated vs coherent = graded or flat). */
export const SPLIT_CELLS = ['th/coherent', 'th/dissociated', 'en/coherent', 'en/dissociated'];
export const cellOf = (a) => `${a.language}/${a.profile === 'dissociated' ? 'dissociated' : 'coherent'}`;

/**
 * How many held-out per cell: proportional to the cell's size (largest remainder, ties in SPLIT_CELLS
 * order), summing to heldOut, never taking a whole cell of 2 or more (tuning keeps at least one).
 */
export function allocateHeldOut(sizes, heldOut) {
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  const cap = (c) => (sizes[c] >= 2 ? sizes[c] - 1 : sizes[c]);
  const want = Object.fromEntries(SPLIT_CELLS.map((c) => [c, ((sizes[c] ?? 0) * heldOut) / total]));
  const got = Object.fromEntries(SPLIT_CELLS.map((c) => [c, Math.min(Math.floor(want[c]), cap(c))]));
  let left = heldOut - Object.values(got).reduce((a, b) => a + b, 0);
  const order = [...SPLIT_CELLS].sort((x, y) => (want[y] - Math.floor(want[y])) - (want[x] - Math.floor(want[x])) || SPLIT_CELLS.indexOf(x) - SPLIT_CELLS.indexOf(y));
  while (left > 0) {
    const c = order.find((k) => got[k] < cap(k) && got[k] < Math.ceil(want[k])) ?? order.find((k) => got[k] < cap(k));
    if (!c) throw new Error('cannot allocate held-out within the caps');
    got[c]++; left--;
  }
  return got;
}

/**
 * Reserve held-out by design id. Pure: design in, {held_out, tuning, cells} out.
 * Within each language × profile cell, ordered by designed composite, the cell's held-out share is
 * drawn one per consecutive stratum (seeded), so held-out mirrors tuning on language, on profile and
 * along the composite.
 * @param {{seed: number, heldOut: number}} opts
 */
export function reserveByDesign(design, { seed, heldOut }) {
  if (!Number.isInteger(seed)) throw new Error('seed must be an integer');
  const eligible = design.anchors.filter((a) => !a.pilot && !a.excluded);
  if (!Number.isInteger(heldOut) || heldOut < 2 || heldOut > eligible.length - 2) throw new Error(`held-out must be 2..${eligible.length - 2}`);
  const byCell = Object.fromEntries(SPLIT_CELLS.map((c) => [c, eligible.filter((a) => cellOf(a) === c)
    .sort((x, y) => (x.target_composite - y.target_composite) || x.id.localeCompare(y.id))]));
  const alloc = allocateHeldOut(Object.fromEntries(SPLIT_CELLS.map((c) => [c, byCell[c].length])), heldOut);
  const R = rng(seed);
  const held = [];
  for (const c of SPLIT_CELLS) {
    const rows = byCell[c], h = alloc[c];
    for (let k = 0; k < h; k++) {
      const lo = Math.floor((k * rows.length) / h);
      const hi = Math.floor(((k + 1) * rows.length) / h);
      held.push(rows[lo + Math.floor(R.next() * (hi - lo))].id);
    }
  }
  const heldSet = new Set(held);
  const tuning = design.anchors.filter((a) => !a.excluded && !heldSet.has(a.id)).map((a) => a.id);
  const cells = Object.fromEntries(SPLIT_CELLS.map((c) => [c, { held_out: alloc[c], tuning: byCell[c].length - alloc[c] }]));
  return { held_out: [...heldSet].sort(), tuning: tuning.sort(), cells };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const num = (k) => { const i = argv.indexOf(`--${k}`); return i > -1 ? Number(argv[i + 1]) : NaN; };
  if (argv.includes('--report')) { await report(); process.exit(0); }
  if (argv.includes('--check-scorable')) {
    const ids = String(argv[argv.indexOf('--check-scorable') + 1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    try { assertHeldOutScorable(ids, { split: await loadAnchorSplit(), lock: await loadHeldOutLock() }); console.log(`✔ may be scored now: ${ids.join(' ')}`); process.exit(0); }
    catch (e) { console.error(`✖ ${e.message}`); process.exit(1); }
  }
  if (!argv.includes('--reserve')) { console.error('usage: anchor-split.mjs --reserve --seed <int> --held-out <n> | --report | --check-scorable <ids>'); process.exit(2); }
  try { await access(SPLIT_ANCHORS_PATH); console.error(`✖ ${SPLIT_ANCHORS_PATH} exists — the split is reserved and is never overwritten (D13). Delete it in a commit that says why.`); process.exit(1); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const seed = num('seed'), heldOut = num('held-out');
  const bytes = await readFile(DESIGN_PATH);
  const design = JSON.parse(bytes.toString('utf8'));
  const { held_out, tuning, cells } = reserveByDesign(design, { seed, heldOut });
  const errs = checkSplit(design, { held_out, tuning });
  if (errs.length) { console.error(`✖ ${errs.join('\n  ')}`); process.exit(1); }
  let git_head = null; try { git_head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { /* not in git */ }
  const comp = (ids) => ids.map((id) => design.anchors.find((a) => a.id === id).target_composite);
  const record = {
    reserved_at: new Date().toISOString(),
    git_head,
    seed,
    method: 'by DESIGN id, before any non-pilot fixture exists: eligible = non-pilot active anchors, split into language × profile cells (th/en × dissociated/coherent); held-out allocated to cells proportionally (largest remainder; a cell of 2+ keeps at least one tuning anchor); within each cell, ordered by target composite and cut into that many consecutive strata, one id drawn per stratum (design.mjs rng / mulberry32). Pilot and §7.4 replacements of tuning anchors are tuning.',
    cells_non_pilot: cells,
    design_sha256: createHash('sha256').update(bytes).digest('hex'),
    note: 'Held-out anchors are never rewritten on the strength of any AI or panel score (AUTHORING.md §7.5). Fixture bytes are bound at intake (HELDOUT-LOCK.json), and no held-out anchor is scored before every one is locked (§9).',
    held_out,
    tuning,
  };
  await writeFile(SPLIT_ANCHORS_PATH, JSON.stringify(record, null, 2) + '\n');
  const rng_ = (xs) => `${Math.min(...xs)}–${Math.max(...xs)}`;
  console.log(`held-out (${held_out.length}) composites ${rng_(comp(held_out))}: ${held_out.join(' ')}`);
  console.log(`tuning   (${tuning.length}) composites ${rng_(comp(tuning))}`);
  for (const [c, v] of Object.entries(cells)) {
    const ids = (set) => set.filter((id) => { const r = design.anchors.find((a) => a.id === id); return !r.pilot && cellOf(r) === c; });
    console.log(`  ${c.padEnd(15)} tuning ${String(v.tuning).padStart(2)} (${rng_(comp(ids(tuning)))})   held-out ${String(v.held_out).padStart(2)} (${rng_(comp(ids(held_out)))})`);
  }
  console.log(`seed ${seed} · design ${record.design_sha256.slice(0, 12)} · head ${git_head ?? '(none)'}`);
  console.log('Commit SPLIT-anchors.json now, before any authoring or screening.');
}

/**
 * COORDINATOR-ONLY report (needs SPLIT-anchors.json, which author checkouts do not have): per-cell
 * counts and composite spans, the batch run order (most tuning anchors first), and where each
 * extra-review row sits. Kept out of every committed document an author can read.
 */
async function report() {
  const split = await loadAnchorSplit();
  if (!split) { console.error('✖ no SPLIT-anchors.json in this checkout'); process.exit(1); }
  const design = JSON.parse(await readFile(DESIGN_PATH, 'utf8'));
  const row = (id) => design.anchors.find((a) => a.id === id);
  const span = (ids) => { const c = ids.map((id) => row(id).target_composite); return c.length ? (Math.min(...c) === Math.max(...c) ? `${c[0]}` : `${Math.min(...c)}–${Math.max(...c)}`) : '—'; };
  const held = new Set(split.held_out);
  console.log(`split: ${split.held_out.length} held-out / ${split.tuning.length} tuning (seed ${split.seed})`);
  console.log('cell (non-pilot)   tuning            held-out');
  for (const c of SPLIT_CELLS) {
    const ids = design.anchors.filter((a) => !a.pilot && !a.excluded && cellOf(a) === c).map((a) => a.id);
    const t = ids.filter((id) => !held.has(id)), h = ids.filter((id) => held.has(id));
    console.log(`  ${c.padEnd(16)} ${String(t.length).padStart(2)} (${span(t)})`.padEnd(38) + `${String(h.length).padStart(2)} (${span(h)})`);
  }
  let plan = null;
  try { plan = JSON.parse(await readFile(path.join(path.dirname(DESIGN_PATH), 'batches.json'), 'utf8')); } catch { /* no plan */ }
  if (plan) {
    const per = plan.batches.map((b) => ({ b: b.batch, t: b.rows.filter((r) => !held.has(r.id)).length }));
    const order = [...per].sort((x, y) => (y.t - x.t) || (x.b - y.b));
    console.log(`run order (most tuning anchors first): ${order.map((x) => `batch ${x.b} (${x.t})`).join(', ')}`);
    for (const b of plan.batches) for (const r of b.rows) if (r.extra_review) console.log(`  extra review: ${r.id} in batch ${b.batch} — ${held.has(r.id) ? 'HELD-OUT: can never be rewritten after scoring, so review hardest before intake' : 'tuning'}`);
  }
  const lock = await loadHeldOutLock();
  console.log(`held-out lock: ${Object.keys(lock?.locked ?? {}).length} of ${split.held_out.length} locked${lockComplete(split, lock) ? ' — COMPLETE: held-out may now be scored' : ' — held-out may NOT be scored yet'}`);
}
