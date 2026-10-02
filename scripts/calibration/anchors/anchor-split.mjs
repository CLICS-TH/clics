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
// Package-free.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPLIT_ANCHORS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'SPLIT-anchors.json');
export const SPLIT_NAMES = ['tuning', 'heldout'];

export async function loadAnchorSplit(p = SPLIT_ANCHORS_PATH) {
  try { return JSON.parse(await readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Ids a held-out reservation may draw from: every designed anchor that is NOT pilot. */
export function heldOutEligible(design) {
  return design.anchors.filter((a) => !a.pilot).map((a) => a.id);
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
  return new Set(name === 'heldout' ? split.held_out : split.tuning);
}
