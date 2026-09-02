#!/usr/bin/env node
/*
 * Reserve the held-out split — ONCE, before any prompt is tuned (roadmap D13).
 *
 *   node scripts/probe/reserve-split.mjs --seed 20260901 --held-out 8
 *
 * Writes scripts/probe/SPLIT.json (committed; ids + sha256 only, no transcript text) and REFUSES to
 * overwrite it. There is deliberately no --force: if the split must change, delete the file in a
 * commit whose message says why, so the change is visible in history. The seed is recorded so the
 * shuffle is reproducible; the fixture digests make a later swap detectable.
 */
import { readdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PROBE_DIR, bold, dim, green, hr, fail } from './lib.mjs';
import { SPLIT_PATH, sha256File } from './split.mjs';

const argNum = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? Number(process.argv[i + 1]) : d; };
const SEED = argNum('seed', NaN);
const HELD = argNum('held-out', 8);
if (!Number.isInteger(SEED)) fail('--seed <integer> is required, so the shuffle is reproducible and the choice is on record.');

try { await access(SPLIT_PATH); fail(`${SPLIT_PATH} already exists — the split is reserved. It is not overwritten by design (D13).`); }
catch (e) { if (e.code !== 'ENOENT') throw e; }

const FIX = path.join(PROBE_DIR, 'fixtures');
const files = (await readdir(FIX).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
if (files.length < HELD + 2) fail(`only ${files.length} fixtures; cannot hold out ${HELD}.`);

// mulberry32: small, seeded, good enough to shuffle 26 ids reproducibly.
let s = SEED >>> 0;
const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ids = files.map((f) => f.replace(/\.json$/, ''));
for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }

const held_out = ids.slice(0, HELD).sort();
const tuning = ids.slice(HELD).sort();
const fixture_sha256 = {};
for (const f of files) fixture_sha256[f.replace(/\.json$/, '')] = await sha256File(path.join(FIX, f));
let git_head = null; try { git_head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { /* not in git */ }

const record = { reserved_at: new Date().toISOString(), git_head, seed: SEED, method: 'seeded Fisher–Yates over sorted fixture ids (mulberry32)', held_out, tuning, fixture_sha256 };
await writeFile(SPLIT_PATH, JSON.stringify(record, null, 2) + '\n');

hr('held-out split reserved');
console.log(`  ${bold('held-out')} (${held_out.length})  ${held_out.join(', ')}`);
console.log(`  ${bold('tuning')}   (${tuning.length})  ${tuning.join(', ')}`);
console.log(`  ${dim(`seed ${SEED} · head ${git_head ?? '(none)'} · ${SPLIT_PATH}`)}`);
console.log(`\n  ${green('Commit SPLIT.json now, alone, before any prompt change.')}\n`);
