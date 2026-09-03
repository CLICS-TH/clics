#!/usr/bin/env node
/*
 * Run the integrity detector over PLEs that ended BEFORE it shipped.
 *
 * WHY THIS IS NEEDED AT ALL. services/integrity-scan.js runs automatically at /end, but the detector
 * landed 2026-08-26 and the last session ended 2026-08-16 — so in production it has never executed
 * once, and the queue it feeds is empty for that reason rather than because the corpus is clean.
 * A backfill is the only way to find out which it is.
 *
 * ============================================================================================
 * IT PRINTS NO TRANSCRIPT TEXT. NOT ONE CHARACTER. READ THIS BEFORE CHANGING THE OUTPUT.
 * Flag evidence carries an `excerpt` — 120 characters of the physician's own turn — and this
 * script strips it before printing. Physician turns are raw PII: acceptable inside the backend,
 * never in a terminal someone pastes into a review or an assistant. What prints is signal names,
 * severities, PLE ids and counts, which is enough to decide anything this script is used to decide.
 * ============================================================================================
 *
 *   node scripts/integrity/scan-existing.mjs              # DRY RUN — writes nothing
 *   node scripts/integrity/scan-existing.mjs --write      # persists flags, as /end would
 *
 * --write is not idempotent-free: scanPle REPLACES this PLE's detector flags on every run, and a
 * flagged session is forced into the audit sample. That is the intended behaviour and the reason
 * the default is a dry run.
 *
 * Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from backend/.env (gitignored, never committed).
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const WRITE = process.argv.includes('--write');

// backend/src/lib/supabase.js reads process.env at require time, so the env must be populated first.
const env = Object.fromEntries(
  (await readFile(join(ROOT, 'backend/.env'), 'utf8').catch(() => ''))
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;
if (!process.env.SUPABASE_URL) { console.error('No SUPABASE_URL (checked env and backend/.env).'); process.exit(2); }

const { supabase } = require(join(ROOT, 'backend/src/lib/supabase.js'));
const { scanPle } = require(join(ROOT, 'backend/src/services/integrity-scan.js'));
const { detectIntegritySignals } = require(join(ROOT, 'backend/src/services/integrity.js'));

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

const { data: ples, error } = await supabase.from('ples')
  .select('id, ple_code, physician_id, is_test, ended_at')
  .not('ended_at', 'is', null).order('ended_at');
if (error) { console.error('ples:', error.message); process.exit(1); }

console.log(`\n${C.b}${WRITE ? 'WRITING' : 'DRY RUN — nothing is persisted'}${C.x}`);
console.log(`${ples.length} ended PLE(s) to scan\n`);

const bySignal = new Map();
const flagged = [];
let scannedTurns = 0;

for (const c of ples) {
  let flags;
  if (WRITE) {
    const r = await scanPle({ pleId: c.id, physicianId: c.physician_id });
    flags = r.flags; scannedTurns += r.scanned_turns ?? 0;
  } else {
    // Same inputs scanPle assembles, without the write.
    const { data: msgs } = await supabase.from('messages')
      .select('role, content, created_at, token_count').eq('ple_id', c.id).order('created_at');
    let prior = [];
    if (c.physician_id) {
      const { data: others } = await supabase.from('ples')
        .select('id').eq('physician_id', c.physician_id).eq('is_test', false).neq('id', c.id);
      const ids = (others ?? []).map((o) => o.id);
      if (ids.length) {
        const { data: p } = await supabase.from('messages')
          .select('ple_id, content').in('ple_id', ids).in('role', ['user', 'physician']);
        prior = p ?? [];
      }
    }
    flags = detectIntegritySignals(msgs ?? [], prior);
    scannedTurns += (msgs ?? []).filter((m) => m.role === 'user' || m.role === 'physician').length;
  }

  if (!flags.length) continue;
  flagged.push({ c, flags });
  for (const f of flags) {
    const k = `${f.signal}|${f.severity}`;
    bySignal.set(k, (bySignal.get(k) ?? 0) + 1);
  }
}

if (!bySignal.size) {
  console.log(`${C.g}✓${C.x} 0 flags across ${ples.length} PLE(s), ${scannedTurns} physician turn(s).`);
  console.log(`${C.d}  The corpus is clean by these rules — the empty queue is a real result, not a gap.${C.x}\n`);
  process.exit(0);
}

console.log(`${C.b}signal totals${C.x}`);
for (const [k, n] of [...bySignal].sort((a, b) => b[1] - a[1])) {
  const [sig, sev] = k.split('|');
  const col = sev === 'high' ? C.r : sev === 'medium' ? C.y : C.d;
  console.log(`  ${col}${sev.padEnd(6)}${C.x} ${sig.padEnd(28)} ${n}`);
}

console.log(`\n${C.b}flagged PLEs${C.x}  ${C.d}(ids only — no transcript text is printed)${C.x}`);
for (const { c, flags } of flagged) {
  console.log(`  ${(c.ple_code ?? c.id.slice(0, 8)).padEnd(12)} ${c.is_test ? 'TEST ' : '     '} ${c.id}`);
  for (const f of flags) {
    // Evidence MINUS the excerpt. Numbers are the point; the physician's words are not ours to print.
    const { excerpt, genre, ...rest } = f.evidence ?? {};
    const g = genre ? ` genre{clinical ${genre.clinical_density} discourse ${genre.discourse_density} md ${genre.markdown_marks}}` : '';
    console.log(`      ${f.severity.padEnd(6)} ${f.signal.padEnd(26)} ${JSON.stringify(rest)}${g}`);
  }
}
console.log(`\n${flagged.length} of ${ples.length} PLE(s) flagged · ${scannedTurns} physician turn(s) scanned`);
console.log(WRITE ? `${C.y}Flags persisted. They now appear in /admin/integrity and force those sessions into the audit sample.${C.x}\n`
  : `${C.d}Nothing written. Re-run with --write to persist.${C.x}\n`);
