#!/usr/bin/env node
/*
 * Build Gate 0 fixtures from real PLEs, de-identified by the production filter.
 *
 * WHY REAL TRANSCRIPTS. Gate 0 asks whether a self-hosted model can carry PIS-7 scoring for THIS
 * pilot. Synthetic transcripts answer a different, easier question: they are written by someone who
 * knows what the evaluator wants, in tidy prose, at a convenient length. Real physician turns are
 * short, code-switch mid-sentence between Thai and English drug names, and sometimes trail off. A
 * parse rate measured on invented data is not the number the gate is about.
 *
 * ============================================================================================
 * IT PRINTS NO TRANSCRIPT TEXT. NOT ONE CHARACTER. READ THIS BEFORE CHANGING THE OUTPUT.
 * This reads raw physician turns — PII by definition. They are passed through
 * rimpl/src/services/pii-filter.js (the same module that guards the cloud-AI boundary, with the
 * adversarial leak suite behind it) and written straight to fixtures/, which .gitignore excludes.
 * What reaches this terminal is counts and per-file mask tallies. Adding an excerpt "to check it
 * worked" would put physician text in a scrollback that gets pasted into reviews.
 * ============================================================================================
 *
 *   node scripts/probe/build-fixtures.mjs              # non-test PLEs with >= 4 physician turns
 *   node scripts/probe/build-fixtures.mjs --include-test --min-turns 2
 *
 * Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from backend/.env (gitignored, never committed).
 *
 * The de-identification here is a SECOND pass, not the only one: the pilot's own instruction sheet
 * (CREC082 doc 11 section 3) already forbids identifiers going in, and CREC082 section 7.2 requires
 * 100% human privacy review before a transcript reaches analysis or an expert. This script does not
 * replace either. It exists so a fixture cannot carry something both of those missed.
 */
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const OUT = join(ROOT, 'scripts/probe/fixtures');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? Number(process.argv[i + 1]) : d; };
const INCLUDE_TEST = process.argv.includes('--include-test');
const MIN_TURNS = arg('min-turns', 4);

const env = Object.fromEntries(
  (await readFile(join(ROOT, 'backend/.env'), 'utf8').catch(() => ''))
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const URL_ = process.env.SUPABASE_URL || env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.'); process.exit(2); }

// The production filter, not a copy. A second implementation would drift from the one the leak
// suite actually tests, and the drift would be invisible until it mattered.
const { stripPii, makeRegistry } = require(join(ROOT, 'rimpl/src/services/pii-filter.js'));
const { createClient } = require(join(ROOT, 'backend/node_modules/@supabase/supabase-js'));
const db = createClient(URL_, KEY, { auth: { persistSession: false } });

let q = db.from('ples').select('id, ple_code, is_test, ended_at').not('ended_at', 'is', null).order('ended_at');
if (!INCLUDE_TEST) q = q.eq('is_test', false);
const { data: ples, error } = await q;
if (error) { console.error('ples:', error.message); process.exit(1); }

await mkdir(OUT, { recursive: true });
// Clear previous fixtures so a shrinking corpus cannot leave stale files inflating the next run.
for (const f of await readdir(OUT)) if (f.endsWith('.json')) await unlink(join(OUT, f));

const C = { g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
console.log(`\n${C.b}building Gate 0 fixtures${C.x}  ${ples.length} ended PLE(s), min ${MIN_TURNS} physician turn(s)\n`);

let written = 0, skipped = 0;
const maskTotals = new Map();

for (const p of ples) {
  const { data: msgs } = await db.from('messages')
    .select('role, content, created_at').eq('ple_id', p.id).order('created_at');
  const turns = (msgs ?? []).filter((m) => ['physician', 'user', 'assistant'].includes(m.role));
  const physicianTurns = turns.filter((m) => m.role !== 'assistant').length;
  if (physicianTurns < MIN_TURNS) { skipped++; continue; }

  // One registry PER TRANSCRIPT: the placeholder numbering ([NAME-1], [HN-2]) is only meaningful
  // within a single conversation, and sharing a registry across PLEs would let a reader correlate
  // "[NAME-3]" between two different physicians' sessions.
  const registry = makeRegistry();
  const transcript = turns.map((m) => ({
    role: m.role === 'user' ? 'physician' : m.role,
    content: stripPii(String(m.content ?? ''), registry, []),
  }));

  // Count what got masked, by CLASS only. This is the number worth seeing: a transcript with a
  // dozen masks is one the human privacy review should look at again.
  const masks = {};
  for (const t of transcript) {
    for (const m of t.content.matchAll(/\[([A-Z]+)-\d+\]/g)) {
      masks[m[1]] = (masks[m[1]] ?? 0) + 1;
      maskTotals.set(m[1], (maskTotals.get(m[1]) ?? 0) + 1);
    }
  }

  const name = `${(p.ple_code ?? p.id.slice(0, 8)).toLowerCase()}.json`;
  await writeFile(join(OUT, name), JSON.stringify({
    ple_id: p.ple_code ?? p.id, patient_ref: null, transcript,
  }, null, 2));
  written++;

  const tag = Object.entries(masks).map(([k, n]) => `${k}:${n}`).join(' ');
  console.log(`  ${C.g}✓${C.x} ${name.padEnd(14)} ${String(transcript.length).padStart(3)} turns`
    + `  ${p.is_test ? C.y + 'TEST' + C.x : '    '}  ${tag ? C.y + 'masked ' + tag + C.x : C.d + 'no masks' + C.x}`);
}

console.log(`\n${written} fixture(s) written, ${skipped} skipped (fewer than ${MIN_TURNS} physician turns)`);
if (maskTotals.size) {
  console.log(`${C.y}masked overall:${C.x} ` + [...maskTotals].map(([k, n]) => `${k}=${n}`).join('  '));
  console.log(`${C.d}  Each of these is something the instruction sheet asked physicians not to enter.`);
  console.log(`  Worth raising with the privacy review — the filter is the second line, not the first.${C.x}`);
}
if (written < 10) {
  console.log(`\n${C.y}⚠${C.x} Gate 0 wants 10 minimum, 20+ to reason about a rate.`
    + ` At n=${written} a 95% gate means ${written}/${written} — one bad reply fails it.`);
}
console.log(`\n${C.d}fixtures/ is gitignored. Next: node scripts/probe/json-contract.mjs${C.x}\n`);
