#!/usr/bin/env node
/*
 * Calibrate F6_REGISTER_DISCONTINUITY against real sessions, the way F1 and F5 were calibrated.
 *
 * WHY THIS SCRIPT EXISTS RATHER THAN A NUMBER IN THE SOURCE. services/integrity.js states the rule
 * it holds itself to: "a threshold nobody has checked against data is a threshold that will
 * eventually accuse a physician of something they did not do." F4 is switched off today precisely
 * because it failed this step. F6 ships disabled and stays disabled until this run produces a
 * false-positive count somebody is willing to put their name to.
 *
 * ============================================================================================
 * IT PRINTS NO TRANSCRIPT TEXT. NOT ONE CHARACTER. READ THIS BEFORE CHANGING THE OUTPUT.
 * Physician turns are raw PII by design — services/integrity.js processes them, and that is
 * acceptable only while they stay inside the backend. This script runs on YOUR machine against
 * YOUR database, and its output is counts, PLE ids and percentiles, so the result can be pasted
 * into a review, an issue, or a conversation with an assistant without moving PII anywhere. Adding
 * an `excerpt` here to "make the output easier to read" would quietly undo that. Do not.
 * ============================================================================================
 *
 *   cd backend && node ../scripts/integrity/calibrate-f6.mjs
 *   node ../scripts/integrity/calibrate-f6.mjs --min-baseline 6
 *
 * Reads SUPABASE_URL / SUPABASE_SERVICE_KEY from backend/.env (gitignored, never committed).
 *
 * WHAT TO DO WITH THE OUTPUT. Pick the (z, min_features) cell where the flagged count over
 * non-test sessions is ZERO, or where every flagged PLE has been read by a human and agreed to be
 * a genuine register break. Write that number, and the count it was measured against, into the
 * F6_REGISTER_DISCONTINUITY comment in services/integrity.js — then set enabled: true.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const { detectIntegritySignals, styleVector, STYLE_KEYS, SIGNALS } =
  require(join(ROOT, 'backend/src/services/integrity.js'));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};

// --- env ------------------------------------------------------------------------------------
const env = Object.fromEntries(
  (await readFile(join(ROOT, 'backend/.env'), 'utf8').catch(() => ''))
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const URL_ = process.env.SUPABASE_URL || env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY (checked env and backend/.env).');
  process.exit(2);
}

const { createClient } = require(join(ROOT, 'backend/node_modules/@supabase/supabase-js'));
const db = createClient(URL_, KEY, { auth: { persistSession: false } });

// --- corpus ---------------------------------------------------------------------------------
// TEST sessions are excluded for the same reason F2's comment gives: the pilot's own rehearsal
// pasted scripted prompts repeatedly, and counting that as physician behaviour would calibrate the
// threshold against the team rather than against clinicians.
const { data: ples, error: cErr } = await db.from('ples')
  .select('id, physician_id').eq('is_test', false);
if (cErr) { console.error('ples:', cErr.message); process.exit(1); }

const byPhysician = new Map();
for (const c of ples ?? []) {
  if (!c.physician_id) continue;
  if (!byPhysician.has(c.physician_id)) byPhysician.set(c.physician_id, []);
  byPhysician.get(c.physician_id).push(c.id);
}

const ids = (ples ?? []).map((c) => c.id);
const messages = [];
for (let i = 0; i < ids.length; i += 100) {
  const { data, error } = await db.from('messages')
    .select('ple_id, role, content, created_at, token_count')
    .in('ple_id', ids.slice(i, i + 100)).order('created_at');
  if (error) { console.error('messages:', error.message); process.exit(1); }
  messages.push(...(data ?? []));
}
const byPle = new Map();
for (const m of messages) {
  if (!byPle.has(m.ple_id)) byPle.set(m.ple_id, []);
  byPle.get(m.ple_id).push(m);
}

console.log(`corpus: ${ples.length} non-test PLEs · ${byPhysician.size} physicians · ${messages.length} messages\n`);

// --- feature spread, so the MAD floors can be sanity-checked ---------------------------------
const physTexts = messages.filter((m) => m.role === 'physician' || m.role === 'user')
  .map((m) => String(m.content ?? '')).filter((t) => t.length >= 40);
const pct = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0; };
console.log(`physician turns >=40 chars: ${physTexts.length}`);
console.log('feature'.padEnd(11) + ['p50', 'p90', 'p99', 'max'].map((h) => h.padStart(9)).join(''));
const vecs = physTexts.map(styleVector);
for (const k of STYLE_KEYS) {
  const xs = vecs.map((v) => v[k]);
  console.log(k.padEnd(11) + [pct(xs, 0.5), pct(xs, 0.9), pct(xs, 0.99), Math.max(...xs, 0)]
    .map((n) => String(Math.round(n * 100) / 100).padStart(9)).join(''));
}

// --- the grid -------------------------------------------------------------------------------
// A false positive here is a real clinician routed to an accusation queue, so the cell to pick is
// the one that flags nothing — or nothing a human disagrees with.
const MIN_BASELINE = arg('min-baseline', SIGNALS.F6_REGISTER_DISCONTINUITY.min_baseline);
const Z_GRID = [2.5, 3.0, 3.5, 4.0, 5.0];
const FEAT_GRID = [1, 2, 3];

console.log(`\nflagged NON-TEST PLEs by threshold  (min_baseline ${MIN_BASELINE}, of ${ples.length} PLEs)`);
console.log('z'.padEnd(6) + FEAT_GRID.map((f) => `${f}+ feat`.padStart(10)).join(''));

const hits = new Map();   // "z|feat" -> Set(ple_id)
for (const z of Z_GRID) {
  const row = [];
  for (const mf of FEAT_GRID) {
    const cfg = { F6_REGISTER_DISCONTINUITY: { ...SIGNALS.F6_REGISTER_DISCONTINUITY, enabled: true, z, min_features: mf, min_baseline: MIN_BASELINE } };
    const flagged = new Set();
    for (const [physId, pleIds] of byPhysician) {
      for (const pleId of pleIds) {
        const own = (byPle.get(pleId) ?? []);
        const prior = pleIds.filter((x) => x !== pleId)
          .flatMap((x) => (byPle.get(x) ?? []).filter((m) => m.role === 'physician' || m.role === 'user'))
          .map((m) => ({ ple_id: pleId, content: m.content }));
        const flags = detectIntegritySignals(own, prior, cfg);
        if (flags.some((f) => f.signal === 'F6_REGISTER_DISCONTINUITY')) flagged.add(pleId);
      }
    }
    hits.set(`${z}|${mf}`, flagged);
    row.push(String(flagged.size).padStart(10));
  }
  console.log(String(z).padEnd(6) + row.join(''));
}

// --- what to read next ------------------------------------------------------------------------
const shipped = hits.get(`${SIGNALS.F6_REGISTER_DISCONTINUITY.z}|${SIGNALS.F6_REGISTER_DISCONTINUITY.min_features}`);
console.log(`\nat the values currently in the source (z=${SIGNALS.F6_REGISTER_DISCONTINUITY.z}, `
  + `min_features=${SIGNALS.F6_REGISTER_DISCONTINUITY.min_features}): ${shipped?.size ?? 0} PLE(s) flagged`);
if (shipped?.size) {
  console.log('PLE ids to read by hand before enabling (ids only — no transcript text is printed):');
  for (const id of shipped) console.log(`  ${id}`);
}
console.log('\nF6 stays disabled until a human has read the flagged sessions and agreed.\n');
