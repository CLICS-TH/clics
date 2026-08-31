#!/usr/bin/env node
/*
 * PLE -> PLE across the codebase. Aligns with CREC082 Protocol V4.3, which governs.
 *
 * WHY A RULE TABLE AND NOT `sed s/ple/ple/g`. English is full of words containing "ple", and this
 * repo uses a lot of them: measured here, `clear` x82, `clean` x61, `cleared` x31, `mockClear` x18,
 * `cleanup` x12, `clearTimeout` x11, `CLEARED` x9, `clearance` x7 — plus `nuclear`, `article`,
 * `muscle`, `client`, `obstacle` in prose. A blind substitution corrupts every one of them, and the
 * corruption is silent in comments and Thai copy where no test looks. So every rule below is
 * anchored, each one is listed with what it is FOR, and the script reports per-rule hit counts so a
 * rule that fires far more or far less than expected is visible before anything is written.
 *
 *   node scripts/rename/ple-to-ple.mjs            # DRY RUN — per-rule counts, writes nothing
 *   node scripts/rename/ple-to-ple.mjs --write    # apply
 *   node scripts/rename/ple-to-ple.mjs --write --paths backend rimpl
 *
 * File RENAMES (ple-new.html -> ple-new.html, routes/ples.js -> routes/ples.js) are handled by
 * --rename-files, separately, because a path change breaks imports until every referrer is rewritten
 * and that is worth doing as its own reviewable step.
 */
import { readFileSync, writeFileSync, statSync, readdirSync, renameSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WRITE = process.argv.includes('--write');
const RENAME_FILES = process.argv.includes('--rename-files');
const argPaths = (() => {
  const i = process.argv.indexOf('--paths');
  return i > -1 ? process.argv.slice(i + 1).filter((a) => !a.startsWith('--')) : null;
})();

const DEFAULT_PATHS = ['backend/src', 'backend/tests', 'rimpl/src', 'rimpl/tests', 'physician-ui/public',
  'audit-dashboard/app', 'audit-dashboard/components', 'audit-dashboard/lib', 'audit-dashboard/__tests__',
  // db/schema.sql ONLY, never db/. The migration files are a RECORD of what was applied on a given
  // day and retelling them falsifies it — and db/migration-ple-rename.sql deliberately contains both
  // the old and the new name, so a pass over it rewrites `alter table ples rename to ples` into
  // `alter table ples rename to ples` and destroys the migration it is trying to ship.
  'scripts', 'docs', 'db/schema.sql'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'coverage', 'lcov-report', 'img', 'source']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css', '.json',
  '.md', '.sql', '.yml', '.yaml', '.txt']);

/*
 * The rules, in application order. Order matters in two places:
 *   - `ples_` and `ple_` run BEFORE the bare-word rules, because \b does not fire before `_`
 *     (an underscore is a word character), so `ples_physician_id_fkey` is invisible to /\bcles\b/.
 *   - `PLEs` runs before `PLE`, or the plural is left as `PLEs` -> `PLEs` by luck rather than rule.
 */
const RULES = [
  // --- SQL / API identifiers -------------------------------------------------------------------
  [/\bcles_/g,  'ples_',  'constraint + index names: ples_physician_id_fkey -> ples_physician_id_fkey'],
  [/\bcle_/g,   'ple_',   'columns + tables: ple_id, ple_code, ple_count, ple_folders, ple_pii_map, …'],
  [/_ple_/g,    '_ple_',  'infix: next_ple_code, audit_scores_ple_idx'],
  [/\bcle-/g,   'ple-',   'kebab identifiers + file paths: ple-new, ple-chat, ple-status'],

  // --- JS identifiers --------------------------------------------------------------------------
  // `ple` followed by an UPPERCASE letter is always our own camelCase (pleId, pleRow, pleUpdate).
  // `clear`/`clean` are lowercase after `ple` and so cannot match.
  [/\bcles(?=[A-Z])/g, 'ples', 'camelCase plural: plesRouter, plesErr, plesRes'],
  [/\bcle(?=[A-Z])/g,  'ple',  'camelCase: pleId, pleIds, pleRow, pleUpdate, pleStatusCards'],
  // `…Cle` / `…Cles` at a word end — byPle, perPle, scanPle, mockPles, cappedPles. `mockClear`
  // cannot match: it is `Clear`, not `Cle` at a boundary.
  [/([a-z])Cles\b/g, '$1Ples', 'suffix plural: mockPles, cappedPles'],
  [/([a-z])Cle\b/g,  '$1Ple',  'suffix: byPle, perPle, scanPle, mockPle'],

  // --- bare words ------------------------------------------------------------------------------
  [/\bCLEs\b/g,  'PLEs',  'acronym plural in prose and comments'],
  // Also covers the episode codes: a hyphen is a non-word character, so \b holds after the E and
  // PLE-005 becomes PLE-005 by this rule. A separate /\bCLE-/ rule measured zero hits.
  [/\bCLE\b/g,   'PLE',   'acronym, incl. episode codes PLE-005 -> PLE-005'],
  [/\bcles\b/g,  'ples',  'table name in queries, route segment /ples'],
  [/\bcle\b/g,   'ple',   'lone identifier'],

  // --- prose: the expansions -------------------------------------------------------------------
  // The app carries THREE different expansions (Continuous x41, Professional x5, Clinical x5).
  // The protocol and the v12 manuscript both use exactly one.
  [/\b(?:Continuous|Clinical) Learning Episodes\b/g, 'Professional Learning Episodes', 'expansion, plural'],
  [/\b(?:Continuous|Clinical) Learning Episode\b/g,  'Professional Learning Episode',  'expansion'],
  // CLICS itself. Protocol section 9.8 records the change as deliberate; "Continuous" appears zero
  // times in either governing document.
  [/Case-based Learning Intelligence Credit System/g, 'Case-based Learning Intelligence Credit System', 'CLICS expansion (HTML-escaped)'],
  [/Case-based Learning Intelligence Credit System/g,     'Case-based Learning Intelligence Credit System', 'CLICS expansion'],
  [/Case-based Learning Intelligence Credit System/g,   'Case-based Learning Intelligence Credit System', 'CLICS expansion (spelled and)'],
];

