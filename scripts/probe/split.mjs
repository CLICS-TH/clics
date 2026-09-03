// The held-out split, and the rule that every scoring probe must honour it.
//
// Roadmap D13: the held-out cohort is reserved BEFORE the first tuning run, or the split that passes
// is indistinguishable from the split that was chosen. SPLIT.json lives OUTSIDE fixtures/ so it is
// committed (fixtures/ is gitignored — they are de-identified transcripts); it carries fixture ids
// and sha256 digests only, never transcript text. The digests make a swapped fixture detectable.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PROBE_DIR, fail } from './lib.mjs';

export const SPLIT_PATH = path.join(PROBE_DIR, 'SPLIT.json');
export const SPLITS = ['tuning', 'heldout'];

export async function loadSplit() {
  try { return JSON.parse(await readFile(SPLIT_PATH, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function sha256File(p) {
  return createHash('sha256').update(await readFile(p)).digest('hex');
}

// Apply `--split` to a list of fixture files. Once SPLIT.json exists, a scoring probe MUST name a
// split: running "all fixtures" after the reservation silently folds the held-out cohort into
// tuning, which is exactly the leak D13 forbids. Also verifies digests, so a fixture edited after the
// reservation fails loudly instead of quietly scoring a different transcript under the same id.
export async function applySplit(files, splitName, { fixturesDir }) {
  const split = await loadSplit();
  if (!split) {
    if (splitName) fail(`--split ${splitName} given but ${SPLIT_PATH} does not exist — run scripts/probe/reserve-split.mjs first.`);
    return { files, split: null };
  }
  if (!splitName) {
    fail(`SPLIT.json exists (reserved ${split.reserved_at}); a scoring run must name --split ${SPLITS.join('|')}.\n` +
      `  Running without one would fold the held-out cohort into tuning (roadmap D13).`);
  }
  if (!SPLITS.includes(splitName)) fail(`--split must be ${SPLITS.join('|')} (got ${splitName})`);
  const wanted = new Set(splitName === 'heldout' ? split.held_out : split.tuning);
  const idOf = (f) => f.replace(/\.json$/, '');
  const chosen = files.filter((f) => wanted.has(idOf(f)));
  const missing = [...wanted].filter((id) => !files.some((f) => idOf(f) === id));
  if (missing.length) fail(`fixtures named in SPLIT.json are missing on disk: ${missing.join(', ')}`);
  for (const f of chosen) {
    const want = split.fixture_sha256[idOf(f)];
    const got = await sha256File(path.join(fixturesDir, f));
    if (want && want !== got) fail(`fixture ${idOf(f)} changed since the split was reserved (sha256 mismatch) — a different transcript under the same id would corrupt the cohort.`);
  }
  return { files: chosen, split: { name: splitName, reserved_at: split.reserved_at, git_head: split.git_head } };
}
