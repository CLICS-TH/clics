#!/usr/bin/env node
/*
 * Does every UI label the manual quotes still exist in the product?
 *
 * WHY THIS EXISTS. The three print guides in docs/manuals/source/ went two months stale without a
 * single signal: 21 front-end commits landed, and greps for every August feature return zero hits in
 * them. Prose drift is invisible — nothing renders differently, nothing fails. But a manual that
 * tells a physician to press a button that no longer says that is worse than no manual, because they
 * trust it and then cannot find the control.
 *
 * The house rule (docs/manuals/README.md) is that a quoted label is VERBATIM, so a reader can match
 * it against the screen. That rule is what makes this check possible: every [[label]] must appear,
 * character for character, in the front-end source.
 *
 * WHAT IT CANNOT CATCH. A label that still exists but moved to a different screen, and a screenshot
 * that went stale. Both are noted in the plan; neither is pretended to be covered here.
 *
 *   node scripts/manuals/verify-labels.mjs          # all manuals
 *   node scripts/manuals/verify-labels.mjs physician
 *
 * Exit 0 = every label found. Exit 1 = at least one is gone.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLabels } from './lib/parse.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m' };

// Which source tree backs each manual. A physician label must exist in the portal, an auditor label
// in the dashboard — asserting against BOTH would let a label deleted from one survive on the other.
const MANUALS = {
  physician: { dirs: ['physician-ui/public'], exts: ['.html', '.js'] },
  // The auditor's journey starts at the PORTAL — there is one login door for every role, and they
  // are handed to the dashboard afterwards. So the sign-in labels an auditor is told to look for
  // legitimately live in physician-ui, and searching only the dashboard would fail them wrongly.
  auditor: {
    dirs: ['audit-dashboard/app', 'audit-dashboard/components', 'audit-dashboard/lib', 'physician-ui/public'],
    exts: ['.tsx', '.ts', '.html', '.js'],
  },
};

const readIf = async (rel) => readFile(join(ROOT, rel), 'utf8').catch(() => null);

async function walk(dir, exts, out = []) {
  let entries;
  try { entries = await readdir(join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = join(dir, e.name);
    if (e.isDirectory()) await walk(rel, exts, out);
    else if (exts.includes(extname(e.name))) out.push(rel);
  }
  return out;
}

/**
 * Flatten a source file into text a verbatim label can be found in.
 *
 * The product never stores a bilingual label as one string — it renders Thai and English as separate
 * nodes and lets CSS make English secondary. So the two house forms are re-joined into the ` / `
 * shape the manual quotes, and everything else is reduced to plain text.
 */
function flatten(src) {
  return src
    // physician-ui: <a>หน้าหลัก<span class="bi-en">Home</span></a>  ->  หน้าหลัก / Home
    .replace(/<span class="bi-en">([^<]*)<\/span>/g, ' / $1')
    // audit-dashboard: <BiLabel th="ผู้ใช้งาน" en="Users" />  ->  ผู้ใช้งาน / Users
    .replace(/<BiLabel\s+th=\{?["'`]([^"'`]*)["'`]\}?\s+en=\{?["'`]([^"'`]*)["'`]\}?/g, '$1 / $2')
    // ...and its object form, { th: 'คำเชิญ', en: 'Invites' }
    .replace(/th:\s*['"`]([^'"`]*)['"`],\s*en:\s*['"`]([^'"`]*)['"`]/g, '$1 / $2')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ');
}

// A label is matched on its whitespace-collapsed form: the product wraps and indents its markup, and
// a line break between two words is not a difference a reader can see.
const norm = (s) => s.replace(/\s+/g, ' ').trim();

async function verify(name) {
  const cfg = MANUALS[name];
  if (!cfg) throw new Error(`unknown manual "${name}" (want ${Object.keys(MANUALS).join(', ')})`);

  // BOTH languages. The English file quotes the SAME on-screen strings — the product renders every
  // control bilingually, so an English reader still looks for "จบและส่ง / End" on the button. A
  // translated quotation would break the one thing a quotation is for, and checking only the Thai
  // file would let that through.
  const srcs = [];
  for (const lang of ['th', 'en']) {
    const t = await readIf(`docs/manuals/content/${name}.${lang}.md`);
    if (t != null) srcs.push(t);
  }
  if (!srcs.length) return { name, skipped: true };

  const labels = [...new Set(srcs.flatMap(extractLabels))];
  const files = [];
  for (const d of cfg.dirs) await walk(d, cfg.exts, files);
  const haystack = norm((await Promise.all(files.map((f) => readFile(join(ROOT, f), 'utf8'))))
    .map(flatten).join('\n'));

  const missing = labels.filter((l) => !haystack.includes(norm(l)));
  return { name, total: labels.length, missing, files: files.length };
}

const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = want.length ? want : Object.keys(MANUALS);
let failed = false;

for (const name of names) {
  const r = await verify(name);
  if (r.skipped) { console.log(`${C.dim}${name}: no content file yet — skipped${C.reset}`); continue; }
  if (r.missing.length) {
    failed = true;
    console.log(`\n${C.red}${C.bold}${name}${C.reset} — ${r.missing.length} of ${r.total} quoted labels are not in the product:\n`);
    for (const m of r.missing) console.log(`  ${C.red}✗${C.reset} ${m}`);
    console.log(`\n${C.dim}  Searched ${r.files} files. Either the product changed and the manual must`
      + `\n  follow, or the label was quoted from memory rather than from the source.${C.reset}`);
  } else {
    console.log(`${C.green}✓${C.reset} ${name} — all ${r.total} quoted labels found across ${r.files} files`);
  }
}

process.exit(failed ? 1 : 0);