/*
 * Guard: strings that must survive untouched. Checked AFTER the rewrite — if any of these stopped
 * appearing in a file that had them, a rule over-reached and the run aborts rather than writing.
 * These are the actual high-count "ple" words in this repo, not a hypothetical list.
 */
const MUST_SURVIVE = ['clear', 'clean', 'cleared', 'clearTimeout', 'mockClear', 'cleanup',
  'CLEARED', 'clearance', 'nuclear', 'article', 'muscle', 'client', 'obstacle', 'cleanly',
  'cleanMessage', 'whereCleared', 'clears'];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(extname(p))) out.push(p);
  }
  return out;
}

/*
 * SELF-EXCLUSION, and it is not paranoia — it already happened. This file lives under scripts/,
 * which is in DEFAULT_PATHS, so the first run rewrote its own source: the rename callback's
 * `m === 'cles'` became `m === 'ples'`, the plural branch stopped matching, and every plural file
 * was then renamed to the singular (routes/cles.js -> routes/ple.js) while the content pass had
 * already rewritten every import to `./routes/ples`. A rewriting tool inside its own search path
 * has to take itself out of it.
 */
const SELF = fileURLToPath(import.meta.url);
const files = (argPaths ?? DEFAULT_PATHS).flatMap((p) => {
  const abs = join(ROOT, p);
  try { return statSync(abs).isDirectory() ? walk(abs) : [abs]; } catch { return []; }
}).filter((f) => f !== SELF);

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const hits = new Map(RULES.map((r) => [r[2], 0]));
const touched = [];
const violations = [];

for (const f of files) {
  let src;
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  const before = src;
  let out = src;
  for (const [re, to, label] of RULES) {
    const n = (out.match(re) ?? []).length;
    if (n) { hits.set(label, hits.get(label) + n); out = out.replace(re, to); }
  }
  if (out === before) continue;

  // The guard. A word that was present and is now gone means a rule ate it.
  for (const w of MUST_SURVIVE) {
    const b = (before.match(new RegExp(w, 'g')) ?? []).length;
    const a = (out.match(new RegExp(w, 'g')) ?? []).length;
    if (a < b) violations.push(`${f.replace(ROOT, '')}: "${w}" ${b} -> ${a}`);
  }
  touched.push(f);
  if (WRITE && !violations.length) writeFileSync(f, out);
}

console.log(`\n${C.b}${WRITE ? 'WRITING' : 'DRY RUN — nothing written'}${C.x}  ${files.length} file(s) scanned\n`);
console.log(`${C.b}per-rule hits${C.x}`);
for (const [label, n] of hits) {
  console.log(`  ${n ? String(n).padStart(6) : C.d + '     0' + C.x} ${C.d}${label}${C.x}`);
}
console.log(`\n${touched.length} file(s) would change`);

if (violations.length) {
  console.error(`\n${C.r}${C.b}ABORTED — a rule ate a word it should not have:${C.x}`);
  for (const v of violations.slice(0, 20)) console.error(`  ${C.r}✗${C.x} ${v}`);
  process.exit(1);
}

if (RENAME_FILES && WRITE) {
  // git mv so history follows the file rather than reading as delete + add.
  const renames = files
    .map((f) => [f, join(dirname(f), basename(f).replace(/\bcles?\b/g, (m) => (m === 'cles' ? 'ples' : 'ple')).replace(/\bcle-/g, 'ple-'))])
    .filter(([a, b]) => a !== b);
  for (const [from, to] of renames) {
    // execFileSync with an argument array: no shell, so a path is a path and never a command.
    try { execFileSync('git', ['mv', from, to], { cwd: ROOT, stdio: 'pipe' }); }
    catch { renameSync(from, to); }
    console.log(`  ${C.g}mv${C.x} ${from.replace(ROOT, '')} -> ${to.replace(ROOT, '')}`);
  }
  console.log(`\n${renames.length} file(s) renamed`);
}

console.log(WRITE ? `\n${C.g}✓${C.x} written\n` : `\n${C.d}Re-run with --write to apply.${C.x}\n`);
